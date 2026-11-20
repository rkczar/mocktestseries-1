"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  permanentlyDeleteQuestions,
  previewQuestionDelete,
  QuestionDeleteError,
  type DeletePreview,
  type DeleteResult,
  type DeleteScope,
} from "@/lib/question-permanent-delete";

/** Permanent global question delete. QUESTIONS_MANAGE here; the service re-checks MASTER_ADMIN from the DB. */
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
export type DeleteTarget = string[] | "ALL_IN_BATCH";

async function run<T>(fn: (actorId: string) => Promise<T>): Promise<Result<T>> {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    return { ok: true, data: await fn(session.user.id!) };
  } catch (err) {
    if (err instanceof QuestionDeleteError)
      return { ok: false, error: err.message };
    if (err instanceof Error && err.name === "UnauthorizedError")
      return {
        ok: false,
        error: "Only a Master Admin can permanently delete questions.",
      };
    console.error("question permanent delete failed:", err);
    return {
      ok: false,
      error:
        "Deletion failed on the server. Nothing was deleted; you can retry safely.",
    };
  }
}

export async function previewDeleteAction(
  scope: DeleteScope,
  ids: DeleteTarget,
): Promise<Result<DeletePreview>> {
  return run((actorId) => previewQuestionDelete({ actorId, scope, ids }));
}

export async function deleteQuestionsAction(
  scope: DeleteScope,
  ids: DeleteTarget,
  kind: "SINGLE" | "BATCH" | "BULK",
  operationId: string,
  typed: string,
): Promise<Result<DeleteResult>> {
  if (typed !== (kind === "BATCH" ? "DELETE BATCH" : "DELETE"))
    return { ok: false, error: "Confirmation text does not match." };
  const r = await run((actorId) =>
    permanentlyDeleteQuestions({ actorId, scope, ids, operationId, kind }),
  );
  // Counts, banks, tests and public pages all read questions: drop every cached route.
  if (r.ok) {
    revalidatePath("/", "layout");
    // unstable_cache data survives revalidatePath; same tags as question replacement.
    updateTag("exam-pyq-insights");
    updateTag("exam-pyq-analysis-meta");
    updateTag("homepage-statistics");
  }
  return r;
}
