/**
 * Phase 2 production-readiness checks (2026-11-11) — scratch database + loopback mock only (₹0, no real provider):
 *   A. provider-specific reasoning parameters (mandatory reasoning: Gemini 4 / Claude Opus 5.5) and request validation
 *   B. extract / classify JSON Schemas within Anthropic's 16-union limit, same fields, tolerant parsing
 *   C. near-empty readings: the 7 real FSO failures, legitimately empty pages, number-gap detection on the real run
 *   D. the pipeline: recovery by re-reading, review when it stays incomplete, gap re-read, hidden mandatory reasoning,
 *      an Anthropic-like route
 *   E. provider errors, malformed / partial answers, rate limits, spending-limit exhaustion, parallel calls vs the budget
 *
 *   OPENROUTER_TEST_BASE_URL=http://127.0.0.1:<port> FX_TEST_BASE_URL=… DATABASE_URL=<scratch mts_*> AI_IMPORT_VAULT_DIR=…
 *   STORAGE_DIR=… IMPORT_STAGING_DIR=… AI_IMPORT_DISABLE_KICK=1 NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/verify-ai-import-phase2.ts <fixture dir of scripts/fso-bilingual-fixtures.ts> [prod-schema.json]
 */
import "dotenv/config";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, DEFAULT_TOTAL_INR, PILOT_LIMITS, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, setExpectedQuestions } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { effective } from "@/lib/ai-import/post";
import { importerAiCall, importerAiCallChecked, ImporterAiFailure } from "@/lib/ai-import/ai";
import { computeModelPlan } from "@/lib/ai-import/select";
import { OUTPUT_SCHEMAS } from "@/lib/ai-import/output-schemas";
import { pageSchema, toExtracted } from "@/lib/ai-import/prompts";
import { parsePage } from "@/lib/ai-import/process";
import { ANTHROPIC_UNION_LIMIT, reasoningParam, requestProblem, unionParameterCount } from "@/lib/ai-import/request-params";
import { gapPages, incompleteReading } from "@/lib/ai-import/reading-checks";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !process.env.OPENROUTER_TEST_BASE_URL) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR (scratch) and OPENROUTER_TEST_BASE_URL (loopback mock).");
  process.exit(2);
}
const FX = process.argv[2];
const PROD_SCHEMA = process.argv[3];
const MOCK = process.env.OPENROUTER_TEST_BASE_URL!;
const CONFIRM_ANY = 1_000_000;

// Network guard: only the loopback mock may be contacted.
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
const mock = async (p: string, body?: unknown) => (await realFetch(`${MOCK}${p}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

// ---- A ----------------------------------------------------------------------------------------------------------
// Reasoning blocks exactly as OpenRouter published them on 2026-11-11.
const META = {
  carbon: { mandatory: true, supported_efforts: ["high", "medium", "low"], default_effort: "medium" },
  opus: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high" },
  sol: { mandatory: false, supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"], default_effort: "medium" },
  nex: { mandatory: false, supported_efforts: ["high", "medium", "none"], default_effort: "high" },
  mandatoryNoList: { mandatory: true },
};
function partA() {
  section("A. Provider-specific reasoning parameters");
  check("Gemini 4 (mandatory, low/medium/high): reading gets effort low, never none", reasoningParam([META.carbon], "none")?.effort === "low");
  check("Claude Opus 5.5 (mandatory): reading gets effort low", reasoningParam([META.opus], "none")?.effort === "low");
  check("GPT-5.6 Sol (none allowed): reading keeps effort none", reasoningParam([META.sol], "none")?.effort === "none");
  check("nex-n2.5-mini (high/medium/none): reading none; answer opinion medium (low is not published)", reasoningParam([META.nex], "none")?.effort === "none" && reasoningParam([META.nex], "low")?.effort === "medium");
  check("mandatory without a published list: no effort word at all (provider default, bounded by max_tokens)", JSON.stringify(reasoningParam([META.mandatoryNoList], "none")) === JSON.stringify({ exclude: true }));
  check("catalog not synced yet (null): legacy behaviour (none / low)", reasoningParam([null], "none")?.effort === "none" && reasoningParam([null], "low")?.effort === "low");
  check("requested + fallback: the lowest effort BOTH accept (Sol + Carbon → low)", reasoningParam([META.sol, META.carbon], "none")?.effort === "low");
  check("reasoning is always excluded from the answer text", reasoningParam([META.carbon], "none")?.exclude === true);
  const m = (id: string, reasoning: object | null, params = ["max_tokens", "reasoning", "response_format"]) => ({ id, reasoning, supportedParameters: params });
  check("validation refuses effort none for a mandatory model", /mandatory/.test(requestProblem({ models: [m("google/gemini-4-carbon", META.carbon)], reasoning: { effort: "none" }, schema: null }) ?? ""));
  check("validation refuses an effort the model does not publish (minimal for Carbon)", /does not accept reasoning effort "minimal"/.test(requestProblem({ models: [m("google/gemini-4-carbon", META.carbon)], reasoning: { effort: "minimal" }, schema: null }) ?? ""));
  check("validation refuses a reasoning parameter for a model that takes none", /does not accept a reasoning parameter/.test(requestProblem({ models: [m("google/gemma-3-4b-it", null, ["max_tokens"])], reasoning: { effort: "none" }, schema: null }) ?? ""));
  check("validation passes the chosen parameters for Carbon, Opus, Sol", [["google/gemini-4-carbon", META.carbon], ["anthropic/claude-opus-5.5", META.opus], ["openai/gpt-5.6-sol", META.sol]].every(([id, meta]) => requestProblem({ models: [m(id as string, meta as object)], reasoning: reasoningParam([meta as never], "none"), schema: OUTPUT_SCHEMAS.extract }) === null));
}

// ---- B ----------------------------------------------------------------------------------------------------------
const fieldsOf = (schema: unknown, prefix = ""): string[] => {
  const o = schema as { properties?: Record<string, unknown>; items?: unknown };
  const own = Object.entries(o.properties ?? {}).flatMap(([k, v]) => [prefix + k, ...fieldsOf(v, `${prefix}${k}.`)]);
  return o.items ? [...own, ...fieldsOf(o.items, prefix)] : own;
};
function partB() {
  section("B. Answer schemas within Anthropic's limit, same fields, tolerant parsing");
  const ex = unionParameterCount(OUTPUT_SCHEMAS.extract);
  const cl = unionParameterCount(OUTPUT_SCHEMAS.classify);
  check(`extract schema: ${ex} union-typed parameters (≤ ${ANTHROPIC_UNION_LIMIT})`, ex <= ANTHROPIC_UNION_LIMIT, ex);
  check(`classify schema: ${cl} union-typed parameters (≤ ${ANTHROPIC_UNION_LIMIT})`, cl <= ANTHROPIC_UNION_LIMIT, cl);
  if (PROD_SCHEMA && existsSync(PROD_SCHEMA)) {
    const prod = JSON.parse(readFileSync(PROD_SCHEMA, "utf8"));
    check(`the production schema (a1e3bde) was over the limit (${unionParameterCount(prod)} counted per occurrence) — why Opus was refused`, unionParameterCount(prod) > ANTHROPIC_UNION_LIMIT);
    const before = new Set(fieldsOf(prod));
    const after = new Set(fieldsOf(OUTPUT_SCHEMAS.extract));
    const lost = [...before].filter((f) => !after.has(f));
    check("no field of the production schema was dropped (numbers, text, options, keys, figures, confidence, continuation…)", lost.length === 0, lost);
    check("the bilingual fields are present (hi.stem, hi.options.text, hi.confidence, hi.same_option_order, hi.figures_differ)", ["hi.stem", "hi.options.text", "hi.confidence", "hi.same_option_order", "hi.figures_differ"].every((f) => after.has(`questions.${f}`)), [...after].filter((f) => f.startsWith("questions.hi")));
  }
  // Old-style (nulls), structured-output style (fields left out / ""), and mixed answers parse to the same questions.
  const base = { number: 7, stem: "Which is a gel?", options: [{ label: "(1)", text: "Smoke" }, { label: "(2)", text: "Butter" }], printed_answer: [], confidence: 0.9 };
  const withNulls = { questions: [{ ...base, section: null, type: null, instructions: null, passage: null, explanation: null, region: null, rich: null, continues_on_next_page: null, figures: [{ box: null, owner: "STEM", option_label: null, shared_with: [], caption: null, description: "diagram" }] }], answer_key: null, paper_header: null, page_notes: null };
  const leftOut = { questions: [{ ...base, figures: [{ owner: "STEM", shared_with: [], description: "diagram" }] }] };
  const blanks = { questions: [{ ...base, section: "", type: "", instructions: "", passage: "", explanation: "", figures: [{ owner: "STEM", option_label: "", shared_with: [], caption: "", description: "diagram" }] }], answer_key: [], paper_header: { paper: "", total_questions: "150" }, page_notes: "" };
  const norm = (o: unknown) => JSON.stringify(toExtracted(pageSchema.parse(o), 3, "m").map((q) => ({ ...q, notes: undefined })));
  check("nulls, omitted fields and empty strings give the same extracted question", norm(withNulls) === norm(leftOut) && norm(leftOut) === norm(blanks), [norm(withNulls), norm(blanks)]);
  check("a blank instructions / passage is stored as null (never an empty block)", (() => { const q = toExtracted(pageSchema.parse(blanks), 3, "m")[0]; return q.instructions === null && q.passage === null; })());
  check("answer-key numbers as integer or string, and the printed total as a string, still parse", pageSchema.parse({ questions: [], answer_key: [{ number: "12", answer: 3 }, { number: 13, answer: "B" }], paper_header: { total_questions: "150" } }).answer_key.length === 2);
  let thrown = "";
  try {
    parsePage('{"questions":[{"number":1,"stem":"cut off', "test");
  } catch (e) {
    thrown = (e as Error).message;
  }
  check("a malformed / cut-off answer is refused with a message, never half-saved", thrown.length > 0, thrown);
  const hiMissing = toExtracted(pageSchema.parse({ questions: [{ ...base }] }), 3, "m")[0];
  check("a Hindi version left out (bilingual rule 'leave hi out') reads as no Hindi, not an empty one", !("hi" in hiMissing) || hiMissing.hi === null || hiMissing.hi === undefined, hiMissing.hi);
}

// ---- C ----------------------------------------------------------------------------------------------------------
// The 7 near-empty readings of the 2026-11-11 FSO run (google/gemini-4-carbon), exactly as stored: one question, one
// option. Labels / texts are the model's own notes, not paper content.
const REAL_DEGENERATE: { paper: string; page: number; number: number; label: string; text: string }[] = [
  { paper: "2019", page: 16, number: 74, label: "(1 Supplementary ? No, wait: (1))", text: "..." },
  { paper: "2019", page: 22, number: 104, label: "(1d)?", text: "" },
  { paper: "2019", page: 23, number: 108, label: "(1b?)", text: "Wait" },
  { paper: "2019", page: 25, number: 119, label: "(1a) -> wait no, (1) in image", text: "" },
  { paper: "2022", page: 2, number: 1, label: "(1d", text: "" },
  { paper: "2022", page: 21, number: 101, label: "(1 Dhaka", text: "Tetramethyl amine" },
  { paper: "2022", page: 19, number: 88, label: "(1, a-b-c-d is implicit in header a b c d, wait: format options cleanly as printed: a b c d header, let's check standard format -> a: iii, b: iv, c: i, d: ii or", text: "" },
];
// Question numbers per page read in that run BEFORE the re-scan (numbers only).
const RUN_PAGES: Record<string, Record<number, number[]>> = {
  "2019": { 1: [], 2: [1, 2, 3, 4, 5, 6], 3: [7, 8, 9, 10, 11], 4: [12, 13, 14, 15, 16], 5: [17, 18, 19], 6: [20, 21, 22, 23], 7: [24, 25, 26, 27, 28], 8: [29, 30, 31, 32], 9: [33, 34, 35, 36, 37], 10: [38, 39, 40, 41, 42, 43], 11: [44, 45, 46, 47, 48, 49, 50], 12: [51, 52, 53, 54, 55, 56], 13: [57, 58, 59, 60, 61, 62], 14: [63, 64, 65, 66, 67, 68], 15: [69, 70, 71, 72, 73], 16: [74], 17: [79, 80, 81, 82, 83, 84], 18: [85, 86, 87, 88, 89, 90], 19: [91, 92, 93, 94], 20: [95, 96, 97, 98, 99], 21: [100, 101, 102, 103], 22: [104], 23: [108], 24: [113, 114, 115, 116, 117, 118], 25: [119], 26: [123, 124, 125, 126, 127], 27: [128, 129, 130, 131, 132, 133], 28: [134, 135, 136, 137, 138, 139], 29: [140, 141, 142, 143, 144], 30: [145, 146, 147], 31: [148, 149, 150], 32: [] },
  "2022": { 1: [], 2: [1], 3: [5, 6, 7, 8, 9], 4: [10, 11, 12, 13, 14], 5: [15, 16, 17, 18, 19], 6: [20, 21, 22, 23], 7: [24, 25, 26, 27], 8: [28, 29, 30, 31], 9: [32, 33, 34, 35], 10: [36, 37, 38, 39, 40, 41, 42], 11: [43, 44, 45, 46, 47, 48], 12: [49, 50, 51, 52, 53, 54, 55], 13: [56, 57, 58, 59, 60, 61], 14: [62, 63, 64, 65], 15: [66, 67, 68, 69, 70], 16: [71, 72, 73, 74, 75, 76], 17: [77, 78, 79, 80, 81, 82], 18: [83, 84, 85, 86, 87], 19: [88], 20: [94, 95, 96, 97, 98, 99, 100], 21: [101], 22: [107, 108, 109], 23: [110, 111, 112, 113, 114], 24: [115, 116, 117, 118, 119, 120], 25: [121, 122, 123, 124, 125], 26: [126, 127, 128, 129, 130], 27: [131, 132, 133, 134], 28: [135, 136, 137, 138], 29: [139, 140, 141, 142], 30: [143, 144, 145, 146], 31: [147, 148, 149, 150], 32: [] },
};
function partC() {
  section("C. Near-empty readings — the 7 real FSO pages");
  for (const d of REAL_DEGENERATE) {
    const r = incompleteReading([{ number: d.number, stem: "…", options: [{ label: "A", printed: d.label, text: d.text }] }]);
    check(`${d.paper} p${d.page} (Q${d.number}, label "${d.label.slice(0, 28)}"): not accepted`, r.length === 1, r);
  }
  const good = Array.from({ length: 6 }, (_, k) => ({ number: k + 1, stem: `Question ${k + 1}`, options: ["Avidity", "Affinity", "Active transport", "Antibody synthesis"].map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t })) }));
  check("a normal page (6 questions × 4 options) is accepted", incompleteReading(good).length === 0);
  check("cover / rough-work page with no questions is accepted (0 questions is not 'incomplete' by itself)", incompleteReading([]).length === 0);
  check("a question continued from / onto another page may have one option", incompleteReading([{ number: 9, stem: "", options: [{ label: "D", printed: "(4)", text: "Ferns" }], continuedFromPreviousPage: true }, { number: 10, stem: "x", options: [{ label: "A", printed: "(1)", text: "y" }], continuesOnNextPage: true }]).length === 0);
  check("labels (a) / A. / i) / 1. are printed labels, not notes", incompleteReading([{ number: 3, stem: "x", options: ["(a)", "A.", "i)", "1."].map((p, i) => ({ label: "ABCD"[i], printed: p, text: "t" })) }]).length === 0);
  check("a question whose options are all empty is not accepted", incompleteReading([{ number: 3, stem: "x", options: ["(1)", "(2)", "(3)", "(4)"].map((p, i) => ({ label: "ABCD"[i], printed: p, text: "" })) }]).length === 1);
  section("C2. Number-gap check on the real run (pages as first read)");
  const expect: Record<string, number[]> = { "2019": [16, 22, 23, 25], "2022": [2, 19, 21] };
  for (const paper of ["2019", "2022"]) {
    const found = Object.entries(RUN_PAGES[paper]).flatMap(([p, ns]) => ns.map((n) => ({ number: n, pages: [Number(p)] })));
    const g = gapPages(found, 150, 32);
    const pages = [...g.keys()].sort((a, b) => a - b);
    check(`${paper}: pages to read again = ${expect[paper].join(", ")} (exactly the 7 near-empty pages; no full page re-read)`, JSON.stringify(pages) === JSON.stringify(expect[paper]), Object.fromEntries(g));
    const missing = [...g.values()].flat();
    check(`${paper}: every missing number is placed on a page (${new Set(missing).size} numbers)`, new Set(missing).size === 150 - found.length, { missing: [...new Set(missing)].length, found: found.length });
  }
  const after = Object.fromEntries(Object.entries(RUN_PAGES["2019"]).map(([p, ns]) => [p, ns]));
  after[16] = [74, 75, 76, 77, 78]; after[22] = [104, 105, 106, 107]; after[23] = [108, 109, 110, 111, 112]; after[25] = [119, 120, 121, 122];
  check("after the re-reads (2019 as recovered): no gap left", gapPages(Object.entries(after).flatMap(([p, ns]) => ns.map((n) => ({ number: n, pages: [Number(p)] }))), 150, 32).size === 0);
}

// ---- D ----------------------------------------------------------------------------------------------------------
async function upload(actor: string, jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER, paperFileId: string | null = null) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  return { fileId, ...(await completeFile({ fileId, actorId: actor })) };
}
async function setSettings(patch: (s: ImporterSettings) => ImporterSettings, actor: string) {
  await saveImporterSettings(patch(normalizeImporterSettings(await getImporterSettings())), actor);
}
const MODELS = ["mockreason/mandatory", "mockreason/hidden", "mockanthropic/reader", "mockvision/reader", "mocktext/classifier", "mocktier/reader"];

async function runPaper(actor: string, examId: string, extract: string, mockConfig: Record<string, unknown>, tag: string) {
  await mock("/__mock/reset", {});
  await mock("/__mock/config", { reasonModels: true, ...mockConfig });
  await setSettings((s) => ({ ...s, aiEnabled: true, selection: { mode: "manual" }, importerModels: MODELS, models: { extract, extractFallbacks: [], verify: null, classify: "mocktext/classifier", key: null }, limits: { ...s.limits, concurrency: 1 }, verification: { ...s.verification, independentAnswer: false }, budget: { ...s.budget, totalInr: 600, monthlyInr: 1500 } }), actor);
  const jobId = await createJob({ actorId: actor, title: `P2 ${tag} ${Date.now().toString(36)}`, examId, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2022, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  const paper = await upload(actor, jobId, "bilingual-paper.pdf");
  await upload(actor, jobId, "key-2022.pdf", AiImportFileRole.ANSWER_KEY, paper.fileId);
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  await setExpectedQuestions({ jobId, actorId: actor, expected: 7 });
  const j0 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  await confirmJob({ jobId, actorId: actor, examId: j0.examId, paperType: j0.paperType, subjectId: j0.subjectId, year: j0.year, paperCode: j0.paperCode, previousYearPaperId: j0.previousYearPaperId, confirmedMaxInr: CONFIRM_ANY });
  await runWorker(300_000);
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const pages = await prisma.aiImportPage.findMany({ where: { jobId, fileId: paper.fileId }, orderBy: { pageNumber: "asc" } });
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId } });
  const numbers = qs.map((q) => effective(q).number).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const events = await prisma.aiImportEvent.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const calls = await prisma.aiImportAiCall.findMany({ where: { jobId, task: "extract" }, orderBy: { createdAt: "asc" } });
  const stats = await mock("/__mock/stats");
  return { job, pages, numbers, events, calls, stats };
}

async function partD(actor: string) {
  section("D. Pipeline (mock): mandatory reasoning, near-empty recovery, review, gap re-read, Anthropic-like schema");
  await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
  await mock("/__mock/config", { reasonModels: true });
  check("OpenRouter (mock) connection test", (await testOpenRouterConnection()).ok);
  await setOpenRouterEnabled(true);
  await syncCatalog();
  const meta = await prisma.aiModel.findUnique({ where: { id: "mockreason/mandatory" }, select: { reasoning: true } });
  const stored = meta?.reasoning as { mandatory?: boolean; supported_efforts?: string[]; default_effort?: string } | null;
  check("catalog sync stores the published reasoning block (mandatory, efforts)", stored?.mandatory === true && stored.supported_efforts?.join() === "high,medium,low" && stored.default_effort === "medium", meta);
  const hidden = await prisma.aiModel.findUnique({ where: { id: "mockreason/hidden" }, select: { reasoning: true } });
  check("a model that publishes no reasoning block is stored as unknown (null)", hidden?.reasoning === null, hidden);
  const exam = await prisma.exam.create({ data: { name: `P2 Exam ${Date.now().toString(36)}`, code: `P2-${Date.now().toString(36)}`, isActive: true, languageMode: "BILINGUAL" } });

  // D1 — mandatory reasoning + one near-empty reading → re-read → recovered.
  let r = await runPaper(actor, exam.id, "mockreason/mandatory", { scriptMarker: { "mockreason/mandatory": { "3": ["degenerate"] } } }, "recover");
  check("D1 every reading request to the mandatory model carried effort low (never none) — no refusal", (r.stats.reasoning as { effort?: string }[]).filter(Boolean).every((x) => x.effort === "low") && !r.stats.mandatoryRefused, { reasoning: r.stats.reasoning, refused: r.stats.mandatoryRefused });
  check("D1 the near-empty first reading was not accepted: page read again (1 retry) and recovered", r.events.filter((e) => e.type === "PAGE_READING_INCOMPLETE").length === 1 && r.pages.every((p) => p.status === "DONE"), r.events.filter((e) => e.type === "PAGE_READING_INCOMPLETE").map((e) => e.message));
  check("D1 all 7 numbers extracted", JSON.stringify(r.numbers) === "[1,2,3,4,5,6,7]", r.numbers);
  const retry = r.calls.filter((c) => c.stage === "extract-retry-incomplete");
  check("D1 the retry is recorded (model, cost, ok) like every request", retry.length === 1 && retry[0].model === "mockreason/mandatory" && (retry[0].costInr ?? 0) > 0 && retry[0].ok, retry.map((c) => [c.model, c.costInr, c.ok]));
  check("D1 the degenerate reading itself is recorded too (3 extract requests: 2 pages + 1 retry)", r.calls.length === 3, r.calls.map((c) => [c.stage, c.ok]));

  // D2 — stays near-empty → page to review, nothing saved from it.
  r = await runPaper(actor, exam.id, "mockreason/mandatory", { scriptMarker: { "mockreason/mandatory": { "3": ["degenerate", "degenerate"] } } }, "review");
  const p1 = r.pages.find((p) => p.pageNumber === 1);
  check("D2 still incomplete after 2 readings → page FAILED (review) with the reason", p1?.status === "FAILED" && /Incomplete reading after 2 attempts/.test(p1.errorMessage ?? ""), [p1?.status, p1?.errorMessage]);
  check("D2 nothing from the near-empty readings was saved (Q1–3 absent, Q4–7 from page 2 kept)", JSON.stringify(r.numbers) === "[4,5,6,7]", r.numbers);
  check("D2 bounded: exactly 2 attempts on that page, both recorded", r.calls.filter((c) => c.pageId === p1?.id).length === 2, r.calls.map((c) => [c.stage, c.pageId === p1?.id]));
  check("D2 final event says it was sent to review", r.events.some((e) => e.type === "PAGE_READING_INCOMPLETE" && /sent to review/.test(e.message)));

  // D3 — a reading with no questions mid-paper → number gap → page read once more → recovered.
  r = await runPaper(actor, exam.id, "mockreason/mandatory", { scriptMarker: { "mockreason/mandatory": { "3": ["zero"] } } }, "gap");
  check("D3 numbers 1–3 missing before page 2 → page 1 read again (PAGE_NUMBERS_MISSING) → all 7 found", r.events.some((e) => e.type === "PAGE_NUMBERS_MISSING") && JSON.stringify(r.numbers) === "[1,2,3,4,5,6,7]", { n: r.numbers, ev: r.events.filter((e) => e.type === "PAGE_NUMBERS_MISSING").map((e) => e.message) });
  check("D3 the gap re-read is bounded (page 1 read twice, page 2 once)", r.calls.length === 3, r.calls.length);

  // D4 — still missing after the second reading → review.
  r = await runPaper(actor, exam.id, "mockreason/mandatory", { scriptMarker: { "mockreason/mandatory": { "3": ["zero", "zero"] } } }, "gap-review");
  const g1 = r.pages.find((p) => p.pageNumber === 1);
  check("D4 numbers still missing after 2 readings → page FAILED (review) naming them", g1?.status === "FAILED" && /1, 2, 3/.test(g1.errorMessage ?? ""), [g1?.status, g1?.errorMessage]);

  // D5 — catalog does not know the model is mandatory → provider refuses "none" once (₹0) → sent without an effort word.
  r = await runPaper(actor, exam.id, "mockreason/hidden", {}, "hidden");
  check("D5 provider refused effort none (₹0), the request was sent again without it, every page read", (r.stats.mandatoryRefused ?? 0) >= 1 && JSON.stringify(r.numbers) === "[1,2,3,4,5,6,7]", { refused: r.stats.mandatoryRefused, n: r.numbers });
  check("D5 a refused request is never charged", r.calls.filter((c) => !c.ok).every((c) => (c.costInr ?? 0) === 0), r.calls.map((c) => [c.ok, c.costInr]));

  // D5b — a model with a normal and a 1.8× priority route is priced (and capped) at the normal route.
  {
    await mock("/__mock/config", { reasonModels: true });
    const s = normalizeImporterSettings(await getImporterSettings());
    const { refreshRoutes } = await import("@/lib/ai-import/routes");
    await refreshRoutes(MODELS);
    const plan = await computeModelPlan({ ...s, importerModels: MODELS, selection: { mode: "manual" }, models: { ...s.models, extract: "mocktier/reader" } }, { refresh: false });
    const pr = plan.tasks.extract.price;
    check("priority tier left out: the plan's price is the normal route's (not 1.8×), so max_price excludes the priority route", !!pr && Math.abs(pr.completion - 0.0000003) < 1e-12 && Math.abs(pr.prompt - 0.00000005) < 1e-12 && !(plan.tasks.extract.routes ?? []).some((r: string) => /priority/.test(r)), { price: pr, routes: plan.tasks.extract.routes });
  }

  // D6 — Anthropic-like route: the json_schema is accepted (≤ 16 unions).
  r = await runPaper(actor, exam.id, "mockanthropic/reader", {}, "anthropic");
  check("D6 structured output sent as json_schema and accepted by the 16-union route; all 7 read", !r.stats.schemaRefused && (r.stats.responseFormat as (string | null)[]).includes("json_schema") && JSON.stringify(r.numbers) === "[1,2,3,4,5,6,7]", { refused: r.stats.schemaRefused, rf: r.stats.responseFormat, n: r.numbers });
}

// ---- E ----------------------------------------------------------------------------------------------------------
async function partE(actor: string) {
  section("E. Provider errors, malformed / partial answers, rate limits, spending limits, parallel calls");
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: { startsWith: "P2-" } }, orderBy: { createdAt: "desc" } });
  const jobId = await createJob({ actorId: actor, title: `P2 calls ${Date.now().toString(36)}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2022, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: "PROCESSING", budgetInr: CONFIRM_ANY } });
  const settings = normalizeImporterSettings(await getImporterSettings());
  const plan = await computeModelPlan({ ...settings, models: { ...settings.models, extract: "mockvision/reader" } }, { refresh: false });
  const call = (extra: Partial<Parameters<typeof importerAiCall>[0]> = {}) =>
    importerAiCall({ jobId, task: "extract", models: ["mockvision/reader"], override: plan.tasks.extract, noReplace: true, system: "You transcribe ONE page", content: [{ type: "text", text: "page" }], maxOutputTokens: 4000, settings: normalizeImporterSettings(settings), needsVision: false, stage: "phase2", ...extra });
  const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (e instanceof ImporterAiFailure ? `failure:${e.kind}` : e.name));

  await mock("/__mock/reset", {});
  await mock("/__mock/config", { script: { "mockvision/reader": ["malformed"] } });
  check("malformed JSON → a model-output failure (nothing parsed or saved)", (await kindOf(importerAiCallChecked({ jobId, task: "extract", models: ["mockvision/reader"], override: plan.tasks.extract, noReplace: true, system: "You transcribe ONE page", content: [{ type: "text", text: "page" }], maxOutputTokens: 4000, settings, needsVision: false, jsonSchema: "extract" }, (t) => parsePage(t)))).startsWith("failure"));
  await mock("/__mock/config", { script: { "mockvision/reader": ["length"] } });
  check("an answer cut off at the output limit (partial) → failure 'cut off', not accepted", (await kindOf(call())) === "failure:model_output");
  await mock("/__mock/config", { script: { "mockvision/reader": ["empty"] } });
  check("an empty answer → failure, not accepted", (await kindOf(call())) === "failure:model_output");
  await mock("/__mock/config", { script: {}, rateLimit: { "mockvision/reader": 1 } });
  const rl = await kindOf(call());
  check("rate limit (429) without the retry option → a rate-limit failure, never a silent success", rl === "failure:rate_limited", rl);
  await mock("/__mock/config", { rateLimit: {}, badRequest: { "mockvision/reader": "Provider returned error" } });
  const before = (await prisma.aiBudgetReservation.aggregate({ where: { requestKey: { startsWith: `qi:${jobId}:` } }, _sum: { settledInr: true } }))._sum.settledInr ?? 0;
  check("provider error (400) → bad-request failure", (await kindOf(call())) === "failure:bad_request");
  const afterErr = (await prisma.aiBudgetReservation.aggregate({ where: { requestKey: { startsWith: `qi:${jobId}:` } }, _sum: { settledInr: true } }))._sum.settledInr ?? 0;
  check("a refused request costs nothing (its reservation is released)", Math.abs(afterErr - before) < 1e-9, { before, afterErr });
  await mock("/__mock/config", { badRequest: {} });

  // Spending limit exhaustion: nothing is sent once the next worst case would pass the all-time limit.
  const ok1 = await call();
  const worst = (await prisma.aiBudgetReservation.findFirstOrThrow({ where: { requestKey: { startsWith: `qi:${jobId}:` }, status: "SETTLED", settledInr: { gt: 0 } }, orderBy: { createdAt: "desc" } })).reservedInr;
  const spentAll = (await prisma.aiBudgetReservation.aggregate({ where: { feature: { startsWith: "qimport_" } }, _sum: { settledInr: true } }))._sum.settledInr ?? 0;
  check("a normal call succeeds and reserves its worst case first", !!ok1.text && worst > 0, worst);
  await setSettings((s) => ({ ...s, budget: { ...s.budget, totalInr: Math.round((spentAll + worst * 0.5) * 100) / 100 } }), actor);
  const chatsBefore = (await mock("/__mock/stats")).chat;
  const exhausted = await kindOf(call({ settings: normalizeImporterSettings(await getImporterSettings()) }));
  check("all-time limit reached → ImporterBudgetError and NOTHING sent", exhausted === "ImporterBudgetError" && (await mock("/__mock/stats")).chat === chatsBefore, { exhausted });

  // Parallel calls cannot pass the limit together (one advisory lock around every reservation).
  const room = 3.5;
  await setSettings((s) => ({ ...s, budget: { ...s.budget, totalInr: Math.floor((spentAll + worst * room) * 100) / 100 } }), actor);
  await mock("/__mock/config", { chatDelayMs: 400 });
  const chats0 = (await mock("/__mock/stats")).chat;
  const s2 = normalizeImporterSettings(await getImporterSettings());
  const results = await Promise.all(Array.from({ length: 10 }, () => kindOf(call({ settings: s2 }))));
  const sent = (await mock("/__mock/stats")).chat - chats0;
  const total = (await prisma.aiBudgetReservation.aggregate({ where: { feature: { startsWith: "qimport_" } }, _sum: { settledInr: true, reservedInr: true } }))._sum;
  const st = await mock("/__mock/stats");
  // Each request reserves its worst case under one lock and settles at its (smaller) actual cost, which frees room:
  // so more than 3 may be sent over time, but never more than 3 worst cases at once, and refused ones are never sent.
  check(`10 parallel calls with room for ${room} worst cases: never more than 3 in flight at once; every refused call was never sent`, st.maxInflight <= 3 && results.filter((x) => x === "ok").length === sent && results.filter((x) => x === "ImporterBudgetError").length === 10 - sent && sent < 10, { sent, maxInflight: st.maxInflight, results });
  check("recorded spend never passes the all-time limit", (total.settledInr ?? 0) <= s2.budget.totalInr + 1e-6, { spent: total.settledInr, cap: s2.budget.totalInr });
  await mock("/__mock/config", { chatDelayMs: 0 });

  section("E2. The all-time limit is configurable (no fixed ₹200 in code)");
  check(`default stays ₹${DEFAULT_TOTAL_INR} (a stored ₹200 is unchanged)`, normalizeImporterSettings({}).budget.totalInr === 200 && normalizeImporterSettings({ budget: { totalInr: 200 } }).budget.totalInr === 200);
  check("₹600 can be set and is kept", normalizeImporterSettings({ budget: { totalInr: 600 } }).budget.totalInr === 600);
  check(`above the technical ceiling (₹${PILOT_LIMITS.totalInr}) it is clamped`, normalizeImporterSettings({ budget: { totalInr: 250_000 } }).budget.totalInr === PILOT_LIMITS.totalInr);
  check("the monthly bound stays ₹1,500 (owner decision)", normalizeImporterSettings({ budget: { monthlyInr: 5000 } }).budget.monthlyInr === 1500);
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: "CANCELLED" } });
}

async function main() {
  partA();
  partB();
  partC();
  if (!FX) throw new Error("fixture directory missing");
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  await partD(admin.id);
  await partE(admin.id);
  section("Safety");
  check("no request left the machine (only the loopback mock)", blockedHosts.size === 0, [...blockedHosts]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
