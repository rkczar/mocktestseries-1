/**
 * SCRATCH-ONLY diagnostic for the intermittent T5 check (12 concurrent importer requests on 2 jobs under
 * a tight all-time cap). Repeats the exact race N times and records every outcome, error, reservation and
 * job state. Mock OpenRouter only; refuses a production-looking DB.
 *   ROUNDS=15 NODE_OPTIONS=--conditions=react-server npx tsx scripts/repro-ai-import-race.ts
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { createJob } from "@/lib/ai-import/jobs";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") || !process.env.OPENROUTER_TEST_BASE_URL) {
  console.error("scratch only");
  process.exit(2);
}
const MOCK = process.env.OPENROUTER_TEST_BASE_URL!;
const mock = (p: string, body?: unknown) => fetch(`${MOCK}${p}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

async function main() {
  const { importerAiCall } = await import("@/lib/ai-import/ai");
  const { computeModelPlan } = await import("@/lib/ai-import/select");
  const actor = (await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } })).id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const restore = (await prisma.setting.findUnique({ where: { key: "ai.importer" } }))?.value ?? null;
  await mock("/__mock/reset");
  await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
  await testOpenRouterConnection();
  await setOpenRouterEnabled(true);
  await syncCatalog();
  const ids = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
  const cur = normalizeImporterSettings(await getImporterSettings());
  const pilot: ImporterSettings = { ...cur, aiEnabled: true, selection: { mode: "manual" }, importerModels: ids, models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: "mocktext/classifier", key: null }, privacy: { dataCollection: "deny", zdr: true }, budget: { ...cur.budget, monthlyInr: 10, totalInr: 10, maxJobInr: 8, defaultJobCapInr: 8, maxRequestInr: 1, keyReserveUsd: 5, retryTransient: false, allowPricierFallback: false }, limits: { ...cur.limits, concurrency: 2 } };
  await saveImporterSettings(pilot, actor);
  const { refreshRoutes } = await import("@/lib/ai-import/routes");
  await refreshRoutes(ids);
  const jobs: string[] = [];
  const mk = async (t: string) => {
    const id = await createJob({ actorId: actor, title: t, examId: exam.id, paperType: "FULL_PAPER", subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null, budgetInr: 5 });
    jobs.push(id);
    const plan = await computeModelPlan(normalizeImporterSettings(await getImporterSettings()), { refresh: true });
    await prisma.aiImportJob.update({ where: { id }, data: { status: "PROCESSING", leaseOwner: "race-repro", leaseUntil: new Date(Date.now() + 3_600_000), config: { modelPlan: plan } as never } });
    return id;
  };
  const ja = await mk("RACE A");
  const jb = await mk("RACE B");
  const used = async () => (await prisma.aiBudgetReservation.findMany({ where: { feature: { startsWith: "qimport_" }, status: { not: "RELEASED" } } })).reduce((a, r) => a + (r.settledInr ?? r.reservedInr), 0);
  const call = (jobId: string, i: number, settings: ImporterSettings) => importerAiCall({ jobId, task: "classify", models: ["mocktext/classifier"], system: "You classify exam questions into an EXISTING syllabus.", content: [{ type: "text", text: `SUBJECT s = Anatomy\n  TOPIC t = Lower Limb\n[q${i}] femur` }], maxOutputTokens: 2500, settings, needsVision: false });
  if (process.env.ORDERED === "1") {
    // Deterministic order: 3 requests of job A in flight, then one more of A and one of B.
    await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
    await saveImporterSettings(pilot, actor);
    await call(ja, -1, normalizeImporterSettings(await getImporterSettings()));
    const worstOne = (await prisma.aiBudgetReservation.findFirstOrThrow({ where: { requestKey: { startsWith: `qi:${ja}:` } } })).reservedInr;
    const capTotal = (await used()) + worstOne * 3.5;
    const s5 = await getImporterSettings();
    await saveImporterSettings({ ...s5, budget: { ...s5.budget, totalInr: capTotal, maxJobInr: Math.min(8, capTotal), maxRequestInr: Math.min(1, capTotal) } }, actor);
    const cfg5 = normalizeImporterSettings(await getImporterSettings());
    await mock("/__mock/config", { chatDelayMs: 4000 });
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      const before = await prisma.aiBudgetReservation.count({ where: { status: "RESERVED" } });
      inflight.push(call(ja, i, cfg5).catch((e) => e));
      while ((await prisma.aiBudgetReservation.count({ where: { status: "RESERVED" } })) === before) await new Promise((r) => setTimeout(r, 20));
    }
    const fourthA = await call(ja, 3, cfg5).then(() => "ok", (e) => `${(e as { scope?: string }).scope ?? "?"}: ${String((e as Error).message).slice(0, 100)}`);
    const fifthB = await call(jb, 4, cfg5).then(() => "ok", (e) => `${(e as { scope?: string }).scope ?? "?"}: ${String((e as Error).message).slice(0, 100)}`);
    await Promise.all(inflight);
    await mock("/__mock/config", { chatDelayMs: 0 });
    console.log(JSON.stringify({ ordered: true, capTotal: +capTotal.toFixed(4), worstOne: +worstOne.toFixed(4), fourthA, fifthB }));
  }
  const rounds = Number(process.env.ROUNDS ?? 15);
  let bad = 0;
  try {
    for (let r = 1; r <= rounds; r++) {
      await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
      await saveImporterSettings(pilot, actor);
      await mock("/__mock/config", { chatDelayMs: 0 });
      await call(ja, -1, normalizeImporterSettings(await getImporterSettings()));
      const worstOne = (await prisma.aiBudgetReservation.findFirstOrThrow({ where: { requestKey: { startsWith: `qi:${ja}:` } } })).reservedInr;
      const capTotal = (await used()) + worstOne * 3.5;
      const s5 = await getImporterSettings();
      await saveImporterSettings({ ...s5, budget: { ...s5.budget, totalInr: capTotal, maxJobInr: Math.min(8, capTotal), maxRequestInr: Math.min(1, capTotal) } }, actor);
      const cfg5 = normalizeImporterSettings(await getImporterSettings());
      const chats0 = (await (await fetch(`${MOCK}/__mock/stats`)).json()).chat;
      await mock("/__mock/config", { chatDelayMs: 1500 });
      const t0 = Date.now();
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => call(i % 2 ? ja : jb, i, cfg5).then((v) => ({ v, ms: Date.now() - t0 }))));
      await mock("/__mock/config", { chatDelayMs: 0 });
      const chats = (await (await fetch(`${MOCK}/__mock/stats`)).json()).chat - chats0;
      const outcomes = results.map((x) => (x.status === "fulfilled" ? `ok@${x.value.ms}ms` : `${(x.reason as Error).constructor.name}[${(x.reason as { scope?: string }).scope ?? "-"}]: ${String((x.reason as Error).message).slice(0, 140)}`));
      const scopes = results.filter((x) => x.status === "rejected").map((x) => (x.reason as { scope?: string }).scope ?? (x.reason as Error).constructor.name);
      const byScope = Object.fromEntries([...new Set(scopes)].map((k) => [k, scopes.filter((z) => z === k).length]));
      // Which job each admitted request belonged to (lock order decides which cap binds first).
      const admitted = results.map((x, i) => (x.status === "fulfilled" ? (i % 2 ? "A" : "B") : null)).filter(Boolean).join("");
      const okN = results.filter((x) => x.status === "fulfilled").length;
      const refused = results.filter((x) => x.status === "rejected" && /all-time AI budget/.test(String((x.reason as Error).message))).length;
      const resv = await prisma.aiBudgetReservation.groupBy({ by: ["status"], where: { feature: { startsWith: "qimport_" } }, _count: { _all: true } });
      const js = await prisma.aiImportJob.findMany({ where: { id: { in: [ja, jb] } }, select: { status: true, spentInr: true } });
      const okRound = okN >= 1 && okN <= 3 && okN + refused === 12 && chats === okN;
      if (!okRound) bad++;
      console.log(JSON.stringify({ round: r, okRound, okN, refused, byScope, admitted, chats, capTotal: +capTotal.toFixed(5), worstOne: +worstOne.toFixed(5), after: +(await used()).toFixed(5), reservations: resv.map((g) => `${g.status}:${g._count._all}`), jobs: js, other: outcomes.filter((o) => !o.startsWith("ok@") && !/all-time AI budget/.test(o)) }));
    }
  } finally {
    await mock("/__mock/reset");
    await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
    await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs } } });
    if (restore) await prisma.setting.update({ where: { key: "ai.importer" }, data: { value: restore as never } });
    else await prisma.setting.deleteMany({ where: { key: "ai.importer" } });
    console.log(`BAD ROUNDS: ${bad} of ${rounds}`);
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
