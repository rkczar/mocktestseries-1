import "server-only";
import { lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PATTERNS, type BackupRoots } from "@/lib/backup/roots";
import { opaqueId, resolveInsideRoot, UnsafePathError } from "@/lib/backup/safe-fs";
import { duChildren, run } from "@/lib/backup/exec";

/**
 * Release storage manager for /var/www/mocktestseries-releases/<sha>.
 * Deployment releases are NOT backups and are managed separately.
 *
 * Protection is always recomputed server-side at deletion time:
 *  - CURRENT: the directory /var/www/mocktestseries-current resolves to
 *    (realpath), and anything PM2's exec cwd resolves to — never deletable
 *  - ROLLBACK: the newest other successfully-built release (.next/BUILD_ID)
 *  - IN PROGRESS: modified in the last 60 minutes without a BUILD_ID
 *  - UNRECOGNIZED: any name that isn't a 40-hex SHA, symlinks, non-dirs
 */

export type ReleaseStatus = "CURRENT" | "ROLLBACK" | "IN_PROGRESS" | "ELIGIBLE" | "UNRECOGNIZED";

export interface Release {
  id: string;
  sha: string;
  mtime: Date;
  sizeBytes: number | null;
  built: boolean;
  status: ReleaseStatus;
  protected: boolean;
  reason: string;
}

let sizeCache: { at: number; root: string; sizes: Map<string, number> } | null = null;
const SIZE_TTL_MS = 10 * 60_000;

export function invalidateReleaseSizes() {
  sizeCache = null;
}

async function releaseSizes(root: string, force = false): Promise<Map<string, number>> {
  if (!force && sizeCache && sizeCache.root === root && Date.now() - sizeCache.at < SIZE_TTL_MS) return sizeCache.sizes;
  const sizes = await duChildren(root);
  sizeCache = { at: Date.now(), root, sizes };
  return sizes;
}

/** Realpaths the running PM2 app is using as cwd (best effort; empty if pm2 absent). */
async function pm2Cwds(): Promise<string[]> {
  const r = await run("pm2", ["jlist"], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxStdout: 32 * 1024 * 1024, timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  try {
    const list = JSON.parse(r.stdout) as { pm2_env?: { pm_cwd?: string } }[];
    const out: string[] = [];
    for (const p of list) if (p.pm2_env?.pm_cwd) out.push(await realpath(p.pm2_env.pm_cwd).catch(() => p.pm2_env!.pm_cwd!));
    return out;
  } catch {
    return [];
  }
}

export async function listReleases(roots: BackupRoots, opts: { forceSizes?: boolean; includePm2?: boolean } = {}): Promise<{ releases: Release[]; currentSha: string | null; rootReal: string }> {
  const rootReal = await realpath(roots.releases);
  const currentReal = await realpath(roots.currentLink).catch(() => null);
  const pm2 = opts.includePm2 === false ? [] : await pm2Cwds();
  const protectedReal = new Set([currentReal, ...pm2].filter(Boolean) as string[]);
  const sizes = await releaseSizes(rootReal, opts.forceSizes);
  const entries = await readdir(rootReal, { withFileTypes: true });
  const rows: Release[] = [];
  const now = Date.now();
  for (const e of entries) {
    const p = path.join(rootReal, e.name);
    const st = await lstat(p).catch(() => null);
    if (!st) continue;
    const recognized = st.isDirectory() && !st.isSymbolicLink() && PATTERNS.releaseDir.test(e.name);
    const built = recognized ? Boolean(await stat(path.join(p, ".next", "BUILD_ID")).catch(() => null)) : false;
    const isCurrent = protectedReal.has(p);
    let status: ReleaseStatus = "ELIGIBLE";
    let reason = "Inactive release";
    if (!recognized) {
      status = "UNRECOGNIZED";
      reason = "Not a recognized release directory — never deleted";
    } else if (isCurrent) {
      status = "CURRENT";
      reason = "Current production release — always protected";
    } else if (!built && now - st.mtimeMs < 60 * 60_000) {
      status = "IN_PROGRESS";
      reason = "Recently modified and not built yet — may be deploying";
    } else if (!built) {
      reason = "Inactive, never finished building";
    }
    rows.push({ id: opaqueId(`release:${rootReal}`, e.name), sha: e.name, mtime: st.mtime, sizeBytes: sizes.get(e.name) ?? null, built, status, protected: status !== "ELIGIBLE", reason });
  }
  // Newest successfully built non-current release = rollback safety.
  const rollback = rows
    .filter((r) => r.status === "ELIGIBLE" && r.built)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
  if (rollback) {
    rollback.status = "ROLLBACK";
    rollback.protected = true;
    rollback.reason = "Newest previous successful release — rollback safety";
  }
  rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return { releases: rows, currentSha: currentReal ? path.basename(currentReal) : null, rootReal };
}

export interface ReleaseCleanupPlan {
  protected: Release[];
  candidates: Release[];
  reclaimableBytes: number;
}

/** keepExtra: additional newest eligible releases to retain beyond current + rollback. */
export function planReleaseCleanup(releases: Release[], keepExtra = 0): ReleaseCleanupPlan {
  const eligible = releases.filter((r) => r.status === "ELIGIBLE").sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const extraKept = eligible.slice(0, Math.max(0, keepExtra));
  const candidates = eligible.slice(Math.max(0, keepExtra));
  return {
    protected: [...releases.filter((r) => r.protected), ...extraKept],
    candidates,
    reclaimableBytes: candidates.reduce((s, r) => s + (r.sizeBytes ?? 0), 0),
  };
}

export class ReleaseProtectedError extends Error {}

/**
 * Deletes one release by opaque id after recomputing protection. fs.rm with
 * recursive:true unlinks symlinks found inside (e.g. public/storage → shared
 * uploads, .env → shared .env) WITHOUT following them.
 */
export async function deleteRelease(roots: BackupRoots, id: string, opts: { includePm2?: boolean } = {}): Promise<{ sha: string; bytes: number }> {
  const { releases, rootReal } = await listReleases(roots, { includePm2: opts.includePm2 });
  const r = releases.find((x) => x.id === id);
  if (!r) throw new ReleaseProtectedError("Release not found.");
  if (r.protected || r.status !== "ELIGIBLE") throw new ReleaseProtectedError(`Refused: ${r.reason}.`);
  const dir = await resolveInsideRoot(rootReal, r.sha, { pattern: PATTERNS.releaseDir, expect: "dir" });
  // Final paranoia: never the production target, re-resolved right now.
  const currentReal = await realpath(roots.currentLink).catch(() => null);
  if (currentReal && (dir === currentReal || currentReal.startsWith(dir + path.sep))) throw new UnsafePathError("current production release");
  const bytes = r.sizeBytes ?? 0;
  await rm(dir, { recursive: true, force: false });
  sizeCache?.sizes.delete(r.sha);
  return { sha: r.sha, bytes };
}

/** Deploy log helper: the release's commit subject if the repo has it. */
export async function releaseSubject(roots: BackupRoots, sha: string): Promise<string | null> {
  if (!PATTERNS.releaseDir.test(sha)) return null;
  const r = await run("git", ["-C", roots.repo, "log", "-1", "--format=%s", sha]).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim().slice(0, 120) : null;
}

export async function readBuildId(dir: string): Promise<string | null> {
  return readFile(path.join(dir, ".next", "BUILD_ID"), "utf8").catch(() => null);
}
