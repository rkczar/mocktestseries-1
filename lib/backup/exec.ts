import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";

/**
 * Process helpers for backup tooling (pg_dump, pg_restore, tar, gpg, du, df,
 * git). Always argv arrays — never a shell string — and database credentials
 * travel only through PG* environment variables, never argv (so they can't
 * show up in `ps`). Error messages returned upward are truncated stderr with
 * the database password scrubbed.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Env = Record<string, string | undefined>;

export function pgEnv(databaseUrl = process.env.DATABASE_URL ?? ""): Env {
  const u = new URL(databaseUrl);
  return {
    PATH: process.env.PATH,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    PGCONNECT_TIMEOUT: "10",
  };
}

export function databaseNameFromUrl(databaseUrl = process.env.DATABASE_URL ?? ""): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
}

function scrub(s: string): string {
  const pw = (() => {
    try {
      return decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").password);
    } catch {
      return "";
    }
  })();
  const out = pw ? s.split(pw).join("****") : s;
  return out.slice(-2000);
}

export function run(
  cmd: string,
  args: string[],
  opts: { env?: Env; cwd?: string; stdoutFile?: NodeJS.WritableStream; stdin?: string | Buffer; fd3?: string; maxStdout?: number; timeoutMs?: number } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdio: ("ignore" | "pipe")[] = [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"];
    if (opts.fd3 !== undefined) stdio.push("pipe");
    const child: ChildProcess = spawn(cmd, args, { env: (opts.env ?? { PATH: process.env.PATH }) as NodeJS.ProcessEnv, cwd: opts.cwd, stdio });
    let stdout = "";
    let stderr = "";
    const max = opts.maxStdout ?? 4 * 1024 * 1024;
    if (opts.stdoutFile) child.stdout!.pipe(opts.stdoutFile);
    else child.stdout!.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString();
    });
    if (opts.fd3 !== undefined) {
      const s = child.stdio[3] as NodeJS.WritableStream;
      s.end(opts.fd3);
    }
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr: scrub(stderr) });
    });
  });
}

export async function runOk(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return r;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export async function duBytes(target: string, timeoutMs = 120_000): Promise<number | null> {
  const r = await run("du", ["-sb", target], { timeoutMs }).catch(() => null);
  if (!r || r.code !== 0) {
    // du exits 1 on partial permission errors but still prints a total.
    const n = Number.parseInt((r?.stdout ?? "").split("\t")[0] ?? "", 10);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number.parseInt(r.stdout.split("\t")[0] ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/** One du pass over a directory's immediate children: name → bytes. */
export async function duChildren(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const r = await run("du", ["-b", "--max-depth=1", root]).catch(() => null);
  if (!r) return out;
  for (const line of r.stdout.split("\n")) {
    const [n, p] = line.split("\t");
    if (!p || p === root) continue;
    const bytes = Number.parseInt(n, 10);
    if (Number.isFinite(bytes)) out.set(p.slice(root.length + 1), bytes);
  }
  return out;
}

export async function diskUsage(target: string): Promise<{ total: number; used: number; avail: number } | null> {
  const r = await run("df", ["-B1", "--output=size,used,avail", target]).catch(() => null);
  if (!r || r.code !== 0) return null;
  const last = r.stdout.trim().split("\n").pop() ?? "";
  const [t, u, a] = last.trim().split(/\s+/).map((x) => Number.parseInt(x, 10));
  return [t, u, a].every(Number.isFinite) ? { total: t, used: u, avail: a } : null;
}
