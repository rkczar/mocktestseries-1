import "server-only";
import crypto from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { BackupJobStatus, Prisma, type BackupKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PATTERNS, type BackupRoots } from "@/lib/backup/roots";
import { diskUsage, duBytes, sha256File } from "@/lib/backup/exec";
import { buildBackupPackage, estimateRequiredBytes, packageFileName, BackupPreflightError } from "@/lib/backup/package";
import { ensureManagedDirs, recordPackageCheck } from "@/lib/backup/discovery";
import { verifyPackage } from "@/lib/backup/verify";
import { resolveInsideRoot } from "@/lib/backup/safe-fs";
import { logBackupAudit } from "@/lib/backup/audit";

/**
 * Backup generation jobs.
 *
 * - One generation at a time across all PM2 workers: BackupJob.lockKey is
 *   UNIQUE and set only while RUNNING.
 * - Disk feasibility is checked BEFORE starting; insufficient space fails
 *   safely with nothing written.
 * - Work happens in <managed>/tmp/job-<id> (0700). Every finished package is
 *   integrity-verified (manifest, SHA-256 of every component, pg_restore
 *   catalog, inner archives, passphrase) BEFORE it counts as a backup; one
 *   that fails verification is FAILED and is not kept.
 * - A verified package is ALWAYS stored in <managed>/packages (status SAVED).
 *   Downloading never deletes it — downloads are repeatable and resumable.
 *   Old packages are removed only by retention (Clean Old Backups / the
 *   scheduled auto-retention), which always keeps the newest verified one.
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
        backupId: job.id,
      });
      await rm(path.join(ws, "stage"), { recursive: true, force: true });
      await rm(path.join(ws, "gnupg"), { recursive: true, force: true });
      // A file that exists is not yet a backup: verify the finished package before it is kept or offered.
      const check = await verifyPackage(file, { workspace: path.join(ws, "verify"), passphrase: opts.passphrase, repo: roots.repo, release: roots.currentLink });
      if (check.status !== "VALID") throw new Error(`integrity verification failed — ${check.summary}`);
      const size = (await stat(file)).size;
      const sha = check.sha256 ?? (await sha256File(file));
      await rename(file, path.join(roots.packages, fileName));
      await rm(ws, { recursive: true, force: true });
      await recordPackageCheck(roots, fileName, { ...check, sha256: sha });
      await prisma.backupJob.update({
        where: { id: job.id },
        data: {
          status: BackupJobStatus.SAVED,
          saveOnVps: true,
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
            integrity: check.status,
            integrityDetail: check.summary.slice(0, 300),
          },
        },
      });
      await logBackupAudit(opts.adminId, "BACKUP_CREATED", "BackupJob", job.id, { kind: opts.kind, sizeBytes: size, sha256: sha, savedOnVps: true, integrity: "VALID" });
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

/** Resolves a job's stored package for download (never a client path), with the SHA-256 recorded when it was verified. */
export async function openJobPackage(roots: BackupRoots, jobId: string): Promise<{ file: string; fileName: string; size: number; saveOnVps: boolean; sha256: string | null } | null> {
  const job = await prisma.backupJob.findUnique({ where: { id: jobId } });
  if (!job || !job.fileName || job.deletedAt) return null;
  if (job.status === BackupJobStatus.SAVED || job.status === BackupJobStatus.DOWNLOADED) {
    const file = await resolveInsideRoot(roots.packages, job.fileName, { pattern: PATTERNS.package, expect: "file" }).catch(() => null);
    return file ? { file, fileName: job.fileName, size: (await stat(file)).size, saveOnVps: true, sha256: job.sha256 } : null;
  }
  // Packages built before 2026-11-08 could be download-only (tmp workspace, 6 h).
  if (job.status === BackupJobStatus.READY) {
    const dir = await resolveInsideRoot(roots.tmp, `job-${job.id}`, { pattern: PATTERNS.jobDir, expect: "dir" }).catch(() => null);
    if (!dir) return null;
    const file = await resolveInsideRoot(dir, job.fileName, { pattern: PATTERNS.package, expect: "file" }).catch(() => null);
    return file ? { file, fileName: job.fileName, size: (await stat(file)).size, saveOnVps: false, sha256: job.sha256 } : null;
  }
  return null;
}

/**
 * Called when the last byte of a download was sent. Only RECORDS it: the package stays on the VPS (the server
 * cannot know the browser saved every byte), so the same backup can be downloaded again or resumed.
 */
export async function completeJobDownload(_roots: BackupRoots, jobId: string, adminId: string | undefined): Promise<void> {
  const job = await prisma.backupJob.findUnique({ where: { id: jobId } });
  if (!job || job.deletedAt) return;
  await prisma.backupJob.update({ where: { id: job.id }, data: { downloadedAt: new Date() } });
  await logBackupAudit(adminId, "BACKUP_DOWNLOADED", "BackupJob", job.id, { kind: job.kind, removedFromVps: false });
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
