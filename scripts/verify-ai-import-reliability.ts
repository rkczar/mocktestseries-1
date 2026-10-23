/**
 * AI Question Importer — reliability fixes from the 2026-10-20 audit of a CMS Paper II import.
 *
 *   A. Answer parsing (pure): JSON repair of trailing commas / LaTeX backslashes only, a cut-off answer stays an
 *      error, common malformed page shapes normalized by position (confidence lowered, nothing invented),
 *      classification answers, figure wording, answer-key paper / series comparison and header parsing.
 *   B. Automatic selection never picks an OpenRouter ":batch" variant.
 *   C. A reasoning model gets a bounded reasoning setting and completes; an answer cut off at the output limit
 *      is reported as cut off (not "empty").
 *   D. Fallback after an unusable answer: sent once to another suitable model (logged with reason and cost),
 *      kept for the job after 2 in a row, never looped, never pricier unless allowed; permanent request errors
 *      are not re-sent elsewhere; the confirmed maximum is never exceeded.
 *   E. Page reading end to end: malformed page shape kept by position, the paid first read is never bought
 *      again after a stop during the second read.
 *   F. Classification with short codes: assigned, and invalid codes counted in a CLASSIFY_RESULT event.
 *   G. An answer key printed for another paper never supplies official answers; a matching one does.
 *   H. Retry of failed pages past the confirmed maximum asks for a new confirmation first.
 *   I. Nothing is approved or put into the Question Bank automatically.
 *
 * Scratch DB, scratch storage and the loopback OpenRouter mock only — no real AI request is possible
 * (network guard below). Removes its own jobs and usage rows; restores Import Settings.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-reliability.ts <fixtures dir>
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, resumeJob, retryJob } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { importerAiCallChecked, parseModelJson, ImporterAiFailure, type AiCallInput } from "@/lib/ai-import/ai";
import { classifySchema, pageSchema, toExtracted } from "@/lib/ai-import/prompts";
import { MENTIONS_FIGURE } from "@/lib/ai-import/post";
import { comparePaperIds, keyPaperChecks, paperNumber, seriesCode } from "@/lib/ai-import/key-check";
import { parseKeyHeader } from "@/lib/ai-import/keys";
import { computeModelPlan, planOf } from "@/lib/ai-import/select";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";

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

// Every HTTP request of this process must go to the loopback mock.
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

const TAG = "relfx";
const jobs: string[] = [];

type Stats = { chat: number; byModel: Record<string, number>; attempts: Record<string, number>; reasoning: ({ effort?: string; exclude?: boolean } | null)[] };
async function mockStats(): Promise<Stats> {
  return (await (await fetch(`${MOCK}/__mock/stats`)).json()) as Stats;
}
async function mockConfig(c: Record<string, unknown>) {
  await fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) });
}
/** Catalog rows the mock serves only with the fixture switches below; removed again at the end (later suites expect the usual catalog). */
const FIXTURE_MODELS = ["mockfree/reader", "mockfree/checker", "mockpaid/ocr", "mockpaid/verify", "mocktext/cheap", "mockreason/think", "mockvision/cheap:batch"];
const MOCK_BASE = { extraModels: true, reasonModels: true, batchModels: true, keyLimitRemaining: 1000, script: {}, badRequest: {}, noEndpoint: [], failTask: {}, keyHeader: null, costMultiplier: 1 };

async function upload(actor: string, jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER, paperFileId: string | null = null) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  await completeFile({ fileId, actorId: actor });
  return fileId;
}
async function newJob(actor: string, examId: string, title: string, paperCode: string | null = null) {
  const id = await createJob({ actorId: actor, title: `${title} ${TAG}`, examId, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode, previousYearPaperId: null });
  jobs.push(id);
  return id;
}
/** Analyze, confirm the displayed maximum, process. */
async function runJob(actor: string, jobId: string) {
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const max = (j.estimate as { maxInr: number | null } | null)?.maxInr ?? null;
  await confirmJob({ jobId, actorId: actor, examId: j.examId, paperType: j.paperType, subjectId: j.subjectId, year: j.year, paperCode: j.paperCode, previousYearPaperId: j.previousYearPaperId, confirmedMaxInr: max });
  await runWorker(300_000);
  return prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
}
/** A job in PROCESSING with a confirmed maximum and the current settings' model plan, for direct requests. */
async function directJob(actor: string, examId: string, title: string, budgetInr = 50) {
  const plan = await computeModelPlan(normalizeImporterSettings(await getImporterSettings()), { refresh: true });
  const j = await prisma.aiImportJob.create({ data: { title: `${title} ${TAG}`, examId, createdById: actor, budgetInr, status: "PROCESSING", leaseOwner: "suite-direct-calls", leaseUntil: new Date(Date.now() + 3_600_000), config: { modelPlan: plan } as never } });
  jobs.push(j.id);
  return j.id;
}
const classifyInput = async (jobId: string, n = 1): Promise<AiCallInput> => ({
  jobId,
  task: "classify",
  models: ["mocktext/classifier"],
  system: "You classify exam questions into an EXISTING syllabus.",
  content: [{ type: "text", text: `SUBJECT S1 = Anatomy\n  TOPIC T1 = Lower Limb\n[Q1] femur ${n}` }],
  maxOutputTokens: 2500,
  settings: normalizeImporterSettings(await getImporterSettings()),
  needsVision: false,
});
const parseClassify = (text: string) => {
  const p = classifySchema.safeParse(parseModelJson(text));
  if (!p.success) throw new ImporterAiFailure("format", "model_output");
  return p.data;
};
const events = (jobId: string, type: string) => prisma.aiImportEvent.findMany({ where: { jobId, type }, orderBy: { createdAt: "asc" } });

async function cleanup() {
  if (jobs.length) {
    await prisma.aiBudgetReservation.deleteMany({ where: { OR: jobs.map((id) => ({ requestKey: { startsWith: `qi:${id}:` } })) } });
    await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs } } });
  }
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  const questionsBefore = await prisma.question.count();

  try {
    // ------------------------------------------------------------------ A
    section("A. Answer parsing, figure wording and key header checks (no AI)");
    check("trailing commas repaired", JSON.stringify(parseModelJson('{"a":[1,2,],"b":{"c":3,},}')) === '{"a":[1,2],"b":{"c":3}}');
    const latex = parseModelJson(String.raw`{"stem":"Find \alpha if \sqrt{x} = 2","ok":"\\beta"}`) as { stem: string; ok: string };
    check("LaTeX backslashes that are not JSON escapes kept literally; a valid escape untouched", latex.stem === String.raw`Find \alpha if \sqrt{x} = 2` && latex.ok === String.raw`\beta`, latex);
    const cut = await errorOf(async () => parseModelJson('{"questions":[{"number":1,"stem":"Which bone"},{"number":2,"stem":"Which'));
    check("a cut-off answer is never patched: model_output error", cut instanceof ImporterAiFailure && cut.kind === "model_output", cut?.message);
    const shaped = pageSchema.safeParse({ questions: [{ number: "7", stem: null, options: ["Femur", { label: null, text: "Tibia" }, "Fibula", { label: "", text: 4 }], list_i: [{ key: null, text: "Ulna" }], list_ii: null, confidence: "0.9", printed_answer: null, figures: null, continues_on_next_page: "false" }], answer_key: null });
    check("malformed page shape accepted (string number, null stem / labels / lists, options as strings, numeric text)", shaped.success, shaped.success ? null : shaped.error.issues.slice(0, 3));
    if (shaped.success) {
      const [q] = toExtracted(shaped.data, 3, "mock/x");
      check("…options labelled by position, their text kept exactly, nothing invented", q.number === 7 && q.options.map((o) => o.printed).join() === "A,B,C,D" && q.options.map((o) => o.text).join() === "Femur,Tibia,Fibula,4" && q.stem === "", q);
      check("…confidence lowered to ≤ 0.6 and a note asks to check the labels", q.confidence <= 0.6 && /labelled by their position/.test((q.notes ?? []).join()), { c: q.confidence, n: q.notes });
      check("…list key taken from position", q.listI?.[0]?.key === "A", q.listI);
    }
    const ok = toExtracted(pageSchema.parse({ questions: [{ number: 1, stem: "x", options: [{ label: "(A)", text: "a" }], confidence: 0.95 }] }), 1, "m")[0];
    check("a well-formed question keeps its confidence and has no note", ok.confidence === 0.95 && !(ok.notes ?? []).length);
    const cls = classifySchema.safeParse({ results: [{ q: 1, subject: "S1", topic: null, confidence: "90" }] });
    check("classification answer: numeric reference and percentage confidence normalized", cls.success && cls.data.results[0].q === "1" && Math.abs(cls.data.results[0].confidence - 0.9) < 1e-9, cls);
    const noFig = ["Match List I with List II and select the correct answer using the code given below the Lists:", "Consider the following statements given below:", "Which of the statements given above is/are correct?"];
    const fig = ["Identify the structure marked X in the figure.", "The X-ray shown is of", "Study the graph and answer.", "The diagram below shows"];
    check("figure wording: 'given below/above' (lists, codes, statements) is not a figure reference", noFig.every((s) => !MENTIONS_FIGURE.test(s)));
    check("figure wording: figure / X-ray / graph / diagram still detected", fig.every((s) => MENTIONS_FIGURE.test(s)));
    check("paper numbers: II = 2 = Paper-2 = (ii); series codes normalized", paperNumber("II") === "2" && paperNumber("Paper-2") === "2" && paperNumber("(ii)") === "2" && paperNumber("A") === null && seriesCode("Series (A)") === "A" && seriesCode("Booklet A") === "A");
    const kh = { exam: null, paper: "I", series: "A", set: null, totalQuestions: 120 };
    check("key printed for Paper I vs question paper II → MISMATCH naming both", comparePaperIds(kh, { paper: "II", series: "A", totalQuestions: 120, source: "x" }).state === "MISMATCH" && /Paper I.*Paper II/.test(comparePaperIds(kh, { paper: "II", series: "A", totalQuestions: 120, source: "x" }).detail));
    check("key Paper 2 / Series A vs paper II / A → MATCH", comparePaperIds({ ...kh, paper: "2" }, { paper: "II", series: "A", totalQuestions: null, source: "x" }).state === "MATCH");
    check("series differs → MISMATCH", comparePaperIds({ ...kh, paper: "II", series: "B" }, { paper: "II", series: "A", totalQuestions: null, source: "x" }).state === "MISMATCH");
    check("nothing printed on the key, or nothing known about the paper → UNKNOWN (never assumed)", comparePaperIds(null, { paper: "II", series: "A", totalQuestions: null, source: "x" }).state === "UNKNOWN" && comparePaperIds(kh, { paper: null, series: null, totalQuestions: null, source: "x" }).state === "UNKNOWN");
    const ph = parseKeyHeader("COMBINED MEDICAL SERVICES EXAMINATION, 2026\nPAPER-II\nSeries A\nTotal Questions 120\n1. B 2. C");
    check("text key header read: Paper II, Series A, 120 questions", ph?.paper === "II" && ph?.series === "A" && ph?.totalQuestions === 120, ph);

    // ------------------------------------------------------------------ B
    section("B. Automatic selection never picks a batch-only variant");
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig(MOCK_BASE);
    await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
    await testOpenRouterConnection();
    await setOpenRouterEnabled(true);
    await syncCatalog();
    const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
    check("catalog has the batch and reasoning fixtures", mockIds.includes("mockvision/cheap:batch") && mockIds.includes("mockreason/think"), mockIds);
    const base = (s: ImporterSettings): ImporterSettings => ({
      ...s,
      aiEnabled: true,
      privacy: { dataCollection: "deny", zdr: false },
      budget: { ...s.budget, maxRequestInr: 1, keyReserveUsd: 5, retryTransient: false, allowPricierFallback: false },
      limits: { ...s.limits, concurrency: 1 },
    });
    await saveImporterSettings({ ...base(savedSettings), selection: { mode: "auto" }, importerModels: mockIds }, actor);
    const autoPlan = await computeModelPlan(normalizeImporterSettings(await getImporterSettings()), { refresh: true });
    const chosen = Object.values(autoPlan.tasks).map((t) => t.model);
    check("no task is given a ':batch' model although it is the cheapest vision model", chosen.every((m) => !m || !m.endsWith(":batch")) && !!autoPlan.tasks.extract.model, chosen);
    const batchRow = autoPlan.tasks.extract.candidates.find((c) => c.id === "mockvision/cheap:batch");
    check("…its candidate row says why (batch-only variant)", !!batchRow && !batchRow.eligible && /batch-only/.test(batchRow.reason ?? ""), batchRow);

    // ------------------------------------------------------------------ C
    section("C. Reasoning model: bounded reasoning, and cut-off answers reported as cut off");
    const manual = (models: Partial<ImporterSettings["models"]>, importerModels = mockIds, extra: Partial<ImporterSettings["budget"]> = {}) =>
      saveImporterSettings({ ...base(savedSettings), selection: { mode: "manual" }, importerModels, budget: { ...base(savedSettings).budget, ...extra }, models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null, ...models } }, actor);
    await manual({ extract: "mockreason/think" });
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig(MOCK_BASE);
    const jR = await newJob(actor, exam.id, "Reasoning model");
    await upload(actor, jR, "scanned.pdf");
    const jr = await runJob(actor, jR);
    const sR = await mockStats();
    const thinkCalls = await prisma.aiImportAiCall.findMany({ where: { jobId: jR, model: { startsWith: "mockreason/" } } });
    check("the reasoning model was sent reasoning {effort: low, exclude: true}", sR.reasoning.length > 0 && sR.reasoning.every((r) => r?.effort === "low" && r?.exclude === true), sR.reasoning);
    check("…and the page was read on the first attempt (no failed call), job finished", jr.status === "NEEDS_REVIEW" && thinkCalls.length >= 1 && thinkCalls.every((c) => c.ok), { s: jr.status, calls: thinkCalls.map((c) => [c.ok, c.errorSummary]) });
    check("…its 3 questions extracted", (await prisma.aiImportQuestion.count({ where: { jobId: jR } })) === 3);

    // ------------------------------------------------------------------ D
    section("D. Fallback after an unusable answer (direct requests)");
    const TEXT2 = ["mocktext/classifier", "mocktext/cheap"];
    await manual({ classify: "mocktext/classifier" }, TEXT2);
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig({ ...MOCK_BASE, script: { "mocktext/classifier": ["empty"] } });
    const jD = await directJob(actor, exam.id, "Fallback");
    const d1 = await importerAiCallChecked(await classifyInput(jD, 1), parseClassify);
    const sw1 = await events(jD, "MODEL_SWITCHED");
    check("an empty answer → the same request sent once to another approved model, which answered", d1.result.model === "mocktext/cheap" && d1.value.results.length === 1, d1.result.model);
    check("…MODEL_SWITCHED logged with both models, the reason and the failed attempt's cost", sw1.length === 1 && /mocktext\/classifier gave an unusable answer/.test(sw1[0].message) && /mocktext\/cheap/.test(sw1[0].message) && /failed attempt cost/.test(sw1[0].message) && (sw1[0].data as { reason?: string }).reason !== undefined, sw1.map((e) => e.message));
    const callsD1 = await prisma.aiImportAiCall.findMany({ where: { jobId: jD }, orderBy: { createdAt: "asc" } });
    check("…both attempts recorded, the failed one as not ok", callsD1.length === 2 && !callsD1[0].ok && callsD1[0].model === "mocktext/classifier" && callsD1[1].ok && callsD1[1].model === "mocktext/cheap", callsD1.map((c) => [c.model, c.ok, c.errorSummary]));
    const jd1 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jD } });
    const sumD1 = callsD1.reduce((a, c) => a + (c.costInr ?? 0), 0);
    check("…job spend = the sum of both attempts (each charged once)", Math.abs(jd1.spentInr - sumD1) < 1e-6 && sumD1 > 0, { spent: jd1.spentInr, sumD1 });
    check("…one unusable answer does not change the job's model", planOf(jd1.config)?.tasks.classify.model === "mocktext/classifier");
    await mockConfig({ script: { "mocktext/classifier": ["length"] } });
    const d2 = await importerAiCallChecked(await classifyInput(jD, 2), parseClassify);
    const cut2 = (await prisma.aiImportAiCall.findMany({ where: { jobId: jD, model: "mocktext/classifier" }, orderBy: { createdAt: "desc" }, take: 1 }))[0];
    check("an empty answer at the output limit is reported as cut off at the token limit, not 'empty'", !!cut2 && !cut2.ok && /cut off at the token limit/.test(cut2.errorSummary ?? "") && !/empty/i.test(cut2.errorSummary ?? ""), cut2?.errorSummary);
    const jd2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jD } });
    const rep = await events(jD, "MODEL_REPLACED");
    check("2 unusable answers in a row → the replacement is kept for the rest of the job (MODEL_REPLACED)", d2.result.model === "mocktext/cheap" && planOf(jd2.config)?.tasks.classify.model === "mocktext/cheap" && rep.length === 1 && /gave unusable answers/.test(rep[0].message), { m: planOf(jd2.config)?.tasks.classify.model, rep: rep.map((e) => e.message) });
    const sD3 = await mockStats();
    await importerAiCallChecked(await classifyInput(jD, 3), parseClassify);
    const sD3b = await mockStats();
    check("…the next request goes straight to the replacement", (sD3b.byModel["mocktext/cheap"] ?? 0) === (sD3.byModel["mocktext/cheap"] ?? 0) + 1 && (sD3b.attempts["mocktext/classifier"] ?? 0) === (sD3.attempts["mocktext/classifier"] ?? 0));

    await mockConfig({ script: { "mocktext/classifier": ["malformed"], "mocktext/cheap": ["malformed"] } });
    const jD4 = await directJob(actor, exam.id, "Both bad");
    const sD4 = await mockStats();
    const e4 = await errorOf(async () => importerAiCallChecked(await classifyInput(jD4), parseClassify));
    const sD4b = await mockStats();
    check("both models unusable → reported as a failure, exactly 2 requests (no loop)", e4 instanceof ImporterAiFailure && sD4b.chat - sD4.chat === 2, { e: e4?.message, n: sD4b.chat - sD4.chat });

    await manual({ classify: "mocktext/classifier" }, ["mocktext/classifier"]);
    await mockConfig({ script: { "mocktext/classifier": ["empty"] } });
    const jD5 = await directJob(actor, exam.id, "No alternative");
    const e5 = await errorOf(async () => importerAiCallChecked(await classifyInput(jD5), parseClassify));
    const sk5 = await events(jD5, "MODEL_SWITCH_SKIPPED");
    check("no other suitable model → failure says no other model was tried; MODEL_SWITCH_SKIPPED logged", e5 instanceof ImporterAiFailure && /No other model was tried/.test(e5.message) && sk5.length === 1, { e: e5?.message, sk5: sk5.length });

    // mocktext/cheap is the job's model; the only alternative, mocktext/classifier, costs more per request.
    await manual({ classify: "mocktext/cheap" }, TEXT2);
    await mockConfig({ script: { "mocktext/cheap": ["empty"] } });
    const jD6 = await directJob(actor, exam.id, "Pricier refused");
    const sD6 = await mockStats();
    const e6 = await errorOf(async () => importerAiCallChecked(await classifyInput(jD6), parseClassify));
    const sD6b = await mockStats();
    check("only a more expensive model left and pricier fallbacks OFF → not sent to it", e6 instanceof ImporterAiFailure && /more expensive fallbacks are OFF/.test(e6.message) && (sD6b.byModel["mocktext/classifier"] ?? 0) === (sD6.byModel["mocktext/classifier"] ?? 0), e6?.message);
    await manual({ classify: "mocktext/cheap" }, TEXT2, { allowPricierFallback: true });
    await mockConfig({ script: { "mocktext/cheap": ["empty"] } });
    const jD7 = await directJob(actor, exam.id, "Pricier allowed");
    const d7 = await importerAiCallChecked(await classifyInput(jD7), parseClassify);
    const sw7 = await events(jD7, "MODEL_SWITCHED");
    check("…with pricier fallbacks allowed it is used and the event says MORE EXPENSIVE", d7.result.model === "mocktext/classifier" && /MORE EXPENSIVE/.test(sw7[0]?.message ?? ""), sw7.map((e) => e.message));

    await manual({ classify: "mocktext/classifier" }, TEXT2);
    await mockConfig({ script: {}, badRequest: { "mocktext/classifier": "Invalid request: bad parameter" } });
    const jD8 = await directJob(actor, exam.id, "Permanent error");
    const sD8 = await mockStats();
    const e8 = await errorOf(async () => importerAiCallChecked(await classifyInput(jD8), parseClassify));
    const sD8b = await mockStats();
    check("a permanent request error (HTTP 400) is not re-sent to another model", !!e8 && (sD8b.byModel["mocktext/cheap"] ?? 0) === (sD8.byModel["mocktext/cheap"] ?? 0) && (await events(jD8, "MODEL_SWITCHED")).length === 0, e8?.message);
    await mockConfig({ badRequest: {} });
    const jD9 = await directJob(actor, exam.id, "Over max", 0.000001);
    const sD9 = await mockStats();
    const e9 = await errorOf(async () => importerAiCallChecked(await classifyInput(jD9), parseClassify));
    check("a request past the job's confirmed maximum is refused before sending", !!e9 && /exceed the confirmed maximum/.test(e9.message) && (await mockStats()).chat === sD9.chat, e9?.message);

    // ------------------------------------------------------------------ E
    section("E. Page reading: malformed shapes, and the paid first read is never bought twice");
    await manual({ extract: "mockvision/reader", classify: "mocktext/classifier" }, ["mockvision/reader", "mockvision/checker", "mocktext/classifier"]);
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig({ ...MOCK_BASE, script: { "mockvision/reader": ["shape"] } });
    const jE = await newJob(actor, exam.id, "Malformed shape");
    await upload(actor, jE, "scanned.pdf");
    const je = await runJob(actor, jE);
    const qe = await prisma.aiImportQuestion.findMany({ where: { jobId: jE }, orderBy: { sourceLabel: "asc" } });
    check("a page answered in a malformed shape is still read (no failed page, no second model)", je.status === "NEEDS_REVIEW" && qe.length === 3 && (await events(jE, "MODEL_SWITCHED")).length === 0, { s: je.status, n: qe.length, e: je.errorMessage });
    check("…its questions flagged with position labels and lowered confidence", qe.every((q) => (q.confidence ?? 1) <= 0.6 && /labelled by their position/.test(JSON.stringify(q.data))), qe.map((q) => q.confidence));

    await manual({ extract: "mockvision/reader", verify: "mockvision/checker", classify: "mocktext/classifier" }, ["mockvision/reader", "mockvision/checker", "mocktext/classifier"]);
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    // The second-read model has no serving route and there is no substitute: the job stops mid-page (as in production).
    await mockConfig({ ...MOCK_BASE, noEndpoint: ["mockvision/checker"] });
    const jC = await newJob(actor, exam.id, "Stop during second read");
    await upload(actor, jC, "scanned.pdf");
    const jc1 = await runJob(actor, jC);
    const sC1 = await mockStats();
    const pageC = await prisma.aiImportPage.findFirstOrThrow({ where: { jobId: jC } });
    check("second-read model unavailable, no substitute → the job stops; the paid first read is kept on the page", ["PAUSED", "PAUSED_BUDGET", "FAILED"].includes(jc1.status) && (sC1.byModel["mockvision/reader"] ?? 0) === 1 && !!(pageC.rawOutput as { primaryCache?: unknown } | null)?.primaryCache, { s: jc1.status, r: jc1.pauseReason ?? jc1.errorMessage, reader: sC1.byModel["mockvision/reader"] });
    // The administrator picks another second-read model for this job (what Reconfigure stores), then resumes.
    await manual({ extract: "mockvision/reader", verify: "mockvision/mid", classify: "mocktext/classifier" }, ["mockvision/reader", "mockvision/mid", "mocktext/classifier"]);
    const planC = await computeModelPlan(normalizeImporterSettings(await getImporterSettings()), { refresh: true });
    await prisma.aiImportJob.update({ where: { id: jC }, data: { config: { ...((jc1.config as object) ?? {}), modelPlan: planC } as never } });
    const rc = await resumeJob(jC, actor);
    if (!rc.started) await resumeJob(jC, actor, rc.cost.neededMaxInr);
    await runWorker(300_000);
    const jc2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jC } });
    const sC2 = await mockStats();
    const pageC2 = await prisma.aiImportPage.findFirstOrThrow({ where: { jobId: jC } });
    check("…after Resume the page finishes without reading (or paying for) the first read again", jc2.status === "NEEDS_REVIEW" && (sC2.byModel["mockvision/reader"] ?? 0) === 1 && (sC2.byModel["mockvision/mid"] ?? 0) >= 1 && pageC2.status === "DONE", { s: jc2.status, r: jc2.pauseReason ?? jc2.errorMessage, reader: sC2.byModel["mockvision/reader"], mid: sC2.byModel["mockvision/mid"] });
    check("…the cached read is cleared once the page is finished", !(pageC2.rawOutput as { primaryCache?: unknown } | null)?.primaryCache);

    // ------------------------------------------------------------------ F
    section("F. Classification with short codes; invalid codes are counted, never silent");
    const cr = (await events(jE, "CLASSIFY_RESULT"))[0];
    const q1E = qe.find((q) => q.sourceLabel === "1");
    check("classification assigned subject / topic from codes (Q1 → Lower Limb)", !!q1E?.topicId && (await prisma.topic.findUniqueOrThrow({ where: { id: q1E.topicId! } })).name === "Lower Limb");
    // Since 2026-10-23 the free local classifier runs first; the AI classifier only gets what it cannot settle.
    const lcE = (await events(jE, "LOCAL_CLASSIFY_RESULT"))[0];
    check("…classification events: free classification of 3 questions; the AI got only the rest, with no invalid codes", !!lcE && (lcE.data as { questions: number }).questions === 3 && (!cr || ((cr.data as { questions: number }).questions < 3 && (cr.data as { invalid: number }).invalid === 0)), [lcE?.message, cr?.message]);
    await manual({ extract: "mockvision/reader", classify: "mocktext/classifier" }, ["mockvision/reader", "mocktext/classifier"]);
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig({ ...MOCK_BASE, script: { "mocktext/classifier": ["badcodes"] } });
    const jF = await newJob(actor, exam.id, "Bad codes");
    await upload(actor, jF, "scanned.pdf");
    await runJob(actor, jF);
    const crF = (await events(jF, "CLASSIFY_RESULT"))[0];
    const qF = await prisma.aiImportQuestion.findMany({ where: { jobId: jF } });
    const linkedF = new Set((await prisma.examSubject.findMany({ where: { examId: exam.id } })).map((l) => l.subjectId));
    const topicsF = new Set((await prisma.examTopic.findMany({ where: { examId: exam.id } })).map((l) => l.topicId));
    check("codes not on the list → never stored: only this exam's own subjects / topics (from the free classifier), nothing guessed", qF.length === 3 && qF.every((q) => (!q.subjectId || linkedF.has(q.subjectId)) && (!q.topicId || topicsF.has(q.topicId))), qF.map((q) => [q.subjectId, q.topicId, q.taxonomySource]));
    const sentF = crF ? (crF.data as { questions: number }).questions : 0;
    check("…when the AI classifier was asked, CLASSIFY_RESULT reports its invalid answers in plain words", !crF || ((crF.data as { invalid: number }).invalid >= sentF && /not on the list/.test(crF.message) && /stay in Needs correction/.test(crF.message)), crF?.message);

    // ------------------------------------------------------------------ G
    section("G. Answer key printed for another paper / series");
    await manual({ extract: "mockvision/reader", key: "mockvision/reader" }, ["mockvision/reader"]);
    const keyJob = async (title: string, header: Record<string, unknown> | null) => {
      await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
      await mockConfig({ ...MOCK_BASE, keyHeader: header });
      const id = await newJob(actor, exam.id, title, "II");
      const paper = await upload(actor, id, "scanned.pdf");
      await upload(actor, id, "scanned-key.png", AiImportFileRole.ANSWER_KEY, paper);
      await runJob(actor, id);
      return { id, qs: await prisma.aiImportQuestion.findMany({ where: { jobId: id }, orderBy: { sourceLabel: "asc" } }), checks: await keyPaperChecks(id) };
    };
    const g1 = await keyJob("Key for Paper I", { exam: "CMS", paper: "I", series: "A", set: null, total_questions: 120 });
    check("the key's printed header is compared with the job's paper (Paper II) → MISMATCH", g1.checks.length === 1 && g1.checks[0].state === "MISMATCH" && /Paper I.*Paper II/.test(g1.checks[0].detail), g1.checks);
    check("…no question gets an official answer from it; each is blocked with ANSWER_KEY_PAPER_MISMATCH", g1.qs.length === 3 && g1.qs.every((q) => q.answerStatus === "KEY_MISMATCH" && q.finalAnswer.length === 0 && q.issueCodes.includes("ANSWER_KEY_PAPER_MISMATCH")), g1.qs.map((q) => [q.answerStatus, q.finalAnswer, q.issueCodes]));
    check("…the key's own value is kept for reference only", g1.qs.every((q) => !!q.officialAnswerRaw), g1.qs.map((q) => q.officialAnswerRaw));
    const g2 = await keyJob("Key for Paper II", { exam: "CMS", paper: "2", series: null, set: null, total_questions: null });
    check("a key printed for Paper 2 matches Paper II → official answers used (Q1 → A)", g2.checks[0]?.state === "MATCH" && g2.qs[0]?.answerStatus === "OFFICIAL_MATCHED" && g2.qs[0]?.finalAnswer.join() === "A" && !g2.qs.some((q) => q.issueCodes.includes("ANSWER_KEY_PAPER_MISMATCH")), [g2.checks[0]?.state, g2.qs[0]?.answerStatus, g2.qs[0]?.finalAnswer]);
    const g3 = await keyJob("Key without header", null);
    check("a key without a printed header → UNKNOWN; its answers are used as before (no blocking)", g3.checks[0]?.state === "UNKNOWN" && g3.qs[0]?.answerStatus === "OFFICIAL_MATCHED", [g3.checks[0]?.state, g3.qs[0]?.answerStatus]);

    // ------------------------------------------------------------------ H
    section("H. Retry of failed pages is priced and needs confirmation past the confirmed maximum");
    const jh = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jE } });
    await prisma.aiImportPage.updateMany({ where: { jobId: jE }, data: { status: "FAILED", errorMessage: "suite: failed" } });
    await prisma.aiImportJob.update({ where: { id: jE }, data: { budgetInr: jh.spentInr } });
    const sH = await mockStats();
    const h1 = await retryJob(jE, actor);
    const jh1 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jE } });
    check("Retry failed pages with no room left → not started; the cost (spent + remaining maximum) is returned", !h1.started && h1.cost.pages === 1 && h1.cost.neededMaxInr > jh.spentInr && jh1.status === "NEEDS_REVIEW" && (await mockStats()).chat === sH.chat, h1);
    const h2 = await retryJob(jE, actor, h1.cost?.neededMaxInr);
    const jh2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jE } });
    check("…confirming it queues the retry with the new maximum (COST_RECONFIRMED)", h2.started && jh2.status === "QUEUED" && Math.abs(jh2.budgetInr - (h1.cost?.neededMaxInr ?? -1)) < 0.001 && (await events(jE, "COST_RECONFIRMED")).length === 1, { s: jh2.status, b: jh2.budgetInr });
    await runWorker(300_000);
    const jh3 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jE } });
    check("…the retry finishes within the new confirmed maximum", jh3.status === "NEEDS_REVIEW" && jh3.spentInr <= jh3.budgetInr + 0.005, { s: jh3.status, spent: jh3.spentInr, b: jh3.budgetInr });

    // ------------------------------------------------------------------ I
    section("I. Nothing approved or imported automatically");
    const all = await prisma.aiImportQuestion.findMany({ where: { jobId: { in: jobs } }, select: { status: true } });
    check("no suite question is IMPORTED / PUBLISHED", all.length > 0 && all.every((q) => q.status !== "IMPORTED" && q.status !== "PUBLISHED"), [...new Set(all.map((q) => q.status))]);
    check("the Question Bank is unchanged", (await prisma.question.count()) === questionsBefore);
  } catch (e) {
    fail++;
    console.error(e);
  } finally {
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    await setOpenRouterEnabled(routerWasEnabled).catch(() => undefined);
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" }).catch(() => undefined);
    await cleanup();
    await prisma.aiModel.deleteMany({ where: { id: { in: FIXTURE_MODELS } } }).catch(() => undefined);
  }
  check("network guard: every request of this run went to the loopback mock", blockedHosts.size === 0, [...blockedHosts]);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("SOME CHECKS FAILED");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

void main();
