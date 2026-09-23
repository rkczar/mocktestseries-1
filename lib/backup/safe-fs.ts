import "server-only";
import crypto from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Path safety for every Backup Center filesystem operation.
 *
 * - The browser only ever holds an opaque id = HMAC-free sha256 of
 *   (root key, basename); the server re-lists the allowlisted root and
 *   matches ids, so no client string is ever joined into a path.
 * - `resolveInsideRoot` additionally requires: a bare basename (no "/",
 *   no "..", no leading "."), a recognized name pattern, the entry itself not
 *   being a symlink (lstat), and realpath(entry)'s parent === realpath(root) —
 *   so a symlink placed inside a root can never redirect an operation
 *   elsewhere (no traversal, no symlink escape).
 */

export class UnsafePathError extends Error {
  constructor(reason: string) {
    super(`Refused: ${reason}`);
    this.name = "UnsafePathError";
  }
}

export function opaqueId(rootKey: string, name: string): string {
  return crypto.createHash("sha256").update(`${rootKey}\0${name}`).digest("hex").slice(0, 32);
}

export function isSafeBasename(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200 &&
    name === path.basename(name) &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

export async function resolveInsideRoot(
  root: string,
  name: string,
  opts: { pattern: RegExp; expect: "file" | "dir" }
): Promise<string> {
  if (!isSafeBasename(name)) throw new UnsafePathError("invalid name");
  if (!opts.pattern.test(name)) throw new UnsafePathError("unrecognized artifact name");
  const rootReal = await realpath(root);
  const candidate = path.join(rootReal, name);
  const st = await lstat(candidate).catch(() => null);
  if (!st) throw new UnsafePathError("not found");
  if (st.isSymbolicLink()) throw new UnsafePathError("symlink");
  if (opts.expect === "file" && !st.isFile()) throw new UnsafePathError("not a regular file");
  if (opts.expect === "dir" && !st.isDirectory()) throw new UnsafePathError("not a directory");
  const real = await realpath(candidate);
  if (path.dirname(real) !== rootReal || path.basename(real) !== name) throw new UnsafePathError("escapes root");
  return real;
}
