/**
 * Sequence integrity and the final quality gate of an import (pure, client-safe).
 *
 * Built only from stored facts (questions, pages, key entries) — never from
 * frontend progress. A job is "Completed" only when every expected question is
 * accounted for: no failed page, no missing number, no unexplained count
 * difference and nothing waiting for a decision. An acknowledged difference
 * still completes "with warnings", never silently.
 */

export interface QualityQuestion {
  fileId: string;
  section: string;
  number: number | null;
  status: string;
  approved: boolean;
  stored: boolean;
  /** true = independent read agreed, false = it disagreed / did not find it, null = not verified. */
  verified: boolean | null;
  issueCodes: string[];
  answerStatus: string;
  importBlocker: string | null;
  rescanPending: boolean;
}

export interface QualityPage {
  status: string;
  kind: string | null;
  attempts: number;
  errorMessage: string | null;
}

export interface SequenceAck {
  byId: string;
  at: string;
  note: string;
  /** What was acknowledged; the acknowledgement lapses when the facts change. */
  missing: string[];
  expected: number | null;
  counted: number;
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
  /** Awaiting approval with no flag at all (what "Approve all questions without flags" approves). */
  awaitingCleanApproval: number;
  /** Approved, not yet in the Question Bank. */
  approvedNotStored: number;
  answerKey: { official: number; independentlyVerified: number; unverified: number; missing: number; mismatch: number; unmatchedEntries: number; failedFiles: number };
  imageIssues: number;
  topicUncertain: number;
  pages: { total: number; completed: number; failed: number; retrying: number; pending: number; skipped: number; needsReview: number };
  missing: string[];
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

export function qualityReport(input: QualityInput): QualityReport {
  const qs = input.questions;
  const by = (f: (q: QualityQuestion) => boolean) => qs.filter(f).length;
  const rejected = by((q) => q.status === "REJECTED");
  const live = qs.filter((q) => q.status !== "REJECTED");
  const numbered = new Set(qs.filter((q) => q.number !== null).map((q) => `${q.fileId}|${q.section}|${q.number}`));
  const counted = numbered.size + live.filter((q) => q.number === null).length;
  // Missing = numbers the extraction never found (a rejected question was found, so it is not missing).
  const missing = missingNumbers(qs, input.expected);
  const countDifference = input.expected === null ? null : input.expected - counted;
  const ackValid =
    !!input.ack && input.ack.expected === input.expected && input.ack.counted === counted && input.ack.missing.length === missing.length && input.ack.missing.every((m, i) => m === missing[i]);
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
  const awaitingApproval = importable.filter((q) => !q.approved).length;
  const awaitingCleanApproval = importable.filter((q) => !q.approved && q.status === "READY" && q.issueCodes.length === 0).length;
  const approvedNotStored = live.filter((q) => q.approved && !q.stored && !q.importBlocker).length;
  const needsCorrection = by((q) => q.status === "NEEDS_CORRECTION");
  const importFailed = by((q) => q.status === "IMPORT_FAILED");
  const rescanPending = by((q) => q.rescanPending);
  const report: QualityReport = {
    expected: input.expected,
    extracted: qs.length,
    counted,
    verified: by((q) => q.verified === true),
    verifyDisagreed: by((q) => q.verified === false),
    unverified: by((q) => q.verified === null),
    approved,
    stored,
    rejected,
    notImportable: by((q) => q.status === "NOT_IMPORTABLE"),
    needsCorrection,
    importFailed,
    duplicateCandidates: by((q) => q.status === "DUPLICATE" || has(q, "DUPLICATE_NEAR") || has(q, "DUPLICATE_IN_BATCH") || has(q, "DUPLICATE_EXISTING")),
    rescanPending,
    awaitingApproval,
    awaitingCleanApproval,
    approvedNotStored,
    answerKey: {
      official: by((q) => q.answerStatus === "OFFICIAL_MATCHED"),
      independentlyVerified: by((q) => q.answerStatus === "INDEPENDENTLY_VERIFIED"),
      unverified: by((q) => q.answerStatus === "UNVERIFIED"),
      missing: by((q) => q.answerStatus === "KEY_MISSING"),
      mismatch: by((q) => q.answerStatus === "KEY_MISMATCH" || q.answerStatus === "AMBIGUOUS_MAPPING"),
      unmatchedEntries: input.unmatchedKeyEntries,
      failedFiles: input.failedKeyFiles,
    },
    imageIssues: by((q) => has(q, "IMAGE_MISSING") || has(q, "IMAGE_MAPPING_UNCERTAIN")),
    topicUncertain: by((q) => has(q, "TOPIC_UNCERTAIN") || has(q, "SUBJECT_UNKNOWN")),
    pages,
    missing,
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
  if (input.expected === null && input.processed) b.push("The expected number of questions was not confirmed.");
  const sequenceProblem = missing.length > 0 || (countDifference !== null && countDifference !== 0);
  if (sequenceProblem && !ackValid) {
    if (missing.length) b.push(`Missing question number(s): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` … and ${missing.length - 20} more` : ""}.`);
    if (countDifference !== null && countDifference !== 0) b.push(countDifference > 0 ? `${countDifference} question(s) fewer than the ${input.expected} expected.` : `${-countDifference} question(s) more than the ${input.expected} expected — check for duplicates or split questions.`);
  }

  const w = report.warnings;
  if (sequenceProblem && ackValid) w.push(`Count difference / missing numbers acknowledged: ${input.ack!.note}`);
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
  else if (awaitingApproval > 0) report.state = live.some((q) => !q.stored && !q.importBlocker && !q.approved && q.issueCodes.length > 0) ? "READY_FOR_REVIEW" : "READY_FOR_APPROVAL";
  else if (approvedNotStored > 0) report.state = "APPROVED";
  else report.state = w.length || report.notImportable || report.rejected ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
  return report;
}
