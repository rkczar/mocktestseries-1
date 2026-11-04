/**
 * Free Trial duration: Admin setting = single source of truth, server-enforced.
 * (lib/premium-policy.ts, lib/premium-trial.ts, lib/payments/access.ts, lib/trial-duration.ts)
 *
 * SAFETY: writes the payment mode, the access policy, students, trials and
 * entitlements, so it REFUSES to run unless DATABASE_URL names a scratch
 * database containing "premium". No network call, no email is sent.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-trial-duration.ts
 *
 * "worker" mode (spawned by the suite itself) = a second, independent Node
 * process with its own policy cache, standing in for the other PM2 worker.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MockTestStatus, StudentAuthProvider } from "@prisma/client";

if (!/premium/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *premium* scratch database.");
  process.exit(2);
}

const HOUR = 3_600_000;

/** Second process: `worker save <hours>` or `worker start <studentId>`. Prints one JSON line. */
async function worker(op: string, arg: string) {
  const { getPremiumPolicy, savePremiumPolicy } = await import("../lib/premium-policy");
  const trialLib = await import("../lib/premium-trial");
  if (op === "save") {
    const cur = await getPremiumPolicy();
    const saved = await savePremiumPolicy({ ...cur, trialHours: Number(arg) }, undefined);
    console.log(JSON.stringify({ trialHours: saved.trialHours }));
  } else if (op === "read") {
    console.log(JSON.stringify({ trialHours: (await getPremiumPolicy()).trialHours }));
  } else {
    const r = await trialLib.startPremiumTrial(arg);
    console.log(JSON.stringify(r.ok ? { ok: true, endsAt: r.endsAt.toISOString(), started: r.started } : r));
  }
  process.exit(0);
}

function runWorker(...args: string[]): Record<string, unknown> {
  const r = spawnSync(process.execPath, [...process.execArgv, __filename, "worker", ...args], { encoding: "utf8", env: process.env });
  const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";
  try {
    return JSON.parse(line);
  } catch {
    return { error: r.stderr?.slice(-400) };
  }
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { setPaymentMode, bumpPaymentSettingsCache } = await import("../lib/payments/settings");
  const { getPremiumPolicy, savePremiumPolicy, bumpPremiumPolicyCache, parsePremiumPolicy, DEFAULT_PREMIUM_POLICY } = await import("../lib/premium-policy");
  const access = await import("../lib/payments/access");
  const trialLib = await import("../lib/premium-trial");
  const { trialLengthLabel, trialLengthText, TRIAL_HOURS_PRESETS } = await import("../lib/trial-duration");
  const { TEMPLATE_DEFAULTS } = await import("../lib/email/templates");

  const setPolicy = async (patch: Partial<import("../lib/premium-policy").PremiumPolicy>) => {
    const cur = await getPremiumPolicy({ fresh: true });
    await savePremiumPolicy({ ...cur, ...patch }, undefined);
  };

  console.log("=== Free Trial duration verification (scratch DB) ===\n");
  const sfx = Date.now().toString(36);
  await setPaymentMode("PAID", undefined);
  bumpPaymentSettingsCache();
  await prisma.setting.deleteMany({ where: { key: "access.premium_policy" } });
  bumpPremiumPolicyCache();

  // ---------------- fixture ----------------
  const exam = await prisma.exam.create({ data: { name: `Dur Exam ${sfx}`, code: `DUR-${sfx}`, durationMinutes: 30 } });
  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: `Dur Series ${sfx}`, status: "PUBLISHED" } });
  const paidMock = await prisma.mockTest.create({ data: { examId: exam.id, testSeriesId: series.id, title: "Dur Paid Mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType: "PAID" } });
  const freeMock = await prisma.mockTest.create({ data: { examId: exam.id, testSeriesId: series.id, title: "Dur Free Mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType: "FREE" } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "DUR 2024" } });
  const premium = await prisma.product.create({
    data: { code: `dur-${sfx}`, name: "Dur Premium", productType: "TEST_SERIES", examId: exam.id, testSeriesId: series.id, accessType: "PAID", mrpPaise: 200000, sellingPricePaise: 99900, accessDurationType: "DAYS", accessDays: 100 },
  });
  let mobileN = 7100000000 + Math.floor(Math.random() * 89999999);
  const mk = (t: string) =>
    prisma.student.create({
      data: { studentId: `DUR-${t}-${sfx}`, name: `Dur ${t}`, email: `dur-${t}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS, mobile: String(mobileN++), mobileVerifiedAt: new Date() },
    });
  const S = Object.fromEntries(
    await Promise.all(["a12", "before", "atExp", "d24", "d48", "old48", "mob1", "mob2", "paid", "w1", "w2", "w3", "cache"].map(async (t) => [t, await mk(t)] as const))
  );
  const now0 = new Date();
  await prisma.studentEntitlement.create({ data: { studentId: S.paid.id, productId: premium.id, source: "PURCHASE", startsAt: now0, expiresAt: new Date(now0.getTime() + 100 * 24 * HOUR) } });
  const D = { kind: "MOCK_TEST", id: paidMock.id, examId: exam.id, testSeriesId: series.id, accessType: "PAID" } as Parameters<typeof access.getContentAccess>[1];
  const allowedAt = async (sid: string, at: Date) => access.evaluateContentAccess(await access.loadAccessContext(sid, at), D).allowed;
  const hoursOf = (r: { startedAt: Date; endsAt: Date }) => (r.endsAt.getTime() - r.startedAt.getTime()) / HOUR;
  const trialRow = (sid: string) => prisma.studentPremiumTrial.findUniqueOrThrow({ where: { studentId: sid } });

  // An "old" 48-hour trial, started before the admin change (as in production).
  await setPolicy({ examId: exam.id, premiumProductIds: [premium.id], freePyqId: paper.id, freeMockTestId: freeMock.id, trialEnabled: true, trialHours: 48, requireVerifiedMobile: true, enforcementEnabled: true, enforcedSince: new Date(Date.now() - 24 * HOUR).toISOString() });
  const old = await trialLib.startPremiumTrial(S.old48.id, new Date(Date.now() - 3 * HOUR));
  const oldRow = await trialRow(S.old48.id);
  check("Setup: pre-change trial is 48 h", old.ok && hoursOf(oldRow) === 48);

  // ---------------- 1. configured duration ----------------
  console.log("\n1. Admin setting = 12 hours");
  await setPolicy({ trialHours: 12 });
  const stored = await prisma.setting.findUniqueOrThrow({ where: { key: "access.premium_policy" } });
  check("DB row stores trialHours = 12", (stored.value as { trialHours?: number }).trialHours === 12);
  check("getPremiumPolicy() reads 12", (await getPremiumPolicy({ fresh: true })).trialHours === 12);
  check("Missing/invalid saved value falls back to 12, never 48", parsePremiumPolicy({}).trialHours === 12 && parsePremiumPolicy({ trialHours: "48" }).trialHours === 12 && DEFAULT_PREMIUM_POLICY.trialHours === 12);
  check("Admin presets include 1, 2, 6, 12, 24, 48, 72", [1, 2, 6, 12, 24, 48, 72].every((h) => (TRIAL_HOURS_PRESETS as readonly number[]).includes(h)));

  // ---------------- 2. new trial = +12 h exactly ----------------
  console.log("\n2. Newly started trial expires at exactly +12 h");
  const t0 = new Date();
  const r12 = await trialLib.startPremiumTrial(S.a12.id, t0);
  const row12 = await trialRow(S.a12.id);
  check("Trial started", r12.ok && r12.started === true);
  check("startedAt = server time of activation", row12.startedAt.getTime() === t0.getTime());
  check("endsAt = startedAt + 12 h exactly (ms)", row12.endsAt.getTime() - row12.startedAt.getTime() === 12 * HOUR, hoursOf(row12));
  check("Returned endsAt = stored endsAt", r12.ok && r12.endsAt.getTime() === row12.endsAt.getTime());
  const status12 = await trialLib.getTrialStatus(S.a12.id);
  check("Dashboard status shows the same endsAt and trialHours 12", status12.trial?.endsAt.getTime() === row12.endsAt.getTime() && status12.trialHours === 12);

  // ---------------- 3/4. boundary ----------------
  console.log("\n3–4. Server-side access before / at / after expiry");
  check("Accessible right after start", await allowedAt(S.a12.id, new Date(t0.getTime() + 1000)));
  check("Accessible 1 ms before expiry", await allowedAt(S.a12.id, new Date(row12.endsAt.getTime() - 1)));
  check("DENIED exactly at expiry", !(await allowedAt(S.a12.id, row12.endsAt)));
  check("DENIED after expiry (+12 h 1 min)", !(await allowedAt(S.a12.id, new Date(t0.getTime() + 12 * HOUR + 60_000))));
  check("Still DENIED at +47 h (no hidden 48 h window)", !(await allowedAt(S.a12.id, new Date(t0.getTime() + 47 * HOUR))));
  // Real wall clock: a trial whose 12 h already ran out.
  const pastStart = new Date(Date.now() - 12 * HOUR - 5_000);
  await trialLib.startPremiumTrial(S.atExp.id, pastStart);
  check("Wall clock: trial started 12 h ago is denied now", !(await access.getContentAccess(S.atExp.id, D)).allowed);
  check("Wall clock: dashboard phase EXPIRED", (await trialLib.getTrialStatus(S.atExp.id)).phase === "EXPIRED");
  check("Expired trial cannot be restarted (ALREADY_USED)", await (async () => { const r = await trialLib.startPremiumTrial(S.atExp.id); return !r.ok && r.reason === "ALREADY_USED"; })());
  await trialLib.startPremiumTrial(S.before.id, new Date(Date.now() - 12 * HOUR + 5_000));
  check("Wall clock: trial 5 s before its end is still allowed", (await access.getContentAccess(S.before.id, D)).allowed);
  check("Free content stays open after expiry", (await access.getContentAccess(S.atExp.id, { kind: "PREVIOUS_YEAR_PAPER", id: paper.id, examId: exam.id } as never)).allowed);

  // ---------------- 5/6. changes affect later trials ----------------
  console.log("\n5–6. Changing the duration affects subsequently started trials");
  await setPolicy({ trialHours: 24 });
  await trialLib.startPremiumTrial(S.d24.id);
  check("After saving 24 h: new trial = 24 h", hoursOf(await trialRow(S.d24.id)) === 24);
  await setPolicy({ trialHours: 48 });
  await trialLib.startPremiumTrial(S.d48.id);
  check("After saving 48 h: new trial = 48 h", hoursOf(await trialRow(S.d48.id)) === 48);
  check("Earlier 12 h trial unchanged by later saves", (await trialRow(S.a12.id)).endsAt.getTime() === row12.endsAt.getTime());
  await setPolicy({ trialHours: 12 });

  // ---------------- 7. existing trials ----------------
  console.log("\n7. Existing trials are never extended or rewritten");
  const oldAfter = await trialRow(S.old48.id);
  check("Pre-change 48 h trial keeps its original endsAt", oldAfter.endsAt.getTime() === oldRow.endsAt.getTime() && oldAfter.startedAt.getTime() === oldRow.startedAt.getTime());
  const reclick = await trialLib.startPremiumTrial(S.a12.id);
  check("Clicking Start again returns the same endsAt (no restart / extension)", reclick.ok && reclick.started === false && reclick.endsAt.getTime() === row12.endsAt.getTime());
  await setPolicy({ trialHours: 72 });
  const reclick72 = await trialLib.startPremiumTrial(S.a12.id);
  check("Raising the duration to 72 h does not extend a running 12 h trial", reclick72.ok && reclick72.endsAt.getTime() === row12.endsAt.getTime() && (await trialRow(S.a12.id)).endsAt.getTime() === row12.endsAt.getTime());
  await setPolicy({ trialHours: 12 });

  // ---------------- 8. one trial per verified mobile ----------------
  console.log("\n8. One trial per verified mobile number");
  await trialLib.startPremiumTrial(S.mob1.id);
  const m1 = (await prisma.student.findUniqueOrThrow({ where: { id: S.mob1.id } })).mobile!;
  await prisma.student.update({ where: { id: S.mob1.id }, data: { mobile: String(mobileN++) } });
  await prisma.student.update({ where: { id: S.mob2.id }, data: { mobile: m1 } });
  const m2 = await trialLib.startPremiumTrial(S.mob2.id);
  check("Second account with the same verified mobile is refused (MOBILE_USED)", !m2.ok && m2.reason === "MOBILE_USED");
  check("…and no trial row was created for it", (await prisma.studentPremiumTrial.count({ where: { studentId: S.mob2.id } })) === 0);
  check("Trial rows per mobile are unique", (await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) n FROM (SELECT mobile FROM "StudentPremiumTrial" WHERE mobile IS NOT NULL GROUP BY mobile HAVING COUNT(*) > 1) d`)[0].n === BigInt(0));

  // ---------------- 9. client cannot manipulate ----------------
  console.log("\n9. Client cannot choose the duration or the time");
  const actionSrc = readFileSync(join(__dirname, "../app/student/(dashboard)/dashboard/trial-actions.ts"), "utf8");
  check("startTrialAction takes no arguments", /export async function startTrialAction\(\)\s*:/.test(actionSrc));
  check("startTrialAction calls startPremiumTrial(student.id) only (server time)", /startPremiumTrial\(student\.id\)/.test(actionSrc) && !/startPremiumTrial\(student\.id,/.test(actionSrc));
  const trialSrc = readFileSync(join(__dirname, "../lib/premium-trial.ts"), "utf8");
  check("Expiry formula = now + policy.trialHours (fresh policy read)", /endsAt = new Date\(now\.getTime\(\) \+ policy\.trialHours \* HOUR\)/.test(trialSrc) && /getPremiumPolicy\(\{ fresh: true \}\)/.test(trialSrc));

  // ---------------- 10. premium entitlements ----------------
  console.log("\n10. Premium entitlements are unaffected");
  const entBefore = JSON.stringify(await prisma.studentEntitlement.findMany({ orderBy: { id: "asc" } }));
  await setPolicy({ trialHours: 6 });
  await setPolicy({ trialHours: 12 });
  check("Premium holder: access allowed", (await access.getContentAccess(S.paid.id, D)).allowed);
  check("Premium holder: phase PAID, trial start refused", (await trialLib.getTrialStatus(S.paid.id)).phase === "PAID" && !(await trialLib.startPremiumTrial(S.paid.id)).ok);
  check("Premium holder: access allowed long after any trial window (+30 days)", await allowedAt(S.paid.id, new Date(Date.now() + 30 * 24 * HOUR)));
  check("Entitlement rows byte-identical after duration changes", JSON.stringify(await prisma.studentEntitlement.findMany({ orderBy: { id: "asc" } })) === entBefore);

  // ---------------- 11. stale cache ----------------
  console.log("\n11. Cached settings cannot leak a stale duration");
  await setPolicy({ trialHours: 48 });
  check("Warm this process's cache at 48 h", (await getPremiumPolicy()).trialHours === 48);
  const saved = runWorker("save", "12");
  check("Another process saves 12 h", saved.trialHours === 12, saved);
  check("This process's cache still says 48 (proves the cache is warm)", (await getPremiumPolicy()).trialHours === 48);
  await trialLib.startPremiumTrial(S.cache.id);
  check("…yet a trial started here gets 12 h (activation reads fresh)", hoursOf(await trialRow(S.cache.id)) === 12);

  // ---------------- 12. multiple workers ----------------
  console.log("\n12. Separate processes (PM2 workers) observe the same saved value");
  check("Worker 1 reads 12", runWorker("read").trialHours === 12);
  const w1 = runWorker("start", S.w1.id);
  check("Worker 1 starts a trial → 12 h", w1.ok === true && hoursOf(await trialRow(S.w1.id)) === 12, w1);
  runWorker("save", "24");
  const w2 = runWorker("start", S.w2.id);
  check("Worker 2 after a 24 h save → 24 h", w2.ok === true && hoursOf(await trialRow(S.w2.id)) === 24, w2);
  runWorker("save", "12");
  await trialLib.startPremiumTrial(S.w3.id);
  check("Main process after a 12 h save elsewhere → 12 h", hoursOf(await trialRow(S.w3.id)) === 12);

  // ---------------- 13. student-facing copy ----------------
  console.log("\n13. Student-facing copy comes from the saved duration");
  check("Labels: 12 → 12-Hour / 12 hours", trialLengthLabel(12) === "12-Hour" && trialLengthText(12) === "12 hours");
  check("Labels: 48 → 2-Day / 2 days; 24 → 1-Day / 1 day; 1 → 1 hour", trialLengthLabel(48) === "2-Day" && trialLengthText(48) === "2 days" && trialLengthText(24) === "1 day" && trialLengthText(1) === "1 hour");
  const popup = await trialLib.claimTrialPopup(S.mob1.id, { force: true }).catch(() => null);
  const fresh = await mk("popup");
  const pop = await trialLib.claimTrialPopup(fresh.id, { force: true });
  check("Welcome popup data carries trialHours 12", pop?.state === "WELCOME" && pop.trialHours === 12, { state: pop?.state, h: pop?.trialHours, prev: popup?.state });
  const ts = TEMPLATE_DEFAULTS.TRIAL_STARTED;
  check("Trial-started email no longer claims a fixed length", !/2-day|48/i.test(`${ts.subject} ${ts.heading} ${ts.bodyHtml}`));
  const root = join(__dirname, "..");
  const hard = ["app", "components", "lib"]
    .flatMap((d) => walk(join(root, d)))
    .filter((f) => !f.endsWith("trial-duration.ts"))
    .filter((f) => /2-Day|2-DAY|trialHours === 48/.test(readFileSync(f, "utf8")));
  check("No hardcoded 2-Day / 48-hour trial copy left in app, components or lib", hard.length === 0, hard.map((f) => f.slice(root.length)));

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === "worker") {
  worker(process.argv[3], process.argv[4]).catch((e) => {
    console.log(JSON.stringify({ error: String(e) }));
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
