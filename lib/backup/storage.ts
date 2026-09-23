import "server-only";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type { BackupRoots } from "@/lib/backup/roots";
import { diskUsage, duBytes } from "@/lib/backup/exec";
import type { Artifact } from "@/lib/backup/discovery";
import type { Release } from "@/lib/backup/releases";

/**
 * Real VPS storage breakdown, built only from fixed, known locations (df for
 * the disk, du for application-owned dirs, pg_database_size for the live
 * DB). "Other" is the remainder of used disk — OS, packages, toolchains and
 * caches outside the application — reported as a number, never browsed.
 */

export interface StorageBreakdown {
  scannedAt: Date;
  disk: { total: number; used: number; avail: number } | null;
  rows: { key: string; label: string; bytes: number | null; group: "BACKUP" | "RELEASE" | "APPLICATION" | "OTHER"; note?: string }[];
}

let cache: { at: number; value: StorageBreakdown } | null = null;
const TTL_MS = 10 * 60_000;

export function invalidateStorage() {
  cache = null;
}

export async function getStorageBreakdown(roots: BackupRoots, artifacts: Artifact[], releases: Release[], force = false): Promise<StorageBreakdown> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const [disk, repo, tmp, logsApp, logsPm2, logsNginx, dbSize, ...persistent] = await Promise.all([
    diskUsage("/"),
    duBytes(roots.repo),
    duBytes(roots.tmp),
    duBytes("/var/log/mocktestseries"),
    duBytes(path.join(os.homedir(), ".pm2", "logs")),
    duBytes("/var/log/nginx"),
    prisma.$queryRaw<{ s: bigint }[]>`SELECT pg_database_size(current_database()) AS s`.then((r) => Number(r[0].s)).catch(() => null),
    ...roots.persistent.map((p) => duBytes(p.dir)),
  ]);
  const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  const dbBackups = sum(artifacts.filter((a) => a.kind === "DB_DUMP" || a.kind === "LEGACY_SQL" || a.category === "Database Package").map((a) => a.sizeBytes));
  const drBackups = sum(artifacts.filter((a) => a.kind === "PACKAGE" && a.category !== "Database Package").map((a) => a.sizeBytes));
  const mirror = sum(artifacts.filter((a) => a.kind === "MIRROR").map((a) => a.sizeBytes));
  const current = sum(releases.filter((r) => r.status === "CURRENT").map((r) => r.sizeBytes));
  const rollback = sum(releases.filter((r) => r.status === "ROLLBACK").map((r) => r.sizeBytes));
  const old = sum(releases.filter((r) => r.status !== "CURRENT" && r.status !== "ROLLBACK").map((r) => r.sizeBytes));
  const logs = sum([logsApp, logsPm2, logsNginx]);
  const rows: StorageBreakdown["rows"] = [
    { key: "current", label: "Current production release", bytes: current, group: "RELEASE", note: "Source + node_modules + .next build" },
    { key: "rollback", label: "Rollback release (protected)", bytes: rollback, group: "RELEASE" },
    { key: "old", label: "Old releases (cleanup candidates)", bytes: old, group: "RELEASE" },
    { key: "db-backups", label: "Database backups", bytes: dbBackups, group: "BACKUP", note: "Nightly pg_dump + legacy dumps + DB packages" },
    { key: "dr-backups", label: "Disaster recovery / portable backups", bytes: drBackups, group: "BACKUP" },
    { key: "mirror", label: "Uploads mirror (nightly)", bytes: mirror, group: "BACKUP" },
    { key: "tmp", label: "Backup temp files", bytes: tmp, group: "BACKUP" },
    { key: "uploads", label: "Persistent uploads", bytes: sum(persistent), group: "APPLICATION" },
    { key: "database", label: "Live PostgreSQL database", bytes: dbSize, group: "APPLICATION" },
    { key: "repo", label: "Application working copy (git repo, dev deps)", bytes: repo, group: "APPLICATION" },
    { key: "logs", label: "Logs (app, PM2, nginx)", bytes: logs, group: "APPLICATION" },
  ];
  const measured = sum(rows.map((r) => r.bytes));
  rows.push({
    key: "other",
    label: "Other (OS, system packages, toolchains & caches)",
    bytes: disk ? Math.max(0, disk.used - measured) : null,
    group: "OTHER",
    note: "Not application-managed; not cleaned from here",
  });
  const value = { scannedAt: new Date(), disk, rows };
  cache = { at: Date.now(), value };
  return value;
}
