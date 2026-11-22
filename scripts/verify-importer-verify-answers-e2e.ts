/**
 * Verify Answers end to end (scratch DB mts_va only, loopback OpenRouter mock, synthetic 8-question paper, no real AI).
 *   node scripts/mock-openrouter-vision.mjs 3571 /root/mts-scratch/va/mock-vision.json &   then
 *   DATABASE_URL=…/mts_va PG_POOL_MAX=3 AI_IMPORT_DISABLE_KICK=1 OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3571 FX_TEST_BASE_URL=http://127.0.0.1:3571 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-verify-answers-e2e.ts
 */
import { prisma } from "@/lib/prisma";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import { runWorker } from "@/lib/ai-import/worker";
import { saveOpenAiConfig } from "@/lib/openai-config";
import { requestVerifyAnswers, stopVerifyAnswers, verifyAnswersPreview, verifyAnswersReport } from "@/lib/ai-import/verify-answers-run";

if (!/\/mts_va(\?|$)/.test(process.env.DATABASE_URL ?? "") || !process.env.OPENROUTER_TEST_BASE_URL) {
  console.error("Refusing: needs DATABASE_URL = scratch mts_va and OPENROUTER_TEST_BASE_URL (loopback mock).");
  process.exit(2);
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new Error(`test network guard: ${host} refused`);
  return realFetch(input, init);
}) as typeof fetch;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const MOCK = process.env.OPENROUTER_TEST_BASE_URL;
const chats = async () => ((await (await fetch(`${MOCK}/__mock/stats`)).json()) as { chat: number }).chat;

// n, stem marker (mock's independent answer), saved answer, key value(s)
const PAPER: [number, string, string[], string[]][] = [
  [1, "MOCKANS=B", ["B"], ["B"]], // CONFIRMED (AI agrees)
  [2, "MOCKANS=C", ["B"], ["B"]], // AI_DISAGREES — official B kept
  [3, "MOCKANS=A", ["A"], []], // MISSING (no key)
  [4, "MOCKANS=D", ["A"], ["D"]], // INCORRECT_MAPPING
  [5, "MOCKANS=A", ["A"], ["A", "C"]], // DUPLICATE (conflicting key entries)
  [6, "MOCKANS=A", [], ["X"]], // WITHDRAWN
  [7, "MOCKANS=DEFECTIVE", ["C"], ["C"]], // AI_DISAGREES (defective)
  [8, "MOCKBAD", ["D"], ["D"]], // AI output unusable → failed, still CONFIRMED by key
];

async function main() {
  await saveOpenRouterKey(`sk-or-v1-mock${"v".repeat(40)}-valid`, "script");
  await testOpenRouterConnection();
  await setOpenRouterEnabled(true);
  await syncCatalog();
  await prisma.aiModel.updateMany({ where: { id: { startsWith: "mock" } }, data: { approved: true } });
  const role = await prisma.role.upsert({ where: { name: "FULL_ADMIN" }, update: {}, create: { name: "FULL_ADMIN" } });
  const admin = await prisma.adminUser.upsert({ where: { username: "va-admin" }, update: {}, create: { name: "VA Admin", username: "va-admin", passwordHash: "x", roleId: role.id } });
  const exam = await prisma.exam.upsert({ where: { code: "VASYN" }, update: {}, create: { name: "Synthetic VA Exam", code: "VASYN" } });
  const s = await getImporterSettings();
  await saveImporterSettings({ ...s, aiEnabled: true, selection: { mode: "manual" }, importerModels: ["mocktext/classifier", "mockvision/checker"], models: { ...s.models, classify: "mocktext/classifier" }, privacy: { dataCollection: "allow", zdr: false } }, admin.id);

  await prisma.aiImportJob.deleteMany({ where: { title: { startsWith: "VA-SYN" } } });
  const job = await prisma.aiImportJob.create({ data: { title: "VA-SYN paper", examId: exam.id, createdById: admin.id, budgetInr: 0, status: "NEEDS_REVIEW" } });
  const paper = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "syn.md", ext: "md", declaredBytes: 1, uploadedById: admin.id, role: "PAPER" } });
  const key = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "syn-key.md", ext: "md", declaredBytes: 1, uploadedById: admin.id, role: "ANSWER_KEY" } });
  for (const [n, marker, saved, keys] of PAPER) {
    const data = { section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem: `Synthetic question ${n}: which drug is first-line for condition ${n}? ${marker}`, options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `Drug ${l}${n}` })), printedAnswer: [], contentFormat: "PLAIN", confidence: 1, unreadable: [], figures: [] };
    const q = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: paper.id, sourceKey: `p1-${n}`, sourceLabel: String(n), sourceNumber: n, orderIndex: n, data, questionType: "SINGLE_CORRECT", finalAnswer: saved } });
    for (const rawValue of keys) await prisma.aiImportKeyEntry.create({ data: { jobId: job.id, keyFileId: key.id, sourceNumber: n, rawValue, matchedQuestionId: q.id, page: 1 } });
  }

  console.log("\n=== price before anything is sent");
  const before = await chats();
  const pv = await verifyAnswersPreview(job.id, "mocktext/classifier");
  check("preview: 8 questions, 8 to ask, model mocktext/classifier", pv.questions === 8 && pv.toAsk === 8 && pv.model === "mocktext/classifier", pv);
  check("preview: maximum ≥ estimate > 0", pv.maxInr >= pv.estimateInr && pv.estimateInr > 0, { e: pv.estimateInr, m: pv.maxInr });
  check("preview sends nothing", (await chats()) === before);
  const unconfirmed = await requestVerifyAnswers({ jobId: job.id, actorId: admin.id, model: "mocktext/classifier", confirmedMaxInr: null });
  check("unconfirmed → not started", !unconfirmed.started);
  const low = await requestVerifyAnswers({ jobId: job.id, actorId: admin.id, model: "mocktext/classifier", confirmedMaxInr: pv.maxInr / 10 });
  check("confirmed below the maximum → not started", !low.started && /price changed/.test(low.reason ?? ""));

  console.log("\n=== run");
  const r = await requestVerifyAnswers({ jobId: job.id, actorId: admin.id, model: "mocktext/classifier", confirmedMaxInr: pv.maxInr });
  check("confirmed → queued", r.started);
  const dup = await requestVerifyAnswers({ jobId: job.id, actorId: admin.id, model: "mocktext/classifier", confirmedMaxInr: pv.maxInr }).then(() => null, (e: Error) => e.message);
  check("second start while queued is refused (no duplicate run)", !!dup && /busy/.test(dup), dup);
  await runWorker(120_000);
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } });
  check("job back to NEEDS_REVIEW", j.status === "NEEDS_REVIEW", j.status);
  const rep = await verifyAnswersReport(job.id);
  const cat = Object.fromEntries(rep.rows.map((x) => [x.label, x.category]));
  const want = { Q1: "CONFIRMED", Q2: "AI_DISAGREES", Q3: "MISSING", Q4: "INCORRECT_MAPPING", Q5: "DUPLICATE", Q6: "WITHDRAWN", Q7: "AI_DISAGREES", Q8: "CONFIRMED" };
  check("question-wise categories", JSON.stringify(cat) === JSON.stringify(want), cat);
  check("state DONE, 1 failed request (Q8 non-JSON)", rep.state?.status === "DONE" && rep.state.failed.length === 1, rep.state && { s: rep.state.status, f: rep.state.failed });
  check("history has one run with counts", rep.history.length === 1 && rep.history[0].counts.AI_DISAGREES === 2, rep.history);
  check("actual cost recorded (≥ 0, ≤ confirmed max)", typeof rep.state?.actualInr === "number" && rep.state.actualInr <= pv.maxInr, rep.state?.actualInr);
  const q2 = await prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId: job.id, sourceNumber: 2 } });
  check("official/saved answer NOT changed by an AI disagreement", q2.finalAnswer.join() === "B" && q2.aiAnswer.length === 0 && !q2.approvedById, { f: q2.finalAnswer, ai: q2.aiAnswer });
  check("nothing published / imported", (await prisma.aiImportQuestion.count({ where: { jobId: job.id, questionId: { not: null } } })) === 0);
  const calls = await prisma.aiImportAiCall.findMany({ where: { jobId: job.id }, select: { inputTokens: true, outputTokens: true, costInr: true, model: true } });
  check("token usage logged per request", calls.length >= 7 && calls.every((c) => (c.inputTokens ?? 0) > 0), calls.slice(0, 2));

  console.log("\n=== resume / retry: only the failed question is asked again");
  const c0 = await chats();
  const pv2 = await verifyAnswersPreview(job.id, "mocktext/classifier");
  check("re-run asks only 1 (the failed one); 7 reused", pv2.toAsk === 1 && pv2.reused === 7, pv2);
  await requestVerifyAnswers({ jobId: job.id, actorId: admin.id, model: "mocktext/classifier", confirmedMaxInr: pv2.maxInr });
  await runWorker(60_000);
  check("re-run sent ≤ 2 requests (1 question + 1 retry)", (await chats()) - c0 <= 2, (await chats()) - c0);
  check("history has 2 runs", (await verifyAnswersReport(job.id)).history.length === 2);

  console.log("\n=== edit invalidates the stored AI answer");
  await prisma.aiImportQuestion.update({ where: { id: q2.id }, data: { editedData: { ...(q2.data as object), stem: "Synthetic question 2 edited MOCKANS=B" } } });
  const rep3 = await verifyAnswersReport(job.id);
  const r2 = rep3.rows.find((x) => x.label === "Q2")!;
  check("edited Q2: AI answer marked stale and not counted → CONFIRMED by key only", r2.aiStale && r2.category === "CONFIRMED", r2);

  console.log("\n=== key check only (₹0) and stop");
  const c1 = await chats();
  const k = await requestVerifyAnswers({ jobId: job.id, actorId: admin.id, model: null, confirmedMaxInr: 0, keyOnly: true });
  check("key-only starts without a price", k.started);
  await runWorker(60_000);
  check("key-only sent no request", (await chats()) === c1);
  await requestVerifyAnswers({ jobId: job.id, actorId: admin.id, model: "mockvision/checker", confirmedMaxInr: 1000 });
  await stopVerifyAnswers(job.id, admin.id);
  const st = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } });
  check("stop: job NEEDS_REVIEW, state STOPPED, nothing sent", st.status === "NEEDS_REVIEW" && (st.config as { verifyAnswers: { status: string } }).verifyAnswers.status === "STOPPED" && (await chats()) === c1);

  console.log("\n=== direct OpenAI route (loopback mock, OPENAI_TEST_BASE_URL)");
  if (!process.env.OPENAI_TEST_BASE_URL) check("OPENAI_TEST_BASE_URL set", false);
  const OAI = process.env.OPENAI_TEST_BASE_URL!;
  await fetch(`${OAI}/__mock/reset`);
  const DM = "openai/gpt-mock-mini";
  const model = { name: "GPT mock mini", vendor: "openai", contextLength: 128000, maxCompletionTokens: 16000, inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["max_tokens", "response_format", "structured_outputs", "reasoning"], promptPrice: 0.0000004, completionPrice: 0.0000016, pricingRaw: { prompt: "0.0000004", completion: "0.0000016", input_cache_read: "0.0000001" }, approved: true, disabled: false, missingSince: null, lastSyncedAt: new Date() };
  await prisma.aiModel.upsert({ where: { id: DM }, update: model, create: { id: DM, ...model } });
  await saveOpenAiConfig({ apiKey: "sk-mock-openai-0123456789abcdef", enabled: true });
  const s2 = await getImporterSettings();
  await saveImporterSettings({ ...s2, importerModels: [...s2.importerModels, DM], openaiDirect: true, privacy: { dataCollection: "deny", zdr: true } }, admin.id);
  // As a confirmed job: its settings frozen at confirmation (ZDR off here), so the stricter-privacy rule allows direct.
  const job2 = await prisma.aiImportJob.create({ data: { title: "VA-SYN direct", examId: exam.id, createdById: admin.id, budgetInr: 0, status: "NEEDS_REVIEW", config: { ...s2, privacy: { dataCollection: "deny", zdr: false } } as never } });
  const p2 = await prisma.aiImportFile.create({ data: { jobId: job2.id, originalName: "syn2.md", ext: "md", declaredBytes: 1, uploadedById: admin.id, role: "PAPER" } });
  const k2 = await prisma.aiImportFile.create({ data: { jobId: job2.id, originalName: "syn2-key.md", ext: "md", declaredBytes: 1, uploadedById: admin.id, role: "ANSWER_KEY" } });
  for (const [n, marker] of [[1, "MOCKANS=B"], [2, "MOCKANS=C"], [3, "MOCKANS=B"]] as const) {
    const data = { section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem: `Synthetic direct question ${n} about a long clinical scenario. ${marker}`, options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `Option ${l}${n}` })), printedAnswer: [], contentFormat: "PLAIN", confidence: 1, unreadable: [], figures: [] };
    const q = await prisma.aiImportQuestion.create({ data: { jobId: job2.id, fileId: p2.id, sourceKey: `d-${n}`, sourceLabel: String(n), sourceNumber: n, orderIndex: n, data, questionType: "SINGLE_CORRECT", finalAnswer: ["B"] } });
    await prisma.aiImportKeyEntry.create({ data: { jobId: job2.id, keyFileId: k2.id, sourceNumber: n, rawValue: "B", matchedQuestionId: q.id, page: 1 } });
  }
  const zdrOn = await verifyAnswersPreview(job2.id, DM);
  const zc = zdrOn.candidates.find((c) => c.id === DM);
  check("ZDR required → OpenAI not used directly (no direct route offered)", !zc?.eligible, zc);
  await saveImporterSettings({ ...(await getImporterSettings()), privacy: { dataCollection: "deny", zdr: false } }, admin.id);
  const pd = await verifyAnswersPreview(job2.id, DM);
  check("ZDR off + key saved → openai/gpt-mock-mini eligible via OpenAI (direct), priced before sending", pd.model === DM && pd.maxInr > 0 && pd.toAsk === 3, pd);
  const oaiBefore = ((await (await fetch(`${OAI}/__mock/stats`)).json()) as { chat: number }).chat;
  const orBefore = await chats();
  await requestVerifyAnswers({ jobId: job2.id, actorId: admin.id, model: DM, confirmedMaxInr: pd.maxInr });
  await runWorker(60_000);
  const st2 = (await (await fetch(`${OAI}/__mock/stats`)).json()) as { chat: number; auth: number; bodies: { model: string; max_completion_tokens?: number; max_tokens?: number; temperature?: number; response_format: string | null; reasoning_effort?: string }[] };
  check("3 requests went to OpenAI with the key, none to OpenRouter", st2.chat - oaiBefore === 3 && st2.auth === 3 && (await chats()) === orBefore, { oai: st2.chat - oaiBefore, or: (await chats()) - orBefore });
  check("request shape: model name without prefix, max_completion_tokens, no max_tokens / temperature", st2.bodies.every((b) => b.model === "gpt-mock-mini" && (b.max_completion_tokens ?? 0) > 0 && b.max_tokens === undefined && b.temperature === undefined), st2.bodies[0]);
  const rep2 = await verifyAnswersReport(job2.id);
  check("direct results: Q1 CONFIRMED, Q2 AI_DISAGREES, Q3 CONFIRMED", rep2.rows.map((r) => r.category).join() === "CONFIRMED,AI_DISAGREES,CONFIRMED", rep2.rows.map((r) => r.category));
  const calls2 = await prisma.aiImportAiCall.findMany({ where: { jobId: job2.id }, orderBy: { createdAt: "asc" } });
  check("log: provider openai, tokens + cached tokens recorded", calls2.length === 3 && calls2.every((c) => c.provider === "openai" && (c.inputTokens ?? 0) > 0 && c.outputTokens === 20) && calls2.some((c) => (c.cachedTokens ?? 0) > 0), calls2.map((c) => [c.provider, c.inputTokens, c.cachedTokens]));
  const cc = calls2.find((c) => (c.cachedTokens ?? 0) > 0)!;
  const expectUsd = (cc.inputTokens! - cc.cachedTokens!) * 0.0000004 + cc.cachedTokens! * 0.0000001 + 20 * 0.0000016;
  check("actual cost = tokens × catalogue price (cached input at the cached rate)", Math.abs((cc.costUsd ?? -1) - expectUsd) < 1e-12 && cc.costStatus === "actual", { got: cc.costUsd, expectUsd });
  const j2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job2.id } });
  check("job spend settled from the direct calls (≤ confirmed max)", j2.spentInr > 0 && j2.spentInr <= pd.maxInr, { spent: j2.spentInr, max: pd.maxInr });
  const keyRow = await prisma.setting.findUnique({ where: { key: "api.openai" } });
  check("OpenAI key stored encrypted (never plain in the DB) and never in the call log", !JSON.stringify(keyRow?.value).includes("sk-mock-openai-0123456789abcdef") && !JSON.stringify(calls2).includes("sk-mock-openai"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
