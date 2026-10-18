/**
 * AI Question Importer — cost ledger (lib/ai-import/ledger.ts) and model suggestions
 * (lib/ai-import/model-options.ts suggestModels). Synthetic rows on a scratch DB only; no AI request.
 * Removes only its own rows (request keys / ids marked "ledgerfx").
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-ledger.ts
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { DEFAULT_IMPORTER_SETTINGS } from "@/lib/ai-import/config";
import { actualState, importerLedger, toPeriod } from "@/lib/ai-import/ledger";
import { suggestModels, type ImporterModelOption } from "@/lib/ai-import/model-options";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const near = (a: number | null | undefined, b: number) => a !== null && a !== undefined && Math.abs(a - b) < 1e-9;
const section = (s: string) => console.log(`\n=== ${s}`);

const TAG = "ledgerfx";
async function cleanup(jobId: string | null) {
  await prisma.aiBudgetReservation.deleteMany({ where: { requestKey: { contains: TAG } } });
  await prisma.aiGatewayCall.deleteMany({ where: { requestId: { startsWith: TAG } } });
  if (jobId) await prisma.aiImportJob.deleteMany({ where: { id: jobId } });
}

async function main() {
  const settings = DEFAULT_IMPORTER_SETTINGS;
  const now = new Date();
  const { istDay, istMonth } = istDayMonth(now);
  const old = new Date(now.getTime() - 40 * 86_400_000);
  const { istDay: oldDay, istMonth: oldMonth } = istDayMonth(old);

  section("A. Pure period arithmetic");
  const p = toPeriod([
    { status: "SETTLED", known: true, n: 2, reserved: 1.0, settled: 0.3 },
    { status: "SETTLED", known: false, n: 1, reserved: 0.5, settled: 0.5 },
    { status: "RESERVED", known: false, n: 1, reserved: 0.4, settled: 0 },
    { status: "RELEASED", known: true, n: 3, reserved: 0.9, settled: 0 },
  ]);
  check("actual = known settled only", near(p.actualInr, 0.3) && p.actualRequests === 2, p);
  check("unknown cost is counted as unknown with its held maximum, never as actual", p.unknownRequests === 1 && near(p.unknownHeldInr, 0.5), p);
  check("in flight held separately", p.inflightRequests === 1 && near(p.inflightInr, 0.4), p);
  check("released (refused before any charge) not counted", p.releasedRequests === 3 && p.requests === 4 && near(p.reservedMaxInr, 1.9), p);
  check("committed = actual + unknown held + in flight (what the budget guard counts)", near(p.committedInr, 1.2), p);

  section("A2. How an actual figure is read (never ₹0 for an unreported cost)");
  check("no recorded call → none", actualState({ actualRequests: 0, unknownRequests: 0, inflightRequests: 0 }) === "none" && actualState(toPeriod([])) === "none");
  check("only in flight → pending (not ₹0)", actualState({ actualRequests: 0, unknownRequests: 0, inflightRequests: 2 }) === "pending");
  check("every cost reported → known", actualState({ actualRequests: 3, unknownRequests: 0 }) === "known");
  check("known + in flight → known (in flight shown apart)", actualState({ actualRequests: 1, unknownRequests: 0, inflightRequests: 1 }) === "known");
  check("some reported, some not → mixed", actualState({ actualRequests: 1, unknownRequests: 1 }) === "mixed");
  check("requests exist but no cost reported → unknown, even though actualInr is 0", actualState(toPeriod([{ status: "SETTLED", known: false, n: 2, reserved: 0.4, settled: 0.4 }])) === "unknown");
  check("released only (refused before any charge) → none", actualState(toPeriod([{ status: "RELEASED", known: true, n: 2, reserved: 0.4, settled: 0 }])) === "none");

  const baseline = await importerLedger(settings, now);
  const exam = await prisma.exam.findFirst({ select: { id: true } });
  const admin = await prisma.adminUser.findFirst({ select: { id: true } });
  if (!exam || !admin) throw new Error("scratch DB needs an exam and an admin");
  const liveJob = await prisma.aiImportJob.create({ data: { title: `Ledger fixture ${TAG}`, examId: exam.id, createdById: admin.id, budgetInr: 8, estCostInr: 0.9 } });
  const goneJob = `${TAG}deleted`;
  try {
    section("B. Ledger from synthetic importer rows");
    const res = (key: string, feature: string, status: "SETTLED" | "RESERVED" | "RELEASED", reservedInr: number, settledInr: number | null, costKnown: boolean, day = istDay, month = istMonth) =>
      prisma.aiBudgetReservation.create({ data: { requestKey: key, feature, status, reservedInr, settledInr, costKnown, istDay: day, istMonth: month, settledAt: status === "RESERVED" ? null : new Date() } });
    await res(`qi:${liveJob.id}:${TAG}-1:1`, "qimport_extract", "SETTLED", 0.8, 0.25, true);
    await res(`qi:${liveJob.id}:${TAG}-2:1`, "qimport_verify", "SETTLED", 0.6, 0.6, false);
    await res(`qi:${liveJob.id}:${TAG}-3:1`, "qimport_extract", "RESERVED", 0.7, null, false);
    await res(`qi:${liveJob.id}:${TAG}-4:1`, "qimport_extract", "RELEASED", 0.7, 0, true);
    await res(`qi:${goneJob}:${TAG}-5:1`, "qimport_classify", "SETTLED", 0.2, 0.05, true, oldDay, oldMonth);
    // One deleted job per actual state, for the per-job and history reading.
    const { istDay: pendDay, istMonth: pendMonth } = istDayMonth(new Date(now.getTime() - 3 * 86_400_000));
    await res(`qi:${TAG}pend:${TAG}-7:1`, "qimport_extract", "RESERVED", 0.3, null, false, pendDay, pendMonth);
    await res(`qi:${TAG}unk:${TAG}-8:1`, "qimport_extract", "SETTLED", 0.4, 0.4, false);
    await res(`qi:${TAG}unk:${TAG}-9:1`, "qimport_verify", "SETTLED", 0.2, 0.2, false);
    // Another AI feature's spend: must never appear in the importer's ledger.
    await res(`ask:${TAG}-6`, "ask_ai", "SETTLED", 5, 4, true);
    let dup = false;
    try {
      await res(`qi:${liveJob.id}:${TAG}-1:1`, "qimport_extract", "SETTLED", 0.8, 0.25, true);
    } catch {
      dup = true;
    }
    check("the same request key cannot be recorded twice (unique ledger key)", dup);

    const gw = (requestId: string, model: string, ok: boolean, est: number | null, actual: number | null, costStatus: string, attempt = 1, fallbackUsed = false, feature = "qimport_extract") =>
      prisma.aiGatewayCall.create({ data: { feature, provider: "openrouter", model, ok, latencyMs: 10, estCostInr: est, actualCostInr: actual, costStatus, attempt, fallbackUsed, requestId } });
    await gw(`${TAG}-1`, "google/gemini-fx-vision", true, 0.2, 0.25, "actual");
    await gw(`${TAG}-2`, "mockvision/fx", false, 0.3, null, "unknown", 2, true, "qimport_verify");
    await gw(`${TAG}-6`, "google/gemini-fx-vision", true, 3, 4, "actual", 1, false, "ask_ai");
    // Estimated-today window: one call without an estimate today; one estimated call yesterday and one tomorrow (IST) — both outside today.
    await gw(`${TAG}-10`, "mockvision/fx-est", true, null, null, "none");
    const dayStart = new Date(`${istDay}T00:00:00+05:30`);
    await prisma.aiGatewayCall.create({ data: { feature: "qimport_extract", provider: "openrouter", model: "mockvision/fx-est", ok: true, latencyMs: 10, estCostInr: 1.5, costStatus: "unknown", actualCostInr: null, requestId: `${TAG}-11`, createdAt: new Date(dayStart.getTime() - 60_000) } });
    await prisma.aiGatewayCall.create({ data: { feature: "qimport_extract", provider: "openrouter", model: "mockvision/fx-est", ok: true, latencyMs: 10, estCostInr: 2.5, costStatus: "unknown", actualCostInr: null, requestId: `${TAG}-12`, createdAt: new Date(dayStart.getTime() + 86_400_000 + 60_000) } });

    const L = await importerLedger(settings, now);
    const d = (a: number, b: number) => a - b;
    check("today: actual ₹0.25 from the one reported cost", near(d(L.periods.today.actualInr, baseline.periods.today.actualInr), 0.25), L.periods.today);
    check("today: 3 unknown-cost requests with ₹1.20 held (not in actual)", L.periods.today.unknownRequests - baseline.periods.today.unknownRequests === 3 && near(d(L.periods.today.unknownHeldInr, baseline.periods.today.unknownHeldInr), 1.2));
    check("today: 1 in flight (₹0.70 held); released request not counted", L.periods.today.inflightRequests - baseline.periods.today.inflightRequests === 1 && L.periods.today.releasedRequests - baseline.periods.today.releasedRequests === 1);
    check("all time includes the deleted job's older spend (₹0.05)", near(d(L.periods.all.actualInr, baseline.periods.all.actualInr), 0.3));
    check("this month excludes the 40-day-old request", near(d(L.periods.month.actualInr, baseline.periods.month.actualInr), 0.25));
    check("another feature's ₹4 is not in any importer total", near(d(L.periods.all.committedInr, baseline.periods.all.committedInr), 0.25 + 0.6 + 0.7 + 0.05 + 0.3 + 0.6));
    check("budget remaining = all-time limit − committed", near(L.remaining.totalInr, Math.max(0, L.limits.totalInr - L.periods.all.committedInr)), L.remaining);
    check("monthly remaining never exceeds what is left of the all-time limit", L.remaining.monthInr <= L.remaining.totalInr + 1e-9);
    check("limits are the pilot ceilings (₹10 / ₹10 / ₹8 / ₹1)", L.limits.totalInr === 10 && L.limits.monthlyInr === 10 && L.limits.maxJobInr === 8 && L.limits.maxRequestInr === 1, L.limits);

    const job = L.jobs.find((j) => j.jobId === liveJob.id);
    check("per job: actual, unknown held, in flight and job estimate kept apart", !!job && near(job.actualInr, 0.25) && job.unknownRequests === 1 && near(job.heldInr, 0.6) && near(job.inflightInr, 0.7) && near(job.jobEstimateInr ?? NaN, 0.9) && job.requests === 3, job);
    const gone = L.jobs.find((j) => j.jobId === goneJob);
    check("per job: a deleted import keeps its spend, marked deleted", !!gone && gone.deleted && gone.title === null && near(gone.actualInr, 0.05), gone);

    const gem = L.usage.byProvider.find((x) => x.family.startsWith("Gemini"));
    const base = (f: string) => baseline.usage.byProvider.find((x) => x.family.startsWith(f));
    check("usage: Gemini models via OpenRouter counted from importer calls only (₹0.25, not the other feature's ₹4)", !!gem && gem.calls - (base("Gemini")?.calls ?? 0) === 1 && near((gem.actualInr ?? 0) - (base("Gemini")?.actualInr ?? 0), 0.25), gem);
    check("usage: failure, retry and fallback counted", L.usage.failed - baseline.usage.failed === 1 && L.usage.retries - baseline.usage.retries === 1 && L.usage.fallbacks - baseline.usage.fallbacks === 1, L.usage);
    check("usage: direct Gemini API calls are 0", L.usage.geminiDirectCalls === 0);
    check("estimate vs actual compares only requests with both (₹0.20 estimated vs ₹0.25 actual)", L.estimates.comparedRequests - baseline.estimates.comparedRequests === 1 && near((L.estimates.comparedActualInr ?? 0) - (baseline.estimates.comparedActualInr ?? 0), 0.25), L.estimates);
    check("history has today's row", L.history.some((h) => h.day === istDay));

    section("B2. Actual states per job and per day; estimated today");
    const jobState = (id: string) => {
      const j = L.jobs.find((x) => x.jobId === id);
      return j ? actualState(j) : "missing";
    };
    check("job with only an in-flight request → pending (actual ₹0 never shown as spend)", jobState(`${TAG}pend`) === "pending");
    check("job whose costs were never reported → unknown, ₹0.60 held", jobState(`${TAG}unk`) === "unknown" && near(L.jobs.find((x) => x.jobId === `${TAG}unk`)!.heldInr, 0.6));
    check("job with one reported and one unreported cost → mixed", jobState(liveJob.id) === "mixed");
    check("job with every cost reported → known", jobState(goneJob) === "known");
    const pendRow = L.history.find((h) => h.day === pendDay);
    check("history day with only an in-flight request: no actual, no unknown, 1 in flight (shown as pending)", !!pendRow && pendRow.actualRequests === 0 && pendRow.unknownRequests === 0 && pendRow.inflightRequests >= 1, pendRow);
    const dCalls = L.estimates.todayCalls - baseline.estimates.todayCalls;
    const dUnest = L.estimates.todayUnestimated - baseline.estimates.todayUnestimated;
    check("estimated today: the total (₹0.50) covers exactly the 2 estimated importer calls of today", dCalls === 2 && near((L.estimates.todayInr ?? 0) - (baseline.estimates.todayInr ?? 0), 0.5), { dCalls, L: L.estimates, b: baseline.estimates });
    check("estimated today: the call without an estimate is counted apart, not in the total", dUnest === 1, { dUnest });
    check("estimated today: yesterday's and tomorrow's calls (IST) and the other feature's call are outside the window", near((L.estimates.todayInr ?? 0) - (baseline.estimates.todayInr ?? 0), 0.5) && dCalls === 2);
    const empty = await importerLedger(settings, new Date(now.getTime() + 400 * 86_400_000));
    check("a day with no recorded call: no estimated calls, actual state none", empty.estimates.todayCalls === 0 && empty.estimates.todayInr === null && actualState(empty.periods.today) === "none", { e: empty.estimates, t: empty.periods.today });
  } finally {
    await cleanup(liveJob.id);
  }
  const after = await importerLedger(settings, now);
  check("fixture removed: ledger back to the baseline", near(after.periods.all.committedInr, baseline.periods.all.committedInr) && after.usage.calls === baseline.usage.calls);

  section("C. Model suggestions (empty importer list recovery)");
  const opt = (id: string, o: Partial<ImporterModelOption> & { max?: number | null }): ImporterModelOption => {
    const cost = o.max === undefined ? 0.05 : o.max;
    const rc = cost === null ? null : { inputTokens: 1, maxOutputTokens: 1, maxUsd: 0, maxInr: cost, typicalUsd: 0, typicalInr: cost / 2 };
    return { id, name: id, vision: true, approved: false, globallyApproved: false, problem: null, visionProblem: null, promptPerM: 0.1, completionPerM: 0.4, imagePrice: 0, requestPrice: 0, context: 100000, synced: "2026-10-18", costs: rc ? { extract: rc, verify: rc, solve: rc, classify: rc, key: rc } : { extract: null, verify: null, solve: { inputTokens: 1, maxOutputTokens: 1, maxUsd: 0, maxInr: 0, typicalUsd: 0, typicalInr: 0 }, classify: { inputTokens: 1, maxOutputTokens: 1, maxUsd: 0, maxInr: 0, typicalUsd: 0, typicalInr: 0 }, key: null }, ...o };
  };
  const options = [
    opt("google/gemini-cheap", { max: 0.02 }),
    opt("vendor/zdr-mid", { max: 0.3 }),
    opt("vendor/no-zdr", { max: 0.01 }),
    opt("vendor/pricey", { max: 3 }),
    opt("vendor/text-only", { vision: false, visionProblem: "cannot read images" }),
    opt("vendor/disabled", { visionProblem: "disabled" }),
    opt("vendor/unpriced", { max: null }),
    opt("vendor/listed", { max: 0.001 }),
  ];
  const zdrModels = ["google/gemini-cheap", "vendor/zdr-mid", "vendor/pricey", "vendor/listed"];
  const s1 = suggestModels(options, { listed: ["vendor/listed"], capInr: 1, zdrRequired: true, zdrModels });
  check("suggests only vision + priced + within ₹1 + ZDR models, cheapest first", JSON.stringify(s1.suggested.map((o) => o.id)) === JSON.stringify(["google/gemini-cheap", "vendor/zdr-mid"]), s1.suggested.map((o) => o.id));
  check("each exclusion is counted with its reason", s1.excluded.notVision === 1 && s1.excluded.unusable === 1 && s1.excluded.noPrice === 1 && s1.excluded.overCap === 1 && s1.excluded.noZdr === 1, s1.excluded);
  check("already-listed models are not suggested again", !s1.suggested.some((o) => o.id === "vendor/listed"));
  const s2 = suggestModels(options, { listed: [], capInr: 1, zdrRequired: true, zdrModels: null });
  check("ZDR required but ZDR list never read → no suggestion, asks to refresh routes", s2.suggested.length === 0 && /Refresh provider routes/.test(s2.privacyUnknown ?? ""), s2);
  const s3 = suggestModels(options, { listed: [], capInr: 1, zdrRequired: false, zdrModels: null });
  check("ZDR not required → the cheapest non-ZDR model is suggested too (privacy setting respected, not changed)", s3.suggested[0]?.id === "vendor/listed" && s3.suggested.some((o) => o.id === "vendor/no-zdr"));
  const s4 = suggestModels(options, { listed: [], capInr: 0.015, zdrRequired: true, zdrModels });
  check("a lower per-request limit shrinks the list (never a pricier model)", s4.suggested.every((o) => (o.costs?.extract?.maxInr ?? 99) <= 0.015));

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup(null).catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
