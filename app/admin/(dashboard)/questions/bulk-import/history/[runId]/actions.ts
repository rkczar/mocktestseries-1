"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdminSession, requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  SelectionError,
  executeImportRollback,
  planResolve,
  previewSelection,
  resolveProtectedQuestions,
  resolveSelection,
  type ResolvePlanRow,
  type ResolveResult,
  type RollbackResult,
  type SelectionPreview,
} from "@/lib/import-rollback";
import { ROW_FILTERS, type ImportSelection } from "@/lib/import-history-selection";

/**
 * Import History → View Import mutations. Every mutation's FIRST statement is
 * requirePermission(IMPORT_ROLLBACK_MANAGE) (MASTER_ADMIN only) — never the
 * client's role, checkbox state or ids. Ids are re-validated against the
 * run (lib/import-rollback.ts#resolveSelection) and every question is
 * re-classified inside its own transaction at execution time.
 */

const MAX_IDS = 20000;
const selectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ids"), rowIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_IDS) }),
  z.object({ kind: z.literal("all"), filter: z.enum(ROW_FILTERS), search: z.string().max(200) }),
]);
const runIdSchema = z.string().min(1).max(64);

async function scope(runId: string, selection: ImportSelection): Promise<{ error: string } | { rowIds: string[] }> {
  const r = runIdSchema.safeParse(runId);
  const s = selectionSchema.safeParse(selection);
  if (!r.success || !s.success) return { error: "Invalid request" };
  try {
    return { rowIds: await resolveSelection(r.data, s.data) };
  } catch (e) {
    if (e instanceof SelectionError) return { error: e.message };
    throw e;
  }
}

function revalidate(runId: string) {
  revalidatePath(`/admin/questions/bulk-import/history/${runId}`);
  revalidatePath("/admin/questions/bulk-import/history");
  revalidatePath("/admin/questions");
}

/** Fresh impact counts for the confirmation dialog. Read-only: any signed-in admin (FULL_ADMIN included). */
export async function previewImportSelectionAction(runId: string, selection: ImportSelection): Promise<{ error?: string; preview?: SelectionPreview }> {
  const session = await getAdminSession();
  if (!session?.user) return { error: "Not signed in" };
  const scoped = await scope(runId, selection);
  if ("error" in scoped) return { error: scoped.error };
  const preview = await previewSelection(runId, scoped.rowIds);
  if (!preview) return { error: "Import run not found" };
  return { preview };
}

/** Full dependency detail for Resolve & Remove / View Dependencies. Read-only. */
export async function planResolveAction(runId: string, selection: ImportSelection): Promise<{ error?: string; filename?: string; rows?: ResolvePlanRow[] }> {
  const session = await getAdminSession();
  if (!session?.user) return { error: "Not signed in" };
  const scoped = await scope(runId, selection);
  if ("error" in scoped) return { error: scoped.error };
  const plan = await planResolve(runId, scoped.rowIds);
  if (!plan) return { error: "Import run not found" };
  if (plan.rows.length > 500) return { error: "Resolve at most 500 questions at a time — narrow the filter or selection." };
  return plan;
}

const executeSchema = z.object({
  runId: runIdSchema,
  selection: selectionSchema,
  mode: z.enum(["ARCHIVE", "DELETE", "AUTO"]),
  confirmation: z.string().max(40),
});

/**
 * ARCHIVE: archive every non-protected selected question (confirmation "ARCHIVE").
 * DELETE / AUTO: permanently delete the SAFE ones (AUTO also archives the
 * history-referenced ones). Requires the typed confirmation "DELETE <n>",
 * where n is the server's own current count of permanently deletable
 * questions in the scope — if anything changed since the preview, the
 * numbers no longer match and nothing happens.
 */
export async function executeImportRollbackAction(input: {
  runId: string;
  selection: ImportSelection;
  mode: "ARCHIVE" | "DELETE" | "AUTO";
  confirmation: string;
}): Promise<{ error?: string; result?: RollbackResult }> {
  const session = await requirePermission(PERMISSIONS.IMPORT_ROLLBACK_MANAGE);
  const parsed = executeSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
  const actorId = session.user.id;
  if (!actorId) return { error: "Not signed in" };

  const { runId, selection, mode } = parsed.data;
  const scoped = await scope(runId, selection);
  if ("error" in scoped) return { error: scoped.error };
  const preview = await previewSelection(runId, scoped.rowIds);
  if (!preview) return { error: "Import run not found" };

  const confirmation = parsed.data.confirmation.trim().replace(/\s+/g, " ");
  if (mode === "ARCHIVE") {
    if (confirmation !== "ARCHIVE") return { error: "Confirmation missing." };
    if (preview.safeNotArchived + preview.archive === 0) return { error: "Nothing in this selection can be archived." };
  } else {
    if (preview.safe === 0 && (mode === "DELETE" || preview.archive === 0)) return { error: "Nothing in this selection can be permanently deleted." };
    if (confirmation !== `DELETE ${preview.safe}`) {
      return { error: `Type DELETE ${preview.safe} to confirm (the deletable count is re-checked on the server; re-open the dialog if it changed).` };
    }
  }

  const result = await executeImportRollback({ runId, rowIds: scoped.rowIds, actorId, mode });
  revalidate(runId);
  return { result };
}

const resolveSchema = z.object({
  runId: runIdSchema,
  selection: selectionSchema,
  detach: z.object({ mockTests: z.boolean(), pyqPaper: z.boolean(), adminCustomModules: z.boolean() }),
  then: z.enum(["NONE", "ARCHIVE", "DELETE"]),
  confirmation: z.string().max(40),
});

/**
 * Resolve & Remove for protected questions: detach only the explicitly
 * ticked links, then keep / archive / delete (delete falls back to archive
 * whenever student history exists). Requires typing "RESOLVE <n>".
 */
export async function resolveProtectedAction(input: {
  runId: string;
  selection: ImportSelection;
  detach: { mockTests: boolean; pyqPaper: boolean; adminCustomModules: boolean };
  then: "NONE" | "ARCHIVE" | "DELETE";
  confirmation: string;
}): Promise<{ error?: string; result?: ResolveResult }> {
  const session = await requirePermission(PERMISSIONS.IMPORT_ROLLBACK_MANAGE);
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
  const actorId = session.user.id;
  if (!actorId) return { error: "Not signed in" };

  const { runId, selection, detach, then } = parsed.data;
  if (!detach.mockTests && !detach.pyqPaper && !detach.adminCustomModules && then === "NONE") return { error: "Choose at least one action." };
  const scoped = await scope(runId, selection);
  if ("error" in scoped) return { error: scoped.error };
  // Only rows that are PROTECTED right now — the plain Archive / Delete flow handles the rest.
  const plan = await planResolve(runId, scoped.rowIds);
  if (!plan) return { error: "Import run not found" };
  const rowIds = plan.rows.map((r) => r.rowId);
  if (rowIds.length === 0) return { error: "No protected questions in this selection." };
  if (rowIds.length > 500) return { error: "Resolve at most 500 questions at a time." };
  if (parsed.data.confirmation.trim().replace(/\s+/g, " ") !== `RESOLVE ${rowIds.length}`) {
    return { error: `Type RESOLVE ${rowIds.length} to confirm (protected count is re-checked on the server).` };
  }

  const result = await resolveProtectedQuestions({ runId, rowIds, detach, then, actorId });
  revalidate(runId);
  return { result };
}
