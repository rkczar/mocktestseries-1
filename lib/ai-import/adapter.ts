import "server-only";
import crypto from "node:crypto";
import sharp from "sharp";
import { AiImportAnswerStatus, AiImportQuestionStatus, BulkImportDuplicateStrategy, BulkImportMode, BulkImportRowStatus, EditorialStage, ImportRowSeverity, QuestionStatus, type AiImportFigure, type AiImportJob, type AiImportQuestion, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { JSON_IMPORT_SCHEMA, JSON_PACKAGE_MANIFEST } from "@/lib/json-import";
import { buildZip, type ZipWriteEntry } from "@/lib/rich-import/zip-writer";
import { CHUNK_BYTES as BUNDLE_CHUNK, completeBundle, createBundle, processBundleSlice, putChunk } from "@/lib/rich-import/bundle";
import { referencedFilenames } from "@/lib/rich-import/validate";
import { stageImportRun, validateImportRun, StageImportError } from "@/lib/bulk-import-stage";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import { mediaStorage } from "@/lib/media-storage";
import { publishQuestions } from "@/lib/question-publish-policy";
import { ISSUE_DEFS, issueLabel, type ImporterSettings } from "@/lib/ai-import/config";
import { readVault } from "@/lib/ai-import/vault";
import { effective, IMPORTABLE } from "@/lib/ai-import/post";
import { logEvent } from "@/lib/ai-import/jobs";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * THE integration contract with the existing Bulk Import (docs: AI-IMPORTER.md).
 * Approved questions become a Rich-mode JSON package (questions.json + their
 * images) that goes through exactly the code an admin's upload uses:
 *   createBundle/putChunk/completeBundle → stageImportRun → processBundleSlice
 *   → validateImportRun → executeBulkImport
 * so validation, duplicate handling (strategy SKIP), DRAFT-only saving,
 * Import History and "Delete Questions Created By This Import" all apply.
 * Nothing here writes Question rows directly, except recording the answer's
 * provenance (Question.answerVerification) on the rows the import created.
 */

export type ImportMode = "DRAFT" | "PUBLISH_ALL" | "PUBLISH_SELECTED";

export interface ImportPlan {
  mode: ImportMode;
  questionIds: string[] | null;
  requestedById: string;
  requestedAt: string;
}

const MAX_ROWS_PER_RUN = 500;
/** Rich-import warnings that do not need a human (papers have no explanations). Anything else keeps the review flag. */
const BENIGN_ROW_WARNINGS = [/^Explanation: missing/];

const answerVerification = (q: AiImportQuestion): string =>
  q.answerConfirmedById && q.answerStatus !== AiImportAnswerStatus.OFFICIAL_MATCHED ? "ADMIN_CONFIRMED" : q.answerStatus === AiImportAnswerStatus.OFFICIAL_MATCHED ? "OFFICIAL_KEY" : q.answerStatus === AiImportAnswerStatus.INDEPENDENTLY_VERIFIED ? "INDEPENDENTLY_VERIFIED" : "UNVERIFIED";

/** Why a question cannot be imported now (null = importable). */
export function importBlocker(q: AiImportQuestion & { figures: AiImportFigure[] }, settings: ImporterSettings): string | null {
  if (q.questionId) return "already imported";
  if (q.status === AiImportQuestionStatus.REJECTED) return "rejected";
  if (q.status === AiImportQuestionStatus.NOT_IMPORTABLE) return "not importable";
  if (q.status === AiImportQuestionStatus.DUPLICATE && !q.allowDuplicate) return "duplicate";
  const blocking = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.blocking && !(q.allowDuplicate && c.startsWith("DUPLICATE")));
  if (blocking.length) return blocking.map(issueLabel).join(", ");
  if (!q.finalAnswer.length) return "no answer";
  if (q.answerStatus === AiImportAnswerStatus.UNVERIFIED && !q.answerConfirmedById && !q.sourceAnswer.length && !settings.publish.allowUnverifiedAnswers) return "answer is only an AI opinion";
  if (!q.subjectId) return "no subject";
  const e = effective(q);
  if (!IMPORTABLE.has(q.questionType) || e.options.length !== 4) return "not a 4-option question";
  const stemImgs = q.figures.filter((f) => f.owner !== "OPTION").length;
  if (stemImgs > 8) return "more than 8 question images";
  for (const l of ["A", "B", "C", "D"]) if (q.figures.filter((f) => f.owner === "OPTION" && f.optionLabel === l).length > 3) return `more than 3 images on option ${l}`;
  return null;
}

/** Why an IMPORTED question may not be published by the importer (null = eligible). */
export function publishBlocker(q: AiImportQuestion & { figures: AiImportFigure[] }, settings: ImporterSettings): string | null {
  const flags = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.publishBlocking && !(q.allowDuplicate && c.startsWith("DUPLICATE")));
  if (flags.length) return flags.map(issueLabel).join(", ");
  const answerOk =
    q.answerStatus === AiImportAnswerStatus.OFFICIAL_MATCHED ||
    q.answerStatus === AiImportAnswerStatus.INDEPENDENTLY_VERIFIED ||
    !!q.answerConfirmedById ||
    (q.answerStatus === AiImportAnswerStatus.UNVERIFIED && settings.publish.allowUnverifiedAnswers);
  if (!answerOk) return q.answerStatus === AiImportAnswerStatus.UNVERIFIED ? "answer unverified (policy does not allow publishing unverified answers)" : "no verified answer";
  if (settings.publish.requireTopic && !q.topicId) return "no topic";
  if (q.figures.some((f) => f.mappingStatus !== "OK" && !f.confirmedById)) return "figure not confirmed";
  return null;
}

function reviewFlags(q: AiImportQuestion, settings: ImporterSettings): string[] {
  const flags = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.publishBlocking).map(issueLabel);
  if (q.answerStatus === AiImportAnswerStatus.UNVERIFIED && !q.answerConfirmedById && !settings.publish.allowUnverifiedAnswers) flags.push("Answer unverified");
  if (settings.publish.requireTopic && !q.topicId) flags.push("No topic");
  return [...new Set(flags)];
}

async function packageImage(f: AiImportFigure): Promise<{ name: string; data: Buffer }> {
  const bytes = await readVault(f.originalKey);
  const ext = f.originalMime === "image/jpeg" ? "jpg" : f.originalMime === "image/png" ? "png" : f.originalMime === "image/webp" ? "webp" : null;
  if (ext) return { name: `${f.originalSha256}.${ext}`, data: bytes };
  // GIF/BMP/TIFF originals: a lossless PNG copy for the package; the vault original is unchanged.
  return { name: `${f.originalSha256}.png`, data: await sharp(bytes).png().toBuffer() };
}

interface BuiltPackage {
  zip: Buffer;
  codes: Map<string, string>;
  expectedImages: Map<string, { question: number; options: Record<string, number> }>;
}

async function buildPackage(job: AiImportJob, rows: (AiImportQuestion & { figures: AiImportFigure[] })[], names: { subjects: Map<string, string>; topics: Map<string, string> }, settings: ImporterSettings, paperCode: string | null): Promise<BuiltPackage> {
  const files = new Map<string, Buffer>();
  const codes = new Map<string, string>();
  const expectedImages: BuiltPackage["expectedImages"] = new Map();
  const questions: unknown[] = [];
  for (const q of rows) {
    const e: ExtractedQuestion = effective(q);
    const code = `AIQ-${q.id}`;
    codes.set(code, q.id);
    const img = async (f: AiImportFigure, i: number) => {
      const p = await packageImage(f);
      files.set(p.name, p.data);
      const alt = (f.description && f.description.length >= 3 ? f.description : `Figure ${i + 1} of question ${e.label}`).slice(0, 300);
      return { file: p.name, alt };
    };
    const usable = q.figures.filter((f) => f.mappingStatus !== "MISSING" && f.originalKey);
    const stemFigs = usable.filter((f) => f.owner !== "OPTION");
    const stemImages = [];
    for (const [i, f] of stemFigs.entries()) stemImages.push(await img(f, i));
    const options = [];
    const optionCounts: Record<string, number> = {};
    for (const o of e.options.slice(0, 4)) {
      const of = usable.filter((f) => f.owner === "OPTION" && f.optionLabel === o.label);
      const images = [];
      for (const [i, f] of of.entries()) images.push(await img(f, i));
      optionCounts[o.label] = images.length;
      options.push({ label: o.label, text: o.text, ...(images.length ? { images } : {}) });
    }
    expectedImages.set(code, { question: stemImages.length, options: optionCounts });
    const prefix = [e.instructions, e.passage].filter((x) => x && x.trim()).join("\n\n");
    const stem = prefix ? `${prefix}\n\n${e.stem}` : e.stem;
    const hasLists = q.questionType === "MATCH_THE_FOLLOWING" && e.listI?.length && e.listII?.length;
    const type = q.questionType === "MULTIPLE_CORRECT" ? "MULTIPLE_CORRECT" : hasLists ? "MATCH_THE_FOLLOWING" : "SINGLE_CORRECT";
    const rich = e.contentFormat === "RICH_V1" || stemImages.length > 0 || options.some((o) => "images" in o);
    const flags = reviewFlags(q, settings);
    questions.push({
      code,
      ...(e.number !== null ? { questionNumber: e.number } : {}),
      ...(job.year ? { year: job.year } : {}),
      ...(paperCode ? { paperCode } : {}),
      subject: names.subjects.get(q.subjectId!)!,
      ...(q.topicId && names.topics.get(q.topicId) ? { topic: names.topics.get(q.topicId) } : {}),
      type,
      contentFormat: rich ? "RICH_V1" : "PLAIN",
      question: stemImages.length ? { text: rich && e.contentFormat !== "RICH_V1" ? escapeForRich(stem) : stem, images: stemImages } : rich && e.contentFormat !== "RICH_V1" ? escapeForRich(stem) : stem,
      options: rich && e.contentFormat !== "RICH_V1" ? options.map((o) => ({ ...o, text: escapeForRich(o.text) })) : options,
      correct: q.finalAnswer,
      difficulty: e.hints?.difficulty && ["EASY", "MEDIUM", "HARD"].includes(e.hints.difficulty.toUpperCase()) ? e.hints.difficulty.toUpperCase() : "MEDIUM",
      ...(job.previousYearPaperId ? { source: "PYQ" } : {}),
      ...(e.hints?.explanation ? { explanation: e.hints.explanation } : {}),
      ...(flags.length ? { review: { required: true, reason: `AI importer: ${flags.join(", ")}`.slice(0, 480) } } : {}),
      ...(hasLists ? { matchLists: { listI: e.listI!.map((x) => ({ key: x.key, text: x.text })), listII: e.listII!.map((x) => ({ key: x.key, text: x.text })) } } : {}),
    });
  }
  const manifest = Buffer.from(JSON.stringify({ schema: JSON_IMPORT_SCHEMA, questions }, null, 1), "utf8");
  const entries: ZipWriteEntry[] = [{ name: JSON_PACKAGE_MANIFEST, data: manifest }, ...[...files].map(([name, data]) => ({ name, data, store: true }))];
  return { zip: buildZip(entries), codes, expectedImages };
}

/** Plain text gaining images must become RICH_V1; a literal "$" must then stay literal. */
function escapeForRich(s: string): string {
  return s.replace(/(?<!\\)\$/g, "\\$");
}

async function uploadBundle(zip: Buffer, actorId: string, filename: string): Promise<string> {
  const bundle = await createBundle({ actorId, filename, declaredBytes: zip.length });
  for (let i = 0, idx = 0; i < zip.length; i += BUNDLE_CHUNK, idx++) await putChunk({ bundleId: bundle.id, actorId, index: idx, bytes: zip.subarray(i, i + BUNDLE_CHUNK) });
  const done = await completeBundle({ bundleId: bundle.id, actorId });
  if (done.status === "FAILED") throw new Error(`The generated package was refused by the Bulk Import ZIP check: ${done.errorMessage}`);
  return bundle.id;
}

/** Runs one import batch through the existing pipeline and reconciles every row back. */
async function importBatch(job: AiImportJob, rows: (AiImportQuestion & { figures: AiImportFigure[] })[], plan: ImportPlan, batchNo: number, settings: ImporterSettings): Promise<{ imported: string[]; skipped: number; failed: number }> {
  const subjectIds = [...new Set(rows.map((r) => r.subjectId!))];
  const topicIds = [...new Set(rows.map((r) => r.topicId).filter((x): x is string => !!x))];
  const [subjects, topics, paper] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
    prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true } }),
    job.previousYearPaperId ? prisma.previousYearPaper.findUnique({ where: { id: job.previousYearPaperId }, select: { paperCode: true } }) : null,
  ]);
  const names = { subjects: new Map(subjects.map((s) => [s.id, s.name])), topics: new Map(topics.map((t) => [t.id, t.name])) };
  const pkg = await buildPackage(job, rows, names, settings, paper?.paperCode ?? null);
  const idKey = `aiimp-${crypto.createHash("sha256").update(`${job.id}|${batchNo}|${rows.map((r) => r.id).sort().join(",")}`).digest("hex").slice(0, 40)}`;

  // Retry-safe: the idempotency key returns the run created by an interrupted earlier attempt.
  let runId: string;
  const previous = await prisma.bulkImportRun.findUnique({ where: { idempotencyKey: idKey }, select: { id: true } });
  if (previous) runId = previous.id;
  else {
    const bundleId = await uploadBundle(pkg.zip, plan.requestedById, `ai-import-${job.id.slice(-8)}-${batchNo}.zip`);
    try {
      const staged = await stageImportRun({
        actorId: plan.requestedById,
        file: null,
        label: `AI Importer — ${job.title}${batchNo > 1 ? ` (part ${batchNo})` : ""}`.slice(0, 190),
        examId: job.examId,
        examYear: job.year,
        previousYearPaperId: job.previousYearPaperId,
        mockTestId: null,
        importSource: "QUESTION_BANK",
        duplicateStrategy: BulkImportDuplicateStrategy.SKIP,
        importMode: BulkImportMode.RICH,
        bundleId,
        jsonPackage: true,
        idempotencyKey: idKey,
      });
      runId = staged.runId;
    } catch (e) {
      if (e instanceof StageImportError) throw new Error(`Bulk Import refused the package: ${e.body.error}`);
      throw e;
    }
  }
  await prisma.aiImportQuestion.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { bulkImportRunId: runId } });
  await logEvent(job.id, "IMPORT_STAGED", `Batch ${batchNo}: ${rows.length} question(s) staged as Bulk Import run ${runId}`, { runId, rows: rows.length }, plan.requestedById);

  const run = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.bundleId) {
    const wanted = await referencedFilenames(runId);
    for (let i = 0; i < 500; i++) {
      const r = await processBundleSlice({ bundleId: run.bundleId, actorId: plan.requestedById, wanted, sliceMs: 15_000 });
      if (r.done) break;
    }
  }
  if (run.status === "UPLOADED" || run.status === "READY" || run.status === "VALIDATING") await validateImportRun(runId);
  // Same scoping as the Bulk Import's own "Import Valid Only": the non-ERROR rows by id, with their
  // warnings acknowledged (the importer already reported them). ERROR rows are left untouched and
  // reported back as "not accepted by the Bulk Import".
  const importable = await prisma.bulkImportRow.findMany({ where: { runId, status: BulkImportRowStatus.PENDING, severity: { not: ImportRowSeverity.ERROR }, removedFromImport: false }, select: { id: true } });
  if (importable.length) await executeBulkImport({ runId, adminUserId: plan.requestedById, rowIds: importable.map((r) => r.id), acknowledgeWarnings: true });

  // Reconcile every row back to its importer question.
  const bulkRows = await prisma.bulkImportRow.findMany({ where: { runId }, select: { id: true, status: true, severity: true, questionId: true, errors: true, warnings: true, errorMessage: true, rawData: true } });
  const imported: string[] = [];
  let skipped = 0;
  let failed = 0;
  const storage = mediaStorage();
  for (const br of bulkRows) {
    const code = (br.rawData as { questionCode?: string }).questionCode ?? "";
    const qid = pkg.codes.get(code);
    if (!qid) continue;
    const q = rows.find((r) => r.id === qid)!;
    if (br.status === BulkImportRowStatus.SUCCESS && br.questionId) {
      // Round trip: the saved question must hold every expected image, each file present.
      const assets = await prisma.questionAsset.findMany({ where: { questionId: br.questionId }, select: { role: true, optionLabel: true, storageKey: true } });
      const exp = pkg.expectedImages.get(code)!;
      const stemOk = assets.filter((a) => a.role === "QUESTION").length === exp.question;
      const optOk = Object.entries(exp.options).every(([l, n]) => assets.filter((a) => a.role === "OPTION" && a.optionLabel === l).length === n);
      const filesOk = (await Promise.all(assets.map((a) => storage.exists(a.storageKey)))).every(Boolean);
      const roundTripOk = stemOk && optOk && filesOk;
      await prisma.question.update({
        where: { id: br.questionId },
        data: {
          answerVerification: answerVerification(q),
          ...(roundTripOk ? {} : { reviewRequired: true, reviewReason: "AI importer: an image did not survive the import — check the question's images", editorialStage: EditorialStage.NEEDS_REVIEW }),
        },
      });
      await prisma.aiImportQuestion.update({
        where: { id: q.id },
        data: {
          status: AiImportQuestionStatus.IMPORTED,
          questionId: br.questionId,
          bulkImportRowId: br.id,
          importedAt: new Date(),
          ...(roundTripOk ? {} : { issueCodes: [...new Set([...q.issueCodes, "IMAGE_MISSING"])] }),
        },
      });
      imported.push(q.id);
    } else if (br.status === BulkImportRowStatus.SKIPPED) {
      skipped++;
      await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.DUPLICATE, bulkImportRowId: br.id, duplicateOfQuestionId: br.questionId, duplicateKind: q.duplicateKind ?? "EXACT", issueCodes: [...new Set([...q.issueCodes, "DUPLICATE_EXISTING"])] } });
    } else {
      failed++;
      const errs = (Array.isArray(br.errors) ? (br.errors as string[]) : []).concat(br.errorMessage ? [br.errorMessage] : []);
      await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.IMPORT_FAILED, bulkImportRowId: br.id, issues: { ...((q.issues as object) ?? {}), IMPORT: errs.slice(0, 3).join(" · ").slice(0, 600) || "The Bulk Import did not accept this row." } as Prisma.InputJsonValue } });
    }
  }
  await logEvent(job.id, "IMPORT_DONE", `Batch ${batchNo}: ${imported.length} imported as draft, ${skipped} skipped as duplicates, ${failed} not accepted by the Bulk Import`, { runId, imported: imported.length, skipped, failed }, plan.requestedById);
  return { imported, skipped, failed };
}

/** Worker step for an IMPORTING job: import, then (optionally) publish eligible questions. */
export async function runImport(job: AiImportJob, plan: ImportPlan, settings: ImporterSettings): Promise<{ imported: number; published: number; skipped: number; failed: number; notImported: number; notPublished: number }> {
  const scope = plan.questionIds ? { id: { in: plan.questionIds } } : {};
  const all = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id, ...scope }, include: { figures: true }, orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }] });
  const candidates = all.filter((q) => !importBlocker(q, settings));
  const notImported = all.filter((q) => !q.questionId && importBlocker(q, settings)).length;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0, batch = 1; i < candidates.length; i += MAX_ROWS_PER_RUN, batch++) {
    const r = await importBatch(job, candidates.slice(i, i + MAX_ROWS_PER_RUN), plan, batch, settings);
    imported += r.imported.length;
    skipped += r.skipped;
    failed += r.failed;
  }
  let published = 0;
  let notPublished = 0;
  if (plan.mode !== "DRAFT") {
    const pool = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id, status: AiImportQuestionStatus.IMPORTED, questionId: { not: null }, ...scope }, include: { figures: true } });
    const eligible: typeof pool = [];
    for (const q of pool) {
      const why = publishBlocker(q, settings);
      if (why) {
        notPublished++;
        continue;
      }
      const row = q.bulkImportRowId ? await prisma.bulkImportRow.findUnique({ where: { id: q.bulkImportRowId }, select: { warnings: true } }) : null;
      const warnings = Array.isArray(row?.warnings) ? (row!.warnings as string[]) : [];
      if (warnings.some((w) => !BENIGN_ROW_WARNINGS.some((re) => re.test(w)))) {
        notPublished++;
        await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { issues: { ...((q.issues as object) ?? {}), PUBLISH: `Kept as draft — Bulk Import warning: ${warnings.find((w) => !BENIGN_ROW_WARNINGS.some((re) => re.test(w)))}`.slice(0, 600) } as Prisma.InputJsonValue } });
        continue;
      }
      eligible.push(q);
    }
    if (eligible.length) {
      const qids = eligible.map((q) => q.questionId!);
      // Automated review under the configured policy: only questions that passed every
      // importer check and carry no Bulk Import warning except "explanation missing".
      await prisma.question.updateMany({ where: { id: { in: qids }, status: QuestionStatus.DRAFT }, data: { reviewRequired: false, reviewReason: null, editorialStage: EditorialStage.DRAFT } });
      await prisma.auditLog.create({ data: { actorId: plan.requestedById, action: "AI_IMPORT_AUTOCHECK_CLEARED", entityType: "AiImportJob", entityId: job.id, metadata: { questionIds: qids, policy: { allowUnverifiedAnswers: settings.publish.allowUnverifiedAnswers, requireTopic: settings.publish.requireTopic } } } });
      const result = await publishQuestions({ ids: qids, actorId: plan.requestedById, source: "AI_IMPORTER" });
      const actuallyPublished = await prisma.question.findMany({ where: { id: { in: qids }, status: QuestionStatus.PUBLISHED }, select: { id: true } });
      const pubIds = new Set(actuallyPublished.map((x) => x.id));
      for (const q of eligible) {
        if (pubIds.has(q.questionId!)) {
          await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.PUBLISHED, publishedAt: new Date() } });
          published++;
        } else {
          notPublished++;
          const b = result.blocked.find((x) => x.id === q.questionId);
          await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { issues: { ...((q.issues as object) ?? {}), PUBLISH: `Not published: ${b?.reasons.map((r) => r.detail).join(" ") ?? "publishing policy"}`.slice(0, 600) } as Prisma.InputJsonValue } });
        }
      }
    }
    await logEvent(job.id, "PUBLISHED", `${published} question(s) published; ${notPublished} kept as draft (exceptions listed in Review Exceptions)`, { published, notPublished }, plan.requestedById);
  }
  return { imported, published, skipped, failed, notImported, notPublished };
}
