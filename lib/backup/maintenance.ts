import "server-only";
import type { BackupRoots } from "@/lib/backup/roots";
import { diskUsage } from "@/lib/backup/exec";
import { deleteArtifact, listArtifacts } from "@/lib/backup/discovery";
import { planBackupCleanup } from "@/lib/backup/cleanup";
import { deleteRelease, listReleases, planReleaseCleanup } from "@/lib/backup/releases";
import { readStorageSnapshot, releaseSizeMap } from "@/lib/backup/storage";
import { withMaintenanceLock } from "@/lib/backup/lock";
import { cleanTemp } from "@/lib/backup/jobs";
import type { RetentionSettings } from "@/lib/backup/settings";
import { logBackupAudit } from "@/lib/backup/audit";

/**
 * Destructive Backup Center operations, shared by the admin Server Actions,
 * the (default-OFF) automatic retention runner and the verification suite.
 *
 * Every operation: runs under the cross-worker maintenance lock, recomputes
 * protection server-side, never runs `du` (sizes come from the storage
 * snapshot, reclaimed space from `df` before/after), and is time-bounded —
 * a bulk cleanup that hits its budget returns what it finished (the rest
 * stays listed for the next run) instead of holding the request open.
 */

export interface MaintenanceOutcome {
  /** DELETED: at least one item removed now. NOTHING: target(s) already gone / nothing eligible. */
  outcome: "DELETED" | "NOTHING";
  deleted: { label: string; bytes: number | null }[];
  /** Candidates left because the time budget ran out (bulk only). */
  remaining: number;
  storageBefore: number | null;
  storageAfter: number | null;
  reclaimed: number | null;
  availableAfter: number | null;
}

const BULK_BUDGET_MS = 40_000;

async function withDiskDelta(roots: BackupRoots, fn: () => Promise<Omit<MaintenanceOutcome, "storageBefore" | "storageAfter" | "reclaimed" | "availableAfter">>, mount = "/"): Promise<MaintenanceOutcome> {
  const before = await diskUsage(mount);
  const r = await fn();
  const after = await diskUsage(mount);
  return {
    ...r,
    storageBefore: before?.used ?? null,
    storageAfter: after?.used ?? null,
    reclaimed: before && after ? Math.max(0, before.used - after.used) : null,
    availableAfter: after?.avail ?? null,
  };
}

async function sizes(roots: BackupRoots) {
  return releaseSizeMap(await readStorageSnapshot(roots));
}

export async function deleteOneRelease(roots: BackupRoots, id: string, settings: RetentionSettings, opts: { includePm2?: boolean; actorId?: string } = {}): Promise<MaintenanceOutcome> {
  return withMaintenanceLock(roots, "release-delete", () =>
    withDiskDelta(roots, async () => {
      const r = await deleteRelease(roots, id, { includePm2: opts.includePm2, rollbackToKeep: settings.rollbackReleasesToKeep, sizes: await sizes(roots) });
      if (r.status === "NOT_FOUND") return { outcome: "NOTHING", deleted: [], remaining: 0 };
      await logBackupAudit(opts.actorId, "RELEASE_DELETED", "Release", r.sha, { bytes: r.bytes });
      return { outcome: "DELETED", deleted: [{ label: r.sha, bytes: r.bytes }], remaining: 0 };
    })
  );
}

/**
 * previewIds = the exact candidates the admin saw; only items that are BOTH
 * still candidates now AND were previewed are deleted. null = every current
 * candidate (automatic retention only).
 */
export async function cleanupReleases(
  roots: BackupRoots,
  settings: RetentionSettings,
  opts: { previewIds: string[] | null; includePm2?: boolean; actorId?: string; auto?: boolean; budgetMs?: number }
): Promise<MaintenanceOutcome> {
  return withMaintenanceLock(roots, "release-cleanup", () =>
    withDiskDelta(roots, async () => {
      const sz = await sizes(roots);
      const { releases } = await listReleases(roots, { includePm2: opts.includePm2, rollbackToKeep: settings.rollbackReleasesToKeep, sizes: sz });
      const plan = planReleaseCleanup(releases);
      const allowed = opts.previewIds ? new Set(opts.previewIds) : null;
      const todo = plan.candidates.filter((c) => !allowed || allowed.has(c.id));
      const deadline = Date.now() + (opts.budgetMs ?? BULK_BUDGET_MS);
      const deleted: MaintenanceOutcome["deleted"] = [];
      let remaining = 0;
      for (const c of todo) {
        if (Date.now() > deadline) {
          remaining++;
          continue;
        }
        // deleteRelease re-lists and re-checks protection for every single item.
        // A release that became protected meanwhile (e.g. a deploy) is skipped, never forced.
        const d = await deleteRelease(roots, c.id, { includePm2: opts.includePm2, rollbackToKeep: settings.rollbackReleasesToKeep, sizes: sz }).catch(() => null);
        if (d?.status === "DELETED") deleted.push({ label: d.sha, bytes: d.bytes });
      }
      if (deleted.length) {
        await logBackupAudit(opts.actorId, opts.auto ? "RETENTION_AUTO_CLEANUP" : "RELEASE_BULK_CLEANUP", "Release", null, {
          deleted: deleted.length,
          shas: deleted.map((d) => d.label),
          freedBytes: deleted.reduce((s, d) => s + (d.bytes ?? 0), 0),
          rollbackReleasesToKeep: settings.rollbackReleasesToKeep,
          remaining,
        });
      }
      return { outcome: deleted.length ? "DELETED" : "NOTHING", deleted, remaining };
    })
  );
}

export async function deleteOneBackup(roots: BackupRoots, id: string, settings: RetentionSettings, opts: { actorId?: string } = {}): Promise<MaintenanceOutcome> {
  return withMaintenanceLock(roots, "backup-delete", () =>
    withDiskDelta(roots, async () => {
      const artifacts = await listArtifacts(roots);
      const a = artifacts.find((x) => x.id === id);
      if (!a) return { outcome: "NOTHING", deleted: [], remaining: 0 };
      const plan = planBackupCleanup(artifacts, settings);
      const r = await deleteArtifact(roots, id, new Set(plan.protectedIds));
      if (r.status === "NOT_FOUND") return { outcome: "NOTHING", deleted: [], remaining: 0 };
      await logBackupAudit(opts.actorId, "BACKUP_DELETED", "BackupArtifact", id, { name: r.name, category: a.category, bytes: r.bytes, verification: a.verification });
      return { outcome: "DELETED", deleted: [{ label: r.name, bytes: r.bytes }], remaining: 0 };
    })
  );
}

export async function cleanupBackups(
  roots: BackupRoots,
  settings: RetentionSettings,
  opts: { previewIds: string[] | null; actorId?: string; auto?: boolean; budgetMs?: number }
): Promise<MaintenanceOutcome> {
  return withMaintenanceLock(roots, "backup-cleanup", () =>
    withDiskDelta(roots, async () => {
      const plan = planBackupCleanup(await listArtifacts(roots), settings);
      const allowed = opts.previewIds ? new Set(opts.previewIds) : null;
      const protectedIds = new Set(plan.protectedIds);
      const deadline = Date.now() + (opts.budgetMs ?? BULK_BUDGET_MS);
      const deleted: MaintenanceOutcome["deleted"] = [];
      let remaining = 0;
      for (const c of plan.candidates.filter((c) => !allowed || allowed.has(c.id))) {
        if (Date.now() > deadline) {
          remaining++;
          continue;
        }
        const r = await deleteArtifact(roots, c.id, protectedIds).catch(() => null);
        if (r?.status === "DELETED") deleted.push({ label: r.name, bytes: r.bytes });
      }
      if (deleted.length) {
        await logBackupAudit(opts.actorId, opts.auto ? "RETENTION_AUTO_CLEANUP" : "BACKUP_BULK_CLEANUP", "BackupArtifact", null, {
          deleted: deleted.length,
          names: deleted.map((d) => d.label),
          freedBytes: deleted.reduce((s, d) => s + (d.bytes ?? 0), 0),
          kept: plan.keep.map((k) => k.name),
          remaining,
        });
      }
      return { outcome: deleted.length ? "DELETED" : "NOTHING", deleted, remaining };
    })
  );
}

export async function cleanSafeTemp(roots: BackupRoots, opts: { actorId?: string } = {}): Promise<MaintenanceOutcome> {
  return withMaintenanceLock(roots, "temp-cleanup", () =>
    withDiskDelta(roots, async () => {
      const r = await cleanTemp(roots);
      await logBackupAudit(opts.actorId, "BACKUP_TEMP_CLEANUP", "BackupJob", null, r);
      return { outcome: r.removed ? "DELETED" : "NOTHING", deleted: r.removed ? [{ label: `${r.removed} stale temp workspace(s)`, bytes: r.bytes }] : [], remaining: 0 };
    })
  );
}

/**
 * Automatic retention (OFF by default). Deletes only what the release and
 * backup plans already classify as cleanup-eligible — never current/rollback
 * releases, protected verified backups, unknown/unverified files, uploads,
 * the database or the source repo — and audits every run that deletes.
 */
export async function runAutoRetention(roots: BackupRoots, settings: RetentionSettings, opts: { includePm2?: boolean } = {}): Promise<{ ran: boolean; releases?: MaintenanceOutcome; backups?: MaintenanceOutcome }> {
  if (!settings.autoCleanup) return { ran: false };
  const releases = await cleanupReleases(roots, settings, { previewIds: null, auto: true, includePm2: opts.includePm2 });
  const backups = await cleanupBackups(roots, settings, { previewIds: null, auto: true });
  return { ran: true, releases, backups };
}
