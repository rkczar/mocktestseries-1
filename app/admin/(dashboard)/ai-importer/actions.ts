"use server";

import { revalidatePath } from "next/cache";
import { AiImportPaperType } from "@prisma/client";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ImportJobError, cancelJob, confirmJob, createJob, discardUpload, pauseJob, removeFile, requestAnalysis, resetJob, resumeJob, type RemovedFile, type ResetCheck } from "@/lib/ai-import/jobs";
import {
  allowDuplicate,
  approveQuestions,
  editQuestion,
  extendRetention,
  rejectQuestions,
  reprocessQuestions,
  requestImport,
  restoreQuestion,
  revalidateQuestions,
  setAnswer,
  setFigure,
  setTaxonomy,
  type QuestionEdit,
} from "@/lib/ai-import/review";
import { saveImporterSettings } from "@/lib/ai-import/settings";
import { normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { importerModelCatalog, importerSettingsProblems } from "@/lib/ai-import/models";
import { refreshRoutes } from "@/lib/ai-import/routes";
import type { ImporterCatalog } from "@/lib/ai-import/model-options";
import { CLEANUP_CATEGORIES, executeCleanup, findCandidates, findDuplicates, scanStorage, type CleanupCategory, type CleanupItem, type CleanupResult, type StorageReport } from "@/lib/ai-import/storage";
import type { ImportMode } from "@/lib/ai-import/adapter";

/**
 * AI Question Importer Server Actions. USE (upload, process, review, import,
 * publish) and MANAGE (settings, budgets, privacy, retention, cleanup) are
 * MASTER_ADMIN permissions, enforced in every action; FULL_ADMIN can only view.
 */

export type ImporterResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function requireUse(): Promise<string | null> {
  try {
    return (await requirePermission(PERMISSIONS.AI_IMPORTER_USE)).user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

async function requireView(): Promise<string | null> {
  try {
    return (await requirePermission(PERMISSIONS.AI_IMPORTER_VIEW)).user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

async function requireManage(): Promise<string | null> {
  try {
    return (await requirePermission(PERMISSIONS.AI_IMPORTER_MANAGE)).user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/** Publishing also needs the Question Bank publish right. */
async function requirePublish(): Promise<string | null> {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    return (await requirePermission(PERMISSIONS.AI_IMPORTER_USE)).user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

async function run<T>(actorId: string | null, fn: (actorId: string) => Promise<T>, paths: string[] = ["/admin/ai-importer"]): Promise<ImporterResult<T>> {
  if (!actorId) return { ok: false, error: "You do not have permission for this AI Question Importer action." };
  try {
    const data = await fn(actorId);
    for (const p of paths) revalidatePath(p, "layout");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ImportJobError) return { ok: false, error: error.message };
    console.error("[ai-importer]", error instanceof Error ? error.message.slice(0, 200) : "error");
    return { ok: false, error: "Something went wrong. Nothing was changed." };
  }
}

const paperType = (v: unknown): AiImportPaperType => (v === "SINGLE_SUBJECT" ? AiImportPaperType.SINGLE_SUBJECT : v === "MIXED" ? AiImportPaperType.MIXED : AiImportPaperType.FULL_PAPER);
const yearOf = (v: unknown) => (typeof v === "string" && /^\d{4}$/.test(v) ? Number(v) : typeof v === "number" ? v : null);

export interface JobFormInput {
  title: string;
  examId: string;
  paperType: string;
  subjectId: string | null;
  year: string | number | null;
  paperCode: string | null;
  previousYearPaperId: string | null;
  budgetInr: number;
}

export async function createJobAction(input: JobFormInput): Promise<ImporterResult<{ jobId: string }>> {
  return run(await requireUse(), async (actorId) => ({
    jobId: await createJob({ actorId, title: input.title, examId: input.examId, paperType: paperType(input.paperType), subjectId: input.subjectId || null, year: yearOf(input.year), paperCode: input.paperCode, previousYearPaperId: input.previousYearPaperId || null, budgetInr: Number(input.budgetInr) }),
  }));
}

export async function analyzeJobAction(jobId: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await requestAnalysis(jobId, actorId);
    return null;
  });
}

export async function confirmJobAction(jobId: string, input: JobFormInput): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await confirmJob({ jobId, actorId, examId: input.examId, paperType: paperType(input.paperType), subjectId: input.subjectId || null, year: yearOf(input.year), paperCode: input.paperCode, previousYearPaperId: input.previousYearPaperId || null, budgetInr: Number(input.budgetInr) });
    return null;
  });
}

export async function pauseJobAction(jobId: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await pauseJob(jobId, actorId);
    return null;
  });
}

export async function resumeJobAction(jobId: string, budgetInr: number | null): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await resumeJob(jobId, actorId, budgetInr);
    return null;
  });
}

export async function cancelJobAction(jobId: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await cancelJob(jobId, actorId);
    return null;
  });
}

export async function discardUploadAction(fileId: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await discardUpload(fileId, actorId);
    return null;
  });
}

/** Removes one uploaded paper or answer key from a job that has not started processing (re-checked on the server). */
export async function removeFileAction(jobId: string, fileId: string): Promise<ImporterResult<RemovedFile>> {
  return run(await requireUse(), async (actorId) => {
    if (typeof jobId !== "string" || typeof fileId !== "string" || !jobId || !fileId) throw new ImportJobError("Select a file to remove.");
    return removeFile({ jobId, fileId, actorId });
  });
}

/** Returns a processed job that produced nothing to Uploading (every server-side check must pass; typed confirmation). */
export async function resetJobAction(jobId: string, confirmation: string): Promise<ImporterResult<{ checks: ResetCheck[] }>> {
  return run(await requireManage(), async (actorId) => {
    if (typeof jobId !== "string" || !jobId) throw new ImportJobError("Select an import.");
    if (confirmation !== "RESET") throw new ImportJobError("Type RESET to confirm.");
    return resetJob({ jobId, actorId });
  });
}

async function jobOf(questionIds: string[]): Promise<string | null> {
  const q = questionIds.length ? await prisma.aiImportQuestion.findUnique({ where: { id: questionIds[0] }, select: { jobId: true } }) : null;
  return q?.jobId ?? null;
}

export async function editQuestionAction(questionId: string, edit: QuestionEdit): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await editQuestion(questionId, actorId, edit);
    const jobId = await jobOf([questionId]);
    if (jobId) await revalidateQuestions(jobId, [questionId]);
    return null;
  });
}

export async function approveQuestionsAction(ids: string[]): Promise<ImporterResult<{ approved: number }>> {
  return run(await requireUse(), async (actorId) => {
    const approved = await approveQuestions(ids.slice(0, 2000), actorId);
    const jobId = await jobOf(ids);
    if (jobId) await revalidateQuestions(jobId, ids);
    return { approved };
  });
}

export async function rejectQuestionsAction(ids: string[], reason: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await rejectQuestions(ids.slice(0, 2000), actorId, reason);
    return null;
  });
}

export async function restoreQuestionAction(id: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await restoreQuestion(id, actorId);
    const jobId = await jobOf([id]);
    if (jobId) await revalidateQuestions(jobId, [id]);
    return null;
  });
}

export async function setAnswerAction(id: string, labels: string[]): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await setAnswer(id, actorId, labels);
    const jobId = await jobOf([id]);
    if (jobId) await revalidateQuestions(jobId, [id]);
    return null;
  });
}

export async function setTaxonomyAction(id: string, subjectId: string, topicId: string | null): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await setTaxonomy(id, actorId, subjectId, topicId);
    const jobId = await jobOf([id]);
    if (jobId) await revalidateQuestions(jobId, [id]);
    return null;
  });
}

export async function setFigureAction(figureId: string, owner: "STEM" | "OPTION" | "REMOVE", optionLabel: string | null): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    const f = await prisma.aiImportFigure.findUnique({ where: { id: figureId }, select: { questionId: true, jobId: true } });
    await setFigure(figureId, actorId, owner, optionLabel);
    if (f?.questionId) await revalidateQuestions(f.jobId, [f.questionId]);
    return null;
  });
}

export async function allowDuplicateAction(id: string, allow: boolean): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await allowDuplicate(id, actorId, allow);
    const jobId = await jobOf([id]);
    if (jobId) await revalidateQuestions(jobId, [id]);
    return null;
  });
}

export async function reprocessQuestionsAction(ids: string[]): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await reprocessQuestions(ids.slice(0, 500), actorId);
    return null;
  });
}

export async function importAction(jobId: string, mode: ImportMode, questionIds: string[] | null): Promise<ImporterResult<null>> {
  const actor = mode === "DRAFT" ? await requireUse() : await requirePublish();
  return run(actor, async (actorId) => {
    await requestImport(jobId, actorId, mode, questionIds ? questionIds.slice(0, 5000) : null);
    return null;
  });
}

export async function extendRetentionAction(fileId: string, days: number): Promise<ImporterResult<null>> {
  return run(await requireManage(), async (actorId) => {
    await extendRetention(fileId, actorId, days);
    return null;
  });
}

export async function saveSettingsAction(next: ImporterSettings): Promise<ImporterResult<ImporterSettings>> {
  return run(await requireManage(), async (actorId) => {
    const normalized = normalizeImporterSettings(next);
    // Unsupported, unapproved or unpriced model IDs are refused (never saved and never silently cleared).
    const problems = await importerSettingsProblems(next, normalized);
    if (problems.length) throw new ImportJobError(`Not saved. ${problems.join(" ")}`);
    return saveImporterSettings(normalized, actorId);
  });
}

/**
 * Re-reads the model catalog, provider status, prices and the automatic choice for Import Settings
 * (read-only; no OpenRouter call). `draft` = the unsaved form values the choice is shown for.
 */
export async function importerModelsAction(draft?: ImporterSettings): Promise<ImporterResult<ImporterCatalog>> {
  return run(await requireView(), async () => importerModelCatalog(draft ? normalizeImporterSettings(draft) : undefined), []);
}

/** Reads every candidate model's provider routes and the ZDR route list from OpenRouter (free, public endpoints; no AI request). */
export async function refreshRoutesAction(draft?: ImporterSettings): Promise<ImporterResult<ImporterCatalog>> {
  return run(
    await requireManage(),
    async () => {
      await refreshRoutes();
      return importerModelCatalog(draft ? normalizeImporterSettings(draft) : undefined);
    },
    []
  );
}

export async function scanStorageAction(): Promise<ImporterResult<StorageReport>> {
  return run(await requireManage(), async () => scanStorage(), []);
}

export async function previewCleanupAction(categories: CleanupCategory[]): Promise<ImporterResult<{ items: CleanupItem[]; bytes: number }>> {
  return run(
    await requireManage(),
    async () => {
      const valid = categories.filter((c) => c in CLEANUP_CATEGORIES);
      const items = (await findCandidates()).filter((i) => valid.includes(i.category));
      return { items: items.slice(0, 5000), bytes: items.reduce((a, i) => a + i.bytes, 0) };
    },
    []
  );
}

export async function executeCleanupAction(categories: CleanupCategory[], keys: string[], confirmation: string): Promise<ImporterResult<CleanupResult>> {
  return run(await requireManage(), async (actorId) => {
    if (confirmation !== "DELETE") throw new ImportJobError('Type DELETE to confirm the cleanup.');
    const valid = categories.filter((c) => c in CLEANUP_CATEGORIES);
    if (!valid.length || !keys.length) throw new ImportJobError("Nothing selected.");
    return executeCleanup({ actorId, categories: valid, keys: keys.slice(0, 20_000) });
  });
}

export async function findDuplicatesAction(): Promise<ImporterResult<Awaited<ReturnType<typeof findDuplicates>>>> {
  return run(await requireManage(), async () => findDuplicates(), []);
}
