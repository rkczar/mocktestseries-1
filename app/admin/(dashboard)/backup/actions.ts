"use server";

import { revalidatePath } from "next/cache";
import argon2 from "argon2";
import { BackupJobStatus, type BackupKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { BackupBusyError, cleanTemp, startBackupJob, sweepStaleJobs } from "@/lib/backup/jobs";
import { BackupPreflightError } from "@/lib/backup/package";
import { ArtifactNotFoundError, deleteArtifact, listArtifacts, resolveArtifact, verifyArtifact } from "@/lib/backup/discovery";
import { planBackupCleanup } from "@/lib/backup/cleanup";
import { deleteRelease, invalidateReleaseSizes, listReleases, planReleaseCleanup, ReleaseProtectedError } from "@/lib/backup/releases";
import { invalidateStorage } from "@/lib/backup/storage";
import { rehearseRestore, restoreProduction, RestoreRefusedError, type RehearsalReport } from "@/lib/backup/restore";
import { UnsafePathError } from "@/lib/backup/safe-fs";
import { logBackupAudit } from "@/lib/backup/audit";
import type { VerifyReport } from "@/lib/backup/verify";

/**
 * Backup Center Server Actions. Every one requires BACKUP_MANAGE
 * (MASTER_ADMIN only) — FULL_ADMIN (BACKUP_VIEW) gets FORBIDDEN here even if
 * it calls the action directly. The browser only sends opaque ids; paths are
 * resolved server-side against allowlisted roots. Destructive operations and
 * FULL backups additionally re-verify the admin's password. Passphrases and
 * passwords are never logged, stored, or echoed back.
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
  if (e instanceof UnauthorizedError) return { ok: false, error: "Forbidden — only Master Admin can perform Backup operations." };
  if (e instanceof BackupPreflightError || e instanceof BackupBusyError || e instanceof ArtifactNotFoundError || e instanceof ReleaseProtectedError || e instanceof RestoreRefusedError || e instanceof UnsafePathError)
    return { ok: false, error: e.message };
  return { ok: false, error: "The operation failed. Nothing further was changed." };
}

function refresh() {
  invalidateStorage();
  revalidatePath("/admin/backup");
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
    const report = await verifyArtifact(roots, id, passphrase || undefined);
    const { artifact } = await resolveArtifact(roots, id);
    await logBackupAudit(session.user.id, "BACKUP_VERIFIED", "BackupArtifact", id, { name: artifact.name, status: report.status, passphraseChecked: Boolean(passphrase) });
    refresh();
    return { ok: true, data: report };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteArtifactAction(input: { id: string; confirm: string; password?: string }): Promise<ActionResult<{ freed: number }>> {
  try {
    const session = await manage();
    const artifacts = await listArtifacts(roots);
    const a = artifacts.find((x) => x.id === input.id);
    if (!a) return { ok: false, error: "Backup not found." };
    const plan = planBackupCleanup(artifacts);
    if (plan.protectedIds.includes(a.id)) return { ok: false, error: "This is the protected latest verified backup of its type. Create a newer verified backup first." };
    const large = a.sizeBytes > 50 * 1024 * 1024 || a.verification === "VALID";
    if (large && input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const r = await deleteArtifact(roots, input.id, new Set(plan.protectedIds));
    await logBackupAudit(session.user.id, "BACKUP_DELETED", "BackupArtifact", input.id, { name: r.name, category: a.category, bytes: r.bytes, verification: a.verification });
    refresh();
    return { ok: true, message: `Deleted ${r.name}.`, data: { freed: r.bytes } };
  } catch (e) {
    return fail(e);
  }
}

export async function cleanupBackupsAction(input: { previewIds: string[]; confirm: string; password?: string }): Promise<ActionResult<{ freed: number; deleted: number; remaining: number; remainingBytes: number }>> {
  try {
    const session = await manage();
    if (input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    // Recompute server-side; delete only what is BOTH still a candidate AND was in the preview the admin saw.
    const plan = planBackupCleanup(await listArtifacts(roots));
    const previewed = new Set(input.previewIds);
    const protectedIds = new Set(plan.protectedIds);
    let freed = 0;
    let deleted = 0;
    for (const c of plan.candidates.filter((c) => previewed.has(c.id))) {
      const r = await deleteArtifact(roots, c.id, protectedIds);
      freed += r.bytes;
      deleted++;
    }
    const after = await listArtifacts(roots);
    const remainingBytes = after.reduce((s, a) => s + a.sizeBytes, 0);
    await logBackupAudit(session.user.id, "BACKUP_BULK_CLEANUP", "BackupArtifact", null, { deleted, freedBytes: freed, kept: plan.keep.map((k) => k.name) });
    refresh();
    return { ok: true, message: `Deleted ${deleted} backup(s).`, data: { freed, deleted, remaining: after.length, remainingBytes } };
  } catch (e) {
    return fail(e);
  }
}

export async function cleanTempAction(): Promise<ActionResult<{ removed: number; bytes: number }>> {
  try {
    const session = await manage();
    const r = await cleanTemp(roots);
    await logBackupAudit(session.user.id, "BACKUP_TEMP_CLEANUP", "BackupJob", null, r);
    refresh();
    return { ok: true, message: `Removed ${r.removed} stale temp workspace(s).`, data: r };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export async function deleteReleaseAction(input: { id: string; confirm: string; password?: string }): Promise<ActionResult<{ freed: number }>> {
  try {
    const session = await manage();
    if (input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const r = await deleteRelease(roots, input.id);
    await logBackupAudit(session.user.id, "RELEASE_DELETED", "Release", r.sha, { bytes: r.bytes });
    refresh();
    return { ok: true, message: `Deleted release ${r.sha.slice(0, 10)}.`, data: { freed: r.bytes } };
  } catch (e) {
    return fail(e);
  }
}

export async function cleanupReleasesAction(input: { previewIds: string[]; keepExtra: number; confirm: string; password?: string }): Promise<ActionResult<{ freed: number; deleted: number; remainingBytes: number }>> {
  try {
    const session = await manage();
    if (input.confirm !== "DELETE") return { ok: false, error: "Type DELETE to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const { releases } = await listReleases(roots, { forceSizes: true });
    const plan = planReleaseCleanup(releases, Math.max(0, Math.min(20, Math.floor(input.keepExtra || 0))));
    const previewed = new Set(input.previewIds);
    let freed = 0;
    let deleted = 0;
    for (const r of plan.candidates.filter((c) => previewed.has(c.id))) {
      const d = await deleteRelease(roots, r.id);
      freed += d.bytes;
      deleted++;
    }
    invalidateReleaseSizes();
    const after = await listReleases(roots, { forceSizes: true });
    const remainingBytes = after.releases.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
    await logBackupAudit(session.user.id, "RELEASE_BULK_CLEANUP", "Release", null, { deleted, freedBytes: freed, currentSha: after.currentSha });
    refresh();
    return { ok: true, message: `Deleted ${deleted} old release(s).`, data: { freed, deleted, remainingBytes } };
  } catch (e) {
    return fail(e);
  }
}

export async function rescanAction(): Promise<ActionResult> {
  try {
    await manage();
    invalidateReleaseSizes();
    await sweepStaleJobs(roots);
    refresh();
    return { ok: true, message: "Rescanned." };
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
    if (input.confirm !== "RESTORE PRODUCTION") return { ok: false, error: "Type RESTORE PRODUCTION to confirm." };
    if (!(await reauth(session.user.id, input.password))) return { ok: false, error: "Your admin password is incorrect." };
    const { artifact, file } = await resolveArtifact(roots, input.id);
    if (artifact.kind !== "PACKAGE") return { ok: false, error: "Production restore needs a verified Backup Center package (.tar)." };
    const r = await restoreProduction({ file, roots, passphrase: input.passphrase || undefined, adminId: session.user.id });
    refresh();
    return { ok: true, data: { ok: r.ok, checks: r.checks, safetyDump: r.safetyDump ? r.safetyDump.split("/").pop()! : null } };
  } catch (e) {
    return fail(e);
  }
}
