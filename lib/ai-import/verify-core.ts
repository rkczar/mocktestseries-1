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

/** The full-paper verification state of one question, judged against its current fingerprint. */
export function verifyState(data: unknown, fingerprint: string): { v1: "passed" | "problems" | "stale" | "none"; v2: "verified" | "disagree" | "failed" | "stale" | "none"; pv: PaperVerification | null } {
  const pv = ((data as ExtractedQuestion | null)?.paperVerify ?? null) as PaperVerification | null;
  const v1 = !pv?.v1 ? "none" : pv.v1.fingerprint !== fingerprint ? "stale" : pv.v1.passed ? "passed" : "problems";
  const v2 = !pv?.v2 ? "none" : pv.v2.fingerprint !== fingerprint ? "stale" : pv.v2.status === "VERIFIED" ? "verified" : pv.v2.status === "FAILED" ? "failed" : "disagree";
  return { v1, v2, pv };
}
