import "server-only";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import type { BackupRoots } from "@/lib/backup/roots";
import { diskUsage, duBytes, run } from "@/lib/backup/exec";
import type { Artifact } from "@/lib/backup/discovery";
import { measureReleaseSizes, type Release, type ReleaseSizes } from "@/lib/backup/releases";
import { retentionClass } from "@/lib/backup/cleanup";

/**
 * Canonical Storage Analysis service — the ONE place VPS storage is measured
 * (Backup Center, Admin Dashboard and System → Storage all read it).
 *
 * Two layers, so nothing expensive ever runs inside a page render or a
 * destructive request:
 *  1. SNAPSHOT — `du` over fixed, known directories (never a client path),
 *     each bounded by a timeout, persisted to <managed>/storage-snapshot.json
 *     so every PM2 worker shares it. Rebuilt only by an explicit Refresh
 *     Storage, or in the background when older than SNAPSHOT_TTL_MS.
 *  2. LIVE VIEW — `df` (instant), the release/backup listings (readdir+stat)
 *     and pg_database_size, combined with the snapshot. Deleting a release or
 *     backup therefore shows up immediately (the row disappears and `df`
 *     drops) without re-running `du`.
 *
 * "Other / unclassified" is the remainder of `df` used after every measured
 * category — never an estimate presented as a measurement.
 */

export const SNAPSHOT_TTL_MS = 15 * 60_000;
const SCAN_TIMEOUT_MS = 90_000;

export interface SourceBreakdown {
  path: string;
  bytes: number;
  files: number;
}

export interface StorageSnapshot {
  version: 2;
  scannedAt: string;
  durationMs: number;
  releaseSizes: Record<string, ReleaseSizes>;
  /** Tracked files of the production commit (git ls-tree blob sizes). */
  source: { sha: string | null; bytes: number | null; files: number; breakdown: SourceBreakdown[] };
  workingCopy: { total: number | null; nodeModules: number | null; next: number | null; git: number | null };
  uploads: { key: string; label: string; bytes: number | null }[];
  uploadsMirror: number | null;
  postgresDataDir: number | null;
  backupTemp: number | null;
  npmCache: number | null;
  systemTmp: number | null;
  logs: { system: number | null; pm2: number | null };
  osPackages: number | null;
  home: number | null;
  errors: string[];
}

export interface StorageScanPaths {
  home: string;
  npmCache: string;
  pm2Logs: string;
  systemLogs: string;
  systemTmp: string;
  osPackages: string;
  postgresData: string;
  diskMount: string;
}

export const PRODUCTION_SCAN_PATHS: StorageScanPaths = {
  home: os.homedir(),
  npmCache: path.join(os.homedir(), ".npm"),
  pm2Logs: path.join(os.homedir(), ".pm2", "logs"),
  systemLogs: "/var/log",
  systemTmp: "/tmp",
  osPackages: "/usr",
  postgresData: "/var/lib/postgresql",
  diskMount: "/",
};

let memo: { file: string; value: StorageSnapshot } | null = null;
const inflight = new Map<string, Promise<StorageSnapshot>>();

function snapshotFile(roots: BackupRoots) {
  return path.join(roots.managed, "storage-snapshot.json");
}

export async function readStorageSnapshot(roots: BackupRoots): Promise<StorageSnapshot | null> {
  const file = snapshotFile(roots);
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as StorageSnapshot;
    if (value.version !== 2) return null;
    memo = { file, value };
    return value;
  } catch {
    return memo?.file === file ? memo.value : null;
  }
}

export function snapshotAgeMs(s: StorageSnapshot | null): number {
  return s ? Date.now() - new Date(s.scannedAt).getTime() : Number.POSITIVE_INFINITY;
}

/** Sizes of the tracked files in one commit, grouped by top-level path. */
export async function measureActualSource(repo: string, sha: string | null): Promise<StorageSnapshot["source"]> {
  const ref = sha && /^[0-9a-f]{40}$/.test(sha) ? sha : "HEAD";
  let r = await run("git", ["-C", repo, "ls-tree", "-r", "-l", ref], { timeoutMs: 30_000, maxStdout: 64 * 1024 * 1024 }).catch(() => null);
  let usedSha = sha;
  if ((!r || r.code !== 0) && ref !== "HEAD") {
    r = await run("git", ["-C", repo, "ls-tree", "-r", "-l", "HEAD"], { timeoutMs: 30_000, maxStdout: 64 * 1024 * 1024 }).catch(() => null);
    usedSha = null;
  }
  if (!r || r.code !== 0) return { sha: usedSha, bytes: null, files: 0, breakdown: [] };
  const groups = new Map<string, SourceBreakdown>();
  let bytes = 0;
  let files = 0;
  for (const line of r.stdout.split("\n")) {
    // "<mode> blob <sha>    <size>\t<path>"
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    if (meta[1] !== "blob") continue;
    const size = Number.parseInt(meta[3] ?? "", 10);
    if (!Number.isFinite(size)) continue;
    const p = line.slice(tab + 1);
    const top = p.includes("/") ? `${p.split("/")[0]}/` : "(root files)";
    const g = groups.get(top) ?? { path: top, bytes: 0, files: 0 };
    g.bytes += size;
    g.files++;
    groups.set(top, g);
    bytes += size;
    files++;
  }
  return { sha: usedSha, bytes, files, breakdown: [...groups.values()].sort((a, b) => b.bytes - a.bytes) };
}

async function scan(roots: BackupRoots, paths: StorageScanPaths): Promise<StorageSnapshot> {
  const started = Date.now();
  const errors: string[] = [];
  const du = async (label: string, p: string) => {
    const v = await duBytes(p, SCAN_TIMEOUT_MS);
    if (v == null) errors.push(`${label}: not measurable`);
    return v;
  };
  const currentSha = await realpath(roots.currentLink).then((p) => path.basename(p)).catch(() => null);
  const [releaseSizes, source, wcTotal, wcNm, wcNext, wcGit, uploads, mirror, pgData, backupTemp, npmCache, sysTmp, sysLogs, pm2Logs, osPkgs, home] = await Promise.all([
    measureReleaseSizes(roots.releases, SCAN_TIMEOUT_MS),
    measureActualSource(roots.repo, currentSha),
    du("Working copy", roots.repo),
    du("Working copy node_modules", path.join(roots.repo, "node_modules")),
    du("Working copy .next", path.join(roots.repo, ".next")),
    du("Working copy .git", path.join(roots.repo, ".git")),
    Promise.all(roots.persistent.map(async (p) => ({ key: p.key, label: p.label, bytes: await du(p.label, p.dir) }))),
    du("Uploads mirror", roots.uploadsMirror),
    du("PostgreSQL data directory", paths.postgresData),
    du("Backup temp", roots.tmp),
    du("npm cache", paths.npmCache),
    du("System /tmp", paths.systemTmp),
    du("System logs", paths.systemLogs),
    du("PM2 logs", paths.pm2Logs),
    du("OS packages", paths.osPackages),
    du("Home directory", paths.home),
  ]);
  return {
    version: 2,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    releaseSizes: Object.fromEntries(releaseSizes),
    source,
    workingCopy: { total: wcTotal, nodeModules: wcNm, next: wcNext, git: wcGit },
    uploads,
    uploadsMirror: mirror,
    postgresDataDir: pgData,
    backupTemp,
    npmCache,
    systemTmp: sysTmp,
    logs: { system: sysLogs, pm2: pm2Logs },
    osPackages: osPkgs,
    home,
    errors,
  };
}

/** Rebuilds the snapshot (single-flight per process) and persists it atomically for every worker. */
export function refreshStorageSnapshot(roots: BackupRoots, paths: StorageScanPaths = PRODUCTION_SCAN_PATHS): Promise<StorageSnapshot> {
  const file = snapshotFile(roots);
  const existing = inflight.get(file);
  if (existing) return existing;
  const p = (async () => {
    const value = await scan(roots, paths);
    await mkdir(roots.managed, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, file);
    memo = { file, value };
    return value;
  })().finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

/**
 * Returns the current snapshot without blocking on a scan: a stale/missing
 * snapshot starts a background refresh, and the caller waits at most `waitMs`
 * for it (0 = never wait). Never throws.
 */
export async function getStorageSnapshot(roots: BackupRoots, opts: { waitMs?: number; paths?: StorageScanPaths } = {}): Promise<StorageSnapshot | null> {
  const current = await readStorageSnapshot(roots);
  if (current && snapshotAgeMs(current) < SNAPSHOT_TTL_MS) return current;
  const refresh = refreshStorageSnapshot(roots, opts.paths).catch(() => null);
  if (!opts.waitMs) return current;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.waitMs));
  return (await Promise.race([refresh, timeout])) ?? current;
}

export function releaseSizeMap(s: StorageSnapshot | null): Map<string, ReleaseSizes> | null {
  return s ? new Map(Object.entries(s.releaseSizes)) : null;
}

// ---------------------------------------------------------------------------
// Live view
// ---------------------------------------------------------------------------

export interface StorageRow {
  key: string;
  label: string;
  bytes: number | null;
  note?: string;
  children?: StorageRow[];
}

export type StorageHealth = "HEALTHY" | "WARNING" | "CRITICAL" | "UNKNOWN";

export interface StorageView {
  snapshotAt: Date | null;
  snapshotAgeMs: number;
  scanErrors: string[];
  disk: { total: number; used: number; avail: number; usedPct: number } | null;
  health: StorageHealth;
  actualSource: StorageSnapshot["source"] | null;
  releases: { current: number | null; rollback: number; old: number; other: number; all: number; reclaimable: number; unmeasured: number };
  backups: { db: number; full: number; clean: number; other: number; mirror: number | null; total: number; reclaimable: number };
  databaseLogical: number | null;
  nextBuild: number | null;
  dependencies: number | null;
  /** Non-overlapping partition of disk "used". */
  partition: StorageRow[];
  largest: { label: string; bytes: number; pctOfUsed: number } | null;
  insights: string[];
}

const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const allKnown = (xs: (number | null | undefined)[]) => xs.every((x) => x != null);

/** Health from `df`: CRITICAL ≥ 90% used or < 2 GB free; WARNING ≥ 75% used or < 5 GB free. Never triggers deletion. */
export function storageHealth(disk: { used: number; total: number; avail: number } | null): StorageHealth {
  if (!disk || !disk.total) return "UNKNOWN";
  const pct = disk.used / disk.total;
  if (pct >= 0.9 || disk.avail < 2 * 1024 ** 3) return "CRITICAL";
  if (pct >= 0.75 || disk.avail < 5 * 1024 ** 3) return "WARNING";
  return "HEALTHY";
}

export async function buildStorageView(
  roots: BackupRoots,
  input: { snapshot: StorageSnapshot | null; releases: Release[]; artifacts: Artifact[]; releaseReclaimable: number; backupReclaimable: number; paths?: StorageScanPaths }
): Promise<StorageView> {
  const s = input.snapshot;
  const paths = input.paths ?? PRODUCTION_SCAN_PATHS;
  const [df, dbLogical] = await Promise.all([
    diskUsage(paths.diskMount),
    prisma.$queryRaw<{ s: bigint }[]>`SELECT pg_database_size(current_database()) AS s`.then((r) => Number(r[0].s)).catch(() => null),
  ]);
  const disk = df ? { ...df, usedPct: df.total ? (df.used / df.total) * 100 : 0 } : null;

  const rel = input.releases;
  const bySt = (st: Release["status"][]) => rel.filter((r) => st.includes(r.status));
  const current = bySt(["CURRENT"]);
  const releases = {
    current: current.length && allKnown(current.map((r) => r.sizeBytes)) ? sum(current.map((r) => r.sizeBytes)) : current.length ? null : 0,
    rollback: sum(bySt(["ROLLBACK"]).map((r) => r.sizeBytes)),
    old: sum(bySt(["ELIGIBLE"]).map((r) => r.sizeBytes)),
    other: sum(bySt(["IN_PROGRESS", "UNRECOGNIZED"]).map((r) => r.sizeBytes)),
    all: sum(rel.map((r) => r.sizeBytes)),
    reclaimable: input.releaseReclaimable,
    unmeasured: rel.filter((r) => r.sizeBytes == null).length,
  };

  const arts = input.artifacts;
  const bk = (pred: (a: Artifact) => boolean) => sum(arts.filter(pred).map((a) => a.sizeBytes));
  const backups = {
    db: bk((a) => retentionClass(a) === "DB" || a.kind === "LEGACY_SQL"),
    full: bk((a) => retentionClass(a) === "FULL"),
    clean: bk((a) => retentionClass(a) === "CLEAN"),
    other: bk((a) => a.kind !== "MIRROR" && a.kind !== "LEGACY_SQL" && retentionClass(a) === null),
    mirror: s?.uploadsMirror ?? null,
    total: 0,
    reclaimable: input.backupReclaimable,
  };
  backups.total = backups.db + backups.full + backups.clean + backups.other + (backups.mirror ?? 0);

  const wc = s?.workingCopy;
  const wcSource = wc && allKnown([wc.total, wc.nodeModules, wc.next, wc.git]) ? Math.max(0, wc.total! - wc.nodeModules! - wc.next! - wc.git!) : null;
  const relDeps = sum(rel.map((r) => r.depsBytes));
  const relBuild = sum(rel.map((r) => r.buildBytes));
  const nextBuild = s ? sum([wc?.next, relBuild]) : null;
  const dependencies = s ? sum([wc?.nodeModules, relDeps]) : null;

  // Home directory minus the parts of it counted elsewhere (npm cache, PM2 logs, legacy DB backups).
  const inHome = (p: string) => p.startsWith(paths.home.replace(/\/$/, "") + "/");
  const legacyBytes = roots.legacyDb.some(inHome) ? sum(arts.filter((a) => a.rootKey === "legacy").map((a) => a.sizeBytes)) : 0;
  const homeTooling = s && s.home != null ? Math.max(0, s.home - (inHome(paths.npmCache) ? (s.npmCache ?? 0) : 0) - (inHome(paths.pm2Logs) ? (s.logs.pm2 ?? 0) : 0) - legacyBytes) : null;

  const partition: StorageRow[] = [
    {
      key: "releases",
      label: "Production releases (all)",
      bytes: releases.all,
      note: "Each release is a full copy: source + node_modules + .next build",
      children: [
        { key: "rel-current", label: "Current release", bytes: releases.current },
        { key: "rel-rollback", label: "Protected rollback release(s)", bytes: releases.rollback },
        { key: "rel-old", label: "Old releases (cleanup eligible)", bytes: releases.old },
        ...(releases.other ? [{ key: "rel-other", label: "Active / unknown release dirs", bytes: releases.other }] : []),
      ],
    },
    {
      key: "working-copy",
      label: "Git working copy (/var/www/mocktestseries)",
      bytes: wc?.total ?? null,
      note: "Editing + build checkout; not served in production",
      children: [
        { key: "wc-source", label: "Source & config files", bytes: wcSource },
        { key: "wc-next", label: ".next build output", bytes: wc?.next ?? null },
        { key: "wc-deps", label: "node_modules", bytes: wc?.nodeModules ?? null },
        { key: "wc-git", label: ".git history", bytes: wc?.git ?? null },
      ],
    },
    { key: "database", label: "Database (PostgreSQL data directory)", bytes: s?.postgresDataDir ?? null, note: dbLogical != null ? `Live database itself: ${fmtBytes(dbLogical)} (pg_database_size)` : undefined },
    {
      key: "backups",
      label: "Backups",
      bytes: backups.total,
      children: [
        { key: "bk-db", label: "Database backups", bytes: backups.db },
        { key: "bk-full", label: "Full disaster recovery backups", bytes: backups.full },
        { key: "bk-clean", label: "Clean portable backups", bytes: backups.clean },
        ...(backups.other ? [{ key: "bk-other", label: "Uploaded / unknown backup files", bytes: backups.other }] : []),
        { key: "bk-mirror", label: "Uploads mirror (nightly)", bytes: backups.mirror },
      ],
    },
    { key: "uploads", label: "Persistent uploads", bytes: s ? sum(s.uploads.map((u) => u.bytes)) : null, children: s?.uploads.map((u) => ({ key: `up-${u.key}`, label: u.label, bytes: u.bytes })) },
    {
      key: "cache",
      label: "Cache / temp",
      bytes: s ? sum([s.backupTemp, s.npmCache, s.systemTmp]) : null,
      children: [
        { key: "c-backup", label: "Backup job temp workspaces", bytes: s?.backupTemp ?? null, note: "Stale ones removable with Clean Safe Temp Files" },
        { key: "c-npm", label: "npm download cache (~/.npm)", bytes: s?.npmCache ?? null, note: "Regenerable; not cleaned from here" },
        { key: "c-tmp", label: "System /tmp", bytes: s?.systemTmp ?? null, note: "Shared by the OS; not cleaned from here" },
      ],
    },
    {
      key: "logs",
      label: "Logs",
      bytes: s ? sum([s.logs.system, s.logs.pm2]) : null,
      children: [
        { key: "l-sys", label: "System, nginx & app logs (/var/log)", bytes: s?.logs.system ?? null },
        { key: "l-pm2", label: "PM2 logs", bytes: s?.logs.pm2 ?? null },
      ],
    },
    { key: "os", label: "OS & system packages (/usr)", bytes: s?.osPackages ?? null, note: "Not application-managed" },
    { key: "tooling", label: "Server tooling in home directory", bytes: homeTooling, note: "Developer/AI tools, browser engines, language runtimes — not application data" },
  ];
  const measured = sum(partition.map((r) => r.bytes));
  partition.push({
    key: "other",
    label: "Other / unclassified",
    bytes: disk && s ? Math.max(0, disk.used - measured) : null,
    note: "Remainder of disk used (kernel, /var/lib, /var/cache, /etc, swap, filesystem overhead) — not browsed or cleaned",
  });

  const ranked = partition.filter((r) => r.bytes != null && r.bytes > 0).sort((a, b) => b.bytes! - a.bytes!);
  const top = ranked[0];
  const largest = top && disk ? { label: top.label, bytes: top.bytes!, pctOfUsed: (top.bytes! / disk.used) * 100 } : null;

  const insights: string[] = [];
  if (disk && s) {
    if (largest) insights.push(`Largest storage consumer: ${largest.label} — ${fmtBytes(largest.bytes)} (${largest.pctOfUsed.toFixed(0)}% of used disk).`);
    const appKeys = new Set(["releases", "working-copy", "database", "backups", "uploads"]);
    const app = sum(partition.filter((r) => appKeys.has(r.key)).map((r) => r.bytes));
    if (app > 0 && releases.all > 0) insights.push(`Production releases account for ${((releases.all / app) * 100).toFixed(0)}% of application storage (${fmtBytes(releases.all)} of ${fmtBytes(app)}).`);
    const hist = releases.rollback + releases.old;
    if (app > 0 && hist > 0) insights.push(`Historical releases (rollback + old) account for ${((hist / app) * 100).toFixed(0)}% of application storage.`);
    if (s.source.bytes != null && releases.current) insights.push(`The actual application source is ${fmtBytes(s.source.bytes)}; one production release is ${fmtBytes(releases.current)} because it also carries node_modules and the .next build.`);
    if (backups.db + backups.full + backups.clean > 0 && disk.used > 0) insights.push(`All backups together use ${((backups.total / disk.used) * 100).toFixed(1)}% of used disk.`);
  }

  return {
    snapshotAt: s ? new Date(s.scannedAt) : null,
    snapshotAgeMs: snapshotAgeMs(s),
    scanErrors: s?.errors ?? [],
    disk,
    health: storageHealth(disk),
    actualSource: s?.source ?? null,
    releases,
    backups,
    databaseLogical: dbLogical,
    nextBuild,
    dependencies,
    partition,
    largest,
    insights,
  };
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 10 ? 0 : 1)} ${units[i]}`;
}
