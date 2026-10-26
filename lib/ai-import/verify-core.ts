import { createHash } from "node:crypto";
import { stripAnnotationTail } from "@/lib/ai-import/local-parse";
import type { ExtractedQuestion, FingerprintParts, PaperVerification } from "@/lib/ai-import/types";

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

type FpInput = Parameters<typeof contentFingerprint>[0];
const hash = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);

/**
 * The same facts, fingerprinted separately (importer-reliability-2): content (wording, options, lists, type, number —
 * a lone printed tick left at the end of an option is an annotation and ignored), answer (printed + final), taxonomy
 * (subject / topic / subtopic ids) and figures. A Verify 1 / Verify 2 result records all four: changing only the
 * subject / topic makes only the taxonomy checks out of date, never the content verification.
 */
export function fingerprintParts(input: FpInput): FingerprintParts {
  const e = input.e;
  return {
    content: hash({ n: [e.section ?? "", e.number ?? null], t: e.type, s: [e.instructions ?? "", e.passage ?? "", stripAnnotationTail(e.stem)], o: e.options.map((o) => [o.label, stripAnnotationTail(o.text)]), l: [(e.listI ?? []).map((x) => [x.key, x.text]), (e.listII ?? []).map((x) => [x.key, x.text])] }),
    answer: hash({ p: [...e.printedAnswer].sort(), a: [...input.finalAnswer].sort() }),
    taxonomy: hash([input.subjectId, input.topicId, input.subTopicId]),
    figures: hash(input.figures.map((f) => [f.originalSha256, f.owner, f.optionLabel, f.mappingStatus, !!f.confirmedById]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
  };
}

/** The content fingerprint alone (what a "text-only" decision or a content check was made on). */
export const contentPartOf = (e: ExtractedQuestion): string => fingerprintParts({ e, finalAnswer: [], subjectId: null, topicId: null, subTopicId: null, figures: [] }).content;

/** A question's current fingerprints: the combined one (results written before importer-reliability-2) and the parts. */
export interface Fp {
  legacy: string;
  parts: FingerprintParts;
}
export function fingerprintsOf(input: FpInput): Fp {
  return { legacy: contentFingerprint(input), parts: fingerprintParts(input) };
}

/** What a new verification result records about the question it checked. */
export const stampOf = (fp: Fp) => ({ fingerprint: fp.legacy, parts: fp.parts });

/** Content, answer and figures unchanged (the subject / topic may differ). Older results without parts: the combined fingerprint. */
export function contentCurrent(r: { fingerprint: string; parts?: FingerprintParts | null }, fp: string | Fp): boolean {
  if (typeof fp === "string") return r.fingerprint === fp;
  if (!r.parts) return r.fingerprint === fp.legacy;
  return r.parts.content === fp.parts.content && r.parts.answer === fp.parts.answer && r.parts.figures === fp.parts.figures;
}

/** Whether a result's subject / topic part still describes the stored subject / topic. */
export function taxonomyCurrent(r: { fingerprint: string; parts?: FingerprintParts | null } | null | undefined, fp: string | Fp): boolean {
  if (!r) return false;
  if (typeof fp === "string") return r.fingerprint === fp;
  return r.parts ? r.parts.taxonomy === fp.parts.taxonomy : r.fingerprint === fp.legacy;
}

export type V1State = "passed" | "problems" | "stale" | "none";
/** "not_found" and "disagree" need a manual decision; "failed" / "unavailable" are NO result (never agreement). */
export type V2State = "verified" | "disagree" | "not_found" | "failed" | "unavailable" | "stale" | "none";

/** The full-paper verification state of one question, judged against its current fingerprint. */
export function verifyState(data: unknown, fingerprint: string | Fp): { v1: V1State; v2: V2State; pv: PaperVerification | null } {
  const pv = ((data as ExtractedQuestion | null)?.paperVerify ?? null) as PaperVerification | null;
  // Out of date only when the content, answer or figures changed; a changed subject / topic leaves the content checks
  // valid (its own taxonomy findings are then out of date: taxonomyCurrent, used by post-processing).
  const v1: V1State = !pv?.v1 ? "none" : !contentCurrent(pv.v1, fingerprint) ? "stale" : pv.v1.passed ? "passed" : "problems";
  const s = pv?.v2?.status;
  const v2: V2State = !pv?.v2 ? "none" : !contentCurrent(pv.v2, fingerprint) ? "stale" : s === "VERIFIED" ? "verified" : s === "FAILED" ? "failed" : s === "UNAVAILABLE" ? "unavailable" : s === "NOT_FOUND" ? "not_found" : "disagree";
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

// ---- Targeted verification passes ---------------------------------------------------------------------------

/**
 * At most three verification passes per question: Pass 1 = Verify 1 (free, deterministic; counted once), Pass 2 =
 * Verify 2 only where it is still needed, Pass 3 = a re-scan of a remaining disagreement. A question at the limit is
 * never sent again; its open findings stay for the administrator (nothing is approved by reaching the limit).
 */
export const MAX_VERIFY_PASSES = 3;

/**
 * A Verify 2 read counts as a pass only when it gave a result (agree / disagree / not found): a failed or unavailable
 * read is no verification, so it never uses up the limit and the question can be retried (resume, not restart).
 */
export const V2_RESULT_STATUSES = ["VERIFIED", "DISAGREE", "NOT_FOUND"];

/** Passes so far (older questions without a log: Verify 1 / a Verify 2 read with a result count as one each). */
export function passCount(pv: PaperVerification | null | undefined): number {
  if (!pv) return 0;
  if (pv.passes) return pv.passes.length;
  return (pv.v1 ? 1 : 0) + (pv.v2 && V2_RESULT_STATUSES.includes(pv.v2.status) ? 1 : 0);
}

/** The pass log with one more pass (Verify 1 only once; older questions get their earlier passes recorded first). */
export function withPass(pv: PaperVerification | null | undefined, kind: "v1" | "v2" | "rescan", model: string | null = null, at = new Date().toISOString()): NonNullable<PaperVerification["passes"]> {
  const log = pv?.passes ? [...pv.passes] : [...(pv?.v1 ? [{ kind: "v1" as const, at: pv.v1.at }] : []), ...(pv?.v2 && V2_RESULT_STATUSES.includes(pv.v2.status) ? [{ kind: "v2" as const, at: pv.v2.at, model: pv.v2.model }] : [])];
  if (kind === "v1" && log.some((p) => p.kind === "v1")) return log;
  return [...log, { kind, at, model }];
}

/**
 * Whether Verify 2 should read this question again (Pass 2 is targeted): not when it is at the pass limit, and not
 * when it already has an up-to-date agreeing result (a successful check is never re-run without a reason). No result,
 * a failed or unavailable read, an out-of-date result or an unresolved disagreement still needs it.
 */
export function needsVerify2(q: { data: unknown }, fingerprint: string | Fp): boolean {
  const s = verifyState(q.data, fingerprint);
  return passCount(s.pv) < MAX_VERIFY_PASSES && s.v2 !== "verified";
}
