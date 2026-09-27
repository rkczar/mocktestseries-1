"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdminSession, requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { analyzeImportRun, executeImportRollback, type RollbackResult, type RollbackSummary } from "@/lib/import-rollback";

/** Fresh impact analysis for the confirmation dialog. Read-only: any signed-in admin (FULL_ADMIN included). */
export async function previewImportRollbackAction(
  runId: string,
  rowIds?: string[]
): Promise<{ error?: string; summary?: RollbackSummary; scope?: { total: number; safe: number; archive: number; protected: number; missing: number } }> {
  const session = await getAdminSession();
  if (!session?.user) return { error: "Not signed in" };
  const analysis = await analyzeImportRun(runId);
  if (!analysis) return { error: "Import run not found" };
  const inScope = analysis.rows.filter((r) => r.action === "CREATED" && r.classification && (!rowIds || rowIds.includes(r.rowId)));
  return {
    summary: analysis.summary,
    scope: {
      total: inScope.length,
      safe: inScope.filter((r) => r.classification === "SAFE_TO_DELETE").length,
      archive: inScope.filter((r) => r.classification === "ARCHIVE_ONLY").length,
      protected: inScope.filter((r) => r.classification === "PROTECTED").length,
      missing: inScope.filter((r) => r.classification === "ALREADY_MISSING").length,
    },
  };
}

const executeSchema = z.object({
  runId: z.string().min(1),
  rowIds: z.array(z.string().min(1)).max(20000).optional(),
  confirmation: z.literal("DELETE", { message: 'Type DELETE to confirm.' }),
});

/**
 * Deletes (or archives, when referenced) ONLY the questions this run CREATED.
 * MASTER_ADMIN-only (IMPORT_ROLLBACK_MANAGE), enforced here regardless of UI.
 * Requires the typed confirmation "DELETE". Idempotent — see
 * lib/import-rollback.ts#executeImportRollback.
 */
export async function executeImportRollbackAction(input: {
  runId: string;
  rowIds?: string[];
  confirmation: string;
}): Promise<{ error?: string; result?: RollbackResult }> {
  const session = await requirePermission(PERMISSIONS.IMPORT_ROLLBACK_MANAGE);
  const parsed = executeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };

  const actorId = session.user.id;
  if (!actorId) return { error: "Not signed in" };
  const result = await executeImportRollback({ runId: parsed.data.runId, rowIds: parsed.data.rowIds, actorId });

  revalidatePath(`/admin/questions/bulk-import/history/${parsed.data.runId}`);
  revalidatePath("/admin/questions/bulk-import/history");
  revalidatePath("/admin/questions");
  return { result };
}
