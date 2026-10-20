/**
 * AI Question Importer — job budget regression suite (scratch DB, synthetic files, the loopback mock
 * OpenRouter only; never real AI, never production). Same environment as scripts/verify-ai-import-v2.ts:
 *
 *   DATABASE_URL=<scratch> STORAGE_DIR=… IMPORT_STAGING_DIR=… AI_IMPORT_VAULT_DIR=… AI_IMPORT_DISABLE_KICK=1 \
 *   OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3531 FX_TEST_BASE_URL=http://127.0.0.1:3531 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-budget.ts /tmp/aifx
 *
 * The job page checks a budget with lib/ai-import/budget-check.ts before it lets Confirm / Resume be
 * clicked. This suite proves that check agrees with the server (confirmJob / resumeJob) for every case,
 * that a refused budget changes nothing and sends no AI request, and that stale estimates cannot bypass
 * the server.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { saveImporterSettings, getImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, resumeJob } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { remainingPilotBudget } from "@/lib/ai-import/job-view";
import { confirmBudgetCheck, parseBudget, resumeBudgetCheck, type BudgetLimits } from "@/lib/ai-import/budget-check";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import type { CostEstimate } from "@/lib/ai-import/estimate";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !process.env.OPENROUTER_TEST_BASE_URL) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR and OPENROUTER_TEST_BASE_URL to scratch values.");
  process.exit(2);
}
const FX = process.argv[2];
const MOCK = process.env.OPENROUTER_TEST_BASE_URL!;

// Every HTTP request of this process must go to the loopback mock (no real AI provider, ever).
const requestHosts = new Set<string>();
const blockedHosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
  requestHosts.add(host);
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
async function serverError(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const mockChats = async () => ((await (await fetch(`${MOCK}/__mock/stats`)).json()) as { chat: number }).chat;

const created = { jobs: [] as string[], reservations: [] as string[] };
const restore: { importer: unknown; openrouter: unknown } = { importer: null, openrouter: null };

async function upload(actor: string, jobId: string, file: string) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role: AiImportFileRole.PAPER, paperFileId: null });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  await completeFile({ fileId, actorId: actor });
}
async function setSettings(patch: (s: ImporterSettings) => ImporterSettings, actor: string) {
  await saveImporterSettings(patch(normalizeImporterSettings(await getImporterSettings())), actor);
}
/** Exactly what the job page receives (jobs/[jobId]/page.tsx). */
async function pageLimits(): Promise<BudgetLimits> {
  const s = await getImporterSettings();
  const p = await remainingPilotBudget(s);
  return { maxJobInr: s.budget.maxJobInr, maxRequestInr: s.budget.maxRequestInr, totalCapInr: p.totalCapInr, monthCapInr: p.monthCapInr, allTimeLeftInr: p.totalCapInr - p.allUsedInr, monthLeftInr: p.monthCapInr - p.monthUsedInr };
}
async function spend(inr: number, month = true) {
  const id = `budget-fx-${Date.now().toString(36)}-${created.reservations.length}`;
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600_000).toISOString();
  await prisma.aiBudgetReservation.create({ data: { id, requestKey: `qi:budget-fx:${id}`, feature: "qimport_extract", reservedInr: inr, settledInr: inr, costKnown: true, status: "SETTLED", istDay: ist.slice(0, 10), istMonth: month ? ist.slice(0, 7) : "2000-01", settledAt: now } });
  created.reservations.push(id);
}
const fingerprint = async (id: string) => JSON.stringify(await prisma.aiImportJob.findUniqueOrThrow({ where: { id }, select: { status: true, budgetInr: true, estCostInr: true, estimate: true, confirmedAt: true, config: true, updatedAt: true, spentInr: true } }));

async function main() {
  const actor = (await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } })).id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const anatomy = await prisma.subject.findFirstOrThrow({ where: { name: "Anatomy" }, select: { id: true } });
  restore.importer = (await prisma.setting.findUnique({ where: { key: "ai.importer" } }))?.value ?? null;
  restore.openrouter = (await prisma.setting.findUnique({ where: { key: "api.openrouter" } }))?.value ?? null;
  await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });

  // ------------------------------------------------------------------ 1
  section("1. Budget field parsing (pure)");
  check("'' → enter a budget", parseBudget("").error?.startsWith("Enter a job budget") === true);
  check("'1..5', '1.234', '-1', '1e3', ' . ' → refused with the format reason", ["1..5", "1.234", "-1", "1e3", " . "].every((v) => parseBudget(v).value === null && /up to 2 decimals/.test(parseBudget(v).error ?? "")));
  check("'8', '7.5', '0.01', '0' → parsed", parseBudget("8").value === 8 && parseBudget("7.5").value === 7.5 && parseBudget("0.01").value === 0.01 && parseBudget("0").value === 0);

  // ------------------------------------------------------------------ 2
  section("2. Confirm: the page's check agrees with the server for every budget");
  await saveOpenRouterKey(`sk-or-v1-mock${"b".repeat(40)}-valid`, "script");
  await prisma.setting.update({ where: { key: "api.openrouter" }, data: { value: { ...((await prisma.setting.findUniqueOrThrow({ where: { key: "api.openrouter" } })).value as object), lastTest: null } } });
  check("OpenRouter (mock) connection test", (await testOpenRouterConnection()).ok);
  await setOpenRouterEnabled(true);
  await syncCatalog();
  const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
  await setSettings((s) => ({ ...s, aiEnabled: true, selection: { mode: "manual" }, importerModels: mockIds, models: { extract: "mockvision/reader", extractFallbacks: [], verify: "mockvision/checker", classify: "mocktext/classifier", key: null }, privacy: { dataCollection: "deny", zdr: false } }), actor);
  const settingsBefore = JSON.stringify((await prisma.setting.findUniqueOrThrow({ where: { key: "ai.importer" } })).value);

  const job = await createJob({ actorId: actor, title: "BUDGET FX scanned", examId: exam.id, paperType: AiImportPaperType.SINGLE_SUBJECT, subjectId: anatomy.id, budgetInr: 8, year: 2024, paperCode: null, previousYearPaperId: null, expectedQuestions: 3 });
  created.jobs.push(job);
  await upload(actor, job, "scanned.pdf");
  await requestAnalysis(job, actor);
  await runWorker(60_000);
  const row = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job } });
  const est = (row.analysis as unknown as JobAnalysis).estimate;
  check("scanned synthetic paper analyzed: awaiting confirmation with a priced estimate", row.status === "AWAITING_CONFIRMATION" && (est.totalInr ?? 0) > 0 && (est.maxInr ?? 0) > (est.totalInr ?? 0), { s: row.status, t: est.totalInr, m: est.maxInr });
  const confirm = (budgetInr: number) => () => confirmJob({ jobId: job, actorId: actor, examId: exam.id, paperType: AiImportPaperType.SINGLE_SUBJECT, subjectId: anatomy.id, year: 2024, paperCode: null, previousYearPaperId: null, budgetInr, expectedQuestions: 3 });

  const chats0 = await mockChats();
  const before = await fingerprint(job);
  let limits = await pageLimits();
  const max = est.maxInr!;
  const raws = ["0", "0.01", (Math.floor(max * 100) / 100 - 0.01).toFixed(2), (Math.floor(max * 100 - 1e-9) / 100).toFixed(2), "8.01", "10", "1..5", ""];
  for (const raw of raws) {
    const c = confirmBudgetCheck({ raw, aiEnabled: true, estimate: est, limits });
    const err = await serverError(confirm(c.value ?? Number(raw)));
    check(`budget "${raw}": page blocks Confirm and the server refuses too`, c.problems.length > 0 && err !== null, { problems: c.problems, server: err });
  }
  const minOk = confirmBudgetCheck({ raw: "1", aiEnabled: true, estimate: est, limits }).range?.minInr ?? NaN;
  check("accepted range starts at the maximum rounded UP to whole paise", minOk === Math.ceil(max * 100 - 1e-9) / 100 && minOk >= max, { minOk, max });
  check("…the paisa below it is refused by the page", confirmBudgetCheck({ raw: (minOk - 0.01).toFixed(2), aiEnabled: true, estimate: est, limits }).problems.length > 0);
  check("refused confirms changed nothing on the job", (await fingerprint(job)) === before);
  check("refused confirms sent no AI request", (await mockChats()) === chats0);
  check("refused confirms reserved no budget", (await prisma.aiBudgetReservation.count({ where: { requestKey: { startsWith: `qi:${job}:` } } })) === 0);

  // All-time budget almost used up: no budget can start the job; the page says so and the server agrees.
  await spend(10 - max / 2, false);
  limits = await pageLimits();
  let c = confirmBudgetCheck({ raw: "8", aiEnabled: true, estimate: est, limits });
  let err = await serverError(confirm(8));
  check("all-time budget left below the maximum: page shows 'cannot fix by budget', server refuses (all-time)", !!c.impossible && /all-time budget/.test(c.impossible) && c.range === null && /all-time budget/.test(err ?? ""), { c, err });
  await prisma.aiBudgetReservation.deleteMany({ where: { id: { in: created.reservations } } });

  // This month's budget lowered below the maximum (and the all-time one untouched).
  await setSettings((s) => ({ ...s, budget: { ...s.budget, monthlyInr: Math.max(0.01, Math.floor(max * 50) / 100) } }), actor);
  limits = await pageLimits();
  c = confirmBudgetCheck({ raw: "8", aiEnabled: true, estimate: est, limits });
  err = await serverError(confirm(8));
  check("monthly budget left below the maximum: page and server both refuse (month)", !!c.impossible && /this month's importer budget/.test(c.impossible) && /this month's importer budget/.test(err ?? ""), { c, err });
  await setSettings((s) => ({ ...s, budget: { ...s.budget, monthlyInr: 10 } }), actor);

  // Hard per-job limit lowered below the maximum: every budget is refused.
  await setSettings((s) => ({ ...s, budget: { ...s.budget, maxRequestInr: Math.min(s.budget.maxRequestInr, Math.max(0.01, Math.floor(max * 50) / 100)), maxJobInr: Math.max(0.01, Math.floor(max * 50) / 100), defaultJobCapInr: Math.max(0.01, Math.floor(max * 50) / 100) } }), actor);
  limits = await pageLimits();
  c = confirmBudgetCheck({ raw: String(limits.maxJobInr), aiEnabled: true, estimate: est, limits });
  err = await serverError(confirm(limits.maxJobInr));
  check("hard per-job limit below the maximum: page shows it cannot be fixed by budget; server refuses", !!c.impossible && /hard limit per job/.test(c.impossible) && err !== null, { c, err });
  await prisma.setting.update({ where: { key: "ai.importer" }, data: { value: JSON.parse(settingsBefore) } });
  limits = await pageLimits();

  // A stale (too cheap) estimate on the job cannot get a too-small budget past the server.
  const stale = { ...(row.analysis as object), estimate: { ...est, totalInr: 0.001, maxInr: 0.002, lines: est.lines.map((l) => ({ ...l, inr: 0.0001, maxInr: 0.0002 })) } as CostEstimate };
  await prisma.aiImportJob.update({ where: { id: job }, data: { analysis: stale as never } });
  c = confirmBudgetCheck({ raw: "0.01", aiEnabled: true, estimate: stale.estimate, limits });
  const before2 = await fingerprint(job);
  err = await serverError(confirm(0.01));
  check("stale estimate: the page would allow ₹0.01, the server re-prices and refuses it", c.problems.length === 0 && /conservative maximum|estimated AI cost/.test(err ?? ""), { c, err });
  check("…and the job is unchanged, no AI request", (await fingerprint(job)) === before2 && (await mockChats()) === chats0);
  await prisma.aiImportJob.update({ where: { id: job }, data: { analysis: row.analysis as never } });

  // Paid AI off: no AI call, so ₹0 is a valid budget on both sides.
  await setSettings((s) => ({ ...s, aiEnabled: false }), actor);
  c = confirmBudgetCheck({ raw: "0", aiEnabled: false, estimate: est, limits });
  check("paid AI off: ₹0 is accepted by the page (no AI call will be made)", c.problems.length === 0, c);
  await prisma.setting.update({ where: { key: "ai.importer" }, data: { value: JSON.parse(settingsBefore) } });

  // The accepted budget starts the job; the global settings never changed with the job budget.
  c = confirmBudgetCheck({ raw: minOk.toFixed(2), aiEnabled: true, estimate: est, limits });
  err = await serverError(confirm(c.value!));
  const after = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job } });
  check("the smallest accepted budget is accepted by the page AND the server; job queued with it", c.problems.length === 0 && err === null && after.status === "QUEUED" && after.budgetInr === minOk, { c, err, s: after.status, b: after.budgetInr });
  check("confirm itself sent no AI request (processing is the worker's job)", (await mockChats()) === chats0);
  check("changing the job budget never changed the importer's global settings or limits", JSON.stringify((await prisma.setting.findUniqueOrThrow({ where: { key: "ai.importer" } })).value) === settingsBefore);

  // ------------------------------------------------------------------ 3
  section("3. Resume with a budget: page check and server agree; refusals change nothing");
  const paused = await prisma.aiImportJob.create({ data: { title: "BUDGET FX paused", examId: exam.id, createdById: actor, budgetInr: 8, spentInr: 0.4, status: "PAUSED", pauseReason: "Paused by an administrator" } });
  created.jobs.push(paused.id);
  const resumeCase = async (raw: string, sent: number | null) => {
    const r = resumeBudgetCheck({ raw, currentInr: 8, spentInr: 0.4, maxJobInr: limits.maxJobInr, budgetPaused: false });
    const b = await fingerprint(paused.id);
    const e = await serverError(() => resumeJob(paused.id, actor, sent));
    return { r, e, unchanged: (await fingerprint(paused.id)) === b };
  };
  for (const [raw, sent] of [["", Number("")], ["abc".replace(/[^\d.]/g, ""), Number("")], ["1..5", Number("1..5")], ["0", 0], ["0.40", 0.4], ["8.01", 8.01]] as [string, number][]) {
    const { r, e, unchanged } = await resumeCase(raw, Number.isNaN(sent) ? NaN : sent);
    check(`resume with "${raw}": page blocks Resume; server refuses and nothing changes`, r.problems.length > 0 && e !== null && unchanged, { problems: r.problems, server: e });
  }
  const neg = await serverError(() => resumeJob(paused.id, actor, -1));
  check("resume with a negative budget is refused (never turned into ₹0)", /valid job budget/.test(neg ?? ""), neg);
  const r41 = resumeBudgetCheck({ raw: "0.41", currentInr: 8, spentInr: 0.4, maxJobInr: limits.maxJobInr, budgetPaused: false });
  check("resume: the smallest budget above the spend is ₹0.41 and is accepted by the page", r41.problems.length === 0 && Math.abs((r41.range?.minInr ?? 0) - 0.41) < 1e-9, r41);
  const e5 = await serverError(() => resumeJob(paused.id, actor, 5));
  const p5 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: paused.id } });
  check("resume with ₹5: accepted, queued with ₹5", e5 === null && p5.status === "QUEUED" && p5.budgetInr === 5, { e5, s: p5.status, b: p5.budgetInr });
  const capped = await prisma.aiImportJob.create({ data: { title: "BUDGET FX budget-paused", examId: exam.id, createdById: actor, budgetInr: 8, spentInr: 8, status: "PAUSED_BUDGET", pauseReason: "The job budget is reached" } });
  created.jobs.push(capped.id);
  const rc = resumeBudgetCheck({ raw: "8", currentInr: 8, spentInr: 8, maxJobInr: limits.maxJobInr, budgetPaused: true });
  const ec = await serverError(() => resumeJob(capped.id, actor, 8));
  check("budget-paused at the hard limit: page blocks Resume (no budget above the spend is allowed), server refuses", rc.problems.length > 0 && rc.range === null && /Raise the job budget/.test(ec ?? ""), { rc, ec });
  const rcNull = await serverError(() => resumeJob(capped.id, actor, null));
  check("…resume without a budget is refused the same way", /Raise the job budget/.test(rcNull ?? ""), rcNull);
  check("no AI request in the whole suite", (await mockChats()) === chats0);
}

async function cleanup() {
  await prisma.aiImportJob.deleteMany({ where: { id: { in: created.jobs } } });
  await prisma.aiBudgetReservation.deleteMany({ where: { OR: [{ id: { in: created.reservations } }, { feature: { startsWith: "qimport_" } }] } });
  await prisma.setting.deleteMany({ where: { key: "ai.importer.routes" } });
  if (restore.openrouter) await prisma.setting.upsert({ where: { key: "api.openrouter" }, create: { key: "api.openrouter", value: restore.openrouter as never }, update: { value: restore.openrouter as never } });
  else await prisma.setting.deleteMany({ where: { key: "api.openrouter" } });
  if (restore.importer) await prisma.setting.upsert({ where: { key: "ai.importer" }, create: { key: "ai.importer", value: restore.importer as never }, update: { value: restore.importer as never } });
  else await prisma.setting.deleteMany({ where: { key: "ai.importer" } });
}

main()
  .catch((e) => {
    fail++;
    console.error(e);
  })
  .finally(async () => {
    if (process.env.KEEP !== "1") await cleanup().catch((e) => console.error("cleanup failed", e));
    check(`network guard: every request went to the loopback mock (hosts: ${[...requestHosts].join(", ") || "none"})`, blockedHosts.size === 0, [...blockedHosts]);
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
