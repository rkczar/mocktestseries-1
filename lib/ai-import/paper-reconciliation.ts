/**
 * Question-number reconciliation of one paper (pure; no server imports): every printed number 1..expected lands in
 * exactly one bucket with the exact reason, so a missing or blocked question is visible immediately (2026-11-12,
 * FSO 2019 / 2022 audit). Rows without a number (extraction artifacts, rejected) are reported separately.
 */
export type ReconBucket =
  | "PUBLISHED"
  | "IN_BANK_DRAFT"
  | "WITHDRAWN_IN_PAPER"
  | "WITHDRAWN_NOT_IN_PAPER"
  | "APPROVED_IMPORTABLE"
  | "READY_AWAITING_APPROVAL"
  | "BLOCKED"
  | "DUPLICATE"
  | "REJECTED"
  | "MISSING"
  | "MULTIPLE_RECORDS";

export interface ReconInput {
  id: string;
  number: number | null;
  status: string;
  answerStatus: string;
  approved: boolean;
  questionId: string | null;
  /** Question Bank status of questionId (null = not in the bank). */
  bankStatus: string | null;
  /** The real gate: why it is not imported now (null = importable now). */
  gate: string | null;
  /** The real gate without the approval: why approving would not make it importable (null = it would). */
  gateOnceApproved: string | null;
  pages: number[];
}

export interface ReconRow {
  number: number;
  bucket: ReconBucket;
  ids: string[];
  pages: number[];
  reason: string;
  /** Not in the Question Bank and not an artifact: a Master Admin may FORCE TO PUBLISH (or add as WITHDRAWN). */
  forceAvailable: boolean;
}

export interface PaperReconciliation {
  expected: number;
  rows: ReconRow[];
  counts: Record<ReconBucket, number>;
  missing: number[];
  unnumbered: { id: string; status: string }[];
  /** Original numbers present in the importer at all (any bucket except MISSING). */
  extracted: number;
}

export const BUCKET_LABELS: Record<ReconBucket, string> = {
  PUBLISHED: "Published",
  IN_BANK_DRAFT: "In Question Bank (draft)",
  WITHDRAWN_IN_PAPER: "Withdrawn (shown in paper)",
  WITHDRAWN_NOT_IN_PAPER: "Withdrawn — not added to paper",
  APPROVED_IMPORTABLE: "Approved and importable",
  READY_AWAITING_APPROVAL: "Ready — awaiting approval",
  BLOCKED: "Blocked (needs correction / hold)",
  DUPLICATE: "Duplicate (skipped)",
  REJECTED: "Rejected",
  MISSING: "Missing",
  MULTIPLE_RECORDS: "Several records",
};

function classify(r: ReconInput): Omit<ReconRow, "number" | "ids" | "pages"> {
  const notInBank = !r.questionId;
  if (r.questionId && r.bankStatus === "PUBLISHED") return { bucket: "PUBLISHED", reason: "", forceAvailable: false };
  if (r.questionId && r.bankStatus === "WITHDRAWN") return { bucket: "WITHDRAWN_IN_PAPER", reason: "withdrawn in the official key; shown in the paper, not scored", forceAvailable: false };
  if (r.questionId) return { bucket: "IN_BANK_DRAFT", reason: `in the Question Bank as ${String(r.bankStatus ?? "unknown").toLowerCase()} — publish it from the paper's batch page`, forceAvailable: false };
  if (r.status === "REJECTED") return { bucket: "REJECTED", reason: r.gate ?? "rejected", forceAvailable: false };
  if (r.answerStatus === "WITHDRAWN") return { bucket: "WITHDRAWN_NOT_IN_PAPER", reason: "withdrawn in the official key — a Master Admin can add it to the paper as WITHDRAWN", forceAvailable: notInBank };
  if (r.status === "DUPLICATE") return { bucket: "DUPLICATE", reason: r.gate ?? "duplicate of an existing Question Bank question", forceAvailable: notInBank };
  if (!r.gate) return { bucket: "APPROVED_IMPORTABLE", reason: "", forceAvailable: notInBank };
  if (!r.approved && !r.gateOnceApproved) return { bucket: "READY_AWAITING_APPROVAL", reason: "approve it to import", forceAvailable: notInBank };
  return { bucket: "BLOCKED", reason: (r.approved ? r.gate : r.gateOnceApproved) ?? r.gate, forceAvailable: notInBank };
}

export function reconcilePaper(expected: number, rows: ReconInput[]): PaperReconciliation {
  const byNumber = new Map<number, ReconInput[]>();
  const unnumbered: PaperReconciliation["unnumbered"] = [];
  for (const r of rows) {
    if (r.number === null || !Number.isInteger(r.number) || r.number < 1) unnumbered.push({ id: r.id, status: r.status });
    else byNumber.set(r.number, [...(byNumber.get(r.number) ?? []), r]);
  }
  const max = Math.max(expected, ...byNumber.keys());
  const out: ReconRow[] = [];
  for (let n = 1; n <= max; n++) {
    const rs = byNumber.get(n) ?? [];
    // A rejected duplicate read never hides the real record of the same number.
    const live = rs.filter((r) => r.status !== "REJECTED");
    if (!rs.length) out.push({ number: n, bucket: "MISSING", ids: [], pages: [], reason: n > expected ? "" : "no record of this number — re-scan its page", forceAvailable: false });
    else if (live.length > 1) out.push({ number: n, bucket: "MULTIPLE_RECORDS", ids: live.map((r) => r.id), pages: [...new Set(live.flatMap((r) => r.pages))], reason: `${live.length} records carry this number — keep one`, forceAvailable: false });
    else {
      const r = live[0] ?? rs[0];
      out.push({ number: n, ids: [r.id], pages: r.pages, ...classify(r) });
    }
  }
  const counts = Object.fromEntries(Object.keys(BUCKET_LABELS).map((k) => [k, 0])) as Record<ReconBucket, number>;
  for (const r of out) counts[r.bucket]++;
  return { expected, rows: out, counts, missing: out.filter((r) => r.bucket === "MISSING" && r.number <= expected).map((r) => r.number), unnumbered, extracted: out.filter((r) => r.bucket !== "MISSING").length };
}

// ---- First read vs independent second read (Verify 2), by identity (2026-11-19 audit) ----------------------------

/** One question of one read: identity = section + printed number; position = page and order on the page. */
export interface ReadRow<T> {
  section: string | null;
  number: number | null;
  page: number;
  /** Order within the read (reading order); rows are compared in this order for the reorder check. */
  order: number;
  item: T;
}

export interface ReadComparison {
  /** Identities ("Q12 p3", "S2 Q1 p27") the first read has and the second does not — and the reverse. */
  missingInSecond: string[];
  missingInFirst: string[];
  /** Identities one read holds more than once. */
  duplicatedInFirst: string[];
  duplicatedInSecond: string[];
  /** Numbers that come after a higher number of the same section in reading (page) order: "Q14 after Q15 (p5)". */
  reorderedInFirst: string[];
  reorderedInSecond: string[];
  /** Identities both reads hold whose wording / options differ (per `agree`). */
  conflicting: string[];
}

const idOf = (r: { section: string | null; number: number | null }) => `${r.section ? `${r.section} ` : ""}Q${r.number ?? "?"}`;

function dupes<T>(rows: ReadRow<T>[]): string[] {
  const seen = new Map<string, number[]>();
  for (const r of rows) if (r.number !== null) seen.set(idOf(r), [...(seen.get(idOf(r)) ?? []), r.page]);
  return [...seen].filter(([, p]) => p.length > 1).map(([k, p]) => `${k} (p${[...new Set(p)].join(", p")})`);
}

function reordered<T>(rows: ReadRow<T>[]): string[] {
  const out: string[] = [];
  const top = new Map<string, ReadRow<T>>();
  for (const r of [...rows].sort((a, b) => a.page - b.page || a.order - b.order)) {
    if (r.number === null) continue;
    const s = r.section ?? "";
    const hi = top.get(s);
    if (hi && hi.number! > r.number) out.push(`${idOf(r)} (p${r.page}) after ${idOf(hi)} (p${hi.page})`);
    else top.set(s, r);
  }
  return out;
}

/**
 * Reconciles the first read (stored questions) with the independent second read of the SAME pages, by identity — never
 * by position, so reading order cannot hide or invent a difference (pure). Only numbered rows have an identity.
 */
export function compareReads<T>(first: ReadRow<T>[], second: ReadRow<T>[], agree: (a: T, b: T) => boolean): ReadComparison {
  const index = (rows: ReadRow<T>[]) => {
    const m = new Map<string, ReadRow<T>>();
    for (const r of rows) if (r.number !== null && !m.has(idOf(r))) m.set(idOf(r), r);
    return m;
  };
  const a = index(first);
  const b = index(second);
  const at = (r: ReadRow<T>) => `${idOf(r)} p${r.page}`;
  return {
    missingInSecond: [...a.values()].filter((r) => !b.has(idOf(r))).map(at),
    missingInFirst: [...b.values()].filter((r) => !a.has(idOf(r))).map(at),
    duplicatedInFirst: dupes(first),
    duplicatedInSecond: dupes(second),
    reorderedInFirst: reordered(first),
    reorderedInSecond: reordered(second),
    conflicting: [...a].filter(([k, r]) => b.has(k) && !agree(r.item, b.get(k)!.item)).map(([, r]) => at(r)),
  };
}

/** Whether a comparison found anything (an empty one is "the two reads agree on every identity"). */
export const readsDiffer = (c: ReadComparison) => Object.values(c).some((x) => x.length > 0);

// ---- Duplicate upload (2026-11-19 audit: 2024 P-I / P-II were each uploaded twice, as DOCX and as a scan) ------------

export interface UploadIdentity {
  jobId: string;
  title: string;
  year: number | null;
  paperCode: string | null;
  /** Question 1 and question 11 as stored (null = not read). */
  q1: string | null;
  q11: string | null;
}

/** Normalized stem: lower-case letters and digits only (OCR spacing / punctuation / case never decide). */
export const stemKey = (s: string | null) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Why `other` looks like the same paper as `job` (pure; null = it does not): the same Q1 + Q11 wording (exact once
 * normalized, or ≥ `minSimilar` by `similar` for OCR noise), or the same year + paper code. Informational only.
 */
export function sameUpload(job: UploadIdentity, other: UploadIdentity, similar: (a: string, b: string) => number, minSimilar = 0.9): string | null {
  const close = (x: string | null, y: string | null) => !!stemKey(x) && !!stemKey(y) && (stemKey(x) === stemKey(y) || similar(x!, y!) >= minSimilar);
  if (close(job.q1, other.q1) && close(job.q11, other.q11)) return "the same question 1 and question 11";
  if (job.year !== null && job.year === other.year && !!job.paperCode?.trim() && job.paperCode.trim().toLowerCase() === other.paperCode?.trim().toLowerCase()) return `the same year (${job.year}) and paper (${job.paperCode})`;
  return null;
}
