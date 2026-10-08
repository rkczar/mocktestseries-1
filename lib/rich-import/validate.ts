import "server-only";
import { BulkImportMode, ImportRowSeverity, QuestionContentFormat, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  mergeRowData,
  resolveRow,
  validateImportRows,
  type BulkImportRow,
  type ParsedImportRow,
  type RunExamContext,
  type ValidatedImportRow,
  type ValidationDb,
  buildTaxonomyLookups,
} from "@/lib/bulk-import";
import { bundleEntries, entryIndex, type BundleEntry } from "@/lib/rich-import/bundle";
import { JSON_PACKAGE_MANIFEST } from "@/lib/json-import";
import {
  allImageRefs,
  IMAGE_LIMITS,
  lintRichSource,
  looksRich,
  toManifestQuestion,
  type ManifestImageRef,
  type ManifestQuestion,
  manifestMatchSpec,
} from "@/lib/rich-import/manifest";
import { MIN_MULTIPLE_CORRECT, matchSpecIssues, readMatchSpec } from "@/lib/question-types";

/**
 * Capability-aware validation for RICH runs (NEET Phase 3).
 *
 * It wraps — never replaces — the legacy rules: every row first goes through
 * the same `validateImportRows` + `resolveRow` as a LEGACY row (exam,
 * canonical taxonomy, PYQ paper, duplicates), then the rich checks below
 * tighten it:
 *   - ERROR   cannot be imported safely (unknown taxonomy, missing/ambiguous/
 *             corrupt image, bad answer, unsupported type, formula cell, …)
 *   - WARNING importable after explicit acknowledgement (explanation missing,
 *             suspicious markup, alt text missing, review flag, publish request)
 *   - INFO    normal facts (defaults applied, formula/image counts, target stage)
 * Text is checked, never rewritten.
 */

export const RICH_TEXT_LIMITS = { question: 10_000, option: 2_000, explanation: 20_000, listEntry: 1_000 } as const;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,63}$/;

export interface RichPaper {
  id: string;
  examId: string;
  year: number;
  title: string;
  paperCode: string | null;
}

export interface RichContext {
  runId: string;
  examId: string | null;
  duplicateStrategy: string;
  runPaper: RichPaper | null;
  papers: RichPaper[];
  bundle: { id: string; status: string; entries: BundleEntry[] } | null;
  index: Map<string, BundleEntry[]>;
  /** Normalized author code → occurrences among the run's non-removed rows. */
  codeCounts: Map<string, number>;
  /** "<year>|<paperCode>|<qno>" → occurrences. */
  qnoCounts: Map<string, number>;
}

export interface RichValidatedRow extends ValidatedImportRow {
  infos: string[];
  manifest: ManifestQuestion | null;
}

const qnoKey = (d: BulkImportRow, ctx: { runPaper: RichPaper | null }) =>
  `${d.examYear || ctx.runPaper?.year || ""}|${(d.paperCode || ctx.runPaper?.paperCode || "").toLowerCase()}|${Number(d.questionNumber)}`;

/** The run's rich context, or null for a LEGACY run (which then follows the unchanged legacy path). */
export async function loadRichContext(runId: string, db: typeof prisma = prisma): Promise<RichContext | null> {
  const run = await db.bulkImportRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      importMode: true,
      examId: true,
      duplicateStrategy: true,
      previousYearPaperId: true,
      bundle: { select: { id: true, status: true, entries: true } },
    },
  });
  if (!run || run.importMode !== BulkImportMode.RICH) return null;
  const [papers, rows] = await Promise.all([
    db.previousYearPaper.findMany({ where: run.examId ? { examId: run.examId } : { id: "__none__" }, select: { id: true, examId: true, year: true, title: true, paperCode: true } }),
    db.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, select: { rawData: true, editedData: true } }),
  ]);
  const runPaper = run.previousYearPaperId ? papers.find((p) => p.id === run.previousYearPaperId) ?? null : null;
  const entries = bundleEntries(run.bundle?.entries);
  const codeCounts = new Map<string, number>();
  const qnoCounts = new Map<string, number>();
  for (const r of rows) {
    const d = mergeRowData(r.rawData, r.editedData);
    const code = d.questionCode?.trim().toLowerCase();
    if (code) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    if (d.questionNumber && /^\d+$/.test(d.questionNumber.trim())) {
      const k = qnoKey(d, { runPaper });
      qnoCounts.set(k, (qnoCounts.get(k) ?? 0) + 1);
    }
  }
  return {
    runId,
    examId: run.examId,
    duplicateStrategy: run.duplicateStrategy,
    runPaper,
    papers,
    bundle: run.bundle ? { id: run.bundle.id, status: run.bundle.status, entries } : null,
    index: entryIndex(entries),
    codeCounts,
    qnoCounts,
  };
}

/** Every (lowercased) image basename referenced by the run's non-removed rows. */
export async function referencedFilenames(runId: string): Promise<Set<string>> {
  const rows = await prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, select: { rawData: true, editedData: true } });
  const wanted = new Set<string>();
  for (const r of rows) for (const ref of allImageRefs(toManifestQuestion(mergeRowData(r.rawData, r.editedData)))) wanted.add(ref.filename.toLowerCase());
  return wanted;
}

/** Legacy defaults that are routine facts in a rich import (INFO, not WARNING). */
const INFO_PREFIXES = [
  "Exam not provided — using the selected import Exam",
  "Exam Year not provided — defaulted",
  "Status not provided, will default to DRAFT",
  "Source not provided, will default to Question Bank",
  "Sub-topic not provided",
];
/** Legacy warnings that a rich import must treat as ERRORS (never guess, never substitute). */
const ESCALATE = [
  /not found in the master taxonomy/,
  /needs mapping/,
  /could not be checked because/,
  /^File specifies Exam/,
  /does not match any existing Exam/,
  /^No PYQ paper found for/,
  /^Difficulty ".*" not recognized/,
  /^Status ".*" not recognized/,
];
/** Legacy messages superseded by the rich checks below. */
const SUPERSEDED = [/^Correct Answer not provided/, /^Correct Answer ".*" is not A, B, C, or D/];

const TAXONOMY_HINT = " The importer never creates taxonomy: fix the spelling, or add it under Exams first, then Revalidate.";

/** Rich shape: an option may be image-only, so "Option X is required" does not apply when it has an image. */
function richShape(parsed: ParsedImportRow, m: ManifestQuestion): ParsedImportRow {
  const imageOnly = new Set(m.options.filter((o) => !o.text.trim() && o.images.length > 0).map((o) => `Option ${o.label} is required`));
  const errors = parsed.errors.filter((e) => !imageOnly.has(e));
  const severity = errors.length ? ImportRowSeverity.ERROR : parsed.warnings.length ? ImportRowSeverity.WARNING : ImportRowSeverity.VALID;
  return { ...parsed, errors, severity, isValid: errors.length === 0 };
}

function checkImage(ref: ManifestImageRef, ctx: RichContext, errors: string[], warnings: string[]) {
  if (!ctx.bundle) {
    errors.push(`${ref.field}: references "${ref.filename}" but no image bundle (ZIP) was uploaded with this import.`);
    return;
  }
  if (ctx.bundle.status === "FAILED") {
    errors.push(`${ref.field}: the image bundle was refused, so "${ref.filename}" cannot be used.`);
    return;
  }
  const hits = ctx.index.get(ref.filename.toLowerCase()) ?? [];
  if (hits.length === 0) {
    errors.push(`${ref.field}: referenced file "${ref.filename}" was not found in the uploaded image bundle.`);
    return;
  }
  if (hits.length > 1 || hits[0].ambiguous) {
    errors.push(`${ref.field}: "${ref.filename}" is ambiguous — the bundle contains ${hits.map((h) => `"${h.name}"`).join(" and ")}. Give every image a unique file name.`);
    return;
  }
  const e = hits[0];
  if (e.status === "UNSUPPORTED") errors.push(`${ref.field}: "${ref.filename}" cannot be used — ${e.error ?? "unsupported file"}`);
  else if (e.status === "INVALID") errors.push(`${ref.field}: "${ref.filename}" is not a valid image — ${e.error ?? "it could not be processed"}`);
  else if (e.status === "PENDING") errors.push(`${ref.field}: "${ref.filename}" has not been processed yet. Click "Process Images", then Revalidate.`);
  if (!ref.decorative && !ref.alt) warnings.push(`${ref.field}: "${ref.filename}" has no alt text — a generic description will be used. Add "${ref.filename} :: <what the image shows>" (or ":: decorative").`);
  else if (ref.alt && ref.alt.length < 3) warnings.push(`${ref.field}: alt text for "${ref.filename}" is too short — a generic description will be used.`);
}

/**
 * Validates one staged row of a RICH run. Same inputs as the legacy path, so
 * every caller (validate, single-row edit, bulk actions, exam change, import)
 * applies identical rules.
 */
export async function resolveRichRow(
  db: ValidationDb,
  lookups: Awaited<ReturnType<typeof buildTaxonomyLookups>>,
  merged: BulkImportRow,
  runExamContext: RunExamContext | null,
  ctx: RichContext
): Promise<RichValidatedRow> {
  const m = toManifestQuestion(merged);
  const [shape] = validateImportRows([merged]);
  // The exact paper: run target → Paper Code → the only paper of that year.
  const paperErrors: string[] = [];
  const wantsPyq = /^pyq$|previous year/i.test(merged.source ?? "");
  const rowYear = /^\d{4}$/.test(m.year) ? Number(m.year) : null;
  const codeMatches = m.paperCode ? ctx.papers.filter((p) => (p.paperCode ?? "").toLowerCase() === m.paperCode!.toLowerCase()) : [];
  let paper: RichPaper | null = null;
  if (ctx.runPaper) {
    paper = ctx.runPaper;
    if (m.paperCode && (ctx.runPaper.paperCode ?? "").toLowerCase() !== m.paperCode.toLowerCase()) {
      paperErrors.push(`Paper Code: "${m.paperCode}" is not the code of this import's target paper "${ctx.runPaper.title}"${ctx.runPaper.paperCode ? ` (${ctx.runPaper.paperCode})` : ""}.`);
    }
  } else if (m.paperCode) {
    if (codeMatches.length === 0) paperErrors.push(`Paper Code: no Previous Year Paper with code "${m.paperCode}" exists for this exam.`);
    else if (codeMatches.length > 1) paperErrors.push(`Paper Code: ${codeMatches.length} papers of this exam share the code "${m.paperCode}" (${codeMatches.map((p) => p.title).join("; ")}). Choose the paper as the Import Target.`);
    else paper = codeMatches[0];
  }
  if (paper && rowYear !== null && paper.year !== rowYear) paperErrors.push(`Year: ${rowYear} does not match paper "${paper.title}" (${paper.year}).`);
  if (!paper && !m.paperCode && wantsPyq && rowYear !== null) {
    const sameYear = ctx.papers.filter((p) => p.year === rowYear);
    if (sameYear.length === 1) paper = sameYear[0];
    else if (sameYear.length > 1) paperErrors.push(`Paper Code: ${sameYear.length} Previous Year Papers exist for ${rowYear} (${sameYear.map((p) => p.paperCode ?? p.title).join(", ")}). Add the Paper Code, or choose the paper as the Import Target.`);
  }
  // The legacy image index (shared-storage filename lookup) is never consulted:
  // rich images come only from this run's bundle.
  const resolved = await matchAwareDuplicate(db, m, await resolveRow(db, lookups, richShape(shape, m), undefined, runExamContext, paper ? { paperId: paper.id } : null));

  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  for (const e of resolved.errors) errors.push(e);
  for (const w of resolved.warnings) {
    if (SUPERSEDED.some((re) => re.test(w))) continue;
    if (INFO_PREFIXES.some((p) => w.startsWith(p))) infos.push(w);
    else if (ESCALATE.some((re) => re.test(w))) errors.push(/taxonomy|mapping|could not be checked/.test(w) ? w + TAXONOMY_HINT : w);
    else warnings.push(w);
  }

  errors.push(...paperErrors);
  for (const issue of m.parseIssues) errors.push(`${issue.field}: ${issue.message}`);
  if (m.formulaCells.length) {
    errors.push(`Spreadsheet formula in ${m.formulaCells.map((c) => `"${c}"`).join(", ")}: formula cells are never evaluated. Paste the text as values (Paste Special → Values).`);
  }
  if (merged.image) errors.push(`Image: the legacy image URL column is not used by rich imports. Put the file in the ZIP and reference it under "Question Images".`);

  // Question type / answer key
  if (!m.questionType) errors.push(`Question Type: "${merged.questionType}" is not supported. Use SINGLE_CORRECT (or MCQ), MULTIPLE_CORRECT, or MATCH_THE_FOLLOWING.`);
  if (m.correct.length === 0 && !m.parseIssues.some((i) => i.field === "Correct")) errors.push("Correct: the correct answer is missing. Use one letter A–D.");
  else if (m.questionType === "MULTIPLE_CORRECT") {
    // NEET Phase 4: the whole set is the key (all-or-nothing). Never narrowed to one answer.
    if (m.correct.length < MIN_MULTIPLE_CORRECT) errors.push(`Correct: a MULTIPLE_CORRECT question needs at least ${MIN_MULTIPLE_CORRECT} correct options (got ${m.correct.join(", ") || "none"}). Use SINGLE_CORRECT for one answer.`);
  } else if (m.correct.length > 1) errors.push(`Correct: ${m.correct.join(", ")} lists ${m.correct.length} answers, but a ${m.questionType ?? "single-correct"} question has exactly one.`);

  // Content format
  const rich = m.contentFormat === "RICH_V1";
  if (!m.contentFormat) errors.push(`Content Format: "${merged.contentFormat}" is not supported. Use PLAIN or RICH_V1.`);
  const images = allImageRefs(m);
  if (m.contentFormat === "PLAIN" && images.length) errors.push("Content Format: images need Content Format RICH_V1 (PLAIN questions cannot carry bundle images).");

  // Text presence / length
  for (const o of m.options) {
    if (!o.text.trim() && o.images.length === 0) {
      if (!errors.includes(`Option ${o.label} is required`)) errors.push(`Option ${o.label}: needs text or an image.`);
    }
    if (o.text.length > RICH_TEXT_LIMITS.option) errors.push(`Option ${o.label}: text is longer than ${RICH_TEXT_LIMITS.option} characters.`);
  }
  if (m.text.length > RICH_TEXT_LIMITS.question) errors.push(`Question Text: longer than ${RICH_TEXT_LIMITS.question} characters.`);
  if ((m.explanation?.length ?? 0) > RICH_TEXT_LIMITS.explanation) errors.push(`Explanation: longer than ${RICH_TEXT_LIMITS.explanation} characters.`);

  // Rich syntax sanity (never rewritten)
  const fields: [string, string][] = [["Question Text", m.text], ...m.options.map((o) => [`Option ${o.label}`, o.text] as [string, string]), ["Explanation", m.explanation ?? ""]];
  if (m.match) for (const e of [...m.match.listI, ...m.match.listII]) fields.push([`List entry ${e.key}`, e.text]);
  let formulas = 0;
  let chemistry = 0;
  if (rich) {
    for (const [field, src] of fields) {
      const lint = lintRichSource(src, field);
      warnings.push(...lint.warnings);
      formulas += lint.stats.formulas;
      chemistry += lint.stats.chemistry;
    }
  } else if (m.contentFormat === "PLAIN" && fields.some(([, src]) => looksRich(src))) {
    warnings.push("Content Format: the text contains formula markup ($…$ or \\ce{…}) but the row is PLAIN, so it will be shown literally. Set Content Format to RICH_V1 if it should render.");
  }

  // Images
  for (const ref of images) checkImage(ref, ctx, errors, warnings);
  const perRole = { q: m.images.question.length, e: m.images.explanation.length };
  if (perRole.q > IMAGE_LIMITS.question) errors.push(`Question Images: ${perRole.q} images (max ${IMAGE_LIMITS.question}).`);
  if (perRole.e > IMAGE_LIMITS.explanation) errors.push(`Explanation Images: ${perRole.e} images (max ${IMAGE_LIMITS.explanation}).`);
  for (const o of m.options) if (o.images.length > IMAGE_LIMITS.perOption) errors.push(`Option ${o.label} Image: ${o.images.length} images (max ${IMAGE_LIMITS.perOption}).`);
  const seen = new Map<string, number>();
  for (const ref of images) seen.set(`${ref.field}|${ref.filename.toLowerCase()}`, (seen.get(`${ref.field}|${ref.filename.toLowerCase()}`) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) warnings.push(`${k.split("|")[0]}: "${k.split("|")[1]}" is listed ${n} times in the same cell.`);

  // Match the Following
  if (m.questionType === "MATCH_THE_FOLLOWING") {
    if (!m.match) errors.push("List I / List II: a MATCH_THE_FOLLOWING question needs both lists (List I and List II columns).");
    else if (m.match.listI.length < 2 || m.match.listII.length < 2) errors.push("List I / List II: each list needs at least two entries.");
    else {
      // Structural rules shared with the admin form (keys, limits). Image-only entries are fine.
      const imageKeys = new Set([...m.match.listI, ...m.match.listII].flatMap((e) => e.images.map((r) => r.listKey ?? "")));
      for (const issue of matchSpecIssues(manifestMatchSpec(m), imageKeys)) if (!/appears twice|needs text or an image/.test(issue)) errors.push(`List I / List II: ${issue}`);
    }
    if (m.match) for (const e of [...m.match.listI, ...m.match.listII]) if (e.text.length > RICH_TEXT_LIMITS.listEntry) errors.push(`List entry ${e.key}: longer than ${RICH_TEXT_LIMITS.listEntry} characters.`);
  } else if (m.match) {
    warnings.push(`List I / List II: lists were given but Question Type is ${m.questionType ?? "unknown"}, not MATCH_THE_FOLLOWING. They will still be appended to the question text.`);
  }

  // Identity: code, QNo, paper/year consistency
  if (m.sourceCode) {
    if (!CODE_PATTERN.test(m.sourceCode)) errors.push(`Code: "${m.sourceCode}" is not a valid code (letters, digits, space, _ . / -; max 64).`);
    const n = ctx.codeCounts.get(m.sourceCode.toLowerCase()) ?? 0;
    if (n > 1) errors.push(`Code: "${m.sourceCode}" appears ${n} times in this file. Every row needs a unique code.`);
  }
  if (m.questionNumber) {
    if (!/^\d{1,3}$/.test(m.questionNumber) || Number(m.questionNumber) < 1) errors.push(`QNo: "${m.questionNumber}" must be a whole number from 1 to 999.`);
    else {
      const n = ctx.qnoCounts.get(qnoKey(merged, ctx)) ?? 0;
      if (n > 1) errors.push(`QNo: question number ${m.questionNumber} appears ${n} times for the same paper/year in this file.`);
    }
  }
  if (m.year && !/^\d{4}$/.test(m.year)) {
    /* already an ERROR from the legacy shape check */
  }
  // Paper / Paper Code / Year consistency was checked above (paperErrors).

  // Editorial
  if (!m.explanation && m.images.explanation.length === 0) warnings.push("Explanation: missing. Students will see no human explanation after review.");
  if (m.review.required) warnings.push(`Review Required: ${m.review.reason ?? "flagged by the author (no reason given)"}`);
  else if (m.review.reason) infos.push(`Review Reason recorded: ${m.review.reason}`);
  if (m.requestedStatus === "PUBLISHED" || m.requestedStatus === "ARCHIVED") {
    warnings.push(`Status: ${m.requestedStatus} requested — rich imports are always saved as DRAFT (import is not publish). Publish later from Question Management.`);
  }

  // Duplicate REPLACE is limited to rich drafts: a published (e.g. RUHS) or a
  // PLAIN question is never rewritten by a rich import.
  if (resolved.resolvedData?.isDuplicate && resolved.resolvedData.duplicateQuestionId && ctx.duplicateStrategy === "REPLACE") {
    const target = await db.question.findUnique({ where: { id: resolved.resolvedData.duplicateQuestionId }, select: { code: true, status: true, contentFormat: true } });
    if (target && (target.status !== QuestionStatus.DRAFT || target.contentFormat !== QuestionContentFormat.RICH_V1)) {
      errors.push(
        `Duplicate: matches existing ${target.status} ${target.contentFormat} question ${target.code}. Rich imports may only REPLACE rich DRAFT questions — converting or overwriting other questions needs a separately approved migration. Use Skip or Add as New.`
      );
    }
  }

  // INFO
  infos.push(`Content: ${m.contentFormat ?? "?"}${rich ? ` · ${formulas} formula(s), ${chemistry} chemistry expression(s)` : ""} · type ${m.questionType ?? "?"}`);
  if (images.length) {
    infos.push(`Images: ${m.images.question.length} question, ${m.options.reduce((s, o) => s + o.images.length, 0)} option, ${m.images.explanation.length} explanation${m.match ? `, ${images.length - m.images.question.length - m.images.explanation.length - m.options.reduce((s, o) => s + o.images.length, 0)} list` : ""}.`);
  }
  const stage = m.review.required || warnings.length > 0 || resolved.reviewRequired ? "NEEDS_REVIEW" : "DRAFT";
  infos.push(`Will be saved as DRAFT · editorial stage ${stage} (technical validation never marks a question VERIFIED).`);

  const severity = errors.length ? ImportRowSeverity.ERROR : warnings.length ? ImportRowSeverity.WARNING : ImportRowSeverity.VALID;
  return {
    ...resolved,
    severity,
    isValid: severity !== ImportRowSeverity.ERROR,
    errors,
    warnings,
    infos,
    manifest: m,
    reviewRequired: resolved.reviewRequired || m.review.required,
    forceDraft: true,
    imageMatches: undefined,
    resolvedData: severity === ImportRowSeverity.ERROR ? undefined : resolved.resolvedData,
  };
}

/**
 * The one entry point every import route uses: LEGACY rows go through the
 * untouched legacy rules; RICH rows through resolveRichRow.
 */
export async function resolveImportRow(
  db: ValidationDb,
  lookups: Awaited<ReturnType<typeof buildTaxonomyLookups>>,
  merged: BulkImportRow,
  imageIndex: Map<string, string> | undefined,
  runExamContext: RunExamContext | null,
  ctx: RichContext | null
): Promise<ValidatedImportRow & { infos?: string[]; manifest?: ManifestQuestion | null }> {
  if (ctx) return resolveRichRow(db, lookups, merged, runExamContext, ctx);
  const [shapeParsed] = validateImportRows([merged]);
  return resolveRow(db, lookups, shapeParsed, imageIndex, runExamContext);
}

export interface RichImageMatch {
  field: string;
  filename: string;
  status: "FOUND" | "MISSING" | "AMBIGUOUS" | "PENDING" | "INVALID";
}

/** Per-reference bundle match for the workspace "Images" column. */
export function richImageMatches(m: ManifestQuestion, ctx: RichContext): RichImageMatch[] {
  return allImageRefs(m).map((ref) => {
    const hits = ctx.index.get(ref.filename.toLowerCase()) ?? [];
    const status: RichImageMatch["status"] =
      hits.length === 0 ? "MISSING" : hits.length > 1 || hits[0].ambiguous ? "AMBIGUOUS" : hits[0].status === "READY" ? "FOUND" : hits[0].status === "PENDING" ? "PENDING" : "INVALID";
    return { field: ref.field, filename: ref.filename, status };
  });
}

/** Bundle images that no row references (a WARNING at batch level; they are never processed). */
export function unusedBundleImages(ctx: RichContext, referenced: Set<string>): string[] {
  return (ctx.bundle?.entries ?? [])
    .filter((e) => (e.kind === "IMAGE" || e.kind === "UNSUPPORTED") && !referenced.has(e.basename.toLowerCase()) && e.basename.toLowerCase() !== JSON_PACKAGE_MANIFEST)
    .map((e) => e.name);
}

/**
 * MATCH_THE_FOLLOWING (NEET Phase 4) stores only the stem as Question.text, and
 * Match stems repeat ("Match List I with List II"). A text-only duplicate is
 * therefore kept only when an existing Match question with the same stem also
 * has the SAME lists; otherwise the row is not a duplicate. Code / paper+QNo
 * duplicates are untouched.
 */
async function matchAwareDuplicate<T extends ValidatedImportRow>(db: ValidationDb, m: ManifestQuestion, resolved: T): Promise<T> {
  const rd = resolved.resolvedData;
  if (m.questionType !== "MATCH_THE_FOLLOWING" || !m.match || !rd?.isDuplicate || rd.duplicateReason !== "Potential duplicate text" || !rd.subjectId) return resolved;
  const spec = JSON.stringify(manifestMatchSpec(m));
  const candidates = await db.question.findMany({
    where: { examId: rd.examId, subjectId: rd.subjectId, text: m.text, questionType: "MATCH_THE_FOLLOWING" },
    select: { id: true, matchSpec: true },
    take: 200,
  });
  const hit = candidates.find((c) => JSON.stringify(readMatchSpec(c.matchSpec)) === spec);
  if (hit) return { ...resolved, resolvedData: { ...rd, duplicateQuestionId: hit.id } };
  return {
    ...resolved,
    warnings: resolved.warnings.filter((w) => w !== "Possible duplicate: Potential duplicate text"),
    resolvedData: { ...rd, isDuplicate: false, duplicateQuestionId: undefined, duplicateReason: undefined },
  };
}
