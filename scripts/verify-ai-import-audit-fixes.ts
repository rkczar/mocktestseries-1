/**
 * AI Question Importer — fixes from the 2026-10-25 audit of the 120-question CMS job.
 *
 *   A. Pure: a bare "X-ray" / "radiograph" / "image" is no figure pointer, an explicit one is; a source without
 *      embedded images never makes it blocking; pass limit (3) bookkeeping; classification answers item by item;
 *      reference comparison never trusts uncertain OCR and never changes the question; dropped-connection pattern.
 *   B. Post-processing: a text-only DOCX question mentioning X-ray gets NO image flag; "the following diagram" in a
 *      DOCX without images is reviewable (not blocking); in a scanned PDF it stays blocking.
 *   C. Requests: the reasoning bound is sent even when fallbacks are configured; a slightly pricier fallback is used
 *      only within the per-request cap and the job's confirmed maximum; a malformed classification entry only drops
 *      its own question and a malformed answer is retried once on another model; a dropped connection is retried
 *      exactly once; other transient errors are not (retries off).
 *   D. Three passes: a re-scan of a question that already had 3 passes is refused with nothing sent; a re-scan
 *      records its pass.
 *   E. Reference OCR: nothing without a price preview and an explicit confirmation; over any budget it does not
 *      run; once confirmed it reads the scanned pages into a REFERENCE_READ event and changes no question.
 *
 * Scratch DB, scratch storage and a loopback OpenRouter mock only (network guard below); no real AI request is
 * possible. Removes its own jobs and reservations; restores Import Settings.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-audit-fixes.ts <fixtures dir>
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { runWorker } from "@/lib/ai-import/worker";
import { DROPPED_CONNECTION, FALLBACK_SLACK, fallbackAllowance, importerAiCall, importerAiCallChecked, parseModelJson, ImporterAiFailure, type AiCallInput } from "@/lib/ai-import/ai";
import { CLASSIFY_BATCH, classifyAnswerOf } from "@/lib/ai-import/prompts";
import { MENTIONS_FIGURE, runPostProcessing, sourceMayHoldImage } from "@/lib/ai-import/post";
import { MAX_VERIFY_PASSES, needsVerify2, passCount, withPass } from "@/lib/ai-import/verify-core";
import { compareWithReference, addReference, listReferences } from "@/lib/ai-import/reference";
import { ocrQuestion, referenceOcrPreview, requestReferenceOcr } from "@/lib/ai-import/reference-ocr";
import { rescanQuestions } from "@/lib/ai-import/review";
import { computeModelPlan, planOf } from "@/lib/ai-import/select";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import type { StepContext } from "@/lib/ai-import/process";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !process.env.OPENROUTER_TEST_BASE_URL) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR and OPENROUTER_TEST_BASE_URL (scratch paths, loopback mock).");
  process.exit(2);
}
const FX = process.argv[2];
const MOCK = process.env.OPENROUTER_TEST_BASE_URL;
const MOCK_PORT = new URL(MOCK).port;

const blockedHosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    blockedHosts.add(host);
    throw new Error(`test network guard: request to ${host} refused`);
  }
  return realFetch(input, init);
}) as typeof fetch;

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
async function errorOf(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

const TAG = "auditfx";
const jobs: string[] = [];
type Stats = { chat: number; byModel: Record<string, number>; attempts: Record<string, number>; reasoning: ({ effort?: string; exclude?: boolean } | null)[] };
const mockStats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()) as Stats;
const mockConfig = async (c: Record<string, unknown>) => void (await fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) }));
const MOCK_BASE = { extraModels: true, reasonModels: true, batchModels: true, keyLimitRemaining: 1000, script: {}, badRequest: {}, noEndpoint: [], failTask: {}, keyHeader: null, costMultiplier: 1, rateLimit: {} };
const FIXTURE_MODELS = ["mockfree/reader", "mockfree/checker", "mockpaid/ocr", "mockpaid/verify", "mocktext/cheap", "mockreason/think", "mockvision/cheap:batch"];

async function directJob(actor: string, examId: string, title: string, budgetInr = 50, status: "PROCESSING" | "NEEDS_REVIEW" = "PROCESSING") {
  const plan = await computeModelPlan(normalizeImporterSettings(await getImporterSettings()), { refresh: true });
  const j = await prisma.aiImportJob.create({ data: { title: `${title} ${TAG}`, examId, createdById: actor, budgetInr, status, ...(status === "PROCESSING" ? { leaseOwner: "suite-direct-calls", leaseUntil: new Date(Date.now() + 3_600_000) } : { confirmedAt: new Date() }), paperType: AiImportPaperType.FULL_PAPER, config: { modelPlan: plan } as never } });
  jobs.push(j.id);
  return j.id;
}
// The format the mock reads (and the importer's own classifyUserText writes): SUBJECT / TOPIC lines, then "[Qn] text".
const classifyText = (n: number) => `SUBJECT S1 = Anatomy\n  TOPIC T1 = Bones\n\n${Array.from({ length: n }, (_, i) => `[Q${i + 1}] Which bones form the knee joint? (a) Femur (b) Tibia (c) Fibula (d) Humerus`).join("\n")}`;
const classifyInput = (jobId: string, settings: ImporterSettings, n = 3): AiCallInput => ({ jobId, task: "classify", models: [settings.models.classify ?? "mocktext/cheap"], system: "You classify exam questions into an EXISTING syllabus. OUTPUT (JSON only)", content: [{ type: "text", text: classifyText(n) }], maxOutputTokens: 2500, settings, needsVision: false });
const parseClassify = (text: string) => {
  const v = classifyAnswerOf(parseModelJson(text));
  if (!v) throw new ImporterAiFailure("format", "model_output");
  return v;
};
const events = (jobId: string, type: string) => prisma.aiImportEvent.findMany({ where: { jobId, type }, orderBy: { createdAt: "asc" } });
const qHash = async (jobId: string) => createHash("sha256").update(JSON.stringify(await prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: { id: "asc" }, select: { id: true, data: true, editedData: true, finalAnswer: true, subjectId: true, topicId: true, subTopicId: true, status: true, issueCodes: true, approvedById: true, questionId: true } }))).digest("hex");

/** A question row (DOCX or PDF source) for post-processing / re-scan checks. */
async function questionRow(jobId: string, fileId: string, n: number, stem: string, extra: Partial<ExtractedQuestion> = {}) {
  const data = { number: n, label: String(n), section: "", type: "SINGLE_CORRECT", stem, instructions: "", passage: "", options: ["Alpha", "Beta", "Gamma", "Delta"].map((t, i) => ({ label: "ABCD"[i], printed: "abcd"[i], text: t })), printedAnswer: [], printedAnswerRaw: null, figures: [], pages: [1], confidence: 0.95, method: "DOCX", model: null, contentFormat: "TEXT", unreadable: [], notes: [], hints: null, listI: null, listII: null, ...extra };
  return prisma.aiImportQuestion.create({ data: { jobId, fileId, sourceKey: `#${n}`, sourceLabel: String(n), sourceNumber: n, orderIndex: n, pages: [1], data: data as never, questionType: "SINGLE_CORRECT", optionCount: 4, finalAnswer: ["A"], status: "EXTRACTED" } });
}

async function cleanup() {
  if (jobs.length) {
    await prisma.aiBudgetReservation.deleteMany({ where: { OR: jobs.map((id) => ({ requestKey: { startsWith: `qi:${id}:` } })) } });
    await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs } } });
  }
}

async function main() {
  let mockProc: ChildProcess | null = spawn(process.execPath, ["scripts/mock-openrouter-vision.mjs", MOCK_PORT, path.join(FX, "mock-vision.json")], { stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    if (await fetch(`${MOCK}/__mock/stats`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  const questionsBefore = await prisma.question.count();
  const questionBankHash = async () => createHash("sha256").update(JSON.stringify(await prisma.question.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } }))).digest("hex");
  const qbBefore = await questionBankHash();

  try {
    // ------------------------------------------------------------------ A
    section("A. Pure checks (no AI, no database)");
    const q2 = "Consider the following statements for diagnosing ventricular aneurysm in a patient with recent myocardial infarction:\nI. Paradoxical impulse on chest wall\nII. Persistent ST elevation on ECG\nIII. Unusual bulge on chest X-ray";
    const bare = [q2, "Chest radiograph shows bilateral hilar lymphadenopathy. The most likely diagnosis is", "Which imaging modality is preferred?", "The best image-guided procedure is", "A photograph of the patient was taken", "Calcification seen on X-ray of the skull"];
    check("a bare mention of X-ray / radiograph / image is not a figure pointer (Q2 of the CMS job included)", bare.every((s) => !MENTIONS_FIGURE.test(s)), bare.filter((s) => MENTIONS_FIGURE.test(s)));
    const explicit = ["Identify the lesion shown in the image", "Study the following diagram and answer", "Refer to Figure 2", "The ECG given below shows", "The X-ray shown is of", "Identify the structure marked X in the figure.", "Study the graph and answer.", "The diagram below shows"];
    check("explicit pointers to an absent visual are still detected", explicit.every((s) => MENTIONS_FIGURE.test(s)), explicit.filter((s) => !MENTIONS_FIGURE.test(s)));
    const noFig = ["Match List I with List II and select the correct answer using the code given below the Lists:", "Consider the following statements given below:", "Which of the statements given above is/are correct?"];
    check("'given below / above' lists and statements stay no figure pointer", noFig.every((s) => !MENTIONS_FIGURE.test(s)));
    const docx = (images: number) => ({ facts: { kind: "DOCX", embeddedImages: images, pagesDetail: [{ page: 1, images, kind: "DOCUMENT" }] } });
    const pdf = { facts: { kind: "PDF", embeddedImages: 1, pagesDetail: [{ page: 1, images: 0, kind: "TEXT" }, { page: 2, images: 1, kind: "TEXT" }, { page: 3, images: 0, kind: "SCANNED" }] } };
    check("source images: DOCX without images → no; DOCX with images → yes", !sourceMayHoldImage(docx(0), [1]) && sourceMayHoldImage(docx(2), [1]));
    check("source images: PDF text page without images → no; page with an image or scanned → yes; unknown facts → yes (safe side)", !sourceMayHoldImage(pdf, [1]) && sourceMayHoldImage(pdf, [2]) && sourceMayHoldImage(pdf, [3]) && sourceMayHoldImage(null, [1]) && sourceMayHoldImage({}, [1]));

    const fp = "fp1";
    const legacy = { v1: { fingerprint: fp, at: "2026-10-23T18:47:00Z", passed: false, problems: [], fixes: [] }, v2: { fingerprint: fp, at: "2026-10-23T19:31:00Z", model: "m", status: "DISAGREE" as const, fields: [], detail: "" } };
    check("older question with Verify 1 + Verify 2 counts 2 passes; a FAILED / UNAVAILABLE Verify 2 (no result) does not count", passCount(legacy) === 2 && passCount({ ...legacy, v2: { ...legacy.v2, status: "UNAVAILABLE" } }) === 1 && passCount({ ...legacy, v2: { ...legacy.v2, status: "FAILED" } }) === 1);
    const afterRescan = withPass(legacy, "rescan", "mockvision/reader");
    check("a re-scan makes it 3 (the earlier passes recorded first); Verify 1 is never counted twice", afterRescan.length === 3 && afterRescan.map((p) => p.kind).join() === "v1,v2,rescan" && withPass({ passes: afterRescan.slice(0, 1) }, "v1").length === 1);
    check("Verify 2 is not sent again at the limit, nor for an up-to-date agreeing result; a disagreement under the limit is", !needsVerify2({ data: { paperVerify: { ...legacy, passes: afterRescan } } }, fp) && !needsVerify2({ data: { paperVerify: { v1: legacy.v1, v2: { ...legacy.v2, status: "VERIFIED" } } } }, fp) && needsVerify2({ data: { paperVerify: legacy } }, fp) && MAX_VERIFY_PASSES === 3);

    const items = classifyAnswerOf({ results: [{ bogus: true }, { q: "Q2", subject: "S1", topic: "T1", confidence: 0.9 }, { q: "Q3", subject: "S1", topic: null, confidence: "80" }] });
    check("classification: a malformed entry drops only its own question; the others are kept", !!items && items.results.length === 2 && items.dropped === 1 && items.results.map((r) => r.q).join() === "Q2,Q3", items);
    check("classification: no usable list → unusable answer (retried once on another model)", classifyAnswerOf({ results: [{ bogus: 1 }] }) === null && classifyAnswerOf({}) === null && classifyAnswerOf({ results: "x" }) === null && CLASSIFY_BATCH === 10);

    const prepared = { number: 7, label: "7", section: "", type: "SINGLE_CORRECT", stem: "Which of the following is the drug of choice for absence seizures in children?", instructions: "", passage: "", options: ["Ethosuximide", "Phenytoin", "Carbamazepine", "Phenobarbitone"].map((t, i) => ({ label: "ABCD"[i], printed: "abcd"[i], text: t })), printedAnswer: [], figures: [], pages: [1] } as unknown as ExtractedQuestion;
    const before = JSON.stringify(prepared);
    const unreadable = ocrQuestion({ section: "", number: 7, stem: "Wh1ch of t~e f0ll0wing is the drvg", options: [{ text: "Eth" }, { text: "" }, { text: "" }, { text: "" }], printedAnswer: ["B"], pages: [3], confidence: 0.45 });
    const c1 = compareWithReference(prepared, ["A"], { questions: [unreadable], key: [] });
    check("low-confidence OCR → 'reference unreadable': no conflict, no suggested answer", unreadable.unreadable === true && c1.unreadable === true && !c1.conflicts.length && !c1.suggestedAnswer.length, c1);
    const readable = ocrQuestion({ section: "", number: 7, stem: prepared.stem, options: prepared.options.map((o) => ({ text: o.text })), printedAnswer: ["B"], pages: [3], confidence: 0.95 });
    const c2 = compareWithReference(prepared, ["A"], { questions: [readable], key: [] });
    check("readable OCR is matched by question number first and its different answer is a conflict to decide", !readable.unreadable && c2.matched === "Q7" && c2.conflicts.some((c) => /answer B/.test(c)), c2);
    check("the comparison never changes the prepared question", JSON.stringify(prepared) === before);
    check("a dropped connection is recognized ('terminated'), an ordinary provider error is not", DROPPED_CONNECTION.test("OpenRouter returned an error. (terminated)") && DROPPED_CONNECTION.test("terminated") && !DROPPED_CONNECTION.test("Provider returned error"));

    // ------------------------------------------------------------------ setup
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig(MOCK_BASE);
    await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
    await testOpenRouterConnection();
    await setOpenRouterEnabled(true);
    await syncCatalog();
    const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
    const base = (s: ImporterSettings): ImporterSettings => ({ ...s, aiEnabled: true, privacy: { dataCollection: "deny", zdr: false }, budget: { ...s.budget, maxRequestInr: 1, keyReserveUsd: 5, retryTransient: false, allowPricierFallback: false, monthlyInr: 10, totalInr: 10, maxJobInr: 8 }, limits: { ...s.limits, concurrency: 1 } });
    const manual = (models: Partial<ImporterSettings["models"]>, importerModels = mockIds, extra: Partial<ImporterSettings["budget"]> = {}) =>
      saveImporterSettings({ ...base(savedSettings), selection: { mode: "manual" }, importerModels, budget: { ...base(savedSettings).budget, ...extra }, models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null, ...models } }, actor);

    // ------------------------------------------------------------------ B
    section("B. Post-processing: image flags follow the source");
    await manual({});
    const jB = await directJob(actor, exam.id, "Image flags", 0, "NEEDS_REVIEW");
    const docxFile = await prisma.aiImportFile.create({ data: { jobId: jB, originalName: `cms ${TAG}.docx`, ext: "docx", declaredBytes: 1, uploadedById: actor, status: "PROCESSED", detected: docx(0) as never } });
    const pdfFile = await prisma.aiImportFile.create({ data: { jobId: jB, originalName: `scan ${TAG}.pdf`, ext: "pdf", declaredBytes: 1, uploadedById: actor, status: "PROCESSED", detected: { facts: { kind: "PDF", embeddedImages: 0, pagesDetail: [{ page: 1, images: 0, kind: "SCANNED" }] } } as never } });
    const bq1 = await questionRow(jB, docxFile.id, 2, q2);
    const bq2 = await questionRow(jB, docxFile.id, 3, "Study the following diagram and identify the chamber marked P.");
    const bq3 = await questionRow(jB, pdfFile.id, 4, "Study the following diagram and identify the chamber marked P.");
    const jobB = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } });
    await runPostProcessing({ job: jobB, settings: { ...normalizeImporterSettings(await getImporterSettings()), aiEnabled: false }, verifyMode: "risk", examName: "Exam", subjectName: null, stillRunning: async () => true } as StepContext);
    const codesOf = async (id: string) => (await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id } })).issueCodes;
    const [c1b, c2b, c3b] = [await codesOf(bq1.id), await codesOf(bq2.id), await codesOf(bq3.id)];
    check("text-only DOCX question mentioning 'chest X-ray' → no image flag at all", !c1b.includes("IMAGE_MISSING") && !c1b.includes("IMAGE_REFERENCE_UNCERTAIN"), c1b);
    check("'the following diagram' in a DOCX without images → reviewable IMAGE_REFERENCE_UNCERTAIN, not blocking IMAGE_MISSING", c2b.includes("IMAGE_REFERENCE_UNCERTAIN") && !c2b.includes("IMAGE_MISSING"), c2b);
    check("the same pointer on a scanned PDF page → blocking IMAGE_MISSING (an uncaptured image is possible)", c3b.includes("IMAGE_MISSING"), c3b);

    // ------------------------------------------------------------------ C
    section("C. Requests: reasoning bound, fallback allowance, classifier isolation, dropped connection");
    await manual({ extract: "mockreason/think", extractFallbacks: [] });
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig(MOCK_BASE);
    const jR = await directJob(actor, exam.id, "Reasoning + fallback");
    const sR0 = await mockStats();
    const plan = planOf((await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jR } })).config)!;
    const withFallback = { ...plan.tasks.extract, fallbacks: ["mockvision/reader"] };
    const rr = await importerAiCall({ jobId: jR, task: "extract", models: ["mockreason/think"], override: withFallback, noReplace: true, system: "Extract questions. OUTPUT (JSON only)", content: [{ type: "text", text: "Page 1 of 1" }], maxOutputTokens: 2000, settings: normalizeImporterSettings(await getImporterSettings()), needsVision: false }).catch((e) => e as Error);
    const sR1 = await mockStats();
    const sent = sR1.reasoning.slice(sR0.reasoning.length);
    check("a reasoning model gets {effort: low, exclude: true} even with a fallback configured, and answers", sent.length >= 1 && sent.every((r) => r?.effort === "low" && r?.exclude === true) && !(rr instanceof Error), { sent, rr: rr instanceof Error ? rr.message : "ok" });

    await manual({ classify: "mocktext/cheap" }, ["mocktext/classifier", "mocktext/cheap"]);
    const s1 = normalizeImporterSettings(await getImporterSettings());
    const jF = await directJob(actor, exam.id, "Fallback allowance");
    check("prod case: ₹0.0512 instead of ₹0.0458 is 'slightly more' → allowed within the cap and budget", (await fallbackAllowance(jF, 0.0458, 0.0512, s1)).ok);
    check("more than slightly more (₹0.05 → ₹0.20) → refused without the setting", !(await fallbackAllowance(jF, 0.05, 0.2, s1)).ok && FALLBACK_SLACK.ratio === 1.5);
    check("above the ₹1 per-request cap → refused", /per-request limit/.test((await fallbackAllowance(jF, 0.95, 1.05, s1)).reason));
    const jTight = await directJob(actor, exam.id, "Fallback over budget", 0.0001);
    check("over what is left of the job's confirmed maximum → refused", /left of this import's confirmed maximum/.test((await fallbackAllowance(jTight, 0.04, 0.05, s1)).reason));
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig({ ...MOCK_BASE, script: { "mocktext/cheap": ["empty"] } });
    // The mock's other text model costs twice as much per request: more than "slightly", so it is not sent.
    const sF0 = await mockStats();
    const eF = await errorOf(() => importerAiCallChecked(classifyInput(jF, s1), parseClassify));
    const sF1 = await mockStats();
    check("a fallback costing twice as much is not used without the setting (reason given, nothing sent to it)", eF instanceof ImporterAiFailure && /more than slightly more expensive/.test(eF.message) && (sF1.byModel["mocktext/classifier"] ?? 0) === (sF0.byModel["mocktext/classifier"] ?? 0), eF?.message);

    await mockConfig({ ...MOCK_BASE, script: { "mocktext/cheap": ["baditem"] } });
    const jI = await directJob(actor, exam.id, "Bad item");
    const sI0 = await mockStats();
    const d2 = await importerAiCallChecked(classifyInput(jI, s1, 3), parseClassify);
    const sI1 = await mockStats();
    check("one malformed classification entry: the other answers are kept, no second request", d2.result.model === "mocktext/cheap" && d2.value.dropped === 1 && d2.value.results.length >= 1 && sI1.chat - sI0.chat === 1, { v: d2.value, n: sI1.chat - sI0.chat });
    await mockConfig({ ...MOCK_BASE, script: { "mocktext/cheap": ["malformed"], "mocktext/classifier": ["malformed"] } });
    // The pricier model as the job's model, so the other one is a (cheaper) allowed fallback.
    await manual({ classify: "mocktext/classifier" }, ["mocktext/classifier", "mocktext/cheap"]);
    const s2 = normalizeImporterSettings(await getImporterSettings());
    const jM = await directJob(actor, exam.id, "Both malformed");
    const sM0 = await mockStats();
    const eM = await errorOf(() => importerAiCallChecked(classifyInput(jM, s2), parseClassify));
    const sM1 = await mockStats();
    check("a malformed answer is retried once on another model, never looped (exactly 2 requests)", eM instanceof ImporterAiFailure && sM1.chat - sM0.chat === 2, { e: eM?.message, n: sM1.chat - sM0.chat });

    await manual({ classify: "mocktext/cheap" }, ["mocktext/classifier", "mocktext/cheap"]);
    await mockConfig({ ...MOCK_BASE, script: { "mocktext/cheap": ["terminated"] } });
    const jT = await directJob(actor, exam.id, "Terminated once");
    const sT0 = await mockStats();
    const t1 = await importerAiCall(classifyInput(jT, s1)).catch((e) => e as Error);
    const sT1 = await mockStats();
    check("a dropped connection ('terminated') is retried once and the retry answers (retries OFF in settings)", !(t1 instanceof Error) && (sT1.attempts["mocktext/cheap"] ?? 0) - (sT0.attempts["mocktext/cheap"] ?? 0) === 2, { t1: t1 instanceof Error ? t1.message : "ok", n: (sT1.attempts["mocktext/cheap"] ?? 0) - (sT0.attempts["mocktext/cheap"] ?? 0) });
    await mockConfig({ ...MOCK_BASE, script: { "mocktext/cheap": ["terminated", "terminated", "terminated"] } });
    const sT2 = await mockStats();
    const t2 = await errorOf(() => importerAiCall(classifyInput(jT, s1)));
    const sT3 = await mockStats();
    check("…dropped twice → reported as a failure after exactly 2 attempts (never a loop)", !!t2 && (sT3.attempts["mocktext/cheap"] ?? 0) - (sT2.attempts["mocktext/cheap"] ?? 0) === 2, { e: t2?.message, n: (sT3.attempts["mocktext/cheap"] ?? 0) - (sT2.attempts["mocktext/cheap"] ?? 0) });
    await mockConfig({ ...MOCK_BASE, rateLimit: { "mocktext/cheap": 1 } });
    const sT4 = await mockStats();
    await errorOf(() => importerAiCall(classifyInput(jT, s1)));
    const sT5 = await mockStats();
    check("…another transient error (rate limit) is not retried while retries are OFF", (sT5.attempts["mocktext/cheap"] ?? 0) - (sT4.attempts["mocktext/cheap"] ?? 0) === 1);

    // ------------------------------------------------------------------ D
    section("D. Three verification passes per question");
    await manual({});
    await mockConfig(MOCK_BASE);
    const jD = await directJob(actor, exam.id, "Pass limit", 0, "NEEDS_REVIEW");
    const pdfD = await prisma.aiImportFile.create({ data: { jobId: jD, originalName: `scan ${TAG}.pdf`, ext: "pdf", declaredBytes: 1, uploadedById: actor, status: "PROCESSED", detected: { kind: "pdf" } as never } });
    const atLimit = await questionRow(jD, pdfD.id, 1, "Which bone is the longest?", { paperVerify: { ...legacy, passes: afterRescan } } as never);
    const sD0 = await mockStats();
    const eD = await errorOf(() => rescanQuestions([atLimit.id], "question", actor));
    const sD1 = await mockStats();
    const jDafter = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jD } });
    check("re-scan of a question that already had 3 passes → refused, nothing queued or sent", !!eD && /already had 3 verification passes/.test(eD.message) && jDafter.status === "NEEDS_REVIEW" && sD1.chat === sD0.chat && (await events(jD, "RESCAN_REQUESTED")).length === 0, eD?.message);

    // ------------------------------------------------------------------ E
    section("E. Reference OCR: price → confirm → read; evidence only");
    await saveImporterSettings({ ...base(savedSettings), selection: { mode: "auto" }, importerModels: mockIds }, actor);
    const jE = await directJob(actor, exam.id, "Reference OCR", 0, "NEEDS_REVIEW");
    const eFile = await prisma.aiImportFile.create({ data: { jobId: jE, originalName: `paper ${TAG}.docx`, ext: "docx", declaredBytes: 1, uploadedById: actor, status: "PROCESSED", detected: docx(0) as never } });
    await questionRow(jE, eFile.id, 1, "Which bone is the longest in the human body?");
    await questionRow(jE, eFile.id, 2, "Which nerve supplies the deltoid muscle?");
    const ref = await addReference({ jobId: jE, actorId: actor, name: `scanned reference ${TAG}.pdf`, bytes: readFileSync(path.join(FX, "scanned.pdf")) });
    check("a scanned reference is stored only (nothing read without AI)", ref.questions.length === 0 && (ref.scannedPages ?? 0) > 0, { q: ref.questions.length, s: ref.scannedPages });
    const hash0 = await qHash(jE);
    const sE0 = await mockStats();
    const pv = await referenceOcrPreview(jE, ref.refId);
    check("preview: pages, model, estimate, maximum and all four budgets shown — nothing sent", pv.pages.length === ref.scannedPages && !!pv.model && pv.maxInr !== null && pv.estimateInr !== null && pv.budgets.map((b) => b.label).join() === "Per request,This import,This month,All time" && (await mockStats()).chat === sE0.chat, pv);
    const noConfirm = await requestReferenceOcr({ jobId: jE, refId: ref.refId, actorId: actor, confirmedMaxInr: null });
    const jE1 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jE } });
    check("without an explicit confirmation nothing starts", !noConfirm.started && /Confirm the maximum/.test(noConfirm.reason) && jE1.status === "NEEDS_REVIEW" && !(jE1.config as { referenceOcr?: unknown }).referenceOcr, noConfirm);
    const low = await requestReferenceOcr({ jobId: jE, refId: ref.refId, actorId: actor, confirmedMaxInr: Math.max(0, (pv.maxInr ?? 0) / 2 - 0.01) });
    check("a confirmation below the current maximum does not start it", !low.started && /price changed|Confirm/.test(low.reason), low);
    await saveImporterSettings({ ...base(savedSettings), selection: { mode: "auto" }, importerModels: mockIds, budget: { ...base(savedSettings).budget, totalInr: 0 } }, actor);
    const over = await requestReferenceOcr({ jobId: jE, refId: ref.refId, actorId: actor, confirmedMaxInr: 5 });
    check("over the all-time budget → reported with the estimate, not run", !over.started && /All time/.test(over.reason) && over.preview.maxInr !== null && (await mockStats()).chat === sE0.chat, over);
    await saveImporterSettings({ ...base(savedSettings), selection: { mode: "auto" }, importerModels: mockIds }, actor);
    const ok = await requestReferenceOcr({ jobId: jE, refId: ref.refId, actorId: actor, confirmedMaxInr: pv.maxInr });
    check("confirmed maximum → queued (event + audit log)", ok.started && (await events(jE, "REFERENCE_OCR_REQUESTED")).length === 1 && (await prisma.auditLog.count({ where: { entityId: jE, action: "AI_IMPORT_REFERENCE_OCR_REQUESTED" } })) === 1, ok);
    await runWorker(240_000);
    const read = await events(jE, "REFERENCE_READ");
    const refs = await listReferences(jE);
    const jE2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jE } });
    check("the worker read the scanned pages into one REFERENCE_READ event; the job is back in review", read.length === 1 && !!refs[0]?.ocr && refs[0].ocr.pagesRead.length + refs[0].ocr.failedPages.length === pv.pages.length && ["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"].includes(jE2.status), { read: read.map((e) => e.message), status: jE2.status, ocr: refs[0]?.ocr });
    check("…its cost stayed within the confirmed maximum", jE2.spentInr <= (pv.maxInr ?? 0) + 0.005, { spent: jE2.spentInr, max: pv.maxInr });
    check("…and no question, answer, subject, status or approval changed", (await qHash(jE)) === hash0);
    const again = await referenceOcrPreview(jE, ref.refId);
    check("…a read reference is not offered for OCR again", !again.canRun && /already read/.test(again.problems.join(" ")), again.problems);

    // ------------------------------------------------------------------ F
    section("F. Nothing entered the Question Bank");
    check("no Question Bank row was added, changed or published by this suite", (await prisma.question.count()) === questionsBefore && (await questionBankHash()) === qbBefore);
    check("no request left the machine", blockedHosts.size === 0, [...blockedHosts]);
  } finally {
    await cleanup().catch((e) => console.error("cleanup failed:", e));
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    await setOpenRouterEnabled(routerWasEnabled).catch(() => undefined);
    await prisma.aiModel.deleteMany({ where: { id: { in: FIXTURE_MODELS } } }).catch(() => undefined);
    mockProc?.kill();
    mockProc = null;
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
