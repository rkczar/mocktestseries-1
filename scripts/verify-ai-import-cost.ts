/**
 * AI Question Importer — cost confirmation without job / monthly / all-time caps (owner decision 2026-10-20).
 *
 *   A. Spend summary (lib/ai-import/ledger.ts importerSpendSummary) from synthetic usage rows: this job's
 *      actual spend vs this month's importer spend, monthly spend above the former ₹10 cap, retries and
 *      refused requests counted once / not at all, other AI features excluded, unknown cost never ₹0.
 *   B. The cost panel (components/admin/ai-importer/cost-summary.tsx) rendered from those figures.
 *   C. Explicit confirmation of an estimate above the former ₹8 job cap; a stale confirmation is refused.
 *   D. Provider credit refusal (HTTP 402 from the loopback mock): nothing charged, the reason shown,
 *      Retry failed pages completes the job and every page is charged once.
 *
 * Scratch DB, scratch storage and the loopback OpenRouter mock only — no real AI request is possible
 * (network guard below). Removes its own jobs and usage rows.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-cost.ts <fixtures dir>
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, cancelJob, completeFile, confirmJob, createJob, putChunk, requestAnalysis, retryJob } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { importerSpendSummary, toPeriod } from "@/lib/ai-import/ledger";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { CostSummary } from "@/components/admin/ai-importer/cost-summary";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !process.env.OPENROUTER_TEST_BASE_URL) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR and OPENROUTER_TEST_BASE_URL to scratch values.");
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const near = (a: number | null | undefined, b: number, eps = 1e-6) => a !== null && a !== undefined && Math.abs(a - b) < eps;

const TAG = "costfx";
const jobs: string[] = [];

async function mockStats() {
  return (await (await fetch(`${MOCK}/__mock/stats`)).json()) as { chat: number };
}
async function mockConfig(c: Record<string, unknown>) {
  await fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) });
}
async function upload(actor: string, jobId: string, file: string) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role: AiImportFileRole.PAPER, paperFileId: null });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  await completeFile({ fileId, actorId: actor });
}
async function newJob(actor: string, examId: string, title: string) {
  const id = await createJob({ actorId: actor, title: `${title} ${TAG}`, examId, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null });
  jobs.push(id);
  return id;
}
const ctxOf = (j: { id: string; examId: string; paperType: AiImportPaperType; subjectId: string | null; year: number | null; paperCode: string | null; previousYearPaperId: string | null }, actorId: string) => ({ jobId: j.id, actorId, examId: j.examId, paperType: j.paperType, subjectId: j.subjectId, year: j.year, paperCode: j.paperCode, previousYearPaperId: j.previousYearPaperId });
/** The estimated maximum named in a refusal ("estimated maximum ₹X" / "estimated maximum now ₹X"). */
const maxIn = (msg: string | null) => Number(/estimated maximum (?:now )?₹(\d+(?:\.\d+)?)/.exec(msg ?? "")?.[1] ?? NaN);

async function cleanup() {
  await prisma.aiBudgetReservation.deleteMany({ where: { OR: [{ requestKey: { contains: TAG } }, ...jobs.map((id) => ({ requestKey: { startsWith: `qi:${id}:` } }))] } });
  if (jobs.length) await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs } } });
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  const now = new Date();
  const { istDay, istMonth } = istDayMonth(now);
  const old = new Date(now.getTime() - 40 * 86_400_000);
  const { istDay: oldDay, istMonth: oldMonth } = istDayMonth(old);

  try {
    // ------------------------------------------------------------------ A
    section("A. Spend summary: this job vs this month, AI Question Importer only");
    const baseline = await importerSpendSummary(null, now);
    const j1 = await prisma.aiImportJob.create({ data: { title: `Spend job 1 ${TAG}`, examId: exam.id, createdById: actor, budgetInr: 0 } });
    const j2 = await prisma.aiImportJob.create({ data: { title: `Spend job 2 ${TAG}`, examId: exam.id, createdById: actor, budgetInr: 0 } });
    const j3 = await prisma.aiImportJob.create({ data: { title: `Spend job 3 ${TAG}`, examId: exam.id, createdById: actor, budgetInr: 0 } });
    jobs.push(j1.id, j2.id, j3.id);
    const res = (key: string, feature: string, status: "SETTLED" | "RESERVED" | "RELEASED", reservedInr: number, settledInr: number | null, costKnown: boolean, day = istDay, month = istMonth) =>
      prisma.aiBudgetReservation.create({ data: { requestKey: key, feature, status, reservedInr, settledInr, costKnown, istDay: day, istMonth: month, settledAt: status === "RESERVED" ? null : new Date() } });
    // Job 1: a page read that failed before any charge (released), its retry (a new attempt key) charged ₹4.00,
    // a second page ₹0.50, one request still in flight.
    await res(`qi:${j1.id}:${TAG}-p1:1`, "qimport_extract", "RELEASED", 0.9, 0, true);
    await res(`qi:${j1.id}:${TAG}-p1:2`, "qimport_extract", "SETTLED", 0.9, 4.0, true);
    await res(`qi:${j1.id}:${TAG}-p2:1`, "qimport_verify", "SETTLED", 0.8, 0.5, true);
    await res(`qi:${j1.id}:${TAG}-p3:1`, "qimport_extract", "RESERVED", 0.3, null, false);
    // Job 2: ₹8.00 this month (above the former ₹8 job cap) and ₹3.00 in an earlier month.
    await res(`qi:${j2.id}:${TAG}-p1:1`, "qimport_extract", "SETTLED", 0.9, 8.0, true);
    await res(`qi:${j2.id}:${TAG}-old:1`, "qimport_extract", "SETTLED", 0.9, 3.0, true, oldDay, oldMonth);
    // Job 3: a request whose cost OpenRouter did not report.
    await res(`qi:${j3.id}:${TAG}-p1:1`, "qimport_extract", "SETTLED", 0.6, 0.6, false);
    // Other AI features this month: never part of the importer's spend.
    await res(`ask:${TAG}-1`, "ask_ai", "SETTLED", 60, 50, true);
    await res(`ig:${TAG}-1`, "ig_caption", "SETTLED", 25, 20, true);
    await res(`sol:${TAG}-1`, "ai_solution", "SETTLED", 15, 10, true);
    let dup = false;
    try {
      await res(`qi:${j1.id}:${TAG}-p1:2`, "qimport_extract", "SETTLED", 0.9, 4.0, true);
    } catch {
      dup = true;
    }
    check("a request attempt cannot be recorded twice (unique request key)", dup);

    const s1 = await importerSpendSummary(j1.id, now);
    check("job 1 actual = ₹4.50 (retry charged once, the refused attempt not counted)", near(s1.job?.actualInr, 4.5) && s1.job?.actualRequests === 2 && s1.job?.releasedRequests === 1, s1.job);
    check("job 1 in-flight request held apart (not in actual)", s1.job?.inflightRequests === 1 && near(s1.job?.inflightInr, 0.3), s1.job);
    check("this month's importer actual = +₹12.50 (above the former ₹10 monthly cap; the earlier month excluded)", near(s1.month.actualInr - baseline.month.actualInr, 12.5), { now: s1.month.actualInr, base: baseline.month.actualInr });
    check("…Ask AI, Instagram and AI Solutions spend (₹80) is not included", s1.month.actualInr - baseline.month.actualInr < 13);
    check("…this month's unknown-cost request counted as unknown, not as actual", s1.month.unknownRequests - baseline.month.unknownRequests === 1 && near(s1.month.unknownHeldInr - baseline.month.unknownHeldInr, 0.6));
    check("job 1 figure differs from the month figure (job vs importer month)", !near(s1.job?.actualInr, s1.month.actualInr));
    const s2 = await importerSpendSummary(j2.id, now);
    check("job 2 actual counts every month (₹11.00), the month figure only this month", near(s2.job?.actualInr, 11) && s2.istMonth === istMonth, s2.job);
    const s3 = await importerSpendSummary(j3.id, now);
    check("job 3: cost not reported → unknown with ₹0.60 held, actual not claimed", s3.job?.actualRequests === 0 && s3.job?.unknownRequests === 1 && near(s3.job?.unknownHeldInr, 0.6), s3.job);
    const s0 = await importerSpendSummary(null, now);
    check("no job asked → job figure null", s0.job === null);

    // ------------------------------------------------------------------ B
    section("B. Cost panel shows estimate, estimated maximum, job and month actual spend");
    // Rendered in a child process: react-dom/server is unavailable under this script's react-server condition.
    const RENDER = `const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server"); const { CostSummary } = await import(${JSON.stringify(path.resolve("components/admin/ai-importer/cost-summary.tsx"))}); process.stdout.write(renderToStaticMarkup(createElement(CostSummary, JSON.parse(process.env.COST_PROPS))));`;
    const render = (props: Parameters<typeof CostSummary>[0]) =>
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", RENDER], { env: { ...process.env, NODE_OPTIONS: "", COST_PROPS: JSON.stringify(props) }, encoding: "utf8" }).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    const month = toPeriod([{ status: "SETTLED", known: true, n: 3, reserved: 3, settled: 12.5 }]);
    const html1 = render({ estimateInr: 9.4, maxInr: 14.2, job: s1.job, month, istMonth: "2026-10", priced: true });
    check("four figures with their labels", /Estimated cost ₹9\.40/.test(html1) && /Estimated maximum ₹14\.20/.test(html1) && /This job's actual spend ₹4\.50/.test(html1) && /Importer spend in October 2026 ₹12\.50/.test(html1), html1);
    check("the maximum is labelled as an estimate; the final cost may differ", /an estimate: every request at its worst case/.test(html1) && /final cost may differ/.test(html1));
    check("in-flight requests are shown, not hidden", /1 in progress \(up to ₹0\.30\)/.test(html1), html1);
    check("no job / monthly / all-time cap or 'remaining' wording", !/remaining|budget left|all-time|hard limit|of ₹10/i.test(html1), html1);
    const html3 = render({ estimateInr: 1, maxInr: 2, job: s3.job, month, istMonth: "2026-10" });
    check("unreported cost → 'Unknown', never ₹0.00", /This job's actual spend Unknown/.test(html3) && /1 request with unknown cost \(up to ₹0\.60\)/.test(html3), html3);
    const html4 = render({ estimateInr: null, maxInr: null, job: null, month: toPeriod([]), istMonth: "2026-10", priced: false });
    const html5 = render({ estimateInr: 3.1, maxInr: 7.4, job: null, month, istMonth: "2026-10", breakdown: [{ label: "Page reading", calls: 12, inr: 2.6, maxInr: 6.2 }, { label: "Classification", calls: 1, inr: 0.5, maxInr: null }, { label: "Answer key", calls: 1, inr: null, maxInr: null }] });
    check("cost breakdown per step: requests, estimate and maximum; an unpriced step says so", /Page reading · 12 AI requests ₹2\.60 \(max ₹6\.20\)/.test(html5) && /Classification · 1 AI request ₹0\.50/.test(html5) && /Answer key · 1 AI request Unknown — not priced/.test(html5), html5);
    check("no breakdown passed → none shown", !/AI request/.test(html1));
    check("unpriced estimate → 'Unknown — not priced'; no AI request yet → ₹0.00 with that reason", /Estimated cost Unknown — not priced/.test(html4) && /Estimated maximum Unknown — not priced/.test(html4) && /₹0\.00 no AI request yet/.test(html4), html4);

    // ------------------------------------------------------------------ C
    section("C. Confirmation of an estimate above the former ₹8 job cap");
    // The loopback mock as the OpenRouter provider (a mock key; OPENROUTER_TEST_BASE_URL points at the mock).
    await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
    await testOpenRouterConnection();
    await setOpenRouterEnabled(true);
    await syncCatalog();
    const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
    const pilot = (s: ImporterSettings): ImporterSettings => ({
      ...s,
      aiEnabled: true,
      selection: { mode: "manual" },
      importerModels: mockIds,
      models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null },
      privacy: { dataCollection: "deny", zdr: true },
      budget: { ...s.budget, monthlyInr: 10, totalInr: 10, maxJobInr: 8, defaultJobCapInr: 8, maxRequestInr: 1, keyReserveUsd: 5, retryTransient: false, allowPricierFallback: false },
      limits: { ...s.limits, concurrency: 2 },
    });
    await saveImporterSettings(pilot(savedSettings), actor);
    await mockConfig({ keyLimitRemaining: 1000, failTask: {}, costMultiplier: 1 });
    const big = await newJob(actor, exam.id, "Large paper");
    await upload(actor, big, "scanned.pdf");
    await requestAnalysis(big, actor);
    await runWorker(120_000);
    // Make the analyzed paper 60× longer (same pages repeated): its estimate passes the former ₹8 job cap.
    const b0 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: big } });
    const an = b0.analysis as { files: { facts?: { pages: number; pagesDetail: unknown[] } }[] };
    for (const f of an.files) if (f.facts) {
      f.facts.pagesDetail = Array.from({ length: 60 }, () => f.facts!.pagesDetail).flat();
      f.facts.pages = f.facts.pagesDetail.length;
    }
    await prisma.aiImportJob.update({ where: { id: big }, data: { analysis: an as never } });
    const b1 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: big } });
    const chatsC = (await mockStats()).chat;
    const e1 = await errorOf(() => confirmJob({ ...ctxOf(b1, actor), confirmedMaxInr: null }));
    const shownMax = maxIn(e1);
    check("not confirmed → nothing starts; the refusal names the estimate and the estimated maximum", /Confirm the cost first: estimated ₹[\d.]+, estimated maximum ₹[\d.]+\. Nothing was started\./.test(e1 ?? ""), e1);
    check("…the estimated maximum is above the former ₹8 job cap (and ₹10 monthly cap)", shownMax > 10, { shownMax });
    const b2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: big } });
    check("…the refreshed estimate is stored on the job for the page to show", near((b2.estimate as { maxInr: number }).maxInr, shownMax, 0.006) && b2.status === "AWAITING_CONFIRMATION", { stored: (b2.estimate as { maxInr: number }).maxInr, shownMax });
    const e2 = await errorOf(() => confirmJob({ ...ctxOf(b1, actor), confirmedMaxInr: shownMax - 1 }));
    check("a confirmation below the freshly priced maximum is refused (the cost changed), nothing started", /The cost changed since it was shown/.test(e2 ?? "") && (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: big } })).status === "AWAITING_CONFIRMATION", e2);
    await confirmJob({ ...ctxOf(b1, actor), confirmedMaxInr: shownMax });
    const b3 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: big } });
    check(`confirming the displayed maximum (₹${shownMax.toFixed(2)}) starts the job; the confirmed maximum is recorded`, b3.status === "QUEUED" && near(b3.budgetInr, shownMax, 0.006), { s: b3.status, b: b3.budgetInr });
    check("…no AI request was sent by confirming", (await mockStats()).chat === chatsC);
    const ev = await prisma.aiImportEvent.findFirst({ where: { jobId: big, type: "CONFIRMED" }, orderBy: { createdAt: "desc" } });
    check("…the activity log records the confirmed cost", /Cost confirmed: estimated ₹[\d.]+, estimated maximum ₹[\d.]+/.test(ev?.message ?? ""), ev?.message);
    await cancelJob(big, actor);
    // Paid AI off: no cost to confirm, confirmation needs no figure.
    await saveImporterSettings({ ...pilot(savedSettings), aiEnabled: false }, actor);
    const off = await newJob(actor, exam.id, "AI off");
    await upload(actor, off, "scanned.pdf");
    await requestAnalysis(off, actor);
    await runWorker(120_000);
    const o1 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: off } });
    const eo = await errorOf(() => confirmJob({ ...ctxOf(o1, actor), confirmedMaxInr: null }));
    check("paid AI off: confirm needs no cost (₹0), job queued", eo === null && (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: off } })).status === "QUEUED", eo);
    await cancelJob(off, actor);

    // ------------------------------------------------------------------ D
    section("D. Provider credit refusal, then Retry failed pages");
    await saveImporterSettings(pilot(savedSettings), actor);
    const cr = await newJob(actor, exam.id, "Credit refusal");
    await upload(actor, cr, "scanned.pdf");
    await requestAnalysis(cr, actor);
    await runWorker(120_000);
    const c0 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: cr } });
    const maxC = (c0.estimate as { maxInr: number }).maxInr;
    await mockConfig({ failTask: { extract: [402, "Insufficient credits. Add more using https://openrouter.ai/credits"] } });
    await confirmJob({ ...ctxOf(c0, actor), confirmedMaxInr: maxC });
    await runWorker(180_000);
    const c1 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: cr } });
    const pages1 = await prisma.aiImportPage.findMany({ where: { jobId: cr } });
    const failed1 = pages1.filter((p) => p.status === "FAILED");
    const rows1 = await prisma.aiBudgetReservation.findMany({ where: { requestKey: { startsWith: `qi:${cr}:` } } });
    check("402 insufficient credit: the job stops without completing the refused pages", failed1.length >= 1 || c1.status === "PAUSED_BUDGET", { s: c1.status, failed: failed1.length, pages: pages1.map((p) => p.status) });
    const reason1 = [c1.pauseReason, c1.errorMessage, ...failed1.map((p) => p.errorMessage)].filter(Boolean).join(" | ");
    check("…the reason names the credit / cost limit (not a generic error)", /Cost or credit limit|credit/i.test(reason1), reason1);
    check("…nothing charged: refused requests are released, job spend ₹0", c1.spentInr === 0 && rows1.length >= 1 && rows1.every((r) => r.status === "RELEASED"), { spent: c1.spentInr, rows: rows1.map((r) => r.status) });
    const sc1 = await importerSpendSummary(cr);
    check("…the job's actual spend reads ₹0 with no unknown or in-flight amount", sc1.job?.actualInr === 0 && sc1.job?.unknownRequests === 0 && sc1.job?.inflightRequests === 0, sc1.job);
    // Credit restored at the provider → Retry failed pages (no budget step, no cap).
    await mockConfig({ failTask: {} });
    const chatsD = (await mockStats()).chat;
    await retryJob(cr, actor);
    await runWorker(180_000);
    const c2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: cr } });
    const pages2 = await prisma.aiImportPage.findMany({ where: { jobId: cr } });
    check("retry after the credit is restored → processing completes", c2.status === "NEEDS_REVIEW" && pages2.every((p) => p.status !== "FAILED" && p.status !== "PENDING"), { s: c2.status, pages: pages2.map((p) => p.status) });
    const rows2 = await prisma.aiBudgetReservation.findMany({ where: { requestKey: { startsWith: `qi:${cr}:` } } });
    const settled2 = rows2.filter((r) => r.status === "SETTLED");
    const sum2 = settled2.reduce((a, r) => a + (r.settledInr ?? 0), 0);
    check("each request after the retry recorded once; job spend = sum of the settled usage rows", settled2.length === (await mockStats()).chat - chatsD && near(c2.spentInr, sum2), { settled: settled2.length, sent: (await mockStats()).chat - chatsD, spent: c2.spentInr, sum2 });
    check("…the refused attempts stay released (not counted twice)", rows2.filter((r) => r.status === "RELEASED").length === rows1.length);
    const sc2 = await importerSpendSummary(cr);
    check("…the job's actual spend equals what the provider reported", near(sc2.job?.actualInr, sum2) && sc2.job?.actualRequests === settled2.length, sc2.job);
    check("network guard: no request left the loopback mock", blockedHosts.size === 0, [...blockedHosts]);
  } finally {
    await mockConfig({ failTask: {}, keyLimitRemaining: 9 });
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    await setOpenRouterEnabled(routerWasEnabled).catch(() => undefined);
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("SOME CHECKS FAILED");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
