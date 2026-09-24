import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BackupJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BackupRoots } from "@/lib/backup/roots";

/**
 * One destructive Backup Center operation at a time, across every PM2 worker.
 *
 * `mkdir` of <managed>/locks/maintenance is atomic on the local filesystem, so
 * exactly one caller wins; the others get MaintenanceBusyError immediately
 * (never a queued/hanging request). A lock older than STALE_MS (a crashed
 * worker) is taken over. Deletes/cleanups also refuse while a backup is being
 * generated, so an artifact or release is never removed mid-backup.
 */

const STALE_MS = 30 * 60_000;

export class MaintenanceBusyError extends Error {}

function lockDir(roots: BackupRoots) {
  return path.join(roots.managed, "locks", "maintenance");
}

async function acquire(roots: BackupRoots, label: string): Promise<boolean> {
  const dir = lockDir(roots);
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const info = await readFile(path.join(dir, "owner.json"), "utf8").then((t) => JSON.parse(t) as { at: number }).catch(() => ({ at: 0 }));
    if (Date.now() - info.at < STALE_MS) return false;
    await rm(dir, { recursive: true, force: true });
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch {
      return false;
    }
  }
  await writeFile(path.join(dir, "owner.json"), JSON.stringify({ at: Date.now(), pid: process.pid, label }), { mode: 0o600 });
  return true;
}

export async function withMaintenanceLock<T>(roots: BackupRoots, label: string, fn: () => Promise<T>, opts: { allowDuringBackup?: boolean } = {}): Promise<T> {
  if (!opts.allowDuringBackup) {
    const running = await prisma.backupJob.count({ where: { status: BackupJobStatus.RUNNING } });
    if (running > 0) throw new MaintenanceBusyError("A backup is being generated right now — deletes and cleanups are paused until it finishes.");
  }
  if (!(await acquire(roots, label))) throw new MaintenanceBusyError("Another cleanup or delete is already running. Wait for it to finish, then refresh.");
  try {
    return await fn();
  } finally {
    await rm(lockDir(roots), { recursive: true, force: true }).catch(() => undefined);
  }
}
