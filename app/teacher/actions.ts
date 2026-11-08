"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { QuestionFormState } from "@/app/admin/(dashboard)/questions/actions";
import { TeacherAccessError } from "@/lib/teacher/scope";
import { requireTeacher } from "@/lib/teacher/session";
import {
  createDraftQuestion,
  discardRevision,
  requestDeletion,
  requestRestore,
  requestUnpublish,
  saveQuestionEdit,
  submitForPublication,
  submitRevision,
  unpublishFromMockTest,
  withdrawRequest,
  type Result,
} from "@/lib/teacher/content";

/**
 * Teacher Portal Server Actions (Phase A). Each one re-derives the caller's
 * scope from the session (requireTeacher) and passes it to lib/teacher —
 * nothing here trusts an id, exam or status posted by the browser.
 */

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

function back(path: string, r: Result): never {
  revalidatePath("/teacher", "layout");
  const q = new URLSearchParams(r.ok ? { ok: "1" } : { err: r.error });
  redirect(`${path}?${q}`);
}

async function scopeOrLogin() {
  try {
    return await requireTeacher();
  } catch (e) {
    if (e instanceof TeacherAccessError) redirect("/admin/login");
    throw e;
  }
}

export async function createQuestionTeacherAction(_prev: QuestionFormState, formData: FormData): Promise<QuestionFormState> {
  const scope = await scopeOrLogin();
  const r = await createDraftQuestion(scope, formData);
  if (!r.ok) return { error: r.error };
  revalidatePath("/teacher", "layout");
  redirect(`/teacher/questions/${r.questionId}?ok=created`);
}

export async function saveQuestionTeacherAction(questionId: string, _prev: QuestionFormState, formData: FormData): Promise<QuestionFormState> {
  const scope = await scopeOrLogin();
  const r = await saveQuestionEdit(scope, questionId, formData);
  if (!r.ok) return { error: r.error };
  revalidatePath("/teacher", "layout");
  redirect(`/teacher/questions/${questionId}?ok=${r.outcome === "DRAFT_SAVED" ? "draft" : "revision"}`);
}

export async function submitForPublicationAction(formData: FormData) {
  const scope = await scopeOrLogin();
  const id = str(formData, "questionId");
  back(`/teacher/questions/${encodeURIComponent(id)}`, await submitForPublication(scope, id, formData.get("reason")));
}

export async function submitRevisionAction(formData: FormData) {
  const scope = await scopeOrLogin();
  const id = str(formData, "questionId");
  back(`/teacher/questions/${encodeURIComponent(id)}`, await submitRevision(scope, id, formData.get("reason")));
}

export async function discardRevisionAction(formData: FormData) {
  const scope = await scopeOrLogin();
  const id = str(formData, "questionId");
  back(`/teacher/questions/${encodeURIComponent(id)}`, await discardRevision(scope, id));
}

export async function requestDeletionAction(formData: FormData) {
  const scope = await scopeOrLogin();
  const id = str(formData, "questionId");
  back(`/teacher/questions/${encodeURIComponent(id)}`, await requestDeletion(scope, id, formData.get("reason")));
}

export async function unpublishFromMockTestAction(formData: FormData) {
  const scope = await scopeOrLogin();
  const mockTestId = str(formData, "mockTestId");
  back(`/teacher/tests/${encodeURIComponent(mockTestId)}`, await unpublishFromMockTest(scope, mockTestId, str(formData, "questionId"), formData.get("reason")));
}

export async function requestUnpublishAction(formData: FormData) {
  const scope = await scopeOrLogin();
  const questionId = str(formData, "questionId");
  const kind = str(formData, "targetKind");
  const targetId = str(formData, "targetId");
  const r = await requestUnpublish(scope, kind, targetId, questionId, formData.get("reason"));
  back(kind === "MOCK_TEST" ? `/teacher/tests/${encodeURIComponent(targetId)}` : `/teacher/questions/${encodeURIComponent(questionId)}`, r);
}

export async function requestRestoreAction(formData: FormData) {
  const scope = await scopeOrLogin();
  const mockTestId = str(formData, "mockTestId");
  back(`/teacher/tests/${encodeURIComponent(mockTestId)}`, await requestRestore(scope, mockTestId, str(formData, "questionId"), formData.get("reason")));
}

export async function withdrawRequestAction(formData: FormData) {
  const scope = await scopeOrLogin();
  back("/teacher/requests", await withdrawRequest(scope, str(formData, "requestId")));
}
