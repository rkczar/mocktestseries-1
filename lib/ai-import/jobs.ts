import "server-only";
import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportPaperType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { checkFilename, detectFile } from "@/lib/ai-import/detect";
import { pdfInfo } from "@/lib/ai-import/pdf";
import { adoptFile, tmpDir, removeVaultDir } from "@/lib/ai-import/vault";
import { kickWorker } from "@/lib/ai-import/kick";
import { estimateJobCost } from "@/lib/ai-import/estimate";
import type { JobAnalysis } from "@/lib/ai-import/analyze";

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

export interface JobContextInput {
  examId: string;
  paperType: AiImportPaperType;
  subjectId: string | null;
  year: number | null;
  paperCode: string | null;
  previousYearPaperId: string | null;
}

/** Checks the exam context against the existing taxonomy (never creates anything). */
export async function validateContext(c: JobContextInput): Promise<void> {
  const exam = await prisma.exam.findUnique({ where: { id: c.examId }, select: { id: true } });
  if (!exam) throw new ImportJobError("Select an existing exam.");
  if (c.paperType === AiImportPaperType.SINGLE_SUBJECT) {
    if (!c.subjectId) throw new ImportJobError("Select the subject of this single-subject paper.");
    const link = await prisma.examSubject.findUnique({ where: { examId_subjectId: { examId: c.examId, subjectId: c.subjectId } }, select: { id: true } });
    if (!link) throw new ImportJobError("That subject is not configured for the selected exam.");
  }
  if (c.year !== null && (c.year < 1950 || c.year > 2100)) throw new ImportJobError("Enter a valid 4-digit year.");
  if (c.previousYearPaperId) {
    const paper = await prisma.previousYearPaper.findUnique({ where: { id: c.previousYearPaperId }, select: { examId: true } });
    if (!paper || paper.examId !== c.examId) throw new ImportJobError("The selected Previous Year Paper does not belong to the selected exam.");
  }
}

export async function createJob(input: JobContextInput & { actorId: string; title: string; budgetInr: number }): Promise<string> {
  await validateContext(input);
  const settings = await getImporterSettings();
  const title = input.title.trim().slice(0, 160) || "Untitled import";
  const budget = Number.isFinite(input.budgetInr) && input.budgetInr >= 0 ? Math.min(input.budgetInr, 100_000) : settings.budget.defaultJobCapInr;
  const job = await prisma.aiImportJob.create({
    data: {
      title,
      examId: input.examId,
      paperType: input.paperType,
      subjectId: input.paperType === AiImportPaperType.SINGLE_SUBJECT ? input.subjectId : null,
      year: input.year,
      paperCode: input.paperCode?.trim().slice(0, 40) || null,
      previousYearPaperId: input.previousYearPaperId,
      createdById: input.actorId,
      budgetInr: budget,
      status: AiImportJobStatus.DRAFT,
    },
  });
  await logEvent(job.id, "CREATED", `Import "${title}" created`, { examId: input.examId, paperType: input.paperType, budgetInr: budget }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_JOB_CREATED", entityType: "AiImportJob", entityId: job.id, metadata: { title, examId: input.examId } } });
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
  const adopted = await adoptFile(assembled, "files", kind === "jpeg" ? "jpg" : file.ext);
  await removeVaultDir("tmp", file.id).catch(() => undefined);
  const twin = await prisma.aiImportFile.findFirst({ where: { sha256: adopted.sha256, id: { not: file.id }, status: { not: AiImportFileStatus.PURGED } }, select: { jobId: true, originalName: true } });
  const retainUntil = new Date(Date.now() + settings.retention.originalDays * 86_400_000);
  await prisma.aiImportFile.update({
    where: { id: file.id },
    data: { status: AiImportFileStatus.UPLOADED, bytes: adopted.bytes, sha256: adopted.sha256, storageKey: adopted.key, mime: det.mime, pageCount, retainUntil, detected: { kind, ...(twin ? { identicalTo: { jobId: twin.jobId, name: twin.originalName } } : {}) } },
  });
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
export async function confirmJob(input: JobContextInput & { jobId: string; actorId: string; budgetInr: number }) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status !== AiImportJobStatus.AWAITING_CONFIRMATION) throw new ImportJobError("Only an analyzed import can be confirmed.");
  await validateContext(input);
  if (!Number.isFinite(input.budgetInr) || input.budgetInr < 0) throw new ImportJobError("Enter a valid job budget.");
  const settings = await getImporterSettings();
  // Re-price with the settings that will be frozen on the job: stop before any AI call when
  // the estimate cannot be priced or exceeds the job budget (the budget is never raised for you).
  const analysis = job.analysis as unknown as JobAnalysis | null;
  const facts = (role: string) => (analysis?.files ?? []).filter((f) => f.role === role && f.facts).map((f) => f.facts!);
  const estimate = await estimateJobCost({ paperFacts: facts(AiImportFileRole.PAPER), keyFacts: facts(AiImportFileRole.ANSWER_KEY), settings });
  // Lines without a usable model never run (their questions are flagged instead), so only priced lines count.
  const willCallAi = settings.aiEnabled && estimate.lines.some((l) => l.calls > 0 && l.model !== null && l.problem === null);
  if (willCallAi) {
    if (estimate.totalInr === null) throw new ImportJobError(`The AI cost cannot be estimated (${estimate.notes[0] ?? "missing model price or exchange rate"}). Nothing was started.`);
    if (estimate.totalInr > Math.min(input.budgetInr, 100_000)) {
      throw new ImportJobError(`The estimated AI cost (₹${estimate.totalInr.toFixed(2)}) is above the job budget (₹${input.budgetInr.toFixed(2)}). Nothing was started — reduce the sample or raise the budget deliberately.`);
    }
  }
  await prisma.aiImportJob.update({
    where: { id: job.id },
    data: {
      estCostInr: estimate.totalInr,
      estCostUsd: estimate.totalUsd,
      estimate: estimate as unknown as Prisma.InputJsonValue,
      examId: input.examId,
      paperType: input.paperType,
      subjectId: input.paperType === AiImportPaperType.SINGLE_SUBJECT ? input.subjectId : null,
      year: input.year,
      paperCode: input.paperCode?.trim().slice(0, 40) || null,
      previousYearPaperId: input.previousYearPaperId,
      budgetInr: Math.min(input.budgetInr, 100_000),
      status: AiImportJobStatus.QUEUED,
      confirmedAt: new Date(),
      confirmedById: input.actorId,
      config: JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonValue,
    },
  });
  await logEvent(job.id, "CONFIRMED", `Processing confirmed with a job budget of ₹${input.budgetInr.toFixed(2)}`, { paperType: input.paperType, budgetInr: input.budgetInr, aiEnabled: settings.aiEnabled, models: settings.models }, input.actorId);
  kickWorker();
}

export async function pauseJob(jobId: string, actorId: string) {
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: { in: [AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING] } }, data: { status: AiImportJobStatus.PAUSED, pauseReason: "Paused by an administrator" } });
  if (!r.count) throw new ImportJobError("Only a queued or processing import can be paused.");
  await logEvent(jobId, "PAUSED", "Paused by an administrator", undefined, actorId);
}

/** Resume after a manual or budget pause (optionally with a raised job budget). */
export async function resumeJob(jobId: string, actorId: string, newBudgetInr?: number | null) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status !== AiImportJobStatus.PAUSED && job.status !== AiImportJobStatus.PAUSED_BUDGET && job.status !== AiImportJobStatus.FAILED) throw new ImportJobError("Only a paused or failed import can be resumed.");
  const budget = newBudgetInr !== null && newBudgetInr !== undefined && Number.isFinite(newBudgetInr) ? Math.min(Math.max(newBudgetInr, 0), 100_000) : job.budgetInr;
  if (job.status === AiImportJobStatus.PAUSED_BUDGET && budget <= job.spentInr) throw new ImportJobError("Raise the job budget above what was already spent to continue.");
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: AiImportJobStatus.QUEUED, pauseReason: null, errorMessage: null, budgetInr: budget, leaseOwner: null, leaseUntil: null } });
  // Failed pages get one more attempt on resume (never automatically in a loop).
  await prisma.aiImportPage.updateMany({ where: { jobId, status: "FAILED" }, data: { status: "PENDING", errorMessage: null } });
  await logEvent(jobId, "RESUMED", `Resumed${budget !== job.budgetInr ? ` with the job budget raised to ₹${budget.toFixed(2)}` : ""}`, { budgetInr: budget }, actorId);
  kickWorker();
}

export async function cancelJob(jobId: string, actorId: string) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (job.status === AiImportJobStatus.IMPORTING) throw new ImportJobError("The import into the Question Bank is running; wait for it to finish.");
  if (job.status === AiImportJobStatus.CANCELLED) return;
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: AiImportJobStatus.CANCELLED, cancelledAt: new Date(), leaseOwner: null, leaseUntil: null } });
  await logEvent(jobId, "CANCELLED", "Cancelled by an administrator. Questions already imported stay in the Question Bank (use Import History rollback to remove them).", undefined, actorId);
}

/** Removes abandoned partial uploads of a job (tmp chunks). */
export async function discardUpload(fileId: string, actorId: string) {
  const file = await prisma.aiImportFile.findUnique({ where: { id: fileId } });
  if (!file || file.uploadedById !== actorId) throw new ImportJobError("Upload not found.", 404);
  if (file.status !== AiImportFileStatus.UPLOADING && file.status !== AiImportFileStatus.REJECTED) throw new ImportJobError("Only an unfinished or refused upload can be removed here.");
  await removeVaultDir("tmp", file.id).catch(() => undefined);
  await prisma.aiImportFile.delete({ where: { id: fileId } });
}
