/**
 * Importer master (I-B, 2026-11-12) — version-aware verification, approval vs. later verification, stale Verify 2,
 * import gate. PURE: no database query, no AI, no network. importBlocker is imported from the adapter module but only
 * called on in-memory rows; DATABASE_URL must still point at a scratch mts_* name (nothing connects).
 *
 *   DATABASE_URL=postgresql://none@127.0.0.1:1/mts_none NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/verify-importer-version-integrity.ts
 */
import assert from "node:assert/strict";
import type { AiImportFigure, AiImportQuestion } from "@prisma/client";
import { approvalOutdatedBy, approvedAfter, CHECK_STATUS_LABELS, checksAllowReady, mergePaperVerify, questionChecks, reviewClearsFlag, VERIFY_HISTORY_MAX } from "@/lib/ai-import/checks";
import { fingerprintsOf, stampOf, verifyState } from "@/lib/ai-import/verify-core";
import { v1FieldChecks } from "@/lib/ai-import/field-checks";
import { normalizeImporterSettings } from "@/lib/ai-import/config";
import type { ExtractedQuestion, PaperVerification, QuestionChecks } from "@/lib/ai-import/types";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: set DATABASE_URL to a scratch mts_* name (nothing connects; the adapter module needs a URL to load).");
  process.exit(2);
}

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}

const T0 = "2026-11-11T12:00:00.000Z"; // approval before
const TV = "2026-11-11T23:30:00.000Z"; // Verify run
const T1 = "2026-11-12T01:00:00.000Z"; // approval after

const eq = (over: Partial<ExtractedQuestion> = {}): ExtractedQuestion =>
  ({ section: "", number: 7, label: "7", pages: [1], type: "SINGLE_CORRECT", stem: "Which crop is a legume?", options: ["Gram", "Wheat", "Rice", "Maize"].map((text, i) => ({ label: "ABCD"[i], printed: "ABCD"[i], text })), printedAnswer: [], contentFormat: "PLAIN", confidence: 1, unreadable: [], figures: [], method: "DOCX", ...over }) as ExtractedQuestion;
const fpOf = (e: ExtractedQuestion) => fingerprintsOf({ e, finalAnswer: ["A"], subjectId: "s1", topicId: "t1", subTopicId: null, figures: [] });
const v2 = (e: ExtractedQuestion, status: "VERIFIED" | "DISAGREE" | "NOT_FOUND" | "FAILED" | "UNAVAILABLE", at = TV) => ({ ...stampOf(fpOf(e)), at, model: "gemma-3-27b", status, fields: status === "DISAGREE" ? ["option B"] : [], detail: status === "DISAGREE" ? "option B differs" : "ok" });
const v1 = (e: ExtractedQuestion, passed: boolean, problems: { code: string; detail: string }[] = [], at = TV) => ({ ...stampOf(fpOf(e)), at, passed, problems, fixes: [] });

const baseChecks = { codes: [] as string[], issues: new Map<string, string>(), answerStatus: "OFFICIAL_MATCHED" as const, answerConfirmed: false, subjectId: "s1", topicId: "t1", adminTaxonomy: false, v2Classification: null, v1Ran: true };

async function main() {
  console.log("A. Stale Verify 2 = Re-verification needed (checks.ts)");
  const orig = eq();
  const edited = eq({ stem: "Which crop is a pulse?" });
  await t("A1 stale agreeing Verify 2, no approval → STALE, required, not Ready", () => {
    const c = questionChecks({ ...baseChecks, v2: null, v2Stale: v2(orig, "VERIFIED") });
    assert.equal(c.independent.status, "STALE");
    assert.equal(c.independent.required, true);
    assert.equal(CHECK_STATUS_LABELS.STALE, "Re-verification needed");
    assert.equal(checksAllowReady(c), false);
  });
  await t("A2 stale Verify 2, approved after it → STALE, not required, Ready allowed", () => {
    const c = questionChecks({ ...baseChecks, v2: null, v2Stale: v2(orig, "DISAGREE"), approvedAt: T1 });
    assert.equal(c.independent.status, "STALE");
    assert.equal(c.independent.required, false);
    assert.equal(checksAllowReady(c), true);
  });
  await t("A3 stale Verify 2, approval older than it → still required", () => {
    const c = questionChecks({ ...baseChecks, v2: null, v2Stale: v2(orig, "VERIFIED"), approvedAt: T0 });
    assert.equal(c.independent.required, true);
  });
  await t("A4 stale UNAVAILABLE / FAILED (no result) and no Verify 2 → NOT_RUN, not required (unchanged)", () => {
    for (const s of ["UNAVAILABLE", "FAILED"] as const) assert.deepEqual([questionChecks({ ...baseChecks, v2: null, v2Stale: v2(orig, s) }).independent.status, questionChecks({ ...baseChecks, v2: null, v2Stale: v2(orig, s) }).independent.required], ["NOT_RUN", false]);
    assert.equal(questionChecks({ ...baseChecks, v2: null }).independent.status, "NOT_RUN");
  });
  await t("A5 current disagreement: required until an approval AFTER it", () => {
    assert.equal(questionChecks({ ...baseChecks, v2: v2(orig, "DISAGREE") }).independent.required, true);
    assert.equal(questionChecks({ ...baseChecks, v2: v2(orig, "DISAGREE"), approvedAt: T0 }).independent.required, true);
    const after = questionChecks({ ...baseChecks, v2: v2(orig, "DISAGREE"), approvedAt: T1 });
    assert.equal(after.independent.status, "DISAGREEMENT");
    assert.equal(after.independent.required, false);
  });
  await t("A6 verifyState: an edit makes Verify 2 stale (content fingerprint)", () => {
    assert.equal(verifyState({ paperVerify: { v2: v2(orig, "VERIFIED") } }, fpOf(edited)).v2, "stale");
    assert.equal(verifyState({ paperVerify: { v2: v2(orig, "VERIFIED") } }, fpOf(orig)).v2, "verified");
  });

  console.log("B. A review hides a verification flag only if it came after the result (post.ts)");
  await t("B1 not reviewed → nothing hidden", () => assert.equal(reviewClearsFlag({ reviewedById: null, approvedAt: null }, undefined), false));
  await t("B2 edit / Hindi confirmed (reviewed, not approved) after Verify 2 → Verify 2 flag stays", () => assert.equal(reviewClearsFlag({ reviewedById: "a", approvedAt: null }, TV), false));
  await t("B3 approval BEFORE the Verify 2 result → flag stays", () => assert.equal(reviewClearsFlag({ reviewedById: "a", approvedAt: new Date(T0) }, TV), false));
  await t("B4 approval AFTER the result → flag cleared", () => assert.equal(reviewClearsFlag({ reviewedById: "a", approvedAt: new Date(T1) }, TV), true));
  await t("B5 a flag not raised by a verification → any review clears it (earlier rule)", () => assert.equal(reviewClearsFlag({ reviewedById: "a", approvedAt: null }, undefined), true));
  await t("B6 invalid / missing times never count as after", () => {
    assert.equal(approvedAfter(null, TV), false);
    assert.equal(approvedAfter(T1, "not a date"), false);
    assert.equal(approvedAfter(TV, TV), false);
  });

  console.log("C. Approval older than the current failing result (importBlocker reason)");
  const s = (pv: PaperVerification, e = orig) => verifyState({ paperVerify: pv }, fpOf(e));
  await t("C1 approved before a current Verify 2 disagreement → refused with a reason", () => {
    const why = approvalOutdatedBy(new Date(T0), s({ v2: v2(orig, "DISAGREE") }));
    assert.ok(why && /disagreed at 2026-11-11 23:30 UTC/.test(why) && /approve it again/.test(why), why ?? "null");
  });
  await t("C2 approved after it → covered (null); agreeing Verify 2 → null", () => {
    assert.equal(approvalOutdatedBy(new Date(T1), s({ v2: v2(orig, "DISAGREE") })), null);
    assert.equal(approvalOutdatedBy(new Date(T0), s({ v2: v2(orig, "VERIFIED") })), null);
  });
  await t("C3 approved before Verify 1 found problems → refused; Verify 1 'not passed' with no finding → not refused", () => {
    assert.ok(approvalOutdatedBy(new Date(T0), s({ v1: v1(orig, false, [{ code: "REFERENCE_CONFLICT", detail: "key differs" }]) })));
    assert.equal(approvalOutdatedBy(new Date(T0), s({ v1: v1(orig, false, []) })), null);
  });
  await t("C4 approval before a Verify 2 result the question then changed from → re-verification needed", () => {
    const why = approvalOutdatedBy(new Date(T0), s({ v2: v2(orig, "VERIFIED") }, edited));
    assert.ok(why && /re-verification needed/.test(why), why ?? "null");
  });
  await t("C5 not approved → null (the 'not approved yet' rule decides)", () => assert.equal(approvalOutdatedBy(null, s({ v2: v2(orig, "DISAGREE") })), null));

  console.log("D. Results record the version checked; earlier results kept as history (paper-verify.ts savePaperVerify)");
  const run = { versionId: "ver_abc12345", versionAt: T0, flags: ["OCR_UNCERTAIN"] };
  await t("D1 a first Verify 1 is stamped with version + flags open then, no history", () => {
    const out = mergePaperVerify(null, { v1: v1(orig, true) }, run, TV);
    assert.equal(out.v1?.versionId, "ver_abc12345");
    assert.deepEqual(out.v1?.flagsAtRun, ["OCR_UNCERTAIN"]);
    assert.deepEqual(out.history, []);
  });
  await t("D2 a new Verify 2 replaces the old one, which becomes historical; other keys kept", () => {
    const prev: PaperVerification = { passes: [{ kind: "v1", at: T0 }], v1: { ...v1(orig, true), versionId: "original" }, v2: { ...v2(orig, "DISAGREE", T0), versionId: "original" } };
    const out = mergePaperVerify(prev, { v2: v2(edited, "VERIFIED", TV) }, run, T1);
    assert.equal(out.v2?.status, "VERIFIED");
    assert.equal(out.v2?.versionId, "ver_abc12345");
    assert.equal(out.v1?.versionId, "original", "untouched Verify 1 kept");
    assert.deepEqual(out.passes, prev.passes);
    assert.equal(out.history?.length, 1);
    assert.deepEqual([out.history![0].kind, out.history![0].outcome, out.history![0].versionId, out.history![0].supersededAt], ["v2", "DISAGREE", "original", T1]);
  });
  await t("D3 an update of the same result (same time: re-assessment / classification) keeps its stamp, adds no history", () => {
    const prev: PaperVerification = { v2: { ...v2(orig, "DISAGREE"), versionId: "ver_old", flagsAtRun: [] } };
    const out = mergePaperVerify(prev, { v2: { ...prev.v2!, status: "VERIFIED" } }, run, T1);
    assert.equal(out.v2?.versionId, "ver_old");
    assert.deepEqual(out.v2?.flagsAtRun, []);
    assert.deepEqual(out.history, []);
  });
  await t(`D4 history is capped at ${VERIFY_HISTORY_MAX} (newest kept)`, () => {
    let pv: PaperVerification | null = null;
    for (let i = 0; i < 15; i++) pv = mergePaperVerify(pv, { v1: v1(orig, i % 2 === 0, [], new Date(Date.parse(T0) + i * 60_000).toISOString()) }, run, T1);
    assert.equal(pv!.history!.length, VERIFY_HISTORY_MAX);
    assert.equal(pv!.history![VERIFY_HISTORY_MAX - 1].at, new Date(Date.parse(T0) + 13 * 60_000).toISOString());
  });

  console.log("E. Field checks label flags copied at run time");
  await t("E1 a copied issue code says it was open when Verify 1 ran", () => {
    const fc = v1FieldChecks({ e: orig, problems: [], fixes: [], issueCodes: ["OPTIONS_INCOMPLETE"], issueLabel: (c) => c, memory: [], answer: { final: ["A"], official: ["A"], status: "OFFICIAL_MATCHED", adminConfirmed: false }, classification: null, name: () => null, documentText: true });
    assert.ok(fc.some((f) => f.problem === "OPTIONS_INCOMPLETE (flag open when Verify 1 ran)"), JSON.stringify(fc.filter((f) => f.status === "PROBLEM")));
  });

  console.log("F. Import gate (adapter.ts importBlocker, in-memory rows only)");
  const { importBlocker } = await import("@/lib/ai-import/adapter");
  const settings = normalizeImporterSettings({});
  const passed = (): QuestionChecks => ({ at: T1, content: { status: "PASSED", required: true, detail: "" }, answer: { status: "PASSED", required: true, detail: "" }, taxonomy: { status: "PASSED", required: true, detail: "" }, independent: { status: "NOT_RUN", required: false, detail: "" } });
  const row = (over: Partial<AiImportQuestion> = {}, pv: PaperVerification | null = null, checks: QuestionChecks | null = passed()) =>
    ({ id: "q1", questionId: null, answerStatus: "OFFICIAL_MATCHED", academicReview: null, status: "READY", allowDuplicate: false, issueCodes: [], finalAnswer: ["A"], answerConfirmedById: null, subjectId: "s1", topicId: "t1", subTopicId: null, questionType: "SINGLE_CORRECT", approvedById: "admin", approvedAt: new Date(T1), data: { ...eq(), paperVerify: pv, checks }, editedData: null, figures: [] as AiImportFigure[], ...over }) as unknown as AiImportQuestion & { figures: AiImportFigure[] };
  await t("F1 approved + READY + nothing failing → importable", () => assert.equal(importBlocker(row(), settings), null));
  await t("F2 approved but NEEDS_CORRECTION → refused with the status and the failing checks", () => {
    const c = passed();
    c.independent = { status: "DISAGREEMENT", required: true, detail: "" };
    const why = importBlocker(row({ status: "NEEDS_CORRECTION" }, null, c), settings);
    assert.ok(why && /^status is needs correction \(Verify 2: disagreement\)/.test(why), why ?? "null");
  });
  await t("F3 approved BEFORE the current Verify 2 disagreement → refused with the approval reason (data unchanged)", () => {
    const r = row({ approvedAt: new Date(T0) }, { v2: v2(eq(), "DISAGREE") });
    const why = importBlocker(r, settings);
    assert.ok(why && /^approved 2026-11-11 12:00 UTC, before Verify 2/.test(why), why ?? "null");
    assert.equal(r.approvedById, "admin");
    assert.equal(r.approvedAt?.toISOString(), T0);
  });
  await t("F4 approved AFTER the disagreement and READY → importable", () => assert.equal(importBlocker(row({}, { v2: v2(eq(), "DISAGREE") }), settings), null));
  await t("F5 EXTRACTED (not re-checked) refused; IMPORT_FAILED retry allowed only while checks allow Ready", () => {
    assert.match(importBlocker(row({ status: "EXTRACTED" }), settings) ?? "", /not re-checked/);
    assert.equal(importBlocker(row({ status: "IMPORT_FAILED" }), settings), null);
    const c = passed();
    c.answer = { status: "NEEDS_REVIEW", required: true, detail: "" };
    assert.match(importBlocker(row({ status: "IMPORT_FAILED" }, null, c), settings) ?? "", /^status is import failed/);
  });
  await t("F6 'would it be importable once approved' (ignoreApproval) is not changed by status", () => assert.equal(importBlocker(row({ status: "NEEDS_CORRECTION", approvedById: null, approvedAt: null }), settings, { ignoreApproval: true }), null));
  await t("F7 safeguards intact: academic hold, damaged formula, unapproved, withdrawn", () => {
    assert.match(importBlocker(row({ academicReview: "AMBIGUOUS_PENDING_ACADEMIC_REVIEW" }), settings) ?? "", /academic review/);
    assert.match(importBlocker(row({ issueCodes: ["FORMULA_TEXT_CORRUPT"] }), settings) ?? "", /Formula text damaged/);
    assert.equal(importBlocker(row({ approvedById: null, approvedAt: null }), settings), "not approved yet");
    assert.match(importBlocker(row({ answerStatus: "WITHDRAWN" }), settings) ?? "", /deleted in the official answer key/);
    assert.match(importBlocker(row({ status: "NEEDS_CORRECTION", issueCodes: ["FORMULA_NEEDS_MANUAL_VERIFICATION"] }, null, null), settings) ?? "", /Formula needs manual verification/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
