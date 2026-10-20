"use server";

import { revalidatePath } from "next/cache";
import { AiImportPaperType } from "@prisma/client";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ImportJobError, type ContinueResult, cancelJob, changeJobPaper, confirmJob, createJob, deleteJob, setExpectedQuestions, deleteJobPreview, discardUpload, pauseJob, recoverJob, removeFile, requestAnalysis, resetJob, resumeJob, retryJob, type DeletedJob, type JobDeletePreview, type RemovedFile, type ResetCheck } from "@/lib/ai-import/jobs";
import {
  acknowledgeSequence,
  addMissingQuestion,
  allowDuplicate,
  applyRescan,
  approveAllClean,
  approveQuestions,
  discardRescan,
  editQuestion,
  markFigureUncertain,
  markImageMissing,
  reclassifyQuestions,
  rescanQuestions,
  unapproveQuestions,
  type ApproveResult,
  type RescanScope,
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
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { settleJobStatus } from "@/lib/ai-import/summary";
import { normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { importerModelCatalog, importerSettingsProblems } from "@/lib/ai-import/models";
import { refreshRoutes } from "@/lib/ai-import/routes";
import type { ImporterCatalog } from "@/lib/ai-import/model-options";
import { AssistantApplyError, applyRecommendedModels, modelAssistant, testImporterModels } from "@/lib/ai-import/assistant";
import type { ApplyResult, AssistantResult, ModelTestReport } from "@/lib/ai-import/assistant-types";
import { AutoConfigError, applyAutoConfig, previewAutoConfig } from "@/lib/ai-import/autoconfig";
import { ReconfigureError, reconfigureJob, reconfigurePreview } from "@/lib/ai-import/reconfigure";
import type { AutoConfigApplied, AutoConfigPreview, ReconfigurePreview, ReconfigureResult } from "@/lib/ai-import/autoconfig-types";
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
/** An optional count from a form: blank / null / undefined → null; anything else is validated by expectedCount(). */
/** The confirmed maximum cost sent by the page: a finite number, or null (the server then asks for confirmation). */
const costOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const countOf = (v: unknown): number | null => (v === undefined || v === null || (typeof v === "string" && !v.trim()) ? null : typeof v === "number" ? v : Number(String(v).trim()));
const yearOf = (v: unknown) => (typeof v === "string" && /^\d{4}$/.test(v) ? Number(v) : typeof v === "number" ? v : null);

export interface JobFormInput {
  title: string;
  examId: string;
  paperType: string;
  subjectId: string | null;
  year: string | number | null;
  paperCode: string | null;
  previousYearPaperId: string | null;
  /** Confirm only: the estimated maximum cost the administrator saw and confirmed (null when no paid AI is needed). */
  confirmedMaxInr?: number | null;
  /** Idempotency key generated by the browser per upload: a repeated submission returns the same job. */
  clientKey?: string | null;
  /** The number of questions the administrator expects in the paper (confirmed again before starting). */
  expectedQuestions?: number | string | null;
  /** Independent verification: "risk" (default) or "all" pages. */
  verifyMode?: string | null;
}

export async function createJobAction(input: JobFormInput): Promise<ImporterResult<{ jobId: string }>> {
  return run(await requireUse(), async (actorId) => ({
    jobId: await createJob({ actorId, title: input.title, examId: input.examId, paperType: paperType(input.paperType), subjectId: input.subjectId || null, year: yearOf(input.year), paperCode: input.paperCode, previousYearPaperId: input.previousYearPaperId || null, clientKey: input.clientKey ?? null, expectedQuestions: countOf(input.expectedQuestions) }),
  }));
}

/**
 * The one-page importer's Start Import: confirms the analyzed job with its stored exam and Previous Year
 * Paper, the expected question count the administrator confirmed and the verification choice, then
 * processes it. The administrator confirms the displayed cost (confirmedMaxInr); every privacy, model and
 * price check of a normal confirmation applies. Nothing enters
 * the Question Bank here: questions are reviewed and approved first. A repeated click is harmless.
 */
export async function processAndImportAction(jobId: string, opts: { modelOverride?: string | null; expectedQuestions?: number | string | null; verifyMode?: string | null; confirmedMaxInr?: number | null } = {}): Promise<ImporterResult<{ alreadyStarted: boolean }>> {
  return run(await requireUse(), async (actorId) => {
    if (typeof jobId !== "string" || !jobId) throw new ImportJobError("Select an import.");
    const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
    if (!job) throw new ImportJobError("Import job not found.", 404);
    if (job.status !== "AWAITING_CONFIRMATION") {
      if (["QUEUED", "PROCESSING", "IMPORTING", "NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"].includes(job.status) && job.confirmedAt) return { alreadyStarted: true };
      throw new ImportJobError(job.status === "ANALYZING" || job.status === "DRAFT" ? "The file is still being analyzed. The button becomes available when the analysis is ready." : "This import cannot be started from its current state.");
    }
    // The Bulk Import refuses questions without a year: stop here with the reason instead of failing every question later.
    if (!job.year && !job.previousYearPaperId && !(await prisma.exam.findUnique({ where: { id: job.examId }, select: { year: true } }))?.year) {
      throw new ImportJobError("This import has no paper year and its exam has no year set, so the Question Bank would refuse every question. Nothing was started — select the Previous Year Paper (or delete this import and upload again with the paper's year).");
    }
    const expected = countOf(opts.expectedQuestions) ?? job.expectedQuestions;
    try {
      await confirmJob({ jobId, actorId, examId: job.examId, paperType: job.paperType, subjectId: job.subjectId, year: job.year, paperCode: job.paperCode, previousYearPaperId: job.previousYearPaperId, confirmedMaxInr: costOf(opts.confirmedMaxInr), autoImport: null, modelOverride: typeof opts.modelOverride === "string" && opts.modelOverride ? opts.modelOverride : null, expectedQuestions: expected, requireExpected: true, verifyMode: opts.verifyMode === "all" ? "all" : "risk" });
    } catch (e) {
      // A second click that lost the race to the first one.
      const now = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true, confirmedAt: true } });
      if (now?.confirmedAt && now.status !== "AWAITING_CONFIRMATION") return { alreadyStarted: true };
      throw e;
    }
    return { alreadyStarted: false };
  });
}

/** Explicitly changes (or removes) the Previous Year Paper of an import whose questions are not stored yet. */
export async function changeJobPaperAction(jobId: string, previousYearPaperId: string | null): Promise<ImporterResult<{ previousYearPaperId: string | null; year: number | null }>> {
  return run(await requireUse(), async (actorId) => {
    if (typeof jobId !== "string" || !jobId) throw new ImportJobError("Select an import.");
    return changeJobPaper({ jobId, actorId, previousYearPaperId: typeof previousYearPaperId === "string" && previousYearPaperId ? previousYearPaperId : null });
  });
}

export async function setExpectedQuestionsAction(jobId: string, expected: number | string | null): Promise<ImporterResult<{ expected: number | null }>> {
  return run(await requireUse(), async (actorId) => {
    const r = await setExpectedQuestions({ jobId, actorId, expected });
    await settleJobStatus(jobId);
    return { expected: r };
  });
}

/**
 * "Change model" on the one-page importer, saved only when the administrator asks: a model from the
 * importer's own list becomes the importer's manual choice for page and key reading, or null returns
 * to Automatic. Importer settings only — global AI Engine approvals and routing are never touched.
 */
export async function saveModelPreferenceAction(model: string | null): Promise<ImporterResult<{ mode: "auto" | "manual"; model: string | null }>> {
  return run(await requireManage(), async (actorId) => {
    const current = await getImporterSettings();
    if (model !== null && (typeof model !== "string" || !current.importerModels.includes(model))) throw new ImportJobError("That model is not on the importer's own model list. Nothing was saved.");
    const next: ImporterSettings = model === null ? { ...current, selection: { mode: "auto" } } : { ...current, selection: { mode: "manual" }, models: { ...current.models, extract: model, extractFallbacks: [], key: model } };
    const normalized = normalizeImporterSettings(next);
    const problems = await importerSettingsProblems(next, normalized);
    if (problems.length) throw new ImportJobError(`Not saved. ${problems.join(" ")}`);
    await saveImporterSettings(normalized, actorId);
    return { mode: normalized.selection.mode, model };
  });
}

/** Retry; `confirmedMaxInr`: the new maximum the administrator confirmed after it was shown (else the cost is returned, nothing started). */
export async function retryJobAction(jobId: string, confirmedMaxInr?: number | null): Promise<ImporterResult<ContinueResult>> {
  return run(await requireUse(), async (actorId) => retryJob(jobId, actorId, costOf(confirmedMaxInr)));
}

export async function recoverJobAction(jobId: string): Promise<ImporterResult<{ restarted: boolean; message: string }>> {
  return run(await requireUse(), async (actorId) => recoverJob(jobId, actorId));
}

export async function deleteJobPreviewAction(jobId: string): Promise<ImporterResult<JobDeletePreview | null>> {
  return run(await requireManage(), async () => deleteJobPreview(jobId), []);
}

/** Deletes an import job and its importer-only files (Master Admin; typed confirmation; audited). */
export async function deleteJobAction(jobId: string, confirmation: string): Promise<ImporterResult<DeletedJob>> {
  return run(await requireManage(), async (actorId) => {
    if (typeof jobId !== "string" || !jobId) throw new ImportJobError("Select an import.");
    if (confirmation !== "DELETE") throw new ImportJobError("Type DELETE to confirm.");
    return deleteJob({ jobId, actorId });
  });
}

export async function analyzeJobAction(jobId: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await requestAnalysis(jobId, actorId);
    return null;
  });
}

export async function confirmJobAction(jobId: string, input: JobFormInput): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await confirmJob({ jobId, actorId, examId: input.examId, paperType: paperType(input.paperType), subjectId: input.subjectId || null, year: yearOf(input.year), paperCode: input.paperCode, previousYearPaperId: input.previousYearPaperId || null, confirmedMaxInr: costOf(input.confirmedMaxInr), ...(countOf(input.expectedQuestions) !== null ? { expectedQuestions: countOf(input.expectedQuestions) } : {}), verifyMode: input.verifyMode === "all" ? "all" : "risk" });
    return null;
  });
}

export async function pauseJobAction(jobId: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await pauseJob(jobId, actorId);
    return null;
  });
}

export async function resumeJobAction(jobId: string, confirmedMaxInr?: number | null): Promise<ImporterResult<ContinueResult>> {
  return run(await requireUse(), async (actorId) => resumeJob(jobId, actorId, costOf(confirmedMaxInr)));
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

export async function approveQuestionsAction(ids: string[]): Promise<ImporterResult<ApproveResult>> {
  return run(await requireUse(), async (actorId) => {
    if (!Array.isArray(ids) || !ids.length) throw new ImportJobError("Select the questions to approve.");
    const jobId = await jobOf(ids);
    const result = await approveQuestions(ids.slice(0, 2000), actorId);
    if (jobId) await revalidateQuestions(jobId, ids);
    return result;
  });
}

export async function approveAllCleanAction(jobId: string): Promise<ImporterResult<ApproveResult>> {
  return run(await requireUse(), async (actorId) => {
    const result = await approveAllClean(jobId, actorId);
    return result;
  });
}

export async function unapproveQuestionsAction(ids: string[]): Promise<ImporterResult<{ withdrawn: number }>> {
  return run(await requireUse(), async (actorId) => {
    const withdrawn = await unapproveQuestions(ids.slice(0, 2000), actorId);
    const jobId = await jobOf(ids);
    if (jobId) await revalidateQuestions(jobId, ids);
    return { withdrawn };
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

export async function setTaxonomyAction(id: string, subjectId: string, topicId: string | null, subTopicId: string | null = null): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await setTaxonomy(id, actorId, subjectId, topicId, subTopicId || null);
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

export async function markFigureUncertainAction(figureId: string, note: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    const f = await prisma.aiImportFigure.findUnique({ where: { id: figureId }, select: { questionId: true, jobId: true } });
    await markFigureUncertain(figureId, actorId, typeof note === "string" ? note : "");
    if (f?.questionId) await revalidateQuestions(f.jobId, [f.questionId]);
    return null;
  });
}

export async function markImageMissingAction(questionId: string, owner: "STEM" | "OPTION", optionLabel: string | null, note: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await markImageMissing(questionId, actorId, owner === "OPTION" ? "OPTION" : "STEM", optionLabel, typeof note === "string" ? note : "");
    const jobId = await jobOf([questionId]);
    if (jobId) await revalidateQuestions(jobId, [questionId]);
    return null;
  });
}

export async function rescanQuestionsAction(ids: string[], scope: RescanScope): Promise<ImporterResult<{ pages: number; questions: number }>> {
  return run(await requireUse(), async (actorId) => rescanQuestions(Array.isArray(ids) ? ids.slice(0, 500) : [], scope === "page" ? "page" : "question", actorId));
}

export async function applyRescanAction(versionId: string, fields: string[]): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    const v = await prisma.aiImportQuestionVersion.findUnique({ where: { id: versionId }, select: { questionId: true, jobId: true } });
    await applyRescan(versionId, actorId, Array.isArray(fields) ? fields : []);
    if (v) await revalidateQuestions(v.jobId, [v.questionId]);
    return null;
  });
}

export async function discardRescanAction(versionId: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    const v = await prisma.aiImportQuestionVersion.findUnique({ where: { id: versionId }, select: { questionId: true, jobId: true } });
    await discardRescan(versionId, actorId);
    if (v) await revalidateQuestions(v.jobId, [v.questionId]);
    return null;
  });
}

export async function reclassifyQuestionsAction(ids: string[]): Promise<ImporterResult<{ queued: number }>> {
  return run(await requireUse(), async (actorId) => ({ queued: await reclassifyQuestions(Array.isArray(ids) ? ids.slice(0, 2000) : [], actorId) }));
}

/** Re-matches the official answer key and re-runs every deterministic check for these questions (no AI). */
export async function reverifyAnswerKeyAction(ids: string[]): Promise<ImporterResult<{ answerStatus: Record<string, number> }>> {
  return run(await requireUse(), async () => {
    const jobId = await jobOf(ids);
    if (!jobId) throw new ImportJobError("Select the questions to re-verify.");
    await revalidateQuestions(jobId, ids);
    const rows = await prisma.aiImportQuestion.findMany({ where: { id: { in: ids } }, select: { answerStatus: true } });
    const answerStatus: Record<string, number> = {};
    for (const r of rows) answerStatus[r.answerStatus] = (answerStatus[r.answerStatus] ?? 0) + 1;
    return { answerStatus };
  });
}

export async function acknowledgeSequenceAction(jobId: string, note: string): Promise<ImporterResult<null>> {
  return run(await requireUse(), async (actorId) => {
    await acknowledgeSequence(jobId, actorId, typeof note === "string" ? note : "");
    return null;
  });
}

export async function addMissingQuestionAction(input: { jobId: string; fileId: string; number: number; section: string; page: number }): Promise<ImporterResult<{ questionId: string }>> {
  return run(await requireUse(), async (actorId) => ({ questionId: await addMissingQuestion({ jobId: input.jobId, fileId: input.fileId, number: Number(input.number), section: typeof input.section === "string" ? input.section : "", page: Number(input.page), actorId }) }));
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
      const settings = draft ? normalizeImporterSettings(draft) : await getImporterSettings();
      // OpenRouter failures are recorded inside the snapshot; what throws here is the database read or write.
      try {
        await refreshRoutes(settings.importerModels);
      } catch (error) {
        console.error("[ai-importer] route refresh", error instanceof Error ? error.message.slice(0, 200) : "error");
        throw new ImportJobError("The provider routes could not be saved (database error), so the previous route data is unchanged.");
      }
      return importerModelCatalog(settings);
    },
    []
  );
}

/**
 * Model Assistant: recommendations per purpose for the SAVED settings. Deterministic and catalog-based —
 * no AI request and no network call (AI reasoning for recommendations is not approved).
 */
export async function findBestModelsAction(): Promise<ImporterResult<AssistantResult>> {
  return run(await requireView(), async () => modelAssistant(await getImporterSettings()), []);
}

/** Model Assistant: configuration checks of the importer's listed models (no AI request, no network call). */
export async function testModelsAction(): Promise<ImporterResult<ModelTestReport>> {
  return run(await requireView(), async () => testImporterModels(await getImporterSettings()), []);
}

/**
 * Model Assistant: adds the confirmed recommended models to the importer's OWN list (never a global
 * approval), then re-reads the provider routes and re-validates route, price, privacy and budget.
 */
export async function applyRecommendedModelsAction(add: string[], expectedList: string[]): Promise<ImporterResult<ApplyResult>> {
  return run(
    await requireManage(),
    async (actorId) => {
      try {
        return await applyRecommendedModels({ settings: await getImporterSettings(), add: Array.isArray(add) ? add.filter((x) => typeof x === "string").slice(0, 50) : [], expectedList: Array.isArray(expectedList) ? expectedList.filter((x) => typeof x === "string") : [], actorId });
      } catch (error) {
        if (error instanceof AssistantApplyError) throw new ImportJobError(error.message);
        throw error;
      }
    },
    ["/admin/ai-importer/settings"]
  );
}

/**
 * "AI Auto-Configure Everything": the preview for the SAVED settings. Deterministic and catalog-based —
 * provider routes are read from OpenRouter (free metadata) but nothing is saved and no AI request is sent.
 */
export async function autoConfigPreviewAction(): Promise<ImporterResult<AutoConfigPreview>> {
  return run(await requireManage(), async () => previewAutoConfig(), []);
}

/** "Apply Configuration" after confirmation: re-validated on the server; saved atomically with an audit entry. */
export async function autoConfigApplyAction(baselineKey: string, proposalKey: string): Promise<ImporterResult<AutoConfigApplied>> {
  return run(
    await requireManage(),
    async (actorId) => {
      if (typeof baselineKey !== "string" || typeof proposalKey !== "string" || !baselineKey || !proposalKey) throw new ImportJobError("Run the preview first. Nothing was saved.");
      try {
        return await applyAutoConfig({ baselineKey, proposalKey, actorId });
      } catch (error) {
        if (error instanceof AutoConfigError) throw new ImportJobError(error.message);
        throw error;
      }
    },
    ["/admin/ai-importer/settings"]
  );
}

/** "Reconfigure Models for This Job": a new model and cost preview for a paused import (nothing is changed). */
export async function reconfigurePreviewAction(jobId: string): Promise<ImporterResult<ReconfigurePreview>> {
  return run(
    await requireUse(),
    async () => {
      try {
        return await reconfigurePreview(String(jobId));
      } catch (error) {
        if (error instanceof ReconfigureError) throw new ImportJobError(error.message);
        throw error;
      }
    },
    []
  );
}

export async function reconfigureJobAction(jobId: string, proposalKey: string): Promise<ImporterResult<ReconfigureResult>> {
  return run(await requireUse(), async (actorId) => {
    try {
      return await reconfigureJob({ jobId: String(jobId), proposalKey: String(proposalKey), actorId });
    } catch (error) {
      if (error instanceof ReconfigureError) throw new ImportJobError(error.message);
      throw error;
    }
  });
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
