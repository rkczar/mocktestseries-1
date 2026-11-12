/**
 * Sequence integrity and the final quality gate of an import (pure, client-safe).
 *
 * Built only from stored facts (questions, pages, key entries) — never from
 * frontend progress. A job is "Completed" only when every expected question is
 * accounted for: no failed page, no missing number, no unexplained count
 * difference and nothing waiting for a decision. An acknowledged difference
 * still completes "with warnings", never silently.
 */

import { DUPLICATE_CODES, IMAGE_CODES, awaitingApproval as awaitingRule, unresolved as unresolvedRule } from "@/lib/ai-import/review-filters";

export interface QualityQuestion {
  fileId: string;
  section: string;
  number: number | null;
  /** Printed number of a question kept without a number because that number was already read elsewhere. */
  printedNumber?: number | null;
  status: string;
  approved: boolean;
  stored: boolean;
  /** true = independent read agreed, false = it disagreed / did not find it, null = not verified. */
  verified: boolean | null;
  issueCodes: string[];
  answerStatus: string;
  importBlocker: string | null;
  rescanPending: boolean;
  /** First source page of the question (for per-page counts). */
  page?: number | null;
}

export interface QualityPage {
  status: string;
  kind: string | null;
  attempts: number;
  errorMessage: string | null;
  /** Page identity and documented outcome (lib/ai-import/ocr-page.ts); absent on callers that predate page outcomes. */
  fileId?: string;
  pageNumber?: number;
  outcome?: string | null;
  outcomeReason?: string | null;
}

export interface SequenceAck {
  byId: string;
  at: string;
  note: string;
  /** What was acknowledged; the acknowledgement lapses when the facts change. */
  missing: string[];
  expected: number | null;
  counted: number;
  /** A printed-total conflict explained with the same note (it lapses when the conflict's wording changes). */
  conflict?: string | null;
}

export interface QualityInput {
  expected: number | null;
  questions: QualityQuestion[];
  pages: QualityPage[];
  /** Answer-key entries no question matched, and key files that could not be read. */
  unmatchedKeyEntries: number;
  failedKeyFiles: number;
  /** Questions the independent read found but the primary read did not ("S2 Q14"). */
  verifierExtras: string[];
  ack: SequenceAck | null;
  /** True after processing finished (review / import / completed states). */
  processed: boolean;
  /** Highest question number in the answer key(s), to suggest an expected count. */
  keyMaxNumber?: number | null;
  /**
   * Question totals PRINTED on the paper or its answer key ("Total Questions: 120", "This booklet contains 120 items") —
   * established independently of the extraction (Sprint A item 6, 2026-11-06). Never derived from what was extracted.
   */
  expectedSources?: ExpectedSource[];
}

export interface ExpectedSource {
  /** Plain words: "printed on the answer key “…pdf”". */
  source: string;
  value: number;
}

const UNEXPLAINED = new Set(["NO_QUESTIONS", "NEEDS_REVIEW", "FAILED"]);

/**
 * Pages whose outcome does not explain them: no question found on a page that is not blank or instructions, ink
 * without readable text, failed reading — and pages processed before outcomes existed that were marked blank only
 * because they had no text layer and no embedded image (seen 2026-11-04: 18 of 19 RUHS MO 2016 pages).
 */
export function unexplainedPages(pages: QualityPage[]): { page: number | null; why: string }[] {
  const out: { page: number | null; why: string }[] = [];
  for (const p of pages) {
    if (p.outcome && UNEXPLAINED.has(p.outcome) && p.status !== "PENDING") out.push({ page: p.pageNumber ?? null, why: p.outcomeReason ?? p.outcome });
    else if (!p.outcome && p.kind === "BLANK" && p.status === "DONE") out.push({ page: p.pageNumber ?? null, why: "marked blank without checking the page image (processed before page checks existed) — process the paper again" });
  }
  return out.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
}

/** Pages with far fewer questions than the paper's usual page (a column or half a page may have been missed). */
export function lowCountPages(questions: Pick<QualityQuestion, "fileId" | "page" | "status">[], pages: QualityPage[]): { page: number; count: number; typical: number }[] {
  const counts = new Map<string, number>();
  for (const q of questions) if (q.page && q.status !== "REJECTED") counts.set(`${q.fileId}|${q.page}`, (counts.get(`${q.fileId}|${q.page}`) ?? 0) + 1);
  const read = pages.filter((p) => p.fileId && p.pageNumber && (p.outcome === "OCR" || p.outcome === "TEXT_LAYER" || p.outcome === "AI"));
  const vals = read.map((p) => counts.get(`${p.fileId}|${p.pageNumber}`) ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  if (vals.length < 4) return [];
  const typical = vals[Math.floor(vals.length / 2)];
  if (typical < 3) return [];
  // The last question page of a paper is often short; it is not flagged.
  const lastPage = Math.max(...read.map((p) => p.pageNumber!));
  return read
    .map((p) => ({ page: p.pageNumber!, count: counts.get(`${p.fileId}|${p.pageNumber}`) ?? 0, typical }))
    .filter((x) => x.count > 0 && x.count < typical * 0.4 && x.page !== lastPage);
}

export type QualityState = "PROCESSING" | "NEEDS_CORRECTION" | "READY_FOR_REVIEW" | "READY_FOR_APPROVAL" | "APPROVED" | "COMPLETED" | "COMPLETED_WITH_WARNINGS";

export const QUALITY_STATE_LABELS: Record<QualityState, string> = {
  PROCESSING: "Processing",
  NEEDS_CORRECTION: "Needs Correction",
  READY_FOR_REVIEW: "Ready for Review",
  READY_FOR_APPROVAL: "Ready for Approval",
  APPROVED: "Approved — ready to add to the Question Bank",
  COMPLETED: "Completed",
  COMPLETED_WITH_WARNINGS: "Completed with Warnings",
};

export interface QualityReport {
  expected: number | null;
  /** Where the expected count comes from: "entered by an administrator", or a printed source when none was entered. */
  expectedFrom: string | null;
  /** The independent printed totals that were found (paper header, key header). */
  expectedSources: ExpectedSource[];
  /** An entered count that a printed total contradicts (plain sentence), else null. */
  expectedConflict: string | null;
  /**
   * Why the paper may not be published yet (incomplete or unconfirmed question count, unread pages), else null —
   * enforced server-side on every publish request (review.ts requestImport). Importing as Draft stays possible.
   */
  publishBlocker: string | null;
  extracted: number;
  /**
   * Questions of the paper that were found: distinct printed numbers (per file and section, whatever the
   * decision on them) plus unnumbered questions that were not rejected. A rejected question was still found;
   * junk read as an extra question (unnumbered or a repeated number) does not count once rejected.
   */
  counted: number;
  verified: number;
  verifyDisagreed: number;
  unverified: number;
  approved: number;
  stored: number;
  rejected: number;
  notImportable: number;
  needsCorrection: number;
  importFailed: number;
  duplicateCandidates: number;
  rescanPending: number;
  /** Importable, not yet approved. */
  awaitingApproval: number;
  /** Live questions not in the Question Bank that are not approved-and-ready: what still needs a decision. */
  unresolved: number;
  /** Awaiting approval with no flag at all (what "Approve all questions without flags" approves). */
  awaitingCleanApproval: number;
  /** Approved, not yet in the Question Bank. */
  approvedNotStored: number;
  answerKey: { official: number; independentlyVerified: number; unverified: number; missing: number; mismatch: number; unmatchedEntries: number; failedFiles: number };
  imageIssues: number;
  topicUncertain: number;
  pages: { total: number; completed: number; failed: number; retrying: number; pending: number; skipped: number; needsReview: number };
  missing: string[];
  /** Printed numbers read on more than one question ("Q12 ×2") — reconciliation, never merged automatically. */
  duplicateNumbers: string[];
  verifierExtras: string[];
  /** expected − counted (null when no expected count was confirmed). */
  countDifference: number | null;
  ackValid: boolean;
  /** Unresolved problems, plain sentences, most serious first. */
  blockers: string[];
  warnings: string[];
  state: QualityState;
}

const label = (section: string, n: number) => `${section ? `${section} ` : ""}Q${n}`;

/**
 * Missing question numbers per paper file and section. Numbering restarts are
 * separate sections (S2, S3 …), so a restart never looks like a gap; a single
 * continuous paper is also checked up to the expected count.
 */
export function missingNumbers(questions: Pick<QualityQuestion, "fileId" | "section" | "number">[], expected: number | null): string[] {
  const groups = new Map<string, { section: string; nums: Set<number> }>();
  for (const q of questions) {
    if (q.number === null) continue;
    const k = `${q.fileId}|${q.section}`;
    const g = groups.get(k) ?? { section: q.section, nums: new Set<number>() };
    g.nums.add(q.number);
    groups.set(k, g);
  }
  const out: string[] = [];
  const single = groups.size === 1;
  for (const g of groups.values()) {
    const max = Math.max(...g.nums);
    const upTo = single && expected && expected > max && expected <= 1000 ? expected : max;
    for (let n = 1; n <= upTo; n++) if (!g.nums.has(n)) out.push(label(g.section, n));
  }
  return out;
}

/** Printed numbers that occur on more than one live question of the same paper and section. */
export function duplicateNumbers(questions: Pick<QualityQuestion, "fileId" | "section" | "number" | "printedNumber" | "status">[]): string[] {
  const count = new Map<string, { section: string; n: number; times: number }>();
  for (const q of questions) {
    if (q.status === "REJECTED") continue;
    const n = q.number ?? q.printedNumber ?? null;
    if (n === null) continue;
    const k = `${q.fileId}|${q.section}|${n}`;
    const c = count.get(k) ?? { section: q.section, n, times: 0 };
    c.times++;
    count.set(k, c);
  }
  return [...count.values()].filter((c) => c.times > 1).map((c) => `${label(c.section, c.n)} ×${c.times}`);
}

export function qualityReport(input: QualityInput): QualityReport {
  const qs = input.questions;
  const by = (f: (q: QualityQuestion) => boolean) => qs.filter(f).length;
  const rejected = by((q) => q.status === "REJECTED");
  const live = qs.filter((q) => q.status !== "REJECTED");
  const liveBy = (f: (q: QualityQuestion) => boolean) => live.filter(f).length;
  const numbered = new Set(qs.filter((q) => q.number !== null).map((q) => `${q.fileId}|${q.section}|${q.number}`));
  const counted = numbered.size + live.filter((q) => q.number === null).length;
  // Missing = numbers the extraction never found (a rejected question was found, so it is not missing).
  // The expected count: the administrator's entry; without one, a printed total (paper / key header) when all printed
  // totals agree. The extraction never sets it. A printed total that contradicts the entry is a conflict to decide.
  const sources = (input.expectedSources ?? []).filter((x) => Number.isInteger(x.value) && x.value > 0 && x.value <= 1000);
  const printedValues = [...new Set(sources.map((x) => x.value))];
  const expected = input.expected ?? (printedValues.length === 1 ? printedValues[0] : null);
  const expectedFrom = input.expected !== null ? "entered by an administrator" : expected !== null ? sources.filter((x) => x.value === expected).map((x) => x.source).join("; ") : null;
  // The key's highest number is not a printed total (a key may list more entries than one paper): it is a warning only.
  const keyBeyond = !!input.keyMaxNumber && expected !== null && input.keyMaxNumber > expected;
  const against = input.expected !== null ? sources.filter((x) => x.value !== input.expected) : printedValues.length > 1 ? sources : [];
  const expectedConflict = !against.length
    ? null
    : input.expected !== null
      ? `The expected count is ${input.expected}, but ${against.map((x) => `${x.value} is ${x.source}`).join("; ")} — set the expected number to the paper's real total (job page) before publishing.`
      : `The printed totals disagree (${against.map((x) => `${x.value} ${x.source}`).join("; ")}) — enter the expected number of questions (job page).`;
  // A conflict an administrator explained (e.g. an OCR-misread cover total) stays visible as a warning.
  const conflictAcked = !!expectedConflict && !!input.ack?.conflict && input.ack.conflict === expectedConflict;
  const missing = missingNumbers(qs, expected);
  const countDifference = expected === null ? null : expected - counted;
  const ackValid =
    !!input.ack && input.ack.expected === expected && input.ack.counted === counted && input.ack.missing.length === missing.length && input.ack.missing.every((m, i) => m === missing[i]);
  const pages = {
    total: input.pages.length,
    completed: input.pages.filter((p) => p.status === "DONE").length,
    failed: input.pages.filter((p) => p.status === "FAILED").length,
    retrying: input.pages.filter((p) => p.status === "PENDING" && p.attempts > 0).length,
    pending: input.pages.filter((p) => p.status === "PENDING" && p.attempts === 0).length,
    skipped: input.pages.filter((p) => p.status === "SKIPPED").length,
    needsReview: input.pages.filter((p) => p.status === "SKIPPED" && p.kind === "SCANNED").length,
  };
  const has = (q: QualityQuestion, c: string) => q.issueCodes.includes(c);
  const stored = by((q) => q.stored);
  const approved = by((q) => q.approved || q.stored);
  const importable = live.filter((q) => !q.stored && !q.importBlocker);
  // Displayed counters use the same rules as the Review Exceptions filters (review-filters.ts); REJECTED rows never count.
  const awaitingApproval = live.filter((q) => awaitingRule(q)).length;
  const unresolved = live.filter((q) => unresolvedRule(q)).length;
  const awaitingImportable = importable.filter((q) => !q.approved).length;
  const awaitingCleanApproval = importable.filter((q) => !q.approved && q.status === "READY" && q.issueCodes.length === 0).length;
  const approvedNotStored = live.filter((q) => q.approved && !q.stored && !q.importBlocker).length;
  const needsCorrection = by((q) => q.status === "NEEDS_CORRECTION");
  const importFailed = by((q) => q.status === "IMPORT_FAILED");
  const rescanPending = by((q) => q.rescanPending);
  const report: QualityReport = {
    expected,
    expectedFrom,
    expectedSources: sources,
    expectedConflict,
    publishBlocker: null,
    extracted: qs.length,
    counted,
    verified: liveBy((q) => q.verified === true),
    verifyDisagreed: liveBy((q) => q.verified === false),
    unverified: liveBy((q) => q.verified === null),
    approved,
    stored,
    rejected,
    notImportable: by((q) => q.status === "NOT_IMPORTABLE"),
    needsCorrection,
    importFailed,
    duplicateCandidates: liveBy((q) => q.status === "DUPLICATE" || DUPLICATE_CODES.some((c) => has(q, c))),
    rescanPending,
    awaitingApproval,
    unresolved,
    awaitingCleanApproval,
    approvedNotStored,
    answerKey: {
      official: liveBy((q) => q.answerStatus === "OFFICIAL_MATCHED"),
      independentlyVerified: liveBy((q) => q.answerStatus === "INDEPENDENTLY_VERIFIED"),
      unverified: liveBy((q) => q.answerStatus === "UNVERIFIED"),
      missing: liveBy((q) => q.answerStatus === "KEY_MISSING"),
      mismatch: liveBy((q) => q.answerStatus === "KEY_MISMATCH" || q.answerStatus === "AMBIGUOUS_MAPPING"),
      unmatchedEntries: input.unmatchedKeyEntries,
      failedFiles: input.failedKeyFiles,
    },
    imageIssues: liveBy((q) => IMAGE_CODES.some((c) => has(q, c))),
    topicUncertain: liveBy((q) => has(q, "TOPIC_UNCERTAIN") || has(q, "SUBJECT_UNKNOWN") || has(q, "CLASSIFICATION_FAILED")),
    pages,
    missing,
    duplicateNumbers: duplicateNumbers(qs),
    verifierExtras: input.verifierExtras,
    countDifference,
    ackValid,
    blockers: [],
    warnings: [],
    state: "PROCESSING",
  };

  const b = report.blockers;
  if (pages.failed) b.push(`${pages.failed} page(s) failed — retry them (finished pages are not read or charged again).`);
  if (pages.needsReview) b.push(`${pages.needsReview} scanned page(s) were not read (paid AI is off or unavailable).`);
  if (input.failedKeyFiles) b.push(`${input.failedKeyFiles} answer-key file(s) could not be read.`);
  if (rescanPending) b.push(`${rescanPending} re-scan result(s) are waiting for your choice.`);
  if (needsCorrection) b.push(`${needsCorrection} question(s) need correction.`);
  if (importFailed) b.push(`${importFailed} question(s) were not accepted by the Question Bank.`);
  const unexplained = unexplainedPages(input.pages);
  if (unexplained.length) b.push(`${unexplained.length} page(s) not accounted for: ${unexplained.slice(0, 6).map((u) => `page ${u.page ?? "?"} (${u.why})`).join("; ")}${unexplained.length > 6 ? ` … and ${unexplained.length - 6} more` : ""}.`);
  if (expectedConflict && !conflictAcked) b.push(expectedConflict);
  if (expected === null && input.processed) {
    const maxRead = Math.max(0, ...qs.filter((q) => !q.section).map((q) => q.number ?? 0));
    const hint = [maxRead ? `the paper reads up to Q${maxRead}` : null, input.keyMaxNumber ? `the answer key goes up to ${input.keyMaxNumber}` : null].filter(Boolean).join(" and ");
    b.push(`The expected number of questions was not confirmed${hint ? ` (${hint})` : ""} — without it, questions missing at the end of the paper cannot be detected.`);
  }
  const sequenceProblem = missing.length > 0 || (countDifference !== null && countDifference !== 0);
  if (sequenceProblem && !ackValid) {
    if (missing.length) b.push(`Missing question number(s): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` … and ${missing.length - 20} more` : ""}.`);
    if (countDifference !== null && countDifference !== 0) b.push(countDifference > 0 ? `${countDifference} question(s) fewer than the ${expected} expected.` : `${-countDifference} question(s) more than the ${expected} expected — check for duplicates or split questions.`);
  }
  // Completeness gate for publishing (owner Sprint A item 6): a paper with an unconfirmed or contradicted question count,
  // unexplained missing questions / count difference, or pages that were not read is never published silently.
  const shortBy = countDifference !== null && countDifference > 0 ? ` (${expected} expected / ${counted} extracted / ${countDifference} missing)` : "";
  report.publishBlocker =
    (conflictAcked ? null : expectedConflict) ??
    (expected === null && !ackValid ? "The expected number of questions is not confirmed (enter it on the job page, or explain why it is unknown) — without it, missing questions cannot be detected." : null) ??
    (sequenceProblem && !ackValid ? `The paper is incomplete${shortBy}${missing.length ? `; missing ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? " …" : ""}` : ""} — add or re-scan the missing questions, or acknowledge the difference with a reason.` : null) ??
    (pages.failed || pages.needsReview ? `${pages.failed + pages.needsReview} page(s) of the paper were not read — retry them first.` : null);

  const w = report.warnings;
  if (sequenceProblem && ackValid) w.push(`Count difference / missing numbers acknowledged: ${input.ack!.note}`);
  if (keyBeyond) w.push(`The answer key numbers up to ${input.keyMaxNumber}, more than the ${expected} expected — check for questions missing at the end of the paper.`);
  if (conflictAcked) w.push(`Expected-count conflict acknowledged: ${input.ack!.note} (${expectedConflict})`);
  if (report.duplicateNumbers.length) w.push(`Question number(s) read on more than one question: ${report.duplicateNumbers.slice(0, 10).join(", ")} — each copy is kept and flagged; set the right numbers or reject the extra copy.`);
  const low = lowCountPages(qs, input.pages);
  if (low.length) w.push(`Page(s) with unusually few questions: ${low.slice(0, 6).map((l) => `page ${l.page} (${l.count}, usually ${l.typical})`).join(", ")} — check for a missed column or half page.`);
  if (input.verifierExtras.length) w.push(`The independent read found question(s) the primary read did not: ${input.verifierExtras.slice(0, 10).join(", ")}.`);
  if (report.verifyDisagreed) w.push(`${report.verifyDisagreed} question(s) where the independent read disagreed or did not find the question.`);
  if (report.notImportable) w.push(`${report.notImportable} question(s) cannot be stored by the Question Bank (unsupported type).`);
  if (report.duplicateCandidates) w.push(`${report.duplicateCandidates} duplicate candidate(s).`);
  if (report.imageIssues) w.push(`${report.imageIssues} question(s) with an image problem (missing or placement not confirmed).`);
  if (report.answerKey.unverified) w.push(`${report.answerKey.unverified} answer(s) not confirmed by an official key.`);
  if (report.answerKey.mismatch) w.push(`${report.answerKey.mismatch} answer-key mismatch(es) or ambiguous mapping(s).`);
  if (input.unmatchedKeyEntries) w.push(`${input.unmatchedKeyEntries} answer-key entr(y/ies) matched no question.`);
  if (report.topicUncertain) w.push(`${report.topicUncertain} question(s) without a confident subject/topic.`);

  if (!input.processed) report.state = "PROCESSING";
  else if (b.length) report.state = "NEEDS_CORRECTION";
  else if (awaitingImportable > 0) report.state = live.some((q) => !q.stored && !q.importBlocker && !q.approved && q.issueCodes.length > 0) ? "READY_FOR_REVIEW" : "READY_FOR_APPROVAL";
  else if (approvedNotStored > 0) report.state = "APPROVED";
  else report.state = w.length || report.notImportable || report.rejected ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
  return report;
}
