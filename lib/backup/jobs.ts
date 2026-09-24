import "server-only";
import crypto from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { BackupJobStatus, Prisma, type BackupKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PATTERNS, type BackupRoots } from "@/lib/backup/roots";
import { diskUsage, duBytes, sha256File } from "@/lib/backup/exec";
import { buildBackupPackage, estimateRequiredBytes, packageFileName, BackupPreflightError } from "@/lib/backup/package";
import { ensureManagedDirs } from "@/lib/backup/discovery";
import { resolveInsideRoot } from "@/lib/backup/safe-fs";
import { logBackupAudit } from "@/lib/backup/audit";

/**
 * Backup generation jobs.
 *
 * - One generation at a time across all PM2 workers: BackupJob.lockKey is
 *   UNIQUE and set only while RUNNING.
 * - Disk feasibility is checked BEFORE starting; insufficient space fails
 *   safely with nothing written.
 * - Work happens in <managed>/tmp/job-<id> (0700). Download-only packages are
 *   deleted right after a complete download (or expire after READY_TTL);
 *   "Save copy on VPS" moves the file into <managed>/packages.
 * - The recovery passphrase lives only in this process's memory for the
 *   duration of the build — never persisted, logged, or put in the package.
 */

const LOCK = "backup-generation";
const READY_TTL_MS = 6 * 3600_000;
const RUNNING_STALE_MS = 3 * 3600_000;

export class BackupBusyError extends Error {}

function jobDir(roots: BackupRoots, id: string) {
  return path.join(roots.tmp, `job-${id}`);
}

export async function sweepStaleJobs(roots: BackupRoots): Promise<number> {
  const now = Date.now();
  const stale = await prisma.backupJob.findMany({
    where: {
      OR: [
        { status: BackupJobStatus.RUNNING, createdAt: { lt: new Date(now - RUNNING_STALE_MS) } },
        { status: BackupJobStatus.READY, finishedAt: { lt: new Date(now - READY_TTL_MS) } },
      ],
    },
  });
  for (const j of stale) {
    await rm(jobDir(roots, j.id), { recursive: true, force: true });
    await prisma.backupJob.update({
      where: { id: j.id },
      data: j.status === BackupJobStatus.RUNNING ? { status: BackupJobStatus.FAILED, lockKey: null, error: "Interrupted (process restarted or timed out)", finishedAt: new Date() } : { status: BackupJobStatus.EXPIRED },
    });
  }
  return stale.length;
}

export async function startBackupJob(opts: {
  kind: BackupKind;
  adminId: string | undefined;
  passphrase?: string;
  saveOnVps: boolean;
  roots: BackupRoots;
  databaseUrl?: string;
  envFile?: string;
  /** Tests await completion; the admin UI runs it in the background. */
  wait?: boolean;
}): Promise<{ jobId: string; done: Promise<void> }> {
  const { roots } = opts;
  await ensureManagedDirs(roots);
  await sweepStaleJobs(roots);
  if (opts.kind === "FULL" && (!opts.passphrase || opts.passphrase.length < 12))
    throw new BackupPreflightError("Enter a Backup Recovery Passphrase of at least 12 characters.");

  const [need, disk] = await Promise.all([estimateRequiredBytes(opts.kind, roots), diskUsage(roots.tmp)]);
  if (!disk) throw new BackupPreflightError("Could not measure free disk space — not starting.");
  if (disk.avail < need)
    throw new BackupPreflightError(`Not enough free disk space for a safe backup (need ~${Math.ceil(need / 1048576)} MB, available ${Math.floor(disk.avail / 1048576)} MB). Nothing was started.`);

  let job;
  try {
    job = await prisma.backupJob.create({ data: { kind: opts.kind, lockKey: LOCK, saveOnVps: opts.saveOnVps, createdByAdminId: opts.adminId } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new BackupBusyError("Another backup is being generated right now. Try again when it finishes.");
    throw e;
  }
  const ws = jobDir(roots, job.id);
  const fileName = packageFileName(opts.kind, new Date(), crypto.randomBytes(3).toString("hex"));

  const done = (async () => {
    try {
      await mkdir(ws, { recursive: true, mode: 0o700 });
      const { file, manifest } = await buildBackupPackage({
        kind: opts.kind,
        roots,
        workspace: ws,
        fileName,
        passphrase: opts.passphrase,
        databaseUrl: opts.databaseUrl,
        envFile: opts.envFile,
      });
      await rm(path.join(ws, "stage"), { recursive: true, force: true });
      await rm(path.join(ws, "gnupg"), { recursive: true, force: true });
      const size = (await stat(file)).size;
      const sha = await sha256File(file);
      let status: BackupJobStatus = BackupJobStatus.READY;
      if (opts.saveOnVps) {
        await rename(file, path.join(roots.packages, fileName));
        await rm(ws, { recursive: true, force: true });
        status = BackupJobStatus.SAVED;
      }
      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status,
          lockKey: null,
          fileName,
          sizeBytes: BigInt(size),
          sha256: sha,
          finishedAt: new Date(),
          summary: {
            gitSha: manifest.app.gitSha,
            latestMigration: manifest.database.latestMigration,
            tables: manifest.database.tableCount,
            components: manifest.components.map((c) => c.path),
            componentBytes: manifest.components.map((c) => ({ path: c.path, kind: c.kind, bytes: c.bytes })),
            secretsIncluded: manifest.secrets.included,
            excludedTableData: manifest.database.excludedTableData,
            assetFiles: manifest.persistentAssets.reduce((s, a) => s + a.fileCount, 0),
          },
        },
      });
      await logBackupAudit(opts.adminId, "BACKUP_CREATED", "BackupJob", job.id, { kind: opts.kind, sizeBytes: size, sha256: sha, savedOnVps: opts.saveOnVps });
    } catch (e) {
      await rm(ws, { recursive: true, force: true }).catch(() => undefined);
      const message = e instanceof BackupPreflightError ? e.message : `Backup failed: ${e instanceof Error ? e.message.slice(0, 300) : "unknown error"}`;
      await prisma.backupJob.update({ where: { id: job.id }, data: { status: BackupJobStatus.FAILED, lockKey: null, error: message, finishedAt: new Date() } });
      await logBackupAudit(opts.adminId, "BACKUP_FAILED", "BackupJob", job.id, { kind: opts.kind });
    }
  })();
  if (opts.wait) await done;
  else done.catch(() => undefined);
  return { jobId: job.id, done };
}

/** Resolves a READY job's package for download (never a client path). */
export async function openJobPackage(roots: BackupRoots, jobId: string): Promise<{ file: string; fileName: string; size: number; saveOnVps: boolean } | null> {
  const job = await prisma.backupJob.findUnique({ where: { id: jobId } });
  if (!job || !job.fileName) return null;
  if (job.status === BackupJobStatus.READY) {
    const dir = await resolveInsideRoot(roots.tmp, `job-${job.id}`, { pattern: PATTERNS.jobDir, expect: "dir" }).catch(() => null);
    if (!dir) return null;
    const file = await resolveInsideRoot(dir, job.fileName, { pattern: PATTERNS.package, expect: "file" }).catch(() => null);
    return file ? { file, fileName: job.fileName, size: (await stat(file)).size, saveOnVps: false } : null;
  }
  return null;
}

/** Called when a download stream completed fully: download-only packages are removed from the VPS. */
export async function completeJobDownload(roots: BackupRoots, jobId: string, adminId: string | undefined): Promise<void> {
  const job = await prisma.backupJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== BackupJobStatus.READY) return;
  const dir = jobDir(roots, job.id);
  const freed = (await duBytes(dir)) ?? 0;
  await rm(dir, { recursive: true, force: true });
  await prisma.backupJob.update({ where: { id: job.id }, data: { status: BackupJobStatus.DOWNLOADED, downloadedAt: new Date(), deletedAt: new Date(), storageFreed: BigInt(freed) } });
  await logBackupAudit(adminId, "BACKUP_DOWNLOADED", "BackupJob", job.id, { kind: job.kind, removedFromVps: true });
}

export interface TempEntry {
  name: string;
  sizeBytes: number;
  ageMs: number;
  active: boolean;
  stale: boolean;
}

/** Recognized temp workspaces only (job-<id>); anything else in tmp is ignored, never deleted. */
export async function listTemp(roots: BackupRoots): Promise<TempEntry[]> {
  await ensureManagedDirs(roots);
  const running = new Set((await prisma.backupJob.findMany({ where: { status: { in: [BackupJobStatus.RUNNING, BackupJobStatus.READY] } }, select: { id: true, status: true, finishedAt: true } })).map((j) => `job-${j.id}`));
  const out: TempEntry[] = [];
  for (const e of await readdir(roots.tmp, { withFileTypes: true }).catch(() => [])) {
    if (!PATTERNS.jobDir.test(e.name)) continue;
    const st = await lstat(path.join(roots.tmp, e.name)).catch(() => null);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
    const ageMs = Date.now() - st.mtimeMs;
    const active = running.has(e.name);
    out.push({ name: e.name, sizeBytes: (await duBytes(path.join(roots.tmp, e.name))) ?? 0, ageMs, active, stale: !active && ageMs > 60 * 60_000 });
  }
  return out;
}

export async function cleanTemp(roots: BackupRoots): Promise<{ removed: number; bytes: number }> {
  await sweepStaleJobs(roots);
  let removed = 0;
  let bytes = 0;
  for (const t of await listTemp(roots)) {
    if (!t.stale) continue;
    const dir = await resolveInsideRoot(roots.tmp, t.name, { pattern: PATTERNS.jobDir, expect: "dir" });
    await rm(dir, { recursive: true, force: true });
    removed++;
    bytes += t.sizeBytes;
  }
  return { removed, bytes };
}
