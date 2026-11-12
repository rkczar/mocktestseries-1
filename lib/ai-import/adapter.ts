import "server-only";
import { formulaPlain, structureOnlyText } from "@/lib/ai-import/script-text";
import crypto from "node:crypto";
import sharp from "sharp";
import { AiImportAnswerStatus, AiImportQuestionStatus, BulkImportDuplicateStrategy, BulkImportMode, BulkImportRowStatus, EditorialStage, ImportRowSeverity, QuestionStatus, type AiImportFigure, type AiImportJob, type AiImportQuestion, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { JSON_IMPORT_SCHEMA, JSON_PACKAGE_MANIFEST, questionProblems } from "@/lib/json-import";
import { buildZip, type ZipWriteEntry } from "@/lib/rich-import/zip-writer";
import { CHUNK_BYTES as BUNDLE_CHUNK, completeBundle, createBundle, processBundleSlice, putChunk } from "@/lib/rich-import/bundle";
import { referencedFilenames } from "@/lib/rich-import/validate";
import { stageImportRun, validateImportRun, StageImportError } from "@/lib/bulk-import-stage";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import { mediaStorage } from "@/lib/media-storage";
import { publishQuestions } from "@/lib/question-publish-policy";
import { ISSUE_DEFS, issueLabel, type ImporterSettings } from "@/lib/ai-import/config";
import { explanationIsHeading } from "@/lib/ai-import/local-parse";
import { readVault } from "@/lib/ai-import/vault";
import { effective, IMPORTABLE } from "@/lib/ai-import/post";
import { logEvent } from "@/lib/ai-import/jobs";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { CHECK_NAMES, CHECK_STATUS_LABELS, approvalOutdatedBy, checksAllowReady } from "@/lib/ai-import/checks";
import { fingerprintsOf, verifyState } from "@/lib/ai-import/verify-core";

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

/** The answer is verified: the official key matched it, or an administrator confirmed it (never an AI opinion). */
export function answerVerified(q: Pick<AiImportQuestion, "answerStatus" | "answerConfirmedById" | "finalAnswer">): boolean {
  if (!q.finalAnswer.length) return false;
  return q.answerStatus === AiImportAnswerStatus.OFFICIAL_MATCHED || !!q.answerConfirmedById;
}

/**
 * Why a question cannot be imported now (null = importable). Only questions an administrator approved
 * enter the Question Bank; `ignoreApproval` answers "would it be importable once approved?".
 */
export function importBlocker(q: AiImportQuestion & { figures: AiImportFigure[] }, settings: ImporterSettings, opts: { ignoreApproval?: boolean } = {}): string | null {
  if (q.questionId) return "already imported";
  // A question the official key DELETED (withdrawn / bonus) is kept in the import as a historical record only: never
  // imported, so it can never reach a test or practice — whatever answer an administrator might set (2026-11-11).
  if (q.answerStatus === AiImportAnswerStatus.WITHDRAWN) return "deleted in the official answer key (kept for the record, never imported)";
  // Subject / topic still under academic review (ambiguous or unmapped): never imported, so never published, until an
  // academic decision clears the status (lib/ai-import/review.ts setAcademicReview).
  // The refusal says how to clear it: choosing a subject / topic alone does not (2026-11-11: 68 refusals on 29 FSO questions).
  if (q.academicReview) return `taxonomy pending academic review (${q.academicReview}) — choosing a subject/topic does not clear this hold: a Master Admin confirms the mapping with "Clear hold — mapping confirmed" in the Academic review hold card on this question's page, then approves`;
  if (q.status === AiImportQuestionStatus.REJECTED) return "rejected";
  if (q.status === AiImportQuestionStatus.NOT_IMPORTABLE) return "not importable";
  if (q.status === AiImportQuestionStatus.DUPLICATE && !q.allowDuplicate) return "duplicate";
  // An approval older than the current failing Verify 1 / Verify 2 result does not cover it (2026-11-12: 77 FSO 2022
  // questions were approved before Verify 2 disagreed). Nothing is changed on the question: it is only not imported.
  if (!opts.ignoreApproval && q.approvedById) {
    const outdated = approvalOutdatedBy(q.approvedAt, verifyState(q.data, fingerprintsOf({ e: effective(q), finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures })));
    if (outdated) return outdated;
  }
  const blocking = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.blocking && !(q.allowDuplicate && c.startsWith("DUPLICATE")));
  if (blocking.length) return blocking.map(issueLabel).join(", ");
  if (!q.finalAnswer.length) return "no answer";
  // Owner decision 2, 2026-11-05: only the official key or an administrator's confirmation makes an answer usable —
  // never an AI opinion, two agreeing AI opinions, or an unconfirmed answer printed in the paper.
  if (!answerVerified(q)) return "answer not verified (official key or an administrator's confirmation needed)";
  if (!q.subjectId) return "no subject";
  const e = effective(q);
  if (!IMPORTABLE.has(q.questionType) || e.options.length !== 4) return "not a 4-option question";
  // Same rule as Bulk Import (lib/json-import.ts matchList), from the same parser: one bad list item used to refuse the
  // WHOLE package (2026-11-11: FSO 2022 Q109's keyless List I stopped the import of all 108 approved questions).
  if (q.questionType === "MATCH_THE_FOLLOWING") {
    // Never silently imported as a single-correct question without its lists (owner default, 2026-11-12).
    if (!e.listI?.length || !e.listII?.length) return "match question without List I / List II — correct the lists (Edit) first";
    const bad = matchListProblem(e.listI, e.listII);
    if (bad) return bad;
  }
  const stemImgs = q.figures.filter((f) => f.owner !== "OPTION").length;
  if (stemImgs > 8) return "more than 8 question images";
  for (const l of ["A", "B", "C", "D"]) if (q.figures.filter((f) => f.owner === "OPTION" && f.optionLabel === l).length > 3) return `more than 3 images on option ${l}`;
  if (!opts.ignoreApproval && !q.approvedById) return "not approved yet";
  // Only a question whose last re-check made it Ready is imported (an approval does not override Needs correction).
  // A failed import attempt keeps IMPORT_FAILED; it may be retried while its stored checks would allow Ready.
  if (!opts.ignoreApproval && q.status !== AiImportQuestionStatus.READY) {
    const checks = (q.data as unknown as ExtractedQuestion).checks ?? null;
    if (q.status === AiImportQuestionStatus.IMPORT_FAILED && checksAllowReady(checks) && !q.issueCodes.some((c) => ISSUE_DEFS[c]?.publishBlocking)) return null;
    if (q.status === AiImportQuestionStatus.EXTRACTED) return "not re-checked since the last change — open the import (the re-check runs) and try again";
    const failing = checks ? (["content", "answer", "taxonomy", "independent"] as const).filter((k) => checks[k].required && checks[k].status !== "PASSED").map((k) => `${CHECK_NAMES[k]}: ${CHECK_STATUS_LABELS[checks[k].status].toLowerCase()}`) : [];
    const flags = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.publishBlocking).map(issueLabel);
    return `status is ${q.status.toLowerCase().replace(/_/g, " ")}${failing.length || flags.length ? ` (${[...failing, ...flags].join("; ")})` : ""} — only a question that is Ready after its last check is imported: decide the open checks on its page, then approve it again`;
  }
  return null;
}

/** The first list item Bulk Import would refuse (lib/json-import.ts questionProblems), as an actionable reason; null = valid. */
export function matchListProblem(listI: { key?: unknown; text?: unknown }[], listII: { key?: unknown; text?: unknown }[]): string | null {
  const strip = (l: { key?: unknown; text?: unknown }[]) => l.map((x) => ({ key: x.key ?? "", text: x.text ?? "" }));
  const problems = questionProblems({ type: "MATCH_THE_FOLLOWING", question: "x", options: ["A", "B", "C", "D"].map((label) => ({ label, text: label })), correct: "A", matchLists: { listI: strip(listI), listII: strip(listII) } }).filter((m) => m.includes("matchLists."));
  const m = problems[0]?.match(/matchLists\.(listI|listII)\[(\d+)\]/);
  if (!m) return problems.length ? `match lists refused by Bulk Import: ${problems[0]} — correct the lists (Edit) first` : null;
  const item = (m[1] === "listI" ? listI : listII)[Number(m[2])];
  return `${m[1] === "listI" ? "List I" : "List II"} item "${String(item?.text ?? "").slice(0, 40)}" needs a key such as A, I or 1 and one line of text — correct the lists (Edit) first`;
}

/** Why an IMPORTED question may not be published by the importer (null = eligible). */
export function publishBlocker(q: AiImportQuestion & { figures: AiImportFigure[] }, settings: ImporterSettings): string | null {
  const flags = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.publishBlocking && !(q.allowDuplicate && c.startsWith("DUPLICATE")));
  if (flags.length) return flags.map(issueLabel).join(", ");
  if (!answerVerified(q)) return "answer not verified (official key or an administrator's confirmation needed)";
  if (settings.publish.requireTopic && !q.topicId) return "no topic";
  if (q.figures.some((f) => f.mappingStatus !== "OK" && !f.confirmedById)) return "figure not confirmed";
  return null;
}

function reviewFlags(q: AiImportQuestion, settings: ImporterSettings): string[] {
  const flags = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.publishBlocking).map(issueLabel);
  if (!answerVerified(q)) flags.push("Answer unverified");
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
  /** Bilingual exams: the Hindi version of each question (by code), in the same text format as its English version. */
  hindi: Map<string, { stem: string; options: Record<string, string> }>;
  expectedImages: Map<string, { question: number; options: Record<string, number> }>;
  /** Questions left out of the package, with the exact reason (Bulk Import would refuse the whole file for any one). */
  refused: { id: string; reason: string }[];
}

async function buildPackage(job: AiImportJob, rows: (AiImportQuestion & { figures: AiImportFigure[] })[], names: { subjects: Map<string, string>; topics: Map<string, string>; subTopics: Map<string, string> }, settings: ImporterSettings, paperCode: string | null): Promise<BuiltPackage> {
  const files = new Map<string, Buffer>();
  const codes = new Map<string, string>();
  const expectedImages: BuiltPackage["expectedImages"] = new Map();
  const hindi: BuiltPackage["hindi"] = new Map();
  const questions: unknown[] = [];
  const refused: BuiltPackage["refused"] = [];
  for (const q of rows) {
    // Each question is checked on its own with the Bulk Import parser: one bad question is left out with its reason
    // instead of refusing the package for every other question (2026-11-12).
    try {
      const e: ExtractedQuestion = effective(q);
      const code = `AIQ-${q.id}`;
      const qfiles = new Map<string, Buffer>();
      const img = async (f: AiImportFigure, i: number) => {
        const p = await packageImage(f);
        qfiles.set(p.name, p.data);
        const alt = (f.description && f.description.length >= 3 ? f.description : `Figure ${i + 1} of question ${e.label}`).slice(0, 300);
        return { file: p.name, alt };
      };
      const usable = q.figures.filter((f) => f.mappingStatus !== "MISSING" && f.originalKey);
      const stemFigs = usable.filter((f) => f.owner !== "OPTION");
      const stemImages = [];
      for (const [i, f] of stemFigs.entries()) stemImages.push(await img(f, i));
      const options = [];
      const optionCounts: Record<string, number> = {};
      // Owner decision 2026-11-11: an option that is a cropped structure image shows the ORIGINAL image; the AI's formula
      // transcription is not chemically verified, so it becomes the image's alt text (screen readers), never the content.
      const imageOnly = new Set<string>();
      for (const o of e.options.slice(0, 4)) {
        const of = usable.filter((f) => f.owner === "OPTION" && f.optionLabel === o.label);
        const images = [];
        for (const [i, f] of of.entries()) images.push(await img(f, i));
        optionCounts[o.label] = images.length;
        if (images.length && structureOnlyText(o.text)) {
          imageOnly.add(o.label);
          images[0] = { ...images[0], alt: `Structure (AI transcription, unverified): ${formulaPlain(o.text)}`.slice(0, 300) };
          options.push({ label: o.label, text: "", images });
        } else options.push({ label: o.label, text: o.text, ...(images.length ? { images } : {}) });
      }
      const prefix = [e.instructions, e.passage].filter((x) => x && x.trim()).join("\n\n");
      const stem = prefix ? `${prefix}\n\n${e.stem}` : e.stem;
      const hasLists = q.questionType === "MATCH_THE_FOLLOWING" && e.listI?.length && e.listII?.length;
      // A match question without both lists is refused by importBlocker; never downgraded to single-correct here.
      if (q.questionType === "MATCH_THE_FOLLOWING" && !hasLists) throw new Error("match question without List I / List II");
      const type = q.questionType === "MULTIPLE_CORRECT" ? "MULTIPLE_CORRECT" : hasLists ? "MATCH_THE_FOLLOWING" : "SINGLE_CORRECT";
      const rich = e.contentFormat === "RICH_V1" || stemImages.length > 0 || options.some((o) => "images" in o);
      const flags = reviewFlags(q, settings);
      const item = {
        code,
        // The Question Bank holds one number per paper: a section whose numbering restarts (S2, S3 …) keeps its
        // original number in the importer's source reference instead of colliding with section 1.
        ...(e.number !== null && !e.section ? { questionNumber: e.number } : {}),
        ...(job.year ? { year: job.year } : {}),
        ...(paperCode ? { paperCode } : {}),
        subject: names.subjects.get(q.subjectId!)!,
        ...(q.topicId && names.topics.get(q.topicId) ? { topic: names.topics.get(q.topicId) } : {}),
        ...(q.topicId && q.subTopicId && names.subTopics.get(q.subTopicId) ? { subtopic: names.subTopics.get(q.subTopicId) } : {}),
        type,
        contentFormat: rich ? "RICH_V1" : "PLAIN",
        question: stemImages.length ? { text: rich && e.contentFormat !== "RICH_V1" ? escapeForRich(stem) : stem, images: stemImages } : rich && e.contentFormat !== "RICH_V1" ? escapeForRich(stem) : stem,
        options: rich && e.contentFormat !== "RICH_V1" ? options.map((o) => ({ ...o, text: escapeForRich(o.text) })) : options,
        correct: q.finalAnswer,
        difficulty: e.hints?.difficulty && ["EASY", "MEDIUM", "HARD"].includes(e.hints.difficulty.toUpperCase()) ? e.hints.difficulty.toUpperCase() : "MEDIUM",
        ...(job.previousYearPaperId ? { source: "PYQ" } : {}),
        // A section heading is never stored as a question's explanation (2026-10-26: two headings were read as explanations).
        ...(e.hints?.explanation && !explanationIsHeading(e.hints.explanation) ? { explanation: e.hints.explanation } : {}),
        ...(flags.length ? { review: { required: true, reason: `AI importer: ${flags.join(", ")}`.slice(0, 480) } } : {}),
        ...(hasLists ? { matchLists: { listI: e.listI!.map((x) => ({ key: x.key, text: x.text })), listII: e.listII!.map((x) => ({ key: x.key, text: x.text })) } } : {}),
      };
      const problems = questionProblems(item, "RICH");
      if (problems.length) {
        refused.push({ id: q.id, reason: `Bulk Import would refuse it: ${problems.slice(0, 3).map((m) => m.replace(/^Question 1 › /, "")).join(" · ")}`.slice(0, 600) });
        continue;
      }
      questions.push(item);
      for (const [n, b] of qfiles) files.set(n, b);
      codes.set(code, q.id);
      expectedImages.set(code, { question: stemImages.length, options: optionCounts });
      // The Bulk Import package carries the English version; the Hindi version is written onto the same Question after it
      // is created (importBatch), escaped exactly like the English text when the question becomes RICH_V1.
      if (e.hi?.stem.trim()) {
        const fix = (t: string) => (rich && e.contentFormat !== "RICH_V1" ? escapeForRich(t) : t);
        hindi.set(code, { stem: fix(e.hi.stem), options: Object.fromEntries(e.hi.options.slice(0, 4).map((o) => [o.label, imageOnly.has(o.label) && structureOnlyText(o.text) ? "" : fix(o.text)])) });
      }
    } catch (err) {
      refused.push({ id: q.id, reason: `Could not be packaged: ${err instanceof Error ? err.message : "unexpected error"}`.slice(0, 600) });
    }
  }
  const manifest = Buffer.from(JSON.stringify({ schema: JSON_IMPORT_SCHEMA, questions }, null, 1), "utf8");
  const entries: ZipWriteEntry[] = [{ name: JSON_PACKAGE_MANIFEST, data: manifest }, ...[...files].map(([name, data]) => ({ name, data, store: true }))];
  return { zip: buildZip(entries), codes, expectedImages, hindi, refused };
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

type Row = AiImportQuestion & { figures: AiImportFigure[] };

/** One line of the itemized import result (job page "Last import"). */
export type ImportItem = {
  id: string;
  label: string;
  outcome: "imported" | "skipped" | "failed" | "awaiting";
  reason: string;
};

const itemLabel = (q: Pick<AiImportQuestion, "sourceNumber" | "orderIndex">) => (q.sourceNumber != null ? `Q${q.sourceNumber}` : `#${q.orderIndex + 1}`);
const ITEMS_MAX = 500;

/** The package of `rows` (names resolved), plus the job with its paper's year. */
async function packageFor(job: AiImportJob, rows: Row[], settings: ImporterSettings): Promise<{ job: AiImportJob; pkg: BuiltPackage }> {
  const subjectIds = [...new Set(rows.map((r) => r.subjectId!))];
  const topicIds = [...new Set(rows.map((r) => r.topicId).filter((x): x is string => !!x))];
  const subTopicIds = [...new Set(rows.map((r) => r.subTopicId).filter((x): x is string => !!x))];
  const [subjects, topics, subTopics, paper] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
    prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true } }),
    prisma.subTopic.findMany({ where: { id: { in: subTopicIds } }, select: { id: true, name: true } }),
    job.previousYearPaperId ? prisma.previousYearPaper.findUnique({ where: { id: job.previousYearPaperId }, select: { paperCode: true, year: true } }) : null,
  ]);
  if (job.previousYearPaperId && !paper) throw new Error("The import's Previous Year Paper no longer exists. Select an existing paper for this import (Change paper), then add the questions again.");
  // A linked paper is the only source of the year (jobs created before this rule may lack it).
  if (paper) job = { ...job, year: paper.year };
  const names = { subjects: new Map(subjects.map((s) => [s.id, s.name])), topics: new Map(topics.map((t) => [t.id, t.name])), subTopics: new Map(subTopics.map((t) => [t.id, t.name])) };
  return { job, pkg: await buildPackage(job, rows, names, settings, paper?.paperCode ?? null) };
}

type BulkRow = { id: string; status: BulkImportRowStatus; questionId: string | null; errors: Prisma.JsonValue; errorMessage: string | null; rawData: Prisma.JsonValue };

/** Writes the Bulk Import outcome of each row back to its importer question. */
async function reconcileRows(rows: Row[], pkg: BuiltPackage, bulkRows: BulkRow[]): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
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
      const hi = pkg.hindi.get(code);
      await prisma.$transaction([
        prisma.question.update({
          where: { id: br.questionId },
          data: {
            answerVerification: answerVerification(q),
            ...(hi ? { textHi: hi.stem } : {}),
            // Kept out of automatically generated practice when the administrator marked it so in the import (2026-11-11).
            ...(q.excludeFromPractice ? { excludeFromPractice: true, excludeFromPracticeReason: q.excludeFromPracticeReason } : {}),
            ...(roundTripOk ? {} : { reviewRequired: true, reviewReason: "AI importer: an image did not survive the import — check the question's images", editorialStage: EditorialStage.NEEDS_REVIEW }),
          },
        }),
        // One option row per label serves both languages: same id, same isCorrect, so a student's answer never depends on the language.
        ...(hi ? Object.entries(hi.options).map(([label, text]) => prisma.questionOption.updateMany({ where: { questionId: br.questionId!, label }, data: { textHi: text } })) : []),
        prisma.aiImportQuestion.update({
          where: { id: q.id },
          data: {
            status: AiImportQuestionStatus.IMPORTED,
            questionId: br.questionId,
            bulkImportRowId: br.id,
            importedAt: new Date(),
            ...(roundTripOk ? {} : { issueCodes: [...new Set([...q.issueCodes, "IMAGE_MISSING"])] }),
          },
        }),
      ]);
      items.push({ id: q.id, label: itemLabel(q), outcome: "imported", reason: roundTripOk ? "stored as draft" : "stored as draft — an image did not survive, marked for review" });
    } else if (br.status === BulkImportRowStatus.SKIPPED) {
      await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.DUPLICATE, bulkImportRowId: br.id, duplicateOfQuestionId: br.questionId, duplicateKind: q.duplicateKind ?? "EXACT", issueCodes: [...new Set([...q.issueCodes, "DUPLICATE_EXISTING"])] } });
      items.push({ id: q.id, label: itemLabel(q), outcome: "skipped", reason: "already in the Question Bank (duplicate, not imported again)" });
    } else {
      const errs = (Array.isArray(br.errors) ? (br.errors as string[]) : []).concat(br.errorMessage ? [br.errorMessage] : []);
      const reason = errs.slice(0, 3).join(" · ").slice(0, 600) || "The Bulk Import did not accept this row.";
      await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.IMPORT_FAILED, bulkImportRowId: br.id, issues: { ...((q.issues as object) ?? {}), IMPORT: reason } as Prisma.InputJsonValue } });
      items.push({ id: q.id, label: itemLabel(q), outcome: "failed", reason });
    }
  }
  return items;
}

/** Runs one import batch through the existing pipeline and reconciles every row back. */
async function importBatch(job: AiImportJob, rows: Row[], plan: ImportPlan, batchNo: number, settings: ImporterSettings): Promise<ImportItem[]> {
  const built = await packageFor(job, rows, settings);
  job = built.job;
  const pkg = built.pkg;
  // A question the package left out is recorded like a row the Bulk Import refused; its content and approval are not touched.
  const items: ImportItem[] = [];
  for (const r of pkg.refused) {
    const q = rows.find((x) => x.id === r.id)!;
    await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.IMPORT_FAILED, issues: { ...((q.issues as object) ?? {}), IMPORT: r.reason } as Prisma.InputJsonValue } });
    items.push({ id: q.id, label: itemLabel(q), outcome: "failed", reason: r.reason });
  }
  const included = rows.filter((r) => [...pkg.codes.values()].includes(r.id));
  if (!included.length) {
    await logEvent(job.id, "IMPORT_DONE", `Batch ${batchNo}: 0 imported — ${pkg.refused.length} question(s) could not be packaged (reasons on the job page)`, { refused: pkg.refused.length }, plan.requestedById);
    return items;
  }
  // The package bytes are part of the key: a question edited after an interrupted or refused attempt gets a new run, so the
  // Question Bank never receives the text from before the edit (Agent 7 D1/D2, 2026-11-12). Same content → same run (retry-safe).
  const zipHash = crypto.createHash("sha256").update(pkg.zip).digest("hex");
  const idKey = `aiimp-${crypto.createHash("sha256").update(`${job.id}|${batchNo}|${included.map((r) => r.id).sort().join(",")}|${zipHash}`).digest("hex").slice(0, 40)}`;

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
  await prisma.aiImportQuestion.updateMany({ where: { id: { in: included.map((r) => r.id) } }, data: { bulkImportRunId: runId } });
  await logEvent(job.id, "IMPORT_STAGED", `Batch ${batchNo}: ${included.length} question(s) staged as Bulk Import run ${runId}`, { runId, rows: included.length }, plan.requestedById);

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
  const bulkRows = await prisma.bulkImportRow.findMany({ where: { runId }, select: { id: true, status: true, questionId: true, errors: true, errorMessage: true, rawData: true } });
  items.push(...(await reconcileRows(included, pkg, bulkRows)));
  const n = (o: ImportItem["outcome"]) => items.filter((i) => i.outcome === o).length;
  await logEvent(job.id, "IMPORT_DONE", `Batch ${batchNo}: ${n("imported")} imported as draft, ${n("skipped")} skipped as duplicates, ${n("failed")} not accepted (reasons on the job page)`, { runId, imported: n("imported"), skipped: n("skipped"), failed: n("failed") }, plan.requestedById);
  return items;
}

/**
 * A worker that died after the Bulk Import wrote a question but before it was linked back leaves the importer row
 * unlinked. Linking it first means a retry never re-stages it (which would mark it a duplicate of itself).
 */
async function reconcileInterrupted(job: AiImportJob, rows: Row[], settings: ImporterSettings): Promise<number> {
  const pending = rows.filter((q) => q.bulkImportRunId && !q.questionId);
  let linked = 0;
  for (const runId of new Set(pending.map((q) => q.bulkImportRunId!))) {
    const mine = pending.filter((q) => q.bulkImportRunId === runId);
    const done = await prisma.bulkImportRow.findMany({ where: { runId, status: BulkImportRowStatus.SUCCESS, questionId: { not: null }, OR: mine.map((q) => ({ rawData: { path: ["questionCode"], equals: `AIQ-${q.id}` } })) }, select: { id: true, status: true, questionId: true, errors: true, errorMessage: true, rawData: true } });
    if (!done.length) continue;
    const { pkg } = await packageFor(job, mine, settings);
    linked += (await reconcileRows(mine, pkg, done)).length;
  }
  return linked;
}

/** Worker step for an IMPORTING job: import, then (optionally) publish eligible questions. */
export async function runImport(job: AiImportJob, plan: ImportPlan, settings: ImporterSettings): Promise<{ imported: number; published: number; skipped: number; failed: number; notImported: number; notPublished: number; items: ImportItem[] }> {
  const scope = plan.questionIds ? { id: { in: plan.questionIds } } : {};
  const load = () => prisma.aiImportQuestion.findMany({ where: { jobId: job.id, ...scope }, include: { figures: true }, orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }] });
  let all = await load();
  if (await reconcileInterrupted(job, all, settings)) all = await load();
  const candidates = all.filter((q) => !importBlocker(q, settings));
  // Every question not imported is listed with its reason, in source order: approved ones wait for a correction;
  // the rest (not approved, rejected, withdrawn) are skipped. Questions already in the Question Bank are not listed.
  const items: ImportItem[] = [];
  for (const q of all) {
    if (q.questionId) continue;
    const why = importBlocker(q, settings);
    if (why) items.push({ id: q.id, label: itemLabel(q), outcome: q.approvedById && q.status !== AiImportQuestionStatus.REJECTED && q.answerStatus !== AiImportAnswerStatus.WITHDRAWN ? "awaiting" : "skipped", reason: why });
  }
  const notImported = items.length;
  const done: ImportItem[] = [];
  for (let i = 0, batch = 1; i < candidates.length; i += MAX_ROWS_PER_RUN, batch++) done.push(...(await importBatch(job, candidates.slice(i, i + MAX_ROWS_PER_RUN), plan, batch, settings)));
  items.push(...done);
  const count = (o: ImportItem["outcome"]) => done.filter((i) => i.outcome === o).length;
  const imported = count("imported");
  const skipped = count("skipped");
  const failed = count("failed");
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
  const order = new Map(all.map((q, i) => [q.id, i]));
  items.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  return { imported, published, skipped, failed, notImported, notPublished, items: items.slice(0, ITEMS_MAX) };
}
