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
