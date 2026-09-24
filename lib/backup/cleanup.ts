import "server-only";
import type { Artifact } from "@/lib/backup/discovery";
import { RETENTION_DEFAULTS, type RetentionSettings } from "@/lib/backup/settings";

/**
 * Backup retention plan ("Clean Old Backups"). Pure — the UI previews exactly
 * this plan and the executor recomputes it server-side (never trusting the
 * browser's list) before deleting.
 *
 * KEEP (protected): the newest N VERIFIED backups of each retention class —
 * Database (nightly dump or DB package), Full Disaster Recovery, Clean
 * Portable — N from the retention settings (default 1 each).
 * CANDIDATES: other recognized, deletable, VERIFIED artifacts of those classes.
 * NEVER auto-selected: unknown files, uploaded files, legacy/unverified/
 * corrupt artifacts, read-only roots, the uploads mirror.
 */

export type RetentionClass = "DB" | "FULL" | "CLEAN";

export function retentionClass(a: Pick<Artifact, "category">): RetentionClass | null {
  if (a.category === "Database Backup" || a.category === "Database Package") return "DB";
  if (a.category === "Disaster Recovery Backup") return "FULL";
  if (a.category === "Clean Portable Backup") return "CLEAN";
  return null;
}

export interface BackupCleanupPlan {
  keep: Artifact[];
  candidates: Artifact[];
  manualOnly: Artifact[];
  reclaimableBytes: number;
  protectedIds: string[];
}

type Keep = Pick<RetentionSettings, "dbBackupsToKeep" | "fullBackupsToKeep" | "cleanBackupsToKeep">;

export function planBackupCleanup(artifacts: Artifact[], settings: Keep = RETENTION_DEFAULTS): BackupCleanupPlan {
  const verified = (a: Artifact) => a.verification === "VALID";
  const byNewest = (a: Artifact, b: Artifact) => b.mtime.getTime() - a.mtime.getTime();
  const counts: Record<RetentionClass, number> = { DB: settings.dbBackupsToKeep, FULL: settings.fullBackupsToKeep, CLEAN: settings.cleanBackupsToKeep };
  const keep: Artifact[] = [];
  for (const cls of ["DB", "FULL", "CLEAN"] as const) {
    keep.push(...artifacts.filter((a) => verified(a) && retentionClass(a) === cls).sort(byNewest).slice(0, Math.max(1, counts[cls])));
  }
  const protectedIds = new Set(keep.map((a) => a.id));
  const candidates = artifacts.filter((a) => a.deletable && a.recognized && verified(a) && retentionClass(a) !== null && !protectedIds.has(a.id));
  const candidateIds = new Set(candidates.map((c) => c.id));
  const manualOnly = artifacts.filter((a) => !protectedIds.has(a.id) && !candidateIds.has(a.id));
  return {
    keep,
    candidates,
    manualOnly,
    reclaimableBytes: candidates.reduce((s, a) => s + a.sizeBytes, 0),
    protectedIds: [...protectedIds],
  };
}
