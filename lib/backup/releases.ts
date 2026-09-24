import "server-only";
import { lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PATTERNS, type BackupRoots } from "@/lib/backup/roots";
import { opaqueId, resolveInsideRoot, UnsafePathError } from "@/lib/backup/safe-fs";
import { run } from "@/lib/backup/exec";
import { RETENTION_DEFAULTS } from "@/lib/backup/settings";

/**
 * Release storage manager for /var/www/mocktestseries-releases/<sha>.
 * Deployment releases are NOT backups and are managed separately.
 *
 * Retention = CURRENT + N previous successful releases (N = rollback
 * releases to keep, default 1). Protection is always recomputed server-side
 * at deletion time:
 *  - CURRENT: the directory /var/www/mocktestseries-current resolves to
 *    (realpath), and anything PM2's exec cwd resolves to — never deletable
 *    and never counted inside N
 *  - ROLLBACK: the N newest other successfully-built releases (.next/BUILD_ID)
 *  - IN_PROGRESS: modified in the last 60 minutes without a BUILD_ID
 *  - UNRECOGNIZED: any name that isn't a 40-hex SHA, symlinks, non-dirs
 *
 * Listing never runs `du`: sizes come from the storage snapshot
 * (lib/backup/storage.ts), so a delete request stays fast no matter how many
 * GB of releases exist.
 */

export type ReleaseStatus = "CURRENT" | "ROLLBACK" | "IN_PROGRESS" | "ELIGIBLE" | "UNRECOGNIZED";

export interface ReleaseSizes {
  total: number;
  deps: number | null;
  build: number | null;
}

export interface Release {
  id: string;
  sha: string;
  mtime: Date;
  sizeBytes: number | null;
  /** Release minus node_modules and .next (source, public, config, lockfile). */
  sourceBytes: number | null;
  buildBytes: number | null;
  depsBytes: number | null;
  built: boolean;
  status: ReleaseStatus;
  protected: boolean;
  reason: string;
}

export const RELEASE_STATUS_LABEL: Record<ReleaseStatus, string> = {
  CURRENT: "CURRENT — PROTECTED",
  ROLLBACK: "ROLLBACK — PROTECTED",
  IN_PROGRESS: "ACTIVE JOB — PROTECTED",
  ELIGIBLE: "OLD — CLEANUP ELIGIBLE",
  UNRECOGNIZED: "UNKNOWN — MANUAL REVIEW",
};

/** One bounded `du` pass: per-release total, node_modules and .next. */
export async function measureReleaseSizes(root: string, timeoutMs = 120_000): Promise<Map<string, ReleaseSizes>> {
  const out = new Map<string, ReleaseSizes>();
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return out;
  const r = await run("du", ["-b", "--max-depth=2", rootReal], { timeoutMs, maxStdout: 16 * 1024 * 1024 }).catch(() => null);
  if (!r) return out;
  const sub = new Map<string, { deps?: number; build?: number }>();
  for (const line of r.stdout.split("\n")) {
    const [n, p] = line.split("\t");
    if (!p || !p.startsWith(rootReal + "/")) continue;
    const bytes = Number.parseInt(n, 10);
    if (!Number.isFinite(bytes)) continue;
    const rel = p.slice(rootReal.length + 1).split("/");
    if (rel.length === 1) out.set(rel[0], { total: bytes, deps: 0, build: 0 });
    else if (rel[1] === "node_modules") sub.set(rel[0], { ...sub.get(rel[0]), deps: bytes });
    else if (rel[1] === ".next") sub.set(rel[0], { ...sub.get(rel[0]), build: bytes });
  }
  for (const [name, s] of sub) {
    const t = out.get(name);
    if (t) out.set(name, { total: t.total, deps: s.deps ?? 0, build: s.build ?? 0 });
  }
  return out;
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

export async function listReleases(
  roots: BackupRoots,
  opts: { sizes?: Map<string, ReleaseSizes> | null; includePm2?: boolean; rollbackToKeep?: number } = {}
): Promise<{ releases: Release[]; currentSha: string | null; rootReal: string }> {
  const rootReal = await realpath(roots.releases);
  const currentReal = await realpath(roots.currentLink).catch(() => null);
  const pm2 = opts.includePm2 === false ? [] : await pm2Cwds();
  const protectedReal = new Set([currentReal, ...pm2].filter(Boolean) as string[]);
  const sizes = opts.sizes ?? new Map<string, ReleaseSizes>();
  const keep = Math.max(1, Math.floor(opts.rollbackToKeep ?? RETENTION_DEFAULTS.rollbackReleasesToKeep));
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
    let reason = "Inactive older release";
    if (!recognized) {
      status = "UNRECOGNIZED";
      reason = "Not a recognized release directory — never deleted automatically";
    } else if (isCurrent) {
      status = "CURRENT";
      reason = "Current production release — always protected";
    } else if (!built && now - st.mtimeMs < 60 * 60_000) {
      status = "IN_PROGRESS";
      reason = "Recently modified and not built yet — a deploy may be in progress";
    } else if (!built) {
      reason = "Inactive, never finished building";
    }
    const s = sizes.get(e.name);
    rows.push({
      id: opaqueId(`release:${rootReal}`, e.name),
      sha: e.name,
      mtime: st.mtime,
      sizeBytes: s?.total ?? null,
      sourceBytes: s && s.deps != null && s.build != null ? Math.max(0, s.total - s.deps - s.build) : null,
      buildBytes: s?.build ?? null,
      depsBytes: s?.deps ?? null,
      built,
      status,
      protected: status !== "ELIGIBLE",
      reason,
    });
  }
  // The N newest successfully built non-current releases = rollback safety.
  const rollback = rows
    .filter((r) => r.status === "ELIGIBLE" && r.built)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, keep);
  rollback.forEach((r, i) => {
    r.status = "ROLLBACK";
    r.protected = true;
    r.reason = i === 0 ? "Latest previous successful release — rollback safety" : `Previous successful release #${i + 1} — kept by retention setting`;
  });
  rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return { releases: rows, currentSha: currentReal ? path.basename(currentReal) : null, rootReal };
}

export interface ReleaseCleanupPlan {
  protected: Release[];
  candidates: Release[];
  manualReview: Release[];
  reclaimableBytes: number;
}

/** Pure: candidates are exactly the ELIGIBLE (recognized, inactive, unprotected) releases. */
export function planReleaseCleanup(releases: Release[]): ReleaseCleanupPlan {
  const candidates = releases.filter((r) => r.status === "ELIGIBLE").sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return {
    protected: releases.filter((r) => r.status === "CURRENT" || r.status === "ROLLBACK" || r.status === "IN_PROGRESS"),
    candidates,
    manualReview: releases.filter((r) => r.status === "UNRECOGNIZED"),
    reclaimableBytes: candidates.reduce((s, r) => s + (r.sizeBytes ?? 0), 0),
  };
}

export class ReleaseProtectedError extends Error {}

export type DeleteReleaseResult = { status: "DELETED"; sha: string; bytes: number | null } | { status: "NOT_FOUND" };

/**
 * Deletes one release by opaque id after recomputing protection. An id that
 * no longer matches any release returns NOT_FOUND (idempotent: a repeated or
 * replayed delete never targets anything else — the id binds to one name).
 * fs.rm with recursive:true unlinks symlinks found inside (public/storage →
 * shared uploads, .env → shared .env) WITHOUT following them.
 */
export async function deleteRelease(
  roots: BackupRoots,
  id: string,
  opts: { includePm2?: boolean; rollbackToKeep?: number; sizes?: Map<string, ReleaseSizes> | null } = {}
): Promise<DeleteReleaseResult> {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) throw new UnsafePathError("invalid release id");
  const { releases, rootReal } = await listReleases(roots, { includePm2: opts.includePm2, rollbackToKeep: opts.rollbackToKeep, sizes: opts.sizes });
  const r = releases.find((x) => x.id === id);
  if (!r) return { status: "NOT_FOUND" };
  if (r.protected || r.status !== "ELIGIBLE") throw new ReleaseProtectedError(`Refused: ${r.reason}.`);
  const dir = await resolveInsideRoot(rootReal, r.sha, { pattern: PATTERNS.releaseDir, expect: "dir" });
  // Final paranoia: never the production target, re-resolved right now.
  const currentReal = await realpath(roots.currentLink).catch(() => null);
  if (currentReal && (dir === currentReal || currentReal.startsWith(dir + path.sep))) throw new UnsafePathError("current production release");
  await rm(dir, { recursive: true, force: false });
  return { status: "DELETED", sha: r.sha, bytes: r.sizeBytes };
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
