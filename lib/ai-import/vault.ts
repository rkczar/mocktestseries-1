import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Original Paper Vault: PRIVATE storage for uploaded papers, answer keys, page
 * renders and original figure bytes. Never under /media/ or public storage;
 * files are served only through admin-checked routes. Keys are generated here
 * (content-addressed or id-based) — a client never supplies a path.
 *
 *   files/<aa>/<sha256>.<ext>     original uploads (identical uploads share one file)
 *   figures/<aa>/<sha256>.<ext>   original figure bytes (embedded image or crop)
 *   renders/<jobId>/<fileId>/p<n>.png   page renders (intermediate, re-creatable)
 *   tmp/<uploadId>/<index>        upload chunks (temporary)
 *   work/<jobId>/…                worker scratch (temporary)
 */

const DEFAULT_ROOT = "/var/lib/mocktestseries/ai-import-vault";

export function vaultRoot(): string {
  return path.resolve(process.env.AI_IMPORT_VAULT_DIR || DEFAULT_ROOT);
}

const KEY = /^(files|figures)\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]{2,5}$|^renders\/[a-z0-9]{8,40}\/[a-z0-9]{8,40}\/p\d{1,4}\.png$|^(tmp|work)\/[a-z0-9]{8,40}(\/[a-z0-9._-]{1,80}){0,3}$/;

export function isVaultKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key) && !key.includes("..");
}

export function vaultPath(key: string): string {
  if (!isVaultKey(key)) throw new Error("Refusing an invalid vault key");
  const root = vaultRoot();
  const full = path.join(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("Vault key escapes the vault root");
  return full;
}

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function contentKey(area: "files" | "figures", sha256: string, ext: string): string {
  return `${area}/${sha256.slice(0, 2)}/${sha256}.${ext.toLowerCase()}`;
}

export function renderKey(jobId: string, fileId: string, page: number): string {
  return `renders/${jobId}/${fileId}/p${page}.png`;
}

/** Writes bytes under a content-addressed key; never overwrites (identical bytes = same file). */
export async function putContent(area: "files" | "figures", bytes: Buffer, ext: string): Promise<{ key: string; sha256: string; created: boolean }> {
  const sha256 = sha256Hex(bytes);
  const key = contentKey(area, sha256, ext);
  const target = vaultPath(key);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (await exists(key)) return { key, sha256, created: false };
  const tmp = path.join(path.dirname(target), `.tmp-${randomBytes(8).toString("hex")}`);
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await link(tmp, target);
    return { key, sha256, created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { key, sha256, created: false };
    throw e;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Moves an assembled temp file into its content-addressed place (streamed hash; no full read into memory). */
export async function adoptFile(tmpFull: string, area: "files", ext: string): Promise<{ key: string; sha256: string; bytes: number; created: boolean }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    createReadStream(tmpFull)
      .on("data", (c) => {
        hash.update(c as Buffer);
        bytes += (c as Buffer).length;
      })
      .on("end", () => resolve())
      .on("error", reject);
  });
  const sha256 = hash.digest("hex");
  const key = contentKey(area, sha256, ext);
  const target = vaultPath(key);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (await exists(key)) {
    await unlink(tmpFull).catch(() => {});
    return { key, sha256, bytes, created: false };
  }
  await rename(tmpFull, target);
  return { key, sha256, bytes, created: true };
}

/** Writes (or replaces) an id-addressed intermediate file (renders, work files). */
export async function putIntermediate(key: string, bytes: Buffer): Promise<void> {
  const target = vaultPath(key);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  await (await import("node:fs/promises")).writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, target);
}

export async function exists(key: string): Promise<boolean> {
  try {
    return (await stat(vaultPath(key))).isFile();
  } catch {
    return false;
  }
}

export async function readVault(key: string): Promise<Buffer> {
  return readFile(vaultPath(key));
}

export async function sizeOf(key: string): Promise<number | null> {
  try {
    return (await stat(vaultPath(key))).size;
  } catch {
    return null;
  }
}

/** Deletes one vault file (Storage Manager only, after its reference checks). */
export async function removeVaultFile(key: string): Promise<boolean> {
  try {
    await unlink(vaultPath(key));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Removes a whole id-addressed directory (tmp/<id>, work/<id>, renders/<jobId>). */
export async function removeVaultDir(prefix: "tmp" | "work" | "renders", id: string): Promise<void> {
  if (!/^[a-z0-9]{8,40}$/.test(id)) throw new Error("Invalid vault directory id");
  const dir = path.join(vaultRoot(), prefix, id);
  if (!dir.startsWith(vaultRoot() + path.sep)) throw new Error("Vault directory escapes the vault root");
  await rm(dir, { recursive: true, force: true });
}

export function tmpDir(id: string): string {
  if (!/^[a-z0-9]{8,40}$/.test(id)) throw new Error("Invalid vault directory id");
  return path.join(vaultRoot(), "tmp", id);
}

export function workDir(id: string): string {
  if (!/^[a-z0-9]{8,40}$/.test(id)) throw new Error("Invalid vault directory id");
  return path.join(vaultRoot(), "work", id);
}

export interface VaultEntry {
  key: string;
  bytes: number;
  mtime: Date;
}

/** Lists every file under one vault area (Storage Manager scan). Skips anything that is not a valid key. */
export async function listArea(area: "files" | "figures" | "renders" | "tmp" | "work"): Promise<VaultEntry[]> {
  const root = path.join(vaultRoot(), area);
  const out: VaultEntry[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) {
        const key = path.relative(vaultRoot(), full).split(path.sep).join("/");
        const s = await stat(full).catch(() => null);
        if (s) out.push({ key, bytes: s.size, mtime: s.mtime });
      }
    }
  }
  await walk(root, 0);
  return out;
}
