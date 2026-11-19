/**
 * AI Question Importer redesign P1 — AREA verify (2026-11-19 audit, F-review-verify / E-routing / B-parse).
 * One check per root cause; each fails on base ab3ade2 and passes after the fix:
 *   1. Verify 1 "passed" = its own findings only (another open flag no longer fails it).
 *   2. Format profile: run after the key is mapped; a paper printed in another label style (CMS 2024 P-I DOCX "A." vs the
 *      2025 DOCX profile "(a)") is not flagged per question; profile keyed by each file's own format; FORMAT_DEVIATION a warning.
 *   3. Verify 2 independence: no OCR text sent with an OCR'd page; no OCR-text tie-break for LOCAL_OCR questions.
 *   4. single vs multiple only → no Verify 2 disagreement (info).
 *   5. Safety / guard models never auto-selected; a parse failure is a failed call; ≥3 non-JSON answers skip the model.
 *   6. First vs second read reconciled by identity: missing / duplicated / reordered / conflicting.
 *   7. Duplicate upload (same Q1 + Q11, or year + paper code) reported, informational.
 * Pure tests plus a few scratch-DB rows (ids/titles prefixed "REDESIGN-verify", removed at the end). No AI request.
 *   /root/mts-scratch/redesign/run-suite.sh scripts/verify-ai-import-redesign-verify.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import { questionChecks } from "@/lib/ai-import/checks";
import { paperLabelShape, profileDeviations, type FormatRules } from "@/lib/ai-import/format-profile";
import { compareSecondRead, duplicateUploadsOf, failuresOf, jsonFailures, JSON_FAIL_SKIP, markUnusable, typeOnlyDiffers, v1Passed, verify2Hint } from "@/lib/ai-import/paper-verify";
import { autoSkip } from "@/lib/ai-import/select";
import { compareReads, readsDiffer, sameUpload, type ReadRow } from "@/lib/ai-import/paper-reconciliation";
import { textSimilarity } from "@/lib/ai-import/reference";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import type { CandidateRow } from "@/lib/ai-import/selection-types";

if (!/\/mts_redesign(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL is not the scratch mts_redesign database.");
  process.exit(2);
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new Error(`test network guard: request to ${host} refused`);
  return realFetch(input, init);
}) as typeof fetch;

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
}

const Q = (o: Partial<ExtractedQuestion> & { stem: string }): ExtractedQuestion => ({
  section: "",
  number: 1,
  label: "1",
  pages: [1],
  type: "SINGLE_CORRECT",
  printedAnswer: [],
  contentFormat: "PLAIN",
  confidence: 0.95,
  unreadable: [],
  figures: [],
  method: "DOCX",
  options: ["Alpha", "Beta", "Gamma", "Delta"].map((t, i) => ({ label: "ABCD"[i], printed: `${"ABCD"[i]}.`, text: t })),
  ...o,
});
// A QRow as compareSecondRead reads it.
const row = (e: ExtractedQuestion, extra: Record<string, unknown> = {}) =>
  ({ id: "REDESIGN-verify-q", data: e, editedData: null, finalAnswer: ["B"], officialAnswer: ["B"], answerStatus: "OFFICIAL_MATCHED", answerConfirmedById: null, subjectId: null, topicId: null, subTopicId: null, figures: [], ...extra }) as never;

async function main() {
  // ---- 1 -------------------------------------------------------------------------------------------------------
  section("1. Verify 1 passed = its own findings only");
  check("no finding of its own → passed (an open ANSWER_UNVERIFIED elsewhere no longer fails it)", v1Passed([]));
  check("a blocking finding of its own → not passed", !v1Passed([{ code: "QUESTION_TEXT_SUSPECT", detail: "x" }]));
  check("a warning-only finding (format profile) → passed, still listed", v1Passed([{ code: "FORMAT_DEVIATION", detail: "Format profile: …" }]));
  const src = readFileSync("lib/ai-import/paper-verify.ts", "utf8");
  check("the old rule (passed requires no other blocking flag) is gone", !/const ok = !problems\.length && !blockingNow\.length/.test(src));

  // ---- 2 -------------------------------------------------------------------------------------------------------
  section("2. Format profile (CMS 2024 P-I DOCX false positive, synthetic)");
  const v1Body = src.slice(src.indexOf("export async function runVerify1"), src.indexOf("// ---- Verify 2: pricing"));
  check("the profile is applied AFTER post-processing mapped the re-read key", v1Body.indexOf("applyFormatProfile(jobId)") > v1Body.indexOf("await runPostProcessing(ctx)"));
  // The CMS profile learned from the 2025 DOCX: "(a)" labels, answer line beneath every question.
  const profile: FormatRules = { optionLabels: "(a)", statementNumbering: "roman", answerPlacement: "below-question", answerLinePrefix: "► Official Answer: Option", explanations: false, spansPages: false, figures: "none", ocrErrors: [], notes: "" };
  // The 2024 P-I DOCX: options printed "A." throughout, no answer line (a separate key file), 120 questions.
  const paper = Array.from({ length: 120 }, (_, i) => Q({ number: i + 1, label: String(i + 1), stem: `Question ${i + 1} about the jugular venous pulse?` }));
  const labels = paperLabelShape(paper);
  check("this paper's own label style is recognised (“A.” on ≥80 %)", labels === "A.", labels);
  const devs = paper.map((q) => profileDeviations(profile, q, true, labels)).filter((d) => d.length);
  check("0 of 120 questions deviate once the key is mapped and the paper's label style is known (was 120)", devs.length === 0, devs.slice(0, 2));
  check("before the key is mapped the answer-placement rule would fire (why the order matters)", profileDeviations(profile, paper[0], false, labels).some((d) => /answer beneath/.test(d)));
  const outlier = Q({ stem: "x", options: paper[0].options.map((o, i) => ({ ...o, printed: `(${"abcd"[i]})` })) });
  const mixed = [...paper.slice(0, 119), Q({ stem: "y", options: paper[0].options.map((o, i) => ({ ...o, printed: `${"abcd"[i]})` })) })];
  check("a genuine outlier in a consistent paper is still flagged (not hidden)", profileDeviations({ ...profile, optionLabels: "A." }, outlier, true, paperLabelShape(mixed)).length === 1);
  check("FORMAT_DEVIATION is a warning: neither blocking nor publish-blocking", ISSUE_DEFS.FORMAT_DEVIATION.blocking === false && ISSUE_DEFS.FORMAT_DEVIATION.publishBlocking === false);
  const qc = questionChecks({ codes: ["FORMAT_DEVIATION"], issues: new Map([["FORMAT_DEVIATION", "Format profile: options printed as A."]]), answerStatus: "OFFICIAL_MATCHED", answerConfirmed: false, subjectId: "s", topicId: "t", adminTaxonomy: false, v2: null, v2Classification: null, v1Ran: true });
  check("the content check passes with a format warning (it no longer holds the question back)", qc.content.status === "PASSED" && /Warning/.test(qc.content.detail), qc.content);
  const fp = readFileSync("lib/ai-import/format-profile.ts", "utf8");
  check("each question is checked against the profile of its OWN file's format", /profileOf\(q\.fileId\)/.test(fp) && /p\.sourceKind === kinds\.get\(fileId\)/.test(fp));

  // ---- 3 -------------------------------------------------------------------------------------------------------
  section("3. Verify 2 independence on OCR pages");
  check("an OCR'd page is sent as image only (no OCR text)", verify2Hint({ textLayer: "1. OCR text of the page", ocr: true }) === null);
  check("a PDF's own text layer is still sent as a hint", verify2Hint({ textLayer: "PDF text", ocr: false }) === "PDF text");
  const ocrText = "12. Which of the following is the commonest cause of mitral stenosis?\n(a) Rheumatic fever (b) Infective endocarditis (c) Congenital (d) Calcification";
  const stored = Q({ number: 12, method: "LOCAL_OCR", stem: "Which of the following is the commonest cause of mitral stenosis?", options: ["Rheumatic fever", "Infective endocarditis", "Congenital", "Calcification"].map((t, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: t })) });
  const twinQ = { ...stored, method: "AI_VISION", stem: "Which of the following is the least common cause of mitral stenosis?" };
  const r3 = compareSecondRead(row(stored), { q: twinQ, model: "m2", sourceText: ocrText }, undefined);
  check("LOCAL_OCR question: the OCR text does not settle a disagreement (it was built from it) → DISAGREE for a person", r3.status === "DISAGREE" && !r3.resolvedBySource && /local OCR/.test(r3.detail), { status: r3.status, detail: r3.detail });
  const r3b = compareSecondRead(row({ ...stored, method: "AI_VISION" }), { q: twinQ, model: "m2", sourceText: ocrText }, undefined);
  check("an AI-read question is still settled by the page text (unchanged)", r3b.status === "VERIFIED" && !!r3b.resolvedBySource, r3b.status);

  // ---- 4 -------------------------------------------------------------------------------------------------------
  section("4. single vs multiple only");
  const multi = { ...stored, method: "AI_VISION", type: "MULTIPLE_CORRECT" as const };
  const r4 = compareSecondRead(row(stored, { answerStatus: "KEY_MISSING", officialAnswer: [] }), { q: multi, model: "m2", sourceText: null }, undefined);
  check("type-only difference → VERIFIED, kept as information", r4.status === "VERIFIED" && r4.fields.length === 0 && /info: the second read calls it multiple correct/.test(r4.detail), r4);
  check("typeOnlyDiffers ignores identical types and non-choice types", !typeOnlyDiffers({ type: "SINGLE_CORRECT" }, { type: "SINGLE_CORRECT" }, false) && !typeOnlyDiffers({ type: "MATCH_THE_FOLLOWING" }, { type: "SINGLE_CORRECT" }, false));
  const r4b = compareSecondRead(row(stored, { answerStatus: "KEY_MISSING" }), { q: { ...multi, stem: "Something entirely different about the aortic valve?" }, model: "m2", sourceText: null }, undefined);
  check("a real content difference with a type difference is still a DISAGREE (type not among the fields)", r4b.status === "DISAGREE" && !r4b.fields.includes("type"), r4b.fields);

  // ---- 5 -------------------------------------------------------------------------------------------------------
  section("5. Model selection: safety models, JSON failures, ledger");
  const cand = (id: string): CandidateRow => ({ id, eligible: true, reason: null, maxInr: 0.1, typicalInr: 0.05, routes: ["x"] });
  check("nvidia content-safety is never auto-picked", !!autoSkip(cand("nvidia/nemotron-3.5-content-safety"), undefined));
  check("llama-guard is never auto-picked", !!autoSkip(cand("meta-llama/llama-guard-4-12b"), undefined));
  check("a moderation model is never auto-picked", !!autoSkip(cand("openai/omni-moderation-latest"), undefined));
  check("an ordinary reader is not skipped", autoSkip(cand("google/gemma-3-27b-it"), undefined) === null);
  check("failures of dated variants count for the catalog id", failuresOf(new Map([["google/gemma-3-27b-it", 2], ["google/gemma-3-27b-it-2025-03", 1], ["other/x", 9]]), "google/gemma-3-27b-it") === 3 && JSON_FAIL_SKIP === 3);

  // ---- 6 -------------------------------------------------------------------------------------------------------
  section("6. First read vs second read by identity");
  const R = (section: string | null, number: number | null, page: number, order: number, stem: string): ReadRow<string> => ({ section, number, page, order, item: stem });
  // CMS26 P-II p27: statements of Q109 became a phantom section S2 Q1–Q4 in the first read.
  const first = [R(null, 1, 1, 0, "a"), R(null, 2, 1, 1, "b"), R(null, 4, 2, 2, "d"), R(null, 3, 2, 3, "c"), R(null, 5, 3, 4, "e"), R(null, 5, 3, 5, "e2"), R("S2", 1, 27, 6, "stmt")];
  const second = [R(null, 1, 1, 0, "a"), R(null, 2, 1, 1, "B CHANGED"), R(null, 3, 2, 2, "c"), R(null, 4, 2, 3, "d"), R(null, 5, 3, 4, "e"), R(null, 6, 3, 5, "f")];
  const c = compareReads(first, second, (a, b) => a === b);
  check("missing in the second read (phantom S2 Q1)", c.missingInSecond.length === 1 && /S2 Q1 p27/.test(c.missingInSecond[0]), c.missingInSecond);
  check("missing in the first read (Q6)", c.missingInFirst.length === 1 && /Q6 p3/.test(c.missingInFirst[0]), c.missingInFirst);
  check("duplicated in the first read (Q5 twice)", c.duplicatedInFirst.length === 1 && /^Q5/.test(c.duplicatedInFirst[0]), c.duplicatedInFirst);
  check("reordered in the first read (Q3 after Q4 on p2), not in the second", c.reorderedInFirst.length === 1 && /Q3 \(p2\) after Q4/.test(c.reorderedInFirst[0]) && c.reorderedInSecond.length === 0, c);
  check("conflicting content (Q2)", c.conflicting.length === 1 && /Q2/.test(c.conflicting[0]), c.conflicting);
  check("identical reads → no finding", !readsDiffer(compareReads(second, second, (a, b) => a === b)));

  // ---- 7 -------------------------------------------------------------------------------------------------------
  section("7. Duplicate upload");
  const docx = { jobId: "a", title: "CMS 2024 P-I (DOCX)", year: 2024, paperCode: null, q1: "The height of the Jugular Venous Pulse is measured from the sternal angle. Which is correct?", q11: "Lofgren syndrome includes all of the following, except:" };
  const scan = { jobId: "b", title: "CMS_GS_p1 (scan)", year: null, paperCode: null, q1: "The height of the Jugular Venous Pulse is measured from the sternal angIe. Which is correct ?", q11: "Lofgren syndrome includes all of the following,except :" };
  check("the DOCX and the scanned re-upload are recognised (same Q1 + Q11, OCR noise tolerated)", /question 1 and question 11/.test(sameUpload(docx, scan, textSimilarity) ?? ""));
  check("same year + paper code is recognised", /2026/.test(sameUpload({ ...docx, year: 2026, paperCode: "Paper II", q1: null, q11: null }, { ...scan, year: 2026, paperCode: "paper ii", q1: null, q11: null }, textSimilarity) ?? ""));
  check("another paper is not reported", sameUpload(docx, { ...scan, q1: "Which drug is used in status epilepticus?", q11: "Barrett's oesophagus is a risk factor for:" }, textSimilarity) === null);

  // ---- DB (scratch, own rows only) -------------------------------------------------------------------------------
  section("DB: ledger marking, JSON-failure count, duplicate-upload lookup (scratch rows REDESIGN-verify-*)");
  // Own fixtures (the shared scratch DB may be empty): an exam and an admin; a role is reused if another suite made one.
  const existingRole = await prisma.role.findFirst({ select: { id: true } });
  const role = existingRole ?? (await prisma.role.create({ data: { id: "REDESIGN-verify-role", name: "TEACHER" } }));
  const exam = await prisma.exam.create({ data: { id: "REDESIGN-verify-exam", name: "REDESIGN-verify exam", code: "REDESIGN-VERIFY" } });
  const user = await prisma.adminUser.create({ data: { id: "REDESIGN-verify-admin", name: "REDESIGN-verify", username: "redesign-verify", passwordHash: "x", roleId: role.id } });
  const mk = async (tag: string, title: string, q1: string, q11: string) => {
    const job = await prisma.aiImportJob.create({ data: { id: `REDESIGN-verify-${tag}`, title: `REDESIGN-verify ${title}`, examId: exam.id, createdById: user.id, budgetInr: 0 } });
    const file = await prisma.aiImportFile.create({ data: { id: `REDESIGN-verify-${tag}-f`, jobId: job.id, originalName: `${tag}.docx`, ext: "docx", declaredBytes: 1, uploadedById: user.id } });
    for (const [n, stem] of [[1, q1], [11, q11]] as const) await prisma.aiImportQuestion.create({ data: { id: `REDESIGN-verify-${tag}-q${n}`, jobId: job.id, fileId: file.id, sourceKey: `#${n}`, sourceLabel: String(n), sourceNumber: n, orderIndex: n, questionType: "SINGLE_CORRECT", data: Q({ number: n, stem }) as never } });
    return job;
  };
  try {
    const a = await mk("a", "CMS 2024 P-I DOCX", docx.q1, docx.q11);
    await mk("b", "CMS 2024 P-I scan", scan.q1!, scan.q11!);
    await mk("c", "Other paper", "Which drug is used in status epilepticus?", "Barrett's oesophagus is a risk factor for:");
    const dups = await duplicateUploadsOf(a);
    check("the job's duplicate check names the other upload of the same paper only", dups.length === 1 && dups[0].jobId === "REDESIGN-verify-b", dups);
    const call = (i: number, ok: boolean) => ({ id: `REDESIGN-verify-call-${i}`, jobId: a.id, task: "verify", requestId: `REDESIGN-verify-r${i}`, model: "nvidia/nemotron-3.5-content-safety", ok, costStatus: "actual", stage: "verify2-read", pageId: `REDESIGN-verify-p${i}` });
    await prisma.aiImportAiCall.createMany({ data: [0, 1, 2].map((i) => call(i, true)) });
    for (const i of [0, 1, 2]) await markUnusable(a.id, { stage: "verify2-read", pageId: `REDESIGN-verify-p${i}` }, "nvidia/nemotron-3.5-content-safety", new Error("the Verify 2 model's answer did not return JSON"));
    const rows = await prisma.aiImportAiCall.findMany({ where: { jobId: a.id } });
    check("a parse failure is recorded as a failed call (ok=false, category unusable), cost kept", rows.every((r) => !r.ok && r.errorCategory === "unusable" && r.costStatus === "actual"), rows.map((r) => [r.ok, r.errorCategory]));
    const n = failuresOf(await jsonFailures(a.id), "nvidia/nemotron-3.5-content-safety");
    check(`after ${JSON_FAIL_SKIP} unusable answers the model is skipped for this job`, n >= JSON_FAIL_SKIP, n);
  } finally {
    await prisma.aiImportAiCall.deleteMany({ where: { id: { startsWith: "REDESIGN-verify-" } } });
    await prisma.aiImportEvent.deleteMany({ where: { jobId: { startsWith: "REDESIGN-verify-" } } });
    await prisma.aiImportQuestion.deleteMany({ where: { id: { startsWith: "REDESIGN-verify-" } } });
    await prisma.aiImportFile.deleteMany({ where: { id: { startsWith: "REDESIGN-verify-" } } });
    await prisma.aiImportJob.deleteMany({ where: { id: { startsWith: "REDESIGN-verify-" } } });
    await prisma.adminUser.deleteMany({ where: { id: "REDESIGN-verify-admin" } });
    await prisma.exam.deleteMany({ where: { id: "REDESIGN-verify-exam" } });
    if (!existingRole && !(await prisma.adminUser.count({ where: { roleId: role.id } }))) await prisma.role.deleteMany({ where: { id: "REDESIGN-verify-role" } });
  }
}

main()
  .catch((e) => {
    fail++;
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
