import "server-only";
import { prisma } from "@/lib/prisma";

/** Backup Center events in the existing AuditLog. Metadata is safe facts only — never secrets, passphrases or archive contents. */
export type BackupAuditAction =
  | "BACKUP_CREATED"
  | "BACKUP_FAILED"
  | "BACKUP_VERIFIED"
  | "BACKUP_DOWNLOADED"
  | "BACKUP_DELETED"
  | "BACKUP_BULK_CLEANUP"
  | "BACKUP_UPLOADED"
  | "RELEASE_DELETED"
  | "RELEASE_BULK_CLEANUP"
  | "RESTORE_REHEARSAL"
  | "RESTORE_STARTED"
  | "RESTORE_COMPLETED"
  | "RESTORE_FAILED"
  | "BACKUP_TEMP_CLEANUP";

export const BACKUP_AUDIT_ENTITY_TYPES = ["BackupJob", "BackupArtifact", "Release", "Restore"];

export async function logBackupAudit(
  actorId: string | undefined,
  action: BackupAuditAction,
  entityType: "BackupJob" | "BackupArtifact" | "Release" | "Restore",
  entityId: string | null,
  metadata?: Record<string, unknown>
) {
  await prisma.auditLog
    .create({ data: { actorId, action, entityType, entityId, metadata: metadata ? (JSON.parse(JSON.stringify(metadata)) as object) : undefined } })
    .catch(() => undefined);
}
