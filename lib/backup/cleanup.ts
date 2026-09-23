import "server-only";
import type { Artifact } from "@/lib/backup/discovery";

/**
 * Backup retention plan ("Clean Old Backups"). Pure — the UI previews exactly
 * this plan and the executor recomputes it server-side (never trusting the
 * browser's list) before deleting.
 *
 * KEEP (protected): the newest VERIFIED database backup (nightly dump or DB
 * package) and the newest VERIFIED Full Disaster Recovery package.
 * CANDIDATES: other recognized, deletable, VERIFIED artifacts.
 * NEVER auto-selected: unknown files, legacy/unverified/corrupt artifacts,
 * read-only roots, the uploads mirror.
 */

export interface BackupCleanupPlan {
  keep: Artifact[];
  candidates: Artifact[];
  manualOnly: Artifact[];
  reclaimableBytes: number;
  protectedIds: string[];
}

export function planBackupCleanup(artifacts: Artifact[]): BackupCleanupPlan {
  const verified = (a: Artifact) => a.verification === "VALID";
  const byNewest = (a: Artifact, b: Artifact) => b.mtime.getTime() - a.mtime.getTime();
  const newestDb = artifacts.filter((a) => verified(a) && (a.category === "Database Backup" || a.category === "Database Package")).sort(byNewest)[0];
  const newestFull = artifacts.filter((a) => verified(a) && a.category === "Disaster Recovery Backup").sort(byNewest)[0];
  const keep = [newestDb, newestFull].filter((a): a is Artifact => Boolean(a));
  const protectedIds = new Set(keep.map((a) => a.id));
  const candidates = artifacts.filter((a) => a.deletable && a.recognized && verified(a) && !protectedIds.has(a.id));
  const manualOnly = artifacts.filter((a) => !protectedIds.has(a.id) && !candidates.includes(a));
  return {
    keep,
    candidates,
    manualOnly,
    reclaimableBytes: candidates.reduce((s, a) => s + a.sizeBytes, 0),
    protectedIds: [...protectedIds],
  };
}
