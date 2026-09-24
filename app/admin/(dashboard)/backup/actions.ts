"use server";

import argon2 from "argon2";
import { BackupJobStatus, type BackupKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { BackupBusyError, startBackupJob, sweepStaleJobs } from "@/lib/backup/jobs";
import { BackupPreflightError } from "@/lib/backup/package";
import { ArtifactNotFoundError, listArtifacts, resolveArtifact, verifyArtifact } from "@/lib/backup/discovery";
import { planBackupCleanup } from "@/lib/backup/cleanup";
import { ReleaseProtectedError } from "@/lib/backup/releases";
import { refreshStorageSnapshot } from "@/lib/backup/storage";
import { MaintenanceBusyError } from "@/lib/backup/lock";
import { cleanSafeTemp, cleanupBackups, cleanupReleases, deleteOneBackup, deleteOneRelease, type MaintenanceOutcome } from "@/lib/backup/maintenance";
import { getRetentionSettings, saveRetentionSettings, type RetentionSettings } from "@/lib/backup/settings";
import { rehearseRestore, restoreProduction, RestoreRefusedError, type RehearsalReport } from "@/lib/backup/restore";
import { UnsafePathError } from "@/lib/backup/safe-fs";
import { logBackupAudit } from "@/lib/backup/audit";
import type { VerifyReport } from "@/lib/backup/verify";

/**
 * Backup Center Server Actions. Every mutation requires BACKUP_MANAGE
 * (MASTER_ADMIN only) — FULL_ADMIN (BACKUP_VIEW) gets FORBIDDEN here even if
 * it calls the action directly. The browser only sends opaque ids; paths are
 * resolved server-side against allowlisted roots. Destructive operations and
 * FULL backups additionally re-verify the admin's password. Passphrases and
 * passwords are never logged, stored, or echoed back.
 *
 * Every action returns a deterministic ActionResult and never calls
 * revalidatePath: that would make the response wait for a full re-render of
 * the Backup page. The client refreshes the (cheap) page itself after the
 * result arrives, so a successful delete can never be left "Processing…".
 */

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  message?: string;
  data?: T;
}

const roots = PRODUCTION_ROOTS;

async function manage() {
  return requirePermission(PERMISSIONS.BACKUP_MANAGE);
}

async function reauth(adminId: string | undefined, password: unknown): Promise<boolean> {
  if (!adminId || typeof password !== "string" || !password) return false;
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { passwordHash: true, isActive: true } });
  if (!admin?.isActive) return false;
  return argon2.verify(admin.passwordHash, password).catch(() => false);
}

function fail(e: unknown): ActionResult<never> {
  if (e instanceof UnauthorizedError) return { ok: false, error: "Forbidden — only Master Admin can perform this Backup operation." };
  if (
    e instanceof BackupPreflightError ||
    e instanceof BackupBusyError ||
    e instanceof MaintenanceBusyError ||
    e instanceof ArtifactNotFoundError ||
    e instanceof ReleaseProtectedError ||
    e instanceof RestoreRefusedError ||
    e instanceof UnsafePathError
  )
    return { ok: false, error: e.message };
  return { ok: false, error: "The operation failed. Refresh to see the current state before trying again." };
}

function isId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}

function idList(ids: unknown): string[] {
  return Array.isArray(ids) ? ids.filter(isId).slice(0, 500) : [];
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createBackupAction(input: { kind: BackupKind; saveOnVps: boolean; passphrase?: string; passphraseConfirm?: string; password?: string }): Promise<ActionResult<{ jobId: string }>> {
  try {
    const session = await manage();
    if (!["FULL", "CLEAN", "DATABASE"].includes(input.kind)) return { ok: false, error: "Unknown backup type." };
    if (input.kind === "FULL") {
      if (!input.passphrase || input.passphrase.length < 12) return { ok: false, error: "Backup Recovery Passphrase must be at least 12 characters." };
      if (input.passphrase !== input.passphraseConfirm) return { ok: false, error: "Passphrases don't match." };
      if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    }
    const { jobId } = await startBackupJob({ kind: input.kind, adminId: session.user.id, passphrase: input.passphrase, saveOnVps: Boolean(input.saveOnVps), roots });
    return { ok: true, data: { jobId } };
  } catch (e) {
    return fail(e);
  }
}

export async function backupJobStatusAction(jobId: string): Promise<ActionResult<{ status: BackupJobStatus; error: string | null; fileName: string | null; sizeBytes: number | null }>> {
  try {
    await manage();
    if (!/^[a-z0-9]{20,32}$/.test(jobId)) return { ok: false, error: "Invalid job." };
    const j = await prisma.backupJob.findUnique({ where: { id: jobId } });
    if (!j) return { ok: false, error: "Job not found." };
    return { ok: true, data: { status: j.status, error: j.error, fileName: j.fileName, sizeBytes: j.sizeBytes ? Number(j.sizeBytes) : null } };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Verify / delete / cleanup (backups)
// ---------------------------------------------------------------------------

export async function verifyArtifactAction(id: string, passphrase?: string): Promise<ActionResult<VerifyReport>> {
  try {
    const session = await manage();
    if (!isId(id)) return { ok: false, error: "Backup not found." };
    const report = await verifyArtifact(roots, id, passphrase || undefined);
    const { artifact } = await resolveArtifact(roots, id);
    await logBackupAudit(session.user.id, "BACKUP_VERIFIED", "BackupArtifact", id, { name: artifact.name, status: report.status, passphraseChecked: Boolean(passphrase) });
    return { ok: true, data: report };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteArtifactAction(input: { id: string; confirm: string; password?: string }): Promise<ActionResult<MaintenanceOutcome>> {
  try {
    const session = await manage();
    if (!isId(input.id)) return { ok: false, error: "Backup not found." };
    const settings = await getRetentionSettings();
    const artifacts = await listArtifacts(roots);
    const a = artifacts.find((x) => x.id === input.id);
    // Already gone (e.g. a previous attempt succeeded but its response was lost): nothing to do.
    if (!a) return { ok: true, message: "This backup no longer exists on the VPS — nothing was deleted now.", data: nothingOutcome() };
    if (planBackupCleanup(artifacts, settings).protectedIds.includes(a.id)) return { ok: false, error: "This is a protected latest verified backup of its type. Create a newer verified backup first." };
    if (input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const r = await deleteOneBackup(roots, input.id, settings, { actorId: session.user.id });
    return { ok: true, message: r.outcome === "DELETED" ? `Deleted ${r.deleted[0]?.label}.` : "This backup no longer exists — nothing was deleted now.", data: r };
  } catch (e) {
    return fail(e);
  }
}

export async function cleanupBackupsAction(input: { previewIds: string[]; confirm: string; password?: string }): Promise<ActionResult<MaintenanceOutcome>> {
  try {
    const session = await manage();
    if (input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const r = await cleanupBackups(roots, await getRetentionSettings(), { previewIds: idList(input.previewIds), actorId: session.user.id });
    return { ok: true, message: r.outcome === "DELETED" ? `Deleted ${r.deleted.length} old backup(s).` : "Nothing was eligible any more — no backups were deleted.", data: r };
  } catch (e) {
    return fail(e);
  }
}

export async function cleanTempAction(): Promise<ActionResult<MaintenanceOutcome>> {
  try {
    const session = await manage();
    const r = await cleanSafeTemp(roots, { actorId: session.user.id });
    return { ok: true, message: r.outcome === "DELETED" ? `Removed ${r.deleted[0]?.label}.` : "No stale temp workspaces — nothing to remove.", data: r };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export async function deleteReleaseAction(input: { id: string; confirm: string; password?: string }): Promise<ActionResult<MaintenanceOutcome>> {
  try {
    const session = await manage();
    if (!isId(input.id)) return { ok: false, error: "Release not found." };
    if (input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const r = await deleteOneRelease(roots, input.id, await getRetentionSettings(), { actorId: session.user.id });
    return {
      ok: true,
      message: r.outcome === "DELETED" ? `Deleted release ${r.deleted[0]?.label.slice(0, 12)}.` : "This release no longer exists — nothing was deleted now.",
      data: r,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function cleanupReleasesAction(input: { previewIds: string[]; confirm: string; password?: string }): Promise<ActionResult<MaintenanceOutcome>> {
  try {
    const session = await manage();
    if (input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const r = await cleanupReleases(roots, await getRetentionSettings(), { previewIds: idList(input.previewIds), actorId: session.user.id });
    const more = r.remaining ? ` ${r.remaining} more are still listed — run Clean Old Releases again to continue.` : "";
    return { ok: true, message: r.outcome === "DELETED" ? `Deleted ${r.deleted.length} old release(s).${more}` : `Nothing was eligible any more — no releases were deleted.${more}`, data: r };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Storage + retention
// ---------------------------------------------------------------------------

export async function refreshStorageAction(): Promise<ActionResult<{ scannedAt: string | null; durationMs: number | null; pending: boolean; errors: string[] }>> {
  try {
    await manage();
    await sweepStaleJobs(roots).catch(() => undefined);
    const scan = refreshStorageSnapshot(roots);
    scan.catch(() => undefined);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 40_000));
    const s = await Promise.race([scan, timeout]);
    if (!s) return { ok: true, message: "The storage scan is still running in the background — refresh the page in a minute.", data: { scannedAt: null, durationMs: null, pending: true, errors: [] } };
    return { ok: true, message: `Storage recalculated in ${(s.durationMs / 1000).toFixed(1)}s.`, data: { scannedAt: s.scannedAt, durationMs: s.durationMs, pending: false, errors: s.errors } };
  } catch (e) {
    return fail(e);
  }
}

export async function saveRetentionAction(input: Partial<RetentionSettings> & { password?: string }): Promise<ActionResult<RetentionSettings>> {
  try {
    const session = await manage();
    const before = await getRetentionSettings();
    // Turning automatic deletion ON is itself destructive-in-waiting: re-authenticate.
    if (input.autoCleanup === true && !before.autoCleanup && !(await reauth(session.user.id, input.password))) return { ok: false, error: "Enter your admin password to enable automatic retention cleanup." };
    const saved = await saveRetentionSettings({ ...input, password: undefined });
    await logBackupAudit(session.user.id, "RETENTION_SETTINGS_CHANGED", "BackupRetention", null, { before, after: saved });
    return { ok: true, message: "Retention settings saved.", data: saved };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export async function rehearseRestoreAction(input: { id: string; passphrase?: string }): Promise<ActionResult<RehearsalReport>> {
  try {
    const session = await manage();
    if (!isId(input.id)) return { ok: false, error: "Backup not found." };
    const { artifact, file } = await resolveArtifact(roots, input.id);
    if (artifact.kind !== "PACKAGE") return { ok: false, error: "Restore rehearsal needs a Backup Center package (.tar)." };
    const r = await rehearseRestore({ file, roots, passphrase: input.passphrase || undefined, adminId: session.user.id });
    return { ok: true, data: { ok: r.ok, checks: r.checks } };
  } catch (e) {
    return fail(e);
  }
}

export async function restoreProductionAction(input: { id: string; passphrase?: string; password?: string; confirm: string }): Promise<ActionResult<RehearsalReport & { safetyDump: string | null }>> {
  try {
    const session = await manage();
    if (!isId(input.id)) return { ok: false, error: "Backup not found." };
    if (input.confirm !== "RESTORE PRODUCTION") return { ok: false, error: "Type RESTORE PRODUCTION to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const { artifact, file } = await resolveArtifact(roots, input.id);
    if (artifact.kind !== "PACKAGE") return { ok: false, error: "Production restore needs a verified Backup Center package (.tar)." };
    const r = await restoreProduction({ file, roots, passphrase: input.passphrase || undefined, adminId: session.user.id });
    return { ok: true, data: { ok: r.ok, checks: r.checks, safetyDump: r.safetyDump ? r.safetyDump.split("/").pop()! : null } };
  } catch (e) {
    return fail(e);
  }
}

function nothingOutcome(): MaintenanceOutcome {
  return { outcome: "NOTHING", deleted: [], remaining: 0, storageBefore: null, storageAfter: null, reclaimed: null, availableAfter: null };
}
