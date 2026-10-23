import { createHash } from "node:crypto";
import type { ExtractedQuestion, PaperVerification } from "@/lib/ai-import/types";

/**
 * Fingerprint of what the full-paper verification checked: the question's effective content, its answer,
 * subject / topic / subtopic and figures. A Verify 1 / Verify 2 result whose fingerprint differs from the
 * question's current one is out of date (the question was edited, re-scanned, re-classified or its figures
 * changed) and counts for nothing until the verification runs again.
 */
export function contentFingerprint(input: {
  e: ExtractedQuestion;
  finalAnswer: string[];
  subjectId: string | null;
  topicId: string | null;
  subTopicId: string | null;
  figures: { originalSha256: string; owner: string; optionLabel: string | null; mappingStatus: string; confirmedById: string | null }[];
}): string {
  const e = input.e;
  const body = {
    n: [e.section ?? "", e.number ?? null],
    t: e.type,
    s: [e.instructions ?? "", e.passage ?? "", e.stem],
    o: e.options.map((o) => [o.label, o.text]),
    l: [(e.listI ?? []).map((x) => [x.key, x.text]), (e.listII ?? []).map((x) => [x.key, x.text])],
    p: [...e.printedAnswer].sort(),
    a: [...input.finalAnswer].sort(),
    x: [input.subjectId, input.topicId, input.subTopicId],
    f: input.figures.map((f) => [f.originalSha256, f.owner, f.optionLabel, f.mappingStatus, !!f.confirmedById]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
}

export type V1State = "passed" | "problems" | "stale" | "none";
/** "not_found" and "disagree" need a manual decision; "failed" / "unavailable" are NO result (never agreement). */
export type V2State = "verified" | "disagree" | "not_found" | "failed" | "unavailable" | "stale" | "none";

/** The full-paper verification state of one question, judged against its current fingerprint. */
export function verifyState(data: unknown, fingerprint: string): { v1: V1State; v2: V2State; pv: PaperVerification | null } {
  const pv = ((data as ExtractedQuestion | null)?.paperVerify ?? null) as PaperVerification | null;
  const v1: V1State = !pv?.v1 ? "none" : pv.v1.fingerprint !== fingerprint ? "stale" : pv.v1.passed ? "passed" : "problems";
  const s = pv?.v2?.status;
  const v2: V2State = !pv?.v2 ? "none" : pv.v2.fingerprint !== fingerprint ? "stale" : s === "VERIFIED" ? "verified" : s === "FAILED" ? "failed" : s === "UNAVAILABLE" ? "unavailable" : s === "NOT_FOUND" ? "not_found" : "disagree";
  return { v1, v2, pv };
}

/**
 * What the administrator sees for one question (Pending / Running / Passed / Findings / Disagreement / Failed /
 * Unavailable / Out of date / Not run). `job` is the job's Verify 2 state: a question without a current result
 * is Pending while Verify 2 is queued and Running while it runs — never Passed.
 */
export const V1_DISPLAY: Record<V1State, string> = { passed: "Passed", problems: "Findings", stale: "Out of date", none: "Not run" };
export function v2Display(v2: V2State, job: { status: string } | null | undefined): string {
  if ((v2 === "none" || v2 === "stale" || v2 === "failed" || v2 === "unavailable") && job && (job.status === "QUEUED" || job.status === "RUNNING")) return job.status === "QUEUED" ? "Pending" : "Running";
  return { verified: "Passed", disagree: "Disagreement", not_found: "Disagreement (not found)", failed: "Failed", unavailable: "Unavailable", stale: "Out of date", none: "Not run" }[v2];
}
