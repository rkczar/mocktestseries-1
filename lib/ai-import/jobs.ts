import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportPageStatus, AiImportPaperType, Prisma, type AiImportJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, WORKER_STATUSES, fileRemovalBlockedReason } from "@/lib/ai-import/config";
import { getImporterSettings, jobRunSettings } from "@/lib/ai-import/settings";
import { checkFilename, detectFile } from "@/lib/ai-import/detect";
import { pdfInfo } from "@/lib/ai-import/pdf";
import { adoptFile, tmpDir, removeVaultDir, vaultPath } from "@/lib/ai-import/vault";
import { kickWorker } from "@/lib/ai-import/kick";
import { estimateJobCost } from "@/lib/ai-import/estimate";
import { computeModelPlan, modelsFromPlan, planOf } from "@/lib/ai-import/select";
import { priceRemainingWork } from "@/lib/ai-import/reconfigure";
import { BUDGET_LOCK_KEY } from "@/lib/ai-import/ai";
import { referenceKeysInUse } from "@/lib/ai-import/reference-keys";
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import type { VerifyMode } from "@/lib/ai-import/config";

export class ImportJobError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "ImportJobError";
  }
}

export async function logEvent(jobId: string, type: string, message: string, data?: Record<string, unknown>, actorId?: string | null) {
  await prisma.aiImportEvent.create({ data: { jobId, type, message: message.slice(0, 1000), data: (data ?? undefined) as Prisma.InputJsonValue | undefined, actorId: actorId ?? null } });
}

const TERMINAL: AiImportJobStatus[] = [AiImportJobStatus.CANCELLED];
const EDITABLE: AiImportJobStatus[] = [AiImportJobStatus.DRAFT, AiImportJobStatus.AWAITING_CONFIRMATION];

// Serializes "stored file still referenced?" decisions: an upload adopting identical bytes and a
// file removal deleting them never interleave (originals are content-addressed and shared).
const VAULT_FILES_LOCK = 7_301_442_047;
const VAULT_TX = { timeout: 10 * 60_000, maxWait: 60_000 };

export interface JobContextInput {
  examId: string;
  paperType: AiImportPaperType;
  subjectId: string | null;
  year: number | null;
  paperCode: string | null;
  previousYearPaperId: string | null;
}

/**
 * Checks the exam context against the existing taxonomy (never creates anything) and returns it
 * normalized. A selected Previous Year Paper is the single source of the paper's year and code: the
 * questions are saved with THAT paper's year (never the exam's own year), and a different year or code
 * typed by hand is refused instead of being silently attached to another paper.
 */
export async function validateContext(c: JobContextInput): Promise<JobContextInput> {
  const exam = await prisma.exam.findUnique({ where: { id: c.examId }, select: { id: true } });
  if (!exam) throw new ImportJobError("Select an existing exam.");
  if (c.paperType === AiImportPaperType.SINGLE_SUBJECT) {
    if (!c.subjectId) throw new ImportJobError("Select the subject of this single-subject paper.");
    const link = await prisma.examSubject.findUnique({ where: { examId_subjectId: { examId: c.examId, subjectId: c.subjectId } }, select: { id: true } });
    if (!link) throw new ImportJobError("That subject is not configured for the selected exam.");
  }
  if (c.year !== null && (c.year < 1950 || c.year > 2100)) throw new ImportJobError("Enter a valid 4-digit year.");
  const code = c.paperCode?.trim().slice(0, 40) || null;
  if (c.previousYearPaperId) {
    const paper = await prisma.previousYearPaper.findUnique({ where: { id: c.previousYearPaperId }, select: { examId: true, year: true, title: true, paperCode: true } });
    if (!paper) throw new ImportJobError("The selected Previous Year Paper no longer exists. Select an existing paper (or create it under Previous Year Papers first). Nothing was changed.");
    if (paper.examId !== c.examId) throw new ImportJobError("The selected Previous Year Paper does not belong to the selected exam.");
    if (c.year !== null && c.year !== paper.year) throw new ImportJobError(`The year ${c.year} does not match the selected paper "${paper.title}" (${paper.year}). Clear the year or select the right paper. Nothing was changed.`);
    if (code && paper.paperCode && code.toLowerCase() !== paper.paperCode.toLowerCase()) throw new ImportJobError(`The paper code "${code}" does not match the selected paper "${paper.title}" (${paper.paperCode}). Nothing was changed.`);
    return { ...c, year: paper.year, paperCode: paper.paperCode ?? code };
  }
  return { ...c, paperCode: code };
}

export async function createJob(raw: JobContextInput & { actorId: string; title: string; budgetInr?: number; clientKey?: string | null; expectedQuestions?: number | null }): Promise<string> {
  const input = { ...raw, ...(await validateContext(raw)) };
  const expected = expectedCount(raw.expectedQuestions);
  // A repeated submission (double click, retried request) with the same client key returns the job it created.
  const clientKey = typeof input.clientKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(input.clientKey) ? input.clientKey : null;
  if (clientKey) {
    const twin = await prisma.aiImportJob.findFirst({ where: { createdById: input.actorId, createdAt: { gt: new Date(Date.now() - 24 * 3_600_000) }, config: { path: ["clientKey"], equals: clientKey } }, select: { id: true } });
    if (twin) return twin.id;
  }
  const title = input.title.trim().slice(0, 160) || "Untitled import";
  const job = await prisma.aiImportJob.create({
    data: {
      title,
      examId: input.examId,
      paperType: input.paperType,
      subjectId: input.paperType === AiImportPaperType.SINGLE_SUBJECT ? input.subjectId : null,
      year: input.year,
      paperCode: input.paperCode,
      previousYearPaperId: input.previousYearPaperId,
      expectedQuestions: expected,
      createdById: input.actorId,
      // Records the maximum cost the administrator confirms (set at confirmation); it is not a spending cap.
      budgetInr: 0,
      status: AiImportJobStatus.DRAFT,
      ...(clientKey ? { config: { clientKey } } : {}),
    },
  });
  await logEvent(job.id, "CREATED", `Import "${title}" created`, { examId: input.examId, previousYearPaperId: input.previousYearPaperId, year: input.year, paperCode: input.paperCode, expectedQuestions: expected, paperType: input.paperType }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_JOB_CREATED", entityType: "AiImportJob", entityId: job.id, metadata: { title, examId: input.examId, previousYearPaperId: input.previousYearPaperId } } });
  return job.id;
}

export async function addFile(input: { jobId: string; actorId: string; name: string; size: number; role: AiImportFileRole; paperFileId: string | null }): Promise<{ fileId: string; chunkBytes: number; chunks: number }> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId }, select: { status: true, _count: { select: { files: true } } } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (TERMINAL.includes(job.status)) throw new ImportJobError("This import was cancelled.");
  if (input.role === AiImportFileRole.PAPER && !EDITABLE.includes(job.status)) throw new ImportJobError("Question papers can only be added before processing starts. Start a new import for more papers.");
  if (input.role === AiImportFileRole.ANSWER_KEY && [AiImportJobStatus.PROCESSING, AiImportJobStatus.IMPORTING].includes(job.status as never)) {
    throw new ImportJobError("Wait for the current processing step to finish, then add the answer key.");
  }
  const settings = await getImporterSettings();
  if (job._count.files >= settings.limits.maxFilesPerJob) throw new ImportJobError(`An import holds at most ${settings.limits.maxFilesPerJob} files.`);
  const name = checkFilename(input.name);
  if (!name.ok) throw new ImportJobError(name.reason);
  const max = settings.limits.maxFileMb * 1024 * 1024;
  if (!Number.isFinite(input.size) || input.size <= 0) throw new ImportJobError("The file is empty.");
  if (input.size > max) throw new ImportJobError(`The file is larger than ${settings.limits.maxFileMb} MB.`);
  if (input.paperFileId) {
    const paper = await prisma.aiImportFile.findUnique({ where: { id: input.paperFileId }, select: { jobId: true, role: true } });
    if (!paper || paper.jobId !== input.jobId || paper.role !== AiImportFileRole.PAPER) throw new ImportJobError("The answer key must be linked to a question paper of this import.");
  }
  const file = await prisma.aiImportFile.create({
    data: {
      jobId: input.jobId,
      role: input.role,
      paperFileId: input.role === AiImportFileRole.ANSWER_KEY ? input.paperFileId : null,
      originalName: input.name.trim().slice(0, 200),
      ext: name.ext,
      declaredBytes: input.size,
      uploadedById: input.actorId,
      status: AiImportFileStatus.UPLOADING,
    },
  });
  return { fileId: file.id, chunkBytes: CHUNK_BYTES, chunks: Math.ceil(input.size / CHUNK_BYTES) };
}

async function uploadingFile(fileId: string, actorId: string) {
  const file = await prisma.aiImportFile.findUnique({ where: { id: fileId } });
  if (!file || file.uploadedById !== actorId) throw new ImportJobError("Upload not found.", 404);
  if (file.status !== AiImportFileStatus.UPLOADING) throw new ImportJobError("This upload is already complete.", 409);
  return file;
}

/** Stores one ≤ 8 MB chunk (idempotent per index). */
export async function putChunk(input: { fileId: string; actorId: string; index: number; bytes: Buffer }): Promise<void> {
  const file = await uploadingFile(input.fileId, input.actorId);
  const chunks = Math.ceil(file.declaredBytes / CHUNK_BYTES);
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= chunks) throw new ImportJobError("Invalid chunk index.");
  const expected = input.index === chunks - 1 ? file.declaredBytes - CHUNK_BYTES * (chunks - 1) : CHUNK_BYTES;
  if (input.bytes.length !== expected) throw new ImportJobError("Chunk size does not match the declared file size.");
  const dir = tmpDir(file.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(/* turbopackIgnore: true */ dir, `c${input.index}`), input.bytes, { mode: 0o600 });
}

/** Assembles, validates by content and moves the file into the vault. Refusals are recorded on the file. */
export async function completeFile(input: { fileId: string; actorId: string }) {
  const file = await uploadingFile(input.fileId, input.actorId);
  const settings = await getImporterSettings();
  const dir = tmpDir(file.id);
  const chunks = Math.ceil(file.declaredBytes / CHUNK_BYTES);
  const present = new Set(await readdir(dir).catch(() => [] as string[]));
  for (let i = 0; i < chunks; i++) if (!present.has(`c${i}`)) throw new ImportJobError(`Part ${i + 1} of ${chunks} has not arrived yet.`, 409);
  const assembled = path.join(/* turbopackIgnore: true */ dir, "assembled");
  const out = await open(assembled, "w", 0o600);
  try {
    for (let i = 0; i < chunks; i++) {
      const fh = await open(path.join(/* turbopackIgnore: true */ dir, `c${i}`), "r");
      try {
        const buf = Buffer.alloc(CHUNK_BYTES);
        const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, 0);
        await out.write(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    }
  } finally {
    await out.close();
  }
  const refuse = async (reason: string) => {
    await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.REJECTED, errorMessage: reason } });
    await removeVaultDir("tmp", file.id).catch(() => undefined);
    await logEvent(file.jobId, "FILE_REJECTED", `${file.originalName}: ${reason}`, { fileId: file.id }, input.actorId);
    return { ok: false as const, reason };
  };
  const size = (await stat(assembled)).size;
  if (size !== file.declaredBytes) return refuse("The upload is incomplete (size mismatch). Upload it again.");
  const det = await detectFile(assembled, file.ext as never);
  if (!det.ok) return refuse(det.reason!);
  let pageCount: number | null = null;
  if (det.kind === "pdf") {
    try {
      const info = await pdfInfo(assembled);
      if (info.encrypted) return refuse("The PDF is password-protected or encrypted. Upload an unprotected copy.");
      if (info.pages < 1) return refuse("The PDF has no pages.");
      if (info.pages > settings.limits.maxPagesPerFile) return refuse(`The PDF has ${info.pages} pages; the limit is ${settings.limits.maxPagesPerFile}. Split it into parts.`);
      pageCount = info.pages;
    } catch (e) {
      return refuse(`The PDF could not be read (${e instanceof Error ? e.message.slice(0, 120) : "damaged"}).`);
    }
  } else if (det.kind === "png" || det.kind === "jpeg") pageCount = 1;
  const kind = det.kind!;
  const retainUntil = new Date(Date.now() + settings.retention.originalDays * 86_400_000);
  const { adopted, twin } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_FILES_LOCK}::bigint)`;
    const adopted = await adoptFile(assembled, "files", kind === "jpeg" ? "jpg" : file.ext);
    const twin = await tx.aiImportFile.findFirst({ where: { sha256: adopted.sha256, id: { not: file.id }, status: { not: AiImportFileStatus.PURGED } }, select: { jobId: true, originalName: true } });
    await tx.aiImportFile.update({
      where: { id: file.id },
      data: { status: AiImportFileStatus.UPLOADED, bytes: adopted.bytes, sha256: adopted.sha256, storageKey: adopted.key, mime: det.mime, pageCount, retainUntil, detected: { kind, ...(twin ? { identicalTo: { jobId: twin.jobId, name: twin.originalName } } : {}) } },
    });
    return { adopted, twin };
  }, VAULT_TX);
  await removeVaultDir("tmp", file.id).catch(() => undefined);
  // An answer key added after processing: read it and re-match (no paper is re-read).
  if (file.role === AiImportFileRole.ANSWER_KEY) {
    const requeued = await prisma.aiImportJob.updateMany({
      where: { id: file.jobId, status: { in: [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.COMPLETED, AiImportJobStatus.COMPLETED_WITH_ISSUES] } },
      data: { status: AiImportJobStatus.QUEUED, finishedAt: null },
    });
    if (requeued.count) {
      await logEvent(file.jobId, "KEY_ADDED", `${file.originalName}: answer key added — matching answers again`, { fileId: file.id }, input.actorId);
      kickWorker();
    }
  }
  await logEvent(file.jobId, "FILE_UPLOADED", `${file.originalName} uploaded (${kind.toUpperCase()}${pageCount ? `, ${pageCount} page${pageCount === 1 ? "" : "s"}` : ""})${twin ? " — identical to a file uploaded before; stored once" : ""}`, { fileId: file.id, sha256: adopted.sha256, deduplicated: !adopted.created }, input.actorId);
  return { ok: true as const, kind, pageCount, duplicateOf: twin ?? null };
}

/** Starts the free local analysis of the uploaded files (worker). */
export async function requestAnalysis(jobId: string, actorId: string) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, include: { files: { select: { status: true, role: true } } } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (!EDITABLE.includes(job.status)) throw new ImportJobError("Analysis can only run before processing starts.");
  if (!job.files.some((f) => f.role === AiImportFileRole.PAPER && (f.status === AiImportFileStatus.UPLOADED || f.status === AiImportFileStatus.ANALYZED))) {
    throw new ImportJobError("Upload at least one question paper first.");
  }
  if (job.files.some((f) => f.status === AiImportFileStatus.UPLOADING)) throw new ImportJobError("Wait until every upload has finished.");
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: AiImportJobStatus.ANALYZING, errorMessage: null } });
  await logEvent(jobId, "ANALYSIS_REQUESTED", "Local analysis requested (no AI cost)", undefined, actorId);
  kickWorker();
}

/** Admin confirms (or corrects) the exam context and budget, then queues processing. */
export interface ConfirmOptions {
  /** One-page flow: import every eligible question as Draft through the Bulk Import as soon as processing ends. */
  autoImport?: { mode: "DRAFT" | "PUBLISH_ALL" } | null;
  /** This job only: use this model (from the importer's own list) for page and key reading instead of the automatic choice. */
  modelOverride?: string | null;
  /** The number of questions the administrator confirmed (required by the one-page flow; kept when omitted). */
  expectedQuestions?: number | null;
  /** Independent verification: "risk" = second read of scanned / low-confidence pages (default), "all" = every page. */
  verifyMode?: VerifyMode | null;
  /** The one-page flow requires an explicit expected question count before processing starts. */
  requireExpected?: boolean;
}

export async function confirmJob(raw: JobContextInput & { jobId: string; actorId: string; confirmedMaxInr: number | null } & ConfirmOptions) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: raw.jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status !== AiImportJobStatus.AWAITING_CONFIRMATION) throw new ImportJobError("Only an analyzed import can be confirmed.");
  const input = { ...raw, ...(await validateContext(raw)) };
  const expected = raw.expectedQuestions === undefined ? job.expectedQuestions : expectedCount(raw.expectedQuestions);
  if (raw.requireExpected && !expected) throw new ImportJobError("Confirm the expected number of questions in this paper before starting. Nothing was started.");
  const verifyMode: VerifyMode = raw.verifyMode === "all" ? "all" : "risk";
  const paperChanged = job.previousYearPaperId !== input.previousYearPaperId || job.examId !== input.examId;
  const saved = await getImporterSettings();
  if (input.modelOverride && !saved.importerModels.includes(input.modelOverride)) throw new ImportJobError("That model is not on the importer's own model list. Nothing was started.");
  // A per-job override goes through exactly the same suitability, privacy and price checks (manual mode).
  const settings: typeof saved = input.modelOverride ? { ...saved, selection: { mode: "manual" }, models: { ...saved.models, extract: input.modelOverride, extractFallbacks: [], key: input.modelOverride } } : saved;
  // Choose the models now, from fresh OpenRouter prices and privacy routes, and re-price with them.
  // The plan is frozen on the job: the worker never picks a different (or pricier) model by itself.
  const plan = await computeModelPlan(settings, { refresh: settings.aiEnabled });
  const analysis = job.analysis as unknown as JobAnalysis | null;
  const facts = (role: string) => (analysis?.files ?? []).filter((f) => f.role === role && f.facts).map((f) => f.facts!);
  const estimate = await estimateJobCost({ paperFacts: facts(AiImportFileRole.PAPER), keyFacts: facts(AiImportFileRole.ANSWER_KEY), settings, plan, verifyMode });
  if (settings.aiEnabled) {
    // Pages or answer keys that need AI but have no affordable, suitable model: stop and say why.
    for (const l of estimate.lines.filter((x) => x.calls > 0 && (x.task === "extract" || x.task === "key") && x.problem)) {
      throw new ImportJobError(`${l.label}: ${l.problem} Nothing was started.`);
    }
  }
  // Lines without a usable model never run (their questions are flagged instead), so only priced lines count.
  const willCallAi = settings.aiEnabled && estimate.lines.some((l) => l.calls > 0 && l.model !== null && l.problem === null);
  if (willCallAi) {
    if (estimate.totalInr === null || estimate.maxInr === null) throw new ImportJobError(`The AI cost cannot be established (${estimate.notes[0] ?? "missing model price or exchange rate"}). Nothing was started.`);
    // The administrator confirms the displayed cost. Prices were just refreshed: if the conservative maximum is now
    // higher than what was confirmed, nothing starts and the new estimate is shown for a fresh confirmation.
    // There is no importer job / monthly / all-time cap any more (owner decision 2026-10-20).
    const confirmedMax = typeof input.confirmedMaxInr === "number" && Number.isFinite(input.confirmedMaxInr) ? input.confirmedMaxInr : null;
    if (confirmedMax === null || estimate.maxInr > confirmedMax + 0.005) {
      const fresh = { estCostInr: estimate.totalInr, estCostUsd: estimate.totalUsd, estimate: estimate as unknown as Prisma.InputJsonValue, ...(analysis ? { analysis: { ...analysis, estimate } as unknown as Prisma.InputJsonValue } : {}) };
      await prisma.aiImportJob.updateMany({ where: { id: job.id, status: AiImportJobStatus.AWAITING_CONFIRMATION, updatedAt: job.updatedAt }, data: fresh });
      throw new ImportJobError(
        confirmedMax === null
          ? `Confirm the cost first: estimated ₹${estimate.totalInr.toFixed(2)}, estimated maximum ₹${estimate.maxInr.toFixed(2)}. Nothing was started.`
          : `The cost changed since it was shown (prices were refreshed): estimated ₹${estimate.totalInr.toFixed(2)}, estimated maximum now ₹${estimate.maxInr.toFixed(2)} (you confirmed ₹${confirmedMax.toFixed(2)}). Nothing was started — review the new cost and confirm again.`
      );
    }
  }
  // Conditional on the job being unchanged since it was read: a file removed meanwhile
  // clears the analysis, and its stale estimate must never be confirmed.
  const confirmed = await prisma.aiImportJob.updateMany({
    where: { id: job.id, status: AiImportJobStatus.AWAITING_CONFIRMATION, updatedAt: job.updatedAt },
    data: {
      estCostInr: estimate.totalInr,
      estCostUsd: estimate.totalUsd,
      estimate: estimate as unknown as Prisma.InputJsonValue,
      examId: input.examId,
      paperType: input.paperType,
      subjectId: input.paperType === AiImportPaperType.SINGLE_SUBJECT ? input.subjectId : null,
      year: input.year,
      paperCode: input.paperCode,
      previousYearPaperId: input.previousYearPaperId,
      expectedQuestions: expected,
      budgetInr: willCallAi ? (estimate.maxInr ?? 0) : 0,
      status: AiImportJobStatus.QUEUED,
      confirmedAt: new Date(),
      confirmedById: input.actorId,
      config: JSON.parse(JSON.stringify({ ...settings, modelPlan: plan, verifyMode, clientKey: (job.config as { clientKey?: string } | null)?.clientKey ?? null, autoImport: input.autoImport ? { ...input.autoImport, requestedById: input.actorId, done: false } : null })) as Prisma.InputJsonValue,
    },
  });
  if (!confirmed.count) throw new ImportJobError("The files or analysis of this import changed while you were confirming. Nothing was started — review the page and confirm again.", 409);
  if (paperChanged) await logEvent(job.id, "PAPER_CHANGED", "Exam / Previous Year Paper changed at confirmation", { from: { examId: job.examId, previousYearPaperId: job.previousYearPaperId }, to: { examId: input.examId, previousYearPaperId: input.previousYearPaperId, year: input.year } }, input.actorId);
  const chosen = Object.values(plan.tasks).map((t) => `${t.task}: ${t.model ?? "none"}`).join(", ");
  await logEvent(job.id, "CONFIRMED", `${willCallAi ? `Cost confirmed: estimated ₹${(estimate.totalInr ?? 0).toFixed(2)}, estimated maximum ₹${(estimate.maxInr ?? 0).toFixed(2)} — models (${plan.mode}): ${chosen}` : settings.aiEnabled ? "Processing confirmed — no paid AI request is needed" : "Processing confirmed — paid AI is off"}`, { paperType: input.paperType, previousYearPaperId: input.previousYearPaperId, year: input.year, expectedQuestions: expected, verifyMode, confirmedMaxInr: willCallAi ? estimate.maxInr : 0, aiEnabled: settings.aiEnabled, selection: plan.mode, models: Object.fromEntries(Object.values(plan.tasks).map((t) => [t.task, t.model])), maxInr: estimate.maxInr }, input.actorId);
  kickWorker();
}

/**
 * Explicitly changes the Previous Year Paper (or "Question Bank only") of an import whose questions have
 * not entered the Question Bank yet. The new paper must belong to the job's exam; its year and code
 * replace the old ones; the change is logged with both values. Questions already stored keep their
 * paper (they are edited in the Question Bank), so the change is refused once any question is stored.
 */
export async function changeJobPaper(input: { jobId: string; actorId: string; previousYearPaperId: string | null }): Promise<{ previousYearPaperId: string | null; year: number | null }> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (([AiImportJobStatus.ANALYZING, AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING, AiImportJobStatus.IMPORTING, AiImportJobStatus.CANCELLED] as AiImportJobStatus[]).includes(job.status)) {
    throw new ImportJobError("The paper can be changed while the import is waiting for confirmation or review — not while it is running or cancelled.");
  }
  const stored = await prisma.aiImportQuestion.count({ where: { jobId: job.id, questionId: { not: null } } });
  if (stored) throw new ImportJobError(`${stored} question(s) of this import are already in the Question Bank with the current paper. Change their paper in the Question Bank instead. Nothing was changed.`);
  const next = await validateContext({ examId: job.examId, paperType: job.paperType, subjectId: job.subjectId, year: input.previousYearPaperId ? null : job.year, paperCode: input.previousYearPaperId ? null : job.paperCode, previousYearPaperId: input.previousYearPaperId });
  const r = await prisma.aiImportJob.updateMany({ where: { id: job.id, updatedAt: job.updatedAt }, data: { previousYearPaperId: next.previousYearPaperId, year: next.year, paperCode: next.paperCode } });
  if (!r.count) throw new ImportJobError("The import changed at the same moment. Refresh and try again.", 409);
  await logEvent(job.id, "PAPER_CHANGED", next.previousYearPaperId ? "Previous Year Paper changed by an administrator" : "Previous Year Paper removed (Question Bank only)", { from: { previousYearPaperId: job.previousYearPaperId, year: job.year, paperCode: job.paperCode }, to: { previousYearPaperId: next.previousYearPaperId, year: next.year, paperCode: next.paperCode } }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_PAPER_CHANGED", entityType: "AiImportJob", entityId: job.id, metadata: { from: job.previousYearPaperId, to: next.previousYearPaperId } } });
  return { previousYearPaperId: next.previousYearPaperId, year: next.year };
}

/** Records the confirmed expected question count of an import (any time before it is completed). */
export async function setExpectedQuestions(input: { jobId: string; actorId: string; expected: unknown }): Promise<number | null> {
  const expected = expectedCount(input.expected);
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId }, select: { expectedQuestions: true, status: true } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("This import was cancelled.");
  await prisma.aiImportJob.update({ where: { id: input.jobId }, data: { expectedQuestions: expected } });
  await logEvent(input.jobId, "EXPECTED_SET", `Expected question count set to ${expected ?? "—"}${job.expectedQuestions ? ` (was ${job.expectedQuestions})` : ""}`, { from: job.expectedQuestions, to: expected }, input.actorId);
  return expected;
}

/** A confirmed expected question count: a whole number 1–1000, or null when not given. */
export function expectedCount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ImportJobError("Enter the expected number of questions as a whole number from 1 to 1000.");
  return n;
}

export async function pauseJob(jobId: string, actorId: string) {
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: { in: [AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING] } }, data: { status: AiImportJobStatus.PAUSED, pauseReason: "Paused by an administrator" } });
  if (!r.count) throw new ImportJobError("Only a queued or processing import can be paused.");
  await logEvent(jobId, "PAUSED", "Paused by an administrator", undefined, actorId);
}

/** The cost an administrator must confirm before Resume / Retry may send paid AI requests again (nothing was started). */
export interface ContinueCost {
  /** Recorded spend of the job so far (unknown costs held at their worst case). */
  spentInr: number;
  /** The maximum confirmed for the job until now. */
  confirmedMaxInr: number;
  /** Conservative maximum of the work still to do (failed / pending pages, failed keys, classification). */
  remainingMaxInr: number;
  /** The new confirmed maximum this continuation needs: spent + remaining maximum. */
  neededMaxInr: number;
  pages: number;
  keyFiles: number;
  questionsToClassify: number;
}

/** Started, or not started because the shown cost must be confirmed first. */
export type ContinueResult = { started: true; cost: null } | { started: false; cost: ContinueCost };

/**
 * Renewed confirmation before a paused / failed / finished import sends paid AI requests again. The remaining work
 * is priced with the job's models (no AI request); when spent + its maximum fits the confirmed maximum nothing is
 * asked. Otherwise the caller gets the cost to show, and only a confirmation of at least the freshly priced amount
 * raises the job's confirmed maximum (to exactly that amount). With Paid AI off nothing can be spent, so nothing is asked.
 */
async function authorizeRemaining(job: AiImportJob, actorId: string, confirmedMaxInr: number | null | undefined): Promise<ContinueCost | null> {
  const current = await getImporterSettings();
  const plan = planOf(job.config);
  if (!current.aiEnabled || !plan) return null;
  const settings = { ...jobRunSettings(job.config, current), models: modelsFromPlan(plan) };
  const files = await prisma.aiImportFile.findMany({ where: { jobId: job.id }, select: { id: true, role: true, status: true, errorMessage: true, pageCount: true } });
  const r = await priceRemainingWork({ id: job.id, analysis: job.analysis, files }, plan, settings);
  if (r.maxInr === null) throw new ImportJobError(`The cost of the remaining work cannot be established (${r.estimate.notes[0] ?? "a model price or the exchange rate is missing"}). Nothing was started — use Reconfigure Models for This Job to choose models with a known price.`);
  // Compared exactly (rounding up to the paisa first could ask again for the very maximum already confirmed).
  if (job.spentInr + r.maxInr <= job.budgetInr + 0.005) return null;
  const needed = Math.ceil((job.spentInr + r.maxInr) * 100) / 100;
  const cost: ContinueCost = { spentInr: job.spentInr, confirmedMaxInr: job.budgetInr, remainingMaxInr: r.maxInr, neededMaxInr: needed, pages: r.unreadPages, keyFiles: r.failedKeyFiles, questionsToClassify: r.toClassify };
  const confirmed = typeof confirmedMaxInr === "number" && Number.isFinite(confirmedMaxInr) ? confirmedMaxInr : null;
  if (confirmed === null || confirmed + 0.005 < needed) return cost;
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { budgetInr: needed } });
  await logEvent(job.id, "COST_RECONFIRMED", `New maximum confirmed: ₹${needed.toFixed(2)} (₹${job.spentInr.toFixed(2)} spent + up to ₹${r.maxInr.toFixed(2)} for ${r.unreadPages} page(s)${r.failedKeyFiles ? `, ${r.failedKeyFiles} answer-key file(s)` : ""}${r.toClassify ? ` and classifying ${r.toClassify} question(s)` : ""}); was ₹${job.budgetInr.toFixed(2)}.`, { ...cost }, actorId);
  return null;
}

/** Resume after a manual pause, a provider/key pause or a failure (finished pages are never read or paid for again). */
export async function resumeJob(jobId: string, actorId: string, confirmedMaxInr?: number | null): Promise<ContinueResult> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status !== AiImportJobStatus.PAUSED && job.status !== AiImportJobStatus.PAUSED_BUDGET && job.status !== AiImportJobStatus.FAILED) throw new ImportJobError("Only a paused or failed import can be resumed.");
  const cost = await authorizeRemaining(job, actorId, confirmedMaxInr);
  if (cost) return { started: false, cost };
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: AiImportJobStatus.QUEUED, pauseReason: null, errorMessage: null, leaseOwner: null, leaseUntil: null } });
  // Failed pages get one more attempt on resume (never automatically in a loop).
  await prisma.aiImportPage.updateMany({ where: { jobId, status: "FAILED" }, data: { status: "PENDING", errorMessage: null } });
  await logEvent(jobId, "RESUMED", "Resumed", undefined, actorId);
  kickWorker();
  return { started: true, cost: null };
}

/**
 * Cancels a job. The status write is conditional, so it never races a worker's own transition; the
 * worker sees the change at its next checkpoint (between pages and stages) and stops, and
 * importerAiCall refuses any new AI request for a job that is not processing. Work files are removed;
 * extracted questions and page records are kept so the job can be retried or deleted.
 */
export async function cancelJob(jobId: string, actorId: string) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status === AiImportJobStatus.CANCELLED) return;
  if (job.status === AiImportJobStatus.IMPORTING) throw new ImportJobError("Questions are being written to the Question Bank right now. That step cannot be interrupted safely; it takes a few seconds — refresh, then delete or keep the import.", 409);
  // The worker's lease is kept: it releases it itself when it stops at its next checkpoint, so Delete
  // and Retry wait until the worker has really stopped (a crashed worker's lease simply expires).
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: job.status }, data: { status: AiImportJobStatus.CANCELLED, cancelledAt: new Date() } });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  const leased = !!job.leaseOwner && !!job.leaseUntil && job.leaseUntil > new Date();
  await logEvent(jobId, "CANCELLED", `Cancelled by an administrator (was ${job.status.toLowerCase().replace(/_/g, " ")}).${leased ? " The worker stops at its next safe checkpoint; a request already sent to the AI finishes and is recorded, but no new request is sent." : ""} Questions already imported stay in the Question Bank (use Import History rollback to remove them).`, { previousStatus: job.status, workerWasActive: leased }, actorId);
  await removeVaultDir("work", jobId).catch(() => undefined);
}

/**
 * Retry / resume. Paused and failed jobs continue from their checkpoints (finished pages are never
 * read or paid for again; failed pages get one more attempt). A cancelled job returns to where it was
 * cancelled: before processing it is analyzed again; after confirmation it is queued again.
 */
export async function retryJob(jobId: string, actorId: string, confirmedMaxInr?: number | null): Promise<ContinueResult> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status === AiImportJobStatus.PAUSED || job.status === AiImportJobStatus.PAUSED_BUDGET || job.status === AiImportJobStatus.FAILED) {
    return resumeJob(jobId, actorId, confirmedMaxInr);
  }
  if (job.status === AiImportJobStatus.NEEDS_REVIEW) return retryFailedParts(job, actorId, confirmedMaxInr);
  if (job.status !== AiImportJobStatus.CANCELLED) throw new ImportJobError("Only a failed, paused or cancelled import, or a finished one with failed pages, can be retried.");
  if (job.leaseUntil && job.leaseUntil > new Date()) throw new ImportJobError("The worker is still stopping (it finishes its current step first). Try again in a few seconds.", 409);
  const toQueue = !!job.confirmedAt;
  if (toQueue) {
    const cost = await authorizeRemaining(job, actorId, confirmedMaxInr);
    if (cost) return { started: false, cost };
  }
  const r = await prisma.aiImportJob.updateMany({
    where: { id: jobId, status: AiImportJobStatus.CANCELLED },
    data: toQueue ? { status: AiImportJobStatus.QUEUED, cancelledAt: null, errorMessage: null, pauseReason: null, finishedAt: null, leaseOwner: null, leaseUntil: null } : { status: AiImportJobStatus.DRAFT, cancelledAt: null, errorMessage: null, analysis: Prisma.DbNull, estimate: Prisma.DbNull, estCostInr: null, estCostUsd: null },
  });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  if (toQueue) await prisma.aiImportPage.updateMany({ where: { jobId, status: "FAILED" }, data: { status: "PENDING", errorMessage: null } });
  else await prisma.aiImportFile.updateMany({ where: { jobId, status: AiImportFileStatus.ANALYZED }, data: { status: AiImportFileStatus.UPLOADED } });
  await logEvent(jobId, "RETRIED", toQueue ? "Retried after cancellation: processing continues from the last finished page (finished pages are not read or charged again)." : "Retried after cancellation: the files are analyzed again.", undefined, actorId);
  if (toQueue) kickWorker();
  else await requestAnalysis(jobId, actorId);
  return { started: true, cost: null };
}

/**
 * Recovery of a finished ("Needs review") job whose page or answer-key reading failed — an explicit
 * administrator action, never automatic. Only the FAILED pages go back to pending and only answer-key
 * files whose reading failed are read again; finished pages are never sent or charged again, questions
 * are matched to their stored rows (no duplicates), and page errors, events and cost records are kept.
 * Paid AI must be on now (with it off the pages could not be read, so nothing is started).
 */
async function retryFailedParts(job: AiImportJob, actorId: string, confirmedMaxInr?: number | null): Promise<ContinueResult> {
  if (!job.confirmedAt) throw new ImportJobError("This import was never confirmed for processing, so there is nothing to retry.");
  if (job.leaseUntil && job.leaseUntil > new Date()) throw new ImportJobError("The worker is still finishing this import. Try again in a few seconds.", 409);
  const [failedPages, failedKeys] = await Promise.all([
    prisma.aiImportPage.count({ where: { jobId: job.id, status: AiImportPageStatus.FAILED } }),
    prisma.aiImportFile.count({ where: { jobId: job.id, role: AiImportFileRole.ANSWER_KEY, status: AiImportFileStatus.ANALYZED, errorMessage: { not: null } } }),
  ]);
  if (!failedPages && !failedKeys) throw new ImportJobError("Nothing failed in this import, so there is nothing to retry — review its questions instead.");
  if (!(await getImporterSettings()).aiEnabled) throw new ImportJobError("Paid AI is switched off in Import Settings, so the failed pages cannot be read. Nothing was changed. Switch Paid AI on (and save) first, then retry.");
  const cost = await authorizeRemaining(job, actorId, confirmedMaxInr);
  if (cost) return { started: false, cost };
  const fresh = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id }, select: { budgetInr: true } });
  const r = await prisma.aiImportJob.updateMany({
    where: { id: job.id, status: AiImportJobStatus.NEEDS_REVIEW, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    data: { status: AiImportJobStatus.QUEUED, errorMessage: null, pauseReason: null, finishedAt: null, leaseOwner: null, leaseUntil: null },
  });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  // The previous error stays on the page until it is read again (it is replaced on success or on a new failure).
  await prisma.aiImportPage.updateMany({ where: { jobId: job.id, status: AiImportPageStatus.FAILED }, data: { status: AiImportPageStatus.PENDING } });
  await logEvent(job.id, "RETRY_FAILED", `Retry of the failed parts: ${failedPages} page(s)${failedKeys ? ` and ${failedKeys} answer-key file(s)` : ""} are read again (confirmed maximum ₹${fresh.budgetInr.toFixed(2)}). Finished pages are not read or charged again.`, { failedPages, failedKeys, confirmedMaxInr: fresh.budgetInr }, actorId);
  kickWorker();
  return { started: true, cost: null };
}

/**
 * A busy job whose worker lease is missing or expired: nothing is running it (a live worker renews
 * its lease at every page). Starts the worker again; it picks the job up from its checkpoint. A job
 * with a live lease is never touched.
 */
export async function recoverJob(jobId: string, actorId: string): Promise<{ restarted: boolean; message: string }> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true, leaseOwner: true, leaseUntil: true, heartbeatAt: true } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (!(WORKER_STATUSES as readonly string[]).includes(job.status)) throw new ImportJobError("This import is not waiting for the worker.");
  if (job.leaseUntil && job.leaseUntil > new Date()) {
    return { restarted: false, message: `A worker is processing this import (last activity ${job.heartbeatAt ? `${Math.max(0, Math.round((Date.now() - job.heartbeatAt.getTime()) / 1000))} s ago` : "just now"}). Nothing was changed.` };
  }
  await logEvent(jobId, "WORKER_RESTARTED", `No worker held this import (status ${job.status.toLowerCase()}); the worker was started again. It continues from the last checkpoint.`, undefined, actorId);
  kickWorker();
  return { restarted: true, message: "The worker was started again. Progress appears here within a few seconds." };
}

export interface JobDeletePreview {
  title: string;
  status: string;
  files: { name: string; role: AiImportFileRole; bytes: number; storedCopy: "deleted" | "kept-shared" | "missing" }[];
  pages: number;
  questions: number;
  importedQuestions: number;
  bulkImportRuns: string[];
  figures: { total: number; deleted: number; keptShared: number };
  spentInr: number;
  blocked: string | null;
}

const ACTIVE_LEASE = (j: { leaseUntil: Date | null }) => !!j.leaseUntil && j.leaseUntil > new Date();

async function deletePlan(db: Prisma.TransactionClient | typeof prisma, jobId: string) {
  const job = await db.aiImportJob.findUnique({ where: { id: jobId }, include: { files: true } });
  if (!job) return null;
  const [pages, questions, imported, figures, runs] = await Promise.all([
    db.aiImportPage.count({ where: { jobId } }),
    db.aiImportQuestion.count({ where: { jobId } }),
    db.aiImportQuestion.count({ where: { jobId, questionId: { not: null } } }),
    db.aiImportFigure.findMany({ where: { jobId }, select: { id: true, originalKey: true, bytes: true } }),
    db.aiImportQuestion.findMany({ where: { jobId, bulkImportRunId: { not: null } }, distinct: ["bulkImportRunId"], select: { bulkImportRunId: true } }),
  ]);
  const fileKeys = [...new Set(job.files.map((f) => f.storageKey).filter((k): k is string => !!k))];
  // Also kept: bytes another job's reference paper points at (references are never deleted with a paper).
  const sharedFileKeys = new Set([...(await db.aiImportFile.findMany({ where: { storageKey: { in: fileKeys }, jobId: { not: jobId }, status: { not: AiImportFileStatus.PURGED } }, select: { storageKey: true } })).map((f) => f.storageKey!), ...(await referenceKeysInUse(db, fileKeys, jobId))]);
  // Figure originals of this job: its figure rows and its kept question versions (re-scan results, history).
  const versionKeys = (rows: { figures: Prisma.JsonValue }[]) => rows.flatMap((r) => ((Array.isArray(r.figures) ? r.figures : []) as { originalKey?: string }[]).map((f) => f?.originalKey ?? "")).filter(Boolean);
  const ownVersions = await db.aiImportQuestionVersion.findMany({ where: { jobId, figures: { not: Prisma.DbNull } }, select: { figures: true } });
  const figureKeys = [...new Set([...figures.map((f) => f.originalKey), ...versionKeys(ownVersions)].filter(Boolean))];
  const otherVersions = figureKeys.length ? await db.aiImportQuestionVersion.findMany({ where: { jobId: { not: jobId }, figures: { not: Prisma.DbNull } }, select: { figures: true } }) : [];
  const otherVersionKeys = new Set(versionKeys(otherVersions));
  const sharedFigureKeys = new Set([...(await db.aiImportFigure.findMany({ where: { originalKey: { in: figureKeys }, jobId: { not: jobId } }, select: { originalKey: true } })).map((f) => f.originalKey), ...figureKeys.filter((k) => otherVersionKeys.has(k))]);
  let blocked: string | null = null;
  if (job.status === AiImportJobStatus.IMPORTING) blocked = "Questions are being written to the Question Bank right now. Wait until that step finishes (a few seconds), then delete.";
  else if ((WORKER_STATUSES as readonly string[]).includes(job.status) && ACTIVE_LEASE(job)) blocked = "A worker is processing this import right now. Cancel it first; once it has stopped (a few seconds), delete it.";
  else if (ACTIVE_LEASE(job)) blocked = "The worker is still stopping (it finishes its current step first). Try again in a few seconds.";
  return { job, pages, questions, imported, figures, runs: runs.map((r) => r.bulkImportRunId!), fileKeys, sharedFileKeys, figureKeys, sharedFigureKeys, blocked };
}

/** Read-only: exactly what Delete import would remove (shown in the confirmation dialog). */
export async function deleteJobPreview(jobId: string): Promise<JobDeletePreview | null> {
  const p = await deletePlan(prisma, jobId);
  if (!p) return null;
  const files: JobDeletePreview["files"] = [];
  for (const f of p.job.files) {
    const present = f.storageKey ? await stat(vaultPath(f.storageKey)).then((st) => st.isFile(), () => false) : false;
    files.push({ name: f.originalName, role: f.role, bytes: f.bytes || f.declaredBytes, storedCopy: !f.storageKey || !present ? "missing" : p.sharedFileKeys.has(f.storageKey) ? "kept-shared" : "deleted" });
  }
  const keptShared = p.figures.filter((f) => p.sharedFigureKeys.has(f.originalKey)).length;
  return { title: p.job.title, status: p.job.status, files, pages: p.pages, questions: p.questions, importedQuestions: p.imported, bulkImportRuns: p.runs, figures: { total: p.figures.length, deleted: p.figures.filter((f) => f.originalKey && !p.sharedFigureKeys.has(f.originalKey)).length, keptShared }, spentInr: p.job.spentInr, blocked: p.blocked };
}

export interface DeletedJob {
  alreadyDeleted: boolean;
  title: string | null;
  storedFilesDeleted: number;
  storedFilesKept: number;
  figuresDeleted: number;
  bytesFreed: number;
  warnings: string[];
}

/**
 * Deletes an import job with its uploaded originals, page renders, work files and extracted figures.
 * Never touched: questions already in the Question Bank and their media (the Bulk Import copied them
 * into the media library), Bulk Import history, AI cost records and budget reservations (they stay in
 * the AI Cost Center), and any stored file or figure another import still uses.
 * One transaction holds the vault-files lock and the job row lock; stored bytes are moved aside inside
 * it (restored if it fails) and unlinked after commit. Repeating the call is harmless.
 */
export async function deleteJob(input: { jobId: string; actorId: string }): Promise<DeletedJob> {
  const moved: { from: string; to: string; bytes: number }[] = [];
  const fileIds: string[] = [];
  let result: DeletedJob;
  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_FILES_LOCK}::bigint)`;
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AiImportJob" WHERE "id" = ${input.jobId} FOR UPDATE`;
      if (!locked.length) return { alreadyDeleted: true, title: null, storedFilesDeleted: 0, storedFilesKept: 0, figuresDeleted: 0, bytesFreed: 0, warnings: [] };
      const p = (await deletePlan(tx, input.jobId))!;
      if (p.blocked) throw new ImportJobError(p.blocked, 409);
      fileIds.push(...p.job.files.map((f) => f.id));
      const aside = async (key: string) => {
        const from = vaultPath(key);
        const to = path.join(/* turbopackIgnore: true */ path.dirname(/* turbopackIgnore: true */ from), `.removing-${randomBytes(6).toString("hex")}`);
        try {
          const size = (await stat(from)).size;
          await rename(from, to);
          moved.push({ from, to, bytes: size });
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          return false;
        }
      };
      let storedFilesDeleted = 0;
      for (const k of p.fileKeys) if (!p.sharedFileKeys.has(k) && (await aside(k))) storedFilesDeleted++;
      let figuresDeleted = 0;
      for (const k of p.figureKeys) if (!p.sharedFigureKeys.has(k) && (await aside(k))) figuresDeleted++;
      await tx.aiImportJob.delete({ where: { id: input.jobId } });
      const bytes = moved.reduce((a, m) => a + m.bytes, 0);
      const detail = {
        jobId: input.jobId,
        title: p.job.title,
        status: p.job.status,
        examId: p.job.examId,
        createdAt: p.job.createdAt.toISOString(),
        files: p.job.files.map((f) => ({ id: f.id, name: f.originalName, role: f.role, sha256: f.sha256, bytes: f.bytes, pageCount: f.pageCount, sharedKept: !!f.storageKey && p.sharedFileKeys.has(f.storageKey) })),
        pages: p.pages,
        questions: p.questions,
        importedQuestions: p.imported,
        bulkImportRuns: p.runs,
        figures: p.figures.length,
        spentInr: p.job.spentInr,
        spentUsd: p.job.spentUsd,
      };
      await tx.aiImportCleanup.create({ data: { actorId: input.actorId, categories: ["JOB_DELETED"], fileCount: moved.length, bytes: BigInt(bytes), detail: detail as unknown as Prisma.InputJsonValue } });
      await tx.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_JOB_DELETED", entityType: "AiImportJob", entityId: input.jobId, metadata: detail as unknown as Prisma.InputJsonValue } });
      return { alreadyDeleted: false, title: p.job.title, storedFilesDeleted, storedFilesKept: p.fileKeys.filter((k) => p.sharedFileKeys.has(k)).length, figuresDeleted, bytesFreed: bytes, warnings: [] };
    }, VAULT_TX);
  } catch (e) {
    for (const m of moved) await rename(m.to, m.from).catch((err) => console.error(`[ai-import] could not restore ${m.from}: ${err instanceof Error ? err.message : err}`));
    throw e;
  }
  for (const m of moved) {
    await unlink(m.to).catch((e) => {
      console.error(`[ai-import] deleted job bytes left at ${m.to}: ${e instanceof Error ? e.message : e}`);
      result.warnings.push("A stored copy could not be deleted from disk. Run the Storage Manager scan later.");
    });
  }
  if (!result.alreadyDeleted) {
    await Promise.all([removeVaultDir("renders", input.jobId), removeVaultDir("work", input.jobId), ...fileIds.map((id) => removeVaultDir("tmp", id))]).catch(() => undefined);
  }
  return result;
}

const ROLE_LABEL: Record<AiImportFileRole, string> = { PAPER: "question paper", ANSWER_KEY: "answer key" };

export interface RemovedFile {
  name: string;
  role: AiImportFileRole;
  /** The stored bytes were deleted (false: another upload still uses the same file, or the copy was already gone). */
  storedFileDeleted: boolean;
  /** Other uploads (any job) that share the same stored file. */
  sharedWith: number;
  /** The analysis was cleared and must be run again. */
  analysisCleared: boolean;
  /** Set when the database change succeeded but the stored copy could not be deleted. */
  warning: string | null;
}

/**
 * Removes one uploaded paper or answer key from a job that has not started processing.
 * The job, file and reference checks run inside one transaction that row-locks the job;
 * any analysis is cleared (the job returns to Uploading and must be analyzed again).
 * The stored original is deleted only when no other upload (of any job) uses the same bytes.
 */
export async function removeFile(input: { jobId: string; fileId: string; actorId: string }): Promise<RemovedFile> {
  let moved: { from: string; to: string } | null = null;
  let result: RemovedFile;
  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_FILES_LOCK}::bigint)`;
      const locked = await tx.$queryRaw<{ status: AiImportJobStatus }[]>`SELECT "status" FROM "AiImportJob" WHERE "id" = ${input.jobId} FOR UPDATE`;
      if (!locked.length) throw new ImportJobError("Import job not found.", 404);
      const file = await tx.aiImportFile.findUnique({ where: { id: input.fileId } });
      if (!file || file.jobId !== input.jobId) throw new ImportJobError("That file is not part of this import.", 404);
      const blocked = fileRemovalBlockedReason(locked[0].status);
      if (blocked) throw new ImportJobError(blocked, 409);
      if (file.status === AiImportFileStatus.UPLOADING || file.status === AiImportFileStatus.REJECTED) throw new ImportJobError("This upload is unfinished or was refused — use Remove upload instead.", 409);
      if (file.status !== AiImportFileStatus.UPLOADED && file.status !== AiImportFileStatus.ANALYZED) throw new ImportJobError(`This file is ${file.status.toLowerCase()} and is kept as the original-paper record.`, 409);
      // Nothing extracted, matched or imported may point at the file.
      const [pages, questions, imported, figures, keyRows] = await Promise.all([
        tx.aiImportPage.count({ where: { fileId: file.id } }),
        tx.aiImportQuestion.count({ where: { fileId: file.id } }),
        tx.aiImportQuestion.count({ where: { fileId: file.id, OR: [{ questionId: { not: null } }, { bulkImportRunId: { not: null } }] } }),
        tx.aiImportFigure.count({ where: { fileId: file.id } }),
        tx.aiImportKeyEntry.count({ where: { OR: [{ keyFileId: file.id }, { paperFileId: file.id }] } }),
      ]);
      if (imported) throw new ImportJobError("Questions from this file are already in the Question Bank. The file is kept as their original-paper record.", 409);
      if (pages || questions || figures || keyRows) throw new ImportJobError("This file already has extracted pages, questions or answer-key entries. It is kept as their original-paper record.", 409);
      if (file.role === AiImportFileRole.PAPER) {
        const keys = await tx.aiImportFile.findMany({ where: { jobId: file.jobId, paperFileId: file.id }, select: { originalName: true } });
        if (keys.length) throw new ImportJobError(`Remove the answer key${keys.length === 1 ? "" : "s"} linked to this paper first (${keys.map((k) => `“${k.originalName}”`).join(", ")}).`, 409);
      }

      await tx.aiImportFile.delete({ where: { id: file.id } });
      const sharedWith = file.storageKey ? (await tx.aiImportFile.count({ where: { storageKey: file.storageKey, status: { not: AiImportFileStatus.PURGED } } })) + (await referenceKeysInUse(tx, [file.storageKey])).size : 0;
      // Analysis results may include the removed file: clear them and require a new analysis.
      const job = await tx.aiImportJob.findUniqueOrThrow({ where: { id: file.jobId }, select: { analysis: true, status: true } });
      const analysisCleared = job.analysis !== null || job.status === AiImportJobStatus.AWAITING_CONFIRMATION;
      await tx.aiImportJob.update({ where: { id: file.jobId }, data: { status: AiImportJobStatus.DRAFT, analysis: Prisma.DbNull, estimate: Prisma.DbNull, estCostInr: null, estCostUsd: null } });
      await tx.aiImportFile.updateMany({ where: { jobId: file.jobId, status: AiImportFileStatus.ANALYZED }, data: { status: AiImportFileStatus.UPLOADED } });

      // The stored original: moved aside now (restored if the transaction fails), deleted after commit.
      let storedFileDeleted = false;
      if (file.storageKey && sharedWith === 0) {
        const from = vaultPath(file.storageKey);
        const to = path.join(/* turbopackIgnore: true */ path.dirname(/* turbopackIgnore: true */ from), `.removing-${randomBytes(6).toString("hex")}`);
        try {
          await rename(from, to);
          moved = { from, to };
          storedFileDeleted = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const label = ROLE_LABEL[file.role];
      const message = `“${file.originalName}” (${label}) removed${analysisCleared ? " — analysis cleared; analyze the files again before confirming" : ""}${sharedWith ? `. The stored copy is kept: ${sharedWith} other upload${sharedWith === 1 ? "" : "s"} use${sharedWith === 1 ? "s" : ""} the same file` : ""}.`;
      const data = { fileId: file.id, name: file.originalName, role: file.role, sha256: file.sha256, bytes: file.bytes, pageCount: file.pageCount, uploadedAt: file.createdAt.toISOString(), storedFileDeleted, sharedWith, analysisCleared };
      await tx.aiImportEvent.create({ data: { jobId: file.jobId, type: "FILE_REMOVED", message: message.slice(0, 1000), data, actorId: input.actorId } });
      await tx.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_FILE_REMOVED", entityType: "AiImportJob", entityId: file.jobId, metadata: data } });
      return { name: file.originalName, role: file.role, storedFileDeleted, sharedWith, analysisCleared, warning: null };
    }, VAULT_TX);
  } catch (e) {
    const m = moved as { from: string; to: string } | null;
    if (m) await rename(m.to, m.from).catch((err) => console.error(`[ai-import] could not restore ${m.from}: ${err instanceof Error ? err.message : err}`));
    throw e;
  }
  await removeVaultDir("tmp", input.fileId).catch(() => undefined);
  const m = moved as { from: string; to: string } | null;
  if (m) {
    try {
      await unlink(m.to);
    } catch (e) {
      const warning = "The file was removed from this import, but its stored copy could not be deleted. Run the Storage Manager scan later.";
      console.error(`[ai-import] removed file bytes left at ${m.to}: ${e instanceof Error ? e.message : e}`);
      await logEvent(input.jobId, "FILE_REMOVED_STORAGE_KEPT", warning, { fileId: input.fileId }, input.actorId).catch(() => undefined);
      return { ...result, storedFileDeleted: false, warning };
    }
  }
  return result;
}

// ---- Safe reset of a processed job that produced nothing ------------------------------------

/** Statuses a job may be reset from (never while a worker may run it, never a cancelled record). */
const RESETTABLE: AiImportJobStatus[] = [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.PAUSED, AiImportJobStatus.PAUSED_BUDGET, AiImportJobStatus.FAILED, AiImportJobStatus.COMPLETED, AiImportJobStatus.COMPLETED_WITH_ISSUES];

export interface ResetCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Every condition for returning a processed job to an editable state, read with `db` (the reset's
 * own transaction, after it locked the job). All must hold: nothing extracted or imported, ₹0 spent
 * and no AI request ever reserved, no worker lease, and consistent stored files.
 */
async function resetChecks(db: Prisma.TransactionClient | typeof prisma, jobId: string): Promise<{ job: { status: AiImportJobStatus; config: Prisma.JsonValue; confirmedAt: Date | null } | null; checks: ResetCheck[] }> {
  const job = await db.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true, leaseOwner: true, leaseUntil: true, spentInr: true, spentUsd: true, config: true, confirmedAt: true, files: { select: { id: true, originalName: true, status: true, storageKey: true } } } });
  if (!job) return { job: null, checks: [{ label: "Import job exists", ok: false, detail: "Import job not found." }] };
  const [questions, figures, keyEntries, aiCalls, reservations] = await Promise.all([
    db.aiImportQuestion.count({ where: { jobId } }),
    db.aiImportFigure.count({ where: { jobId } }),
    db.aiImportKeyEntry.count({ where: { jobId } }),
    db.aiImportAiCall.count({ where: { jobId } }),
    db.aiBudgetReservation.count({ where: { requestKey: { startsWith: `qi:${jobId}:` } } }),
  ]);
  const cfg = (job.config ?? {}) as { lastImport?: unknown; importPlan?: unknown };
  const leased = !!job.leaseOwner && !!job.leaseUntil && job.leaseUntil > new Date();
  const missing: string[] = [];
  for (const f of job.files) {
    if (f.status === AiImportFileStatus.UPLOADING || f.status === AiImportFileStatus.REJECTED) continue;
    if (f.status === AiImportFileStatus.PURGED || !f.storageKey) missing.push(`${f.originalName} (${f.status.toLowerCase()})`);
    else {
      const ok = await stat(vaultPath(f.storageKey)).then((st) => st.isFile(), () => false);
      if (!ok) missing.push(`${f.originalName} (stored copy missing)`);
    }
  }
  const unfinished = job.files.filter((f) => f.status === AiImportFileStatus.UPLOADING).length;
  const checks: ResetCheck[] = [
    { label: "Processing has finished or stopped", ok: RESETTABLE.includes(job.status), detail: RESETTABLE.includes(job.status) ? `Status: ${job.status.toLowerCase().replace(/_/g, " ")}.` : `Status ${job.status.toLowerCase().replace(/_/g, " ")} cannot be reset${job.status === AiImportJobStatus.CANCELLED ? " (a cancelled import is kept as a record)" : job.status === AiImportJobStatus.DRAFT || job.status === AiImportJobStatus.AWAITING_CONFIRMATION ? " (it is already editable)" : " (a worker may be running it)"}.` },
    { label: "No worker is running the job", ok: !leased, detail: leased ? `A worker holds the job until ${job.leaseUntil!.toISOString().slice(11, 19)} UTC.` : "No active worker lease." },
    { label: "Zero extracted questions", ok: questions === 0, detail: `${questions} extracted question${questions === 1 ? "" : "s"}.` },
    { label: "No Question Bank records from this job", ok: questions === 0 && !cfg.lastImport && !cfg.importPlan, detail: cfg.lastImport || cfg.importPlan ? "An import into the Question Bank was requested or ran." : questions ? "Extracted questions exist (they may have been imported)." : "Nothing was imported." },
    { label: "₹0 AI expenditure", ok: job.spentInr === 0 && job.spentUsd === 0 && aiCalls === 0 && reservations === 0, detail: `Spent ₹${job.spentInr.toFixed(4)} / $${job.spentUsd.toFixed(6)}; ${aiCalls} AI call record${aiCalls === 1 ? "" : "s"}; ${reservations} budget reservation${reservations === 1 ? "" : "s"}.` },
    { label: "No figures or answer-key entries", ok: figures === 0 && keyEntries === 0, detail: `${figures} figure${figures === 1 ? "" : "s"}, ${keyEntries} answer-key entr${keyEntries === 1 ? "y" : "ies"}.` },
    { label: "Stored files are complete", ok: missing.length === 0 && unfinished === 0, detail: missing.length ? `Missing or purged: ${missing.join(", ")}.` : unfinished ? `${unfinished} upload(s) unfinished.` : `${job.files.length} file${job.files.length === 1 ? "" : "s"} present in the vault.` },
  ];
  return { job: { status: job.status, config: job.config, confirmedAt: job.confirmedAt }, checks };
}

/** Read-only: whether a reset would be allowed now, with every check (Job page). */
export async function resetEligibility(jobId: string): Promise<{ allowed: boolean; checks: ResetCheck[] }> {
  const { checks } = await resetChecks(prisma, jobId);
  return { allowed: checks.every((c) => c.ok), checks };
}

/**
 * Returns a processed job that produced nothing (zero questions, ₹0, no AI request, no import) to
 * Uploading, so its files can be removed or replaced and analyzed again. One transaction holds the
 * vault-files lock, the importer budget lock and the job row lock, re-checks everything inside it,
 * and is audited; any failed check refuses the reset and changes nothing.
 */
export async function resetJob(input: { jobId: string; actorId: string }): Promise<{ checks: ResetCheck[] }> {
  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VAULT_FILES_LOCK}::bigint)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY}::bigint)`;
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AiImportJob" WHERE "id" = ${input.jobId} FOR UPDATE`;
    if (!locked.length) throw new ImportJobError("Import job not found.", 404);
    const { job, checks } = await resetChecks(tx, input.jobId);
    const failed = checks.filter((c) => !c.ok);
    if (!job || failed.length) throw new ImportJobError(`Reset refused — nothing was changed. ${failed.map((c) => `${c.label}: ${c.detail}`).join(" ")}`, 409);
    const pages = await tx.aiImportPage.deleteMany({ where: { jobId: input.jobId } });
    await tx.aiImportFile.updateMany({ where: { jobId: input.jobId, status: { in: [AiImportFileStatus.ANALYZED, AiImportFileStatus.PROCESSED] } }, data: { status: AiImportFileStatus.UPLOADED, errorMessage: null } });
    await tx.aiImportJob.update({
      where: { id: input.jobId },
      data: { status: AiImportJobStatus.DRAFT, analysis: Prisma.DbNull, estimate: Prisma.DbNull, estCostInr: null, estCostUsd: null, config: Prisma.DbNull, confirmedAt: null, confirmedById: null, startedAt: null, finishedAt: null, pauseReason: null, errorMessage: null, leaseOwner: null, leaseUntil: null, heartbeatAt: null },
    });
    const previous = job.config as { modelPlan?: { tasks?: Record<string, { model?: string | null }> }; aiEnabled?: boolean } | null;
    const data = { previousStatus: job.status, previousConfirmedAt: job.confirmedAt?.toISOString() ?? null, previousAiEnabled: previous?.aiEnabled ?? null, previousModels: previous?.modelPlan?.tasks ? Object.fromEntries(Object.entries(previous.modelPlan.tasks).map(([k, v]) => [k, v?.model ?? null])) : null, pagesRemoved: pages.count, checks } as unknown as Prisma.InputJsonValue;
    await tx.aiImportEvent.create({ data: { jobId: input.jobId, type: "JOB_RESET", message: `Reset to editable (was ${job.status.toLowerCase().replace(/_/g, " ")}): every check passed — zero questions, ₹0 AI spend, nothing imported. ${pages.count} page record(s) cleared; the files are kept. Remove or replace files, then analyze again.`, data, actorId: input.actorId } });
    await tx.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_JOB_RESET", entityType: "AiImportJob", entityId: input.jobId, metadata: data } });
    return { checks };
  }, VAULT_TX);
  // Page renders and working files of the old run are no longer referenced.
  await removeVaultDir("renders", input.jobId).catch(() => undefined);
  await removeVaultDir("work", input.jobId).catch(() => undefined);
  return out;
}

/** Removes abandoned partial uploads of a job (tmp chunks). */
export async function discardUpload(fileId: string, actorId: string) {
  const file = await prisma.aiImportFile.findUnique({ where: { id: fileId } });
  if (!file || file.uploadedById !== actorId) throw new ImportJobError("Upload not found.", 404);
  if (file.status !== AiImportFileStatus.UPLOADING && file.status !== AiImportFileStatus.REJECTED) throw new ImportJobError("Only an unfinished or refused upload can be removed here.");
  await removeVaultDir("tmp", file.id).catch(() => undefined);
  await prisma.aiImportFile.delete({ where: { id: fileId } });
}
