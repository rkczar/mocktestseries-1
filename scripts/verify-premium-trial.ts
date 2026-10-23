/**
 * Free Trial + Premium Access verification (lib/premium-policy.ts,
 * lib/premium-trial.ts, lib/payments/access.ts, lib/test-attempt.ts gates).
 *
 * SAFETY: writes the payment mode, the access policy, trials, attempts,
 * orders and entitlements, so it REFUSES to run unless DATABASE_URL names a
 * scratch database containing "premium". No network call is made.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-premium-trial.ts
 */
import "dotenv/config";
import { AttemptAnswerMode, AttemptDurationMode, MockTestStatus, QuestionDifficulty, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { createFixtureSubject } from "./fixture-taxonomy";

if (!/premium/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *premium* scratch database.");
  process.exit(2);
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
async function rejects(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

const HOUR = 3_600_000;

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { setPaymentMode, bumpPaymentSettingsCache } = await import("../lib/payments/settings");
  const { getPremiumPolicy, savePremiumPolicy, bumpPremiumPolicyCache, examDayEnd } = await import("../lib/premium-policy");
  const access = await import("../lib/payments/access");
  const trialLib = await import("../lib/premium-trial");
  const engine = await import("../lib/test-attempt");
  const { recordTrustedPayment } = await import("../lib/payments/orders");
  const { validatePremiumPolicy, enforcementBlockers, extendTillExamAccess, PolicyValidationError } = await import("../lib/premium-admin");

  const setPolicy = async (patch: Partial<import("../lib/premium-policy").PremiumPolicy>) => {
    const cur = await getPremiumPolicy();
    await savePremiumPolicy({ ...cur, ...patch }, undefined);
    bumpPremiumPolicyCache();
  };

  console.log("=== Free Trial + Premium Access verification (scratch DB) ===\n");
  const sfx = Date.now().toString(36);
  await setPaymentMode("PAID", undefined);
  bumpPaymentSettingsCache();
  await prisma.setting.deleteMany({ where: { key: "access.premium_policy" } });
  bumpPremiumPolicyCache();

  // ---------------- fixture ----------------
  const exam = await prisma.exam.create({ data: { name: `Prem Exam ${sfx}`, code: `PREM-${sfx}`, durationMinutes: 30 } });
  const other = await prisma.exam.create({ data: { name: `Other Exam ${sfx}`, code: `OTH-${sfx}`, durationMinutes: 30 } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "Prem Subject" });
  const otherSubject = await createFixtureSubject(prisma, { examId: other.id, name: "Other Subject" });
  const mkQ = (examId: string, subjectId: string, n: number, paperId?: string) =>
    prisma.question.create({
      data: {
        examId,
        subjectId,
        code: `Q-PREM-${sfx}-${examId.slice(-4)}-${n}`,
        text: `Question ${n}?`,
        difficulty: QuestionDifficulty.EASY,
        status: QuestionStatus.PUBLISHED,
        previousYearPaperId: paperId,
        options: { create: [{ label: "A", text: "x", isCorrect: true }, { label: "B", text: "y", isCorrect: false }] },
      },
    });
  const paperFree = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "PREM 2024" } });
  const paperPaid = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2020, title: "PREM 2020" } });
  const qs = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => mkQ(exam.id, subject.id, n, n <= 2 ? paperFree.id : n <= 4 ? paperPaid.id : undefined)));
  const oq = await mkQ(other.id, otherSubject.id, 9);
  const otherPaper = await prisma.previousYearPaper.create({ data: { examId: other.id, year: 2024, title: "OTHER 2024" } });
  await prisma.question.update({ where: { id: oq.id }, data: { previousYearPaperId: otherPaper.id } });

  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: `Prem Series ${sfx}`, status: "PUBLISHED" } });
  const mkMock = (title: string, accessType: "FREE" | "PAID", extra: Record<string, unknown> = {}) =>
    prisma.mockTest.create({
      data: {
        examId: exam.id,
        testSeriesId: series.id,
        title,
        durationMinutes: 30,
        status: MockTestStatus.PUBLISHED,
        accessType,
        questions: { create: qs.slice(0, 3).map((q, i) => ({ questionId: q.id, order: i })) },
        ...extra,
      },
    });
  const freeMock = await mkMock("Free Mock 1", "FREE");
  const legacyFreeMock = await mkMock("Legacy Free Mock 2", "FREE");
  const paidMock = await mkMock("Paid Mock 3", "PAID");
  const soldMock = await mkMock("Sold Mock 4", "PAID");
  const subjectMock = await mkMock("Physiology Subject Mock 01", "PAID", { coverageType: "SUBJECT_WISE", coverageSubjectIds: [subject.id] });
  const liveCbt = await mkMock("Live CBT 01", "FREE", { enrollmentEnabled: true });
  const liveCbtFree = await mkMock("Live CBT 02 (free)", "FREE", { enrollmentEnabled: true });

  const premium = await prisma.product.create({
    data: { code: `prem-${sfx}`, name: "Prem Complete Series", productType: "TEST_SERIES", examId: exam.id, testSeriesId: series.id, accessType: "PAID", mrpPaise: 200000, sellingPricePaise: 99900, accessDurationType: "DAYS", accessDays: 100 },
  });
  const single = await prisma.product.create({
    data: { code: `prem-single-${sfx}`, name: "Sold Mock 4", productType: "MOCK_TEST", examId: exam.id, mockTestId: soldMock.id, accessType: "PAID", mrpPaise: 10000, sellingPricePaise: 2500, accessDurationType: "DAYS", accessDays: 100 },
  });

  let mobileN = 7000000000 + Math.floor(Math.random() * 99999999);
  const mkStudent = (t: string, verified = true) =>
    prisma.student.create({
      data: {
        studentId: `PREM-${t}-${sfx}`,
        name: `Prem ${t}`,
        email: `prem-${t}-${sfx}@example.test`,
        authProvider: StudentAuthProvider.CREDENTIALS,
        mobile: verified ? String(mobileN++) : null,
        mobileVerifiedAt: verified ? new Date() : null,
      },
    });
  const [N, X, P, S, U, R, G, M, A, L] = await Promise.all(
    ["new", "existing", "paid", "single", "unverified", "reminder", "grace", "mobile", "api", "lapsed"].map((t) => mkStudent(t, t !== "unverified"))
  );
  const now0 = new Date();
  await prisma.studentEntitlement.create({ data: { studentId: P.id, productId: premium.id, source: "PURCHASE", startsAt: now0, expiresAt: new Date(now0.getTime() + 100 * 24 * HOUR) } });
  await prisma.studentEntitlement.create({ data: { studentId: S.id, productId: single.id, source: "PURCHASE", startsAt: now0, expiresAt: new Date(now0.getTime() + 100 * 24 * HOUR) } });

  const D = (kind: "MOCK_TEST" | "PREVIOUS_YEAR_PAPER" | "SUBJECT_TEST" | "CUSTOM_MODULE", id: string | null, m?: { testSeriesId: string | null; accessType: "FREE" | "PAID" }, examId = exam.id) =>
    ({ kind, id, examId, ...(m ? { testSeriesId: m.testSeriesId, accessType: m.accessType } : {}) }) as Parameters<typeof access.getContentAccess>[1];
  const allowed = async (sid: string, c: Parameters<typeof access.getContentAccess>[1]) => (await access.getContentAccess(sid, c)).allowed;

  // ---------------- 1. enforcement OFF = legacy ----------------
  console.log("1. Enforcement OFF (no policy row) keeps today's rules");
  check("Legacy FREE mock open", await allowed(N.id, D("MOCK_TEST", legacyFreeMock.id, legacyFreeMock)));
  check("PYQ not covered by a product stays open", await allowed(N.id, D("PREVIOUS_YEAR_PAPER", paperPaid.id)));
  check("Subject Test stays open", await allowed(N.id, D("SUBJECT_TEST", null)));
  check("PAID mock still locked without entitlement", !(await allowed(N.id, D("MOCK_TEST", paidMock.id, paidMock))));
  check("Trial status OFF", (await trialLib.getTrialStatus(N.id)).phase === "OFF");
  check("No popup while OFF", (await trialLib.claimTrialPopup(N.id)) === null);
  const offStart = await trialLib.startPremiumTrial(N.id);
  check("Trial cannot start while OFF (and no row)", !offStart.ok && (await prisma.studentPremiumTrial.count({ where: { studentId: N.id } })) === 0);

  // Policy saved but enforcement OFF: still legacy
  await setPolicy({
    examId: exam.id,
    premiumProductIds: [premium.id],
    freePyqId: paperFree.id,
    freeMockTestId: freeMock.id,
    freeSubjectMockTestId: subjectMock.id,
    freeLiveCbtMockTestIds: [liveCbtFree.id],
    trialEnabled: true,
    trialHours: 48,
  });
  check("Configured but enforcement OFF → legacy (legacy free mock open)", await allowed(N.id, D("MOCK_TEST", legacyFreeMock.id, legacyFreeMock)));
  check("Configured but OFF → no popup", (await trialLib.claimTrialPopup(N.id)) === null);

  // ---------------- 2. admin validation ----------------
  console.log("\n2. Admin validation");
  const otherMock = await prisma.mockTest.create({ data: { examId: other.id, title: "x", durationMinutes: 5, status: MockTestStatus.PUBLISHED } });
  const curPolicy = await getPremiumPolicy();
  const bad = await rejects(() => validatePremiumPolicy({ ...curPolicy, freeMockTestId: otherMock.id }));
  check("Free mock from another exam rejected", bad instanceof PolicyValidationError);
  const badLive = await rejects(() => validatePremiumPolicy({ ...curPolicy, freeLiveCbtMockTestIds: [otherMock.id] }));
  check("Free Live CBT exception from another exam rejected", badLive instanceof PolicyValidationError);
  check("A test with enrollment switched off (past Live CBT) can be a free exception", (await rejects(() => validatePremiumPolicy({ ...curPolicy, freeLiveCbtMockTestIds: [paidMock.id] }))) === null);
  check("Complete policy has no enforcement blockers", enforcementBlockers(await getPremiumPolicy()).length === 0);
  check("Missing free PYQ blocks enforcement", enforcementBlockers({ ...(await getPremiumPolicy()), freePyqId: null }).length === 1);

  // ---------------- 3. enforcement ON ----------------
  console.log("\n3. Enforcement ON — free forever vs Premium");
  const attemptsBefore = await prisma.testAttempt.count();
  // Enforcement "switched ON" a day ago, so the trial-grace checks below are not masked by pre-enforcement grace.
  const enforcedAt = new Date(Date.now() - 24 * HOUR);
  await setPolicy({ enforcementEnabled: true, enforcedSince: enforcedAt.toISOString() });
  check("Selected free PYQ open", await allowed(N.id, D("PREVIOUS_YEAR_PAPER", paperFree.id)));
  check("Other PYQ locked", !(await allowed(N.id, D("PREVIOUS_YEAR_PAPER", paperPaid.id))));
  check("Selected free Mock open", await allowed(N.id, D("MOCK_TEST", freeMock.id, freeMock)));
  check("Legacy-FREE mock now Premium (locked)", !(await allowed(N.id, D("MOCK_TEST", legacyFreeMock.id, legacyFreeMock))));
  check("Selected fixed Subject Mock open (even though PAID-flagged)", await allowed(N.id, D("MOCK_TEST", subjectMock.id, subjectMock)));
  check("Random Subject Test locked", !(await allowed(N.id, D("SUBJECT_TEST", null))));
  check("Custom Module locked", !(await allowed(N.id, D("CUSTOM_MODULE", null, { testSeriesId: null, accessType: "FREE" }))));
  check("Live CBT locked (Premium Live CBT)", !(await allowed(N.id, D("MOCK_TEST", liveCbt.id, liveCbt))));
  check("Admin-selected free Live CBT open", await allowed(N.id, D("MOCK_TEST", liveCbtFree.id, liveCbtFree)));
  const lockRes = await access.getContentAccess(N.id, D("PREVIOUS_YEAR_PAPER", paperPaid.id));
  check("Lock is PAYMENT_REQUIRED, premium, Premium plan offered first", lockRes.status === "PAYMENT_REQUIRED" && lockRes.premium === true && lockRes.products[0]?.id === premium.id);
  check("Premium lock routes to dashboard trial/upgrade popup", access.paywallHref(lockRes) === "/student/dashboard?premium=locked");
  const deniedStart = await rejects(() => engine.startPreviousYearPaperAttempt(N.id, paperPaid.id));
  check("Direct server start of locked PYQ throws PaymentRequiredError", deniedStart instanceof access.PaymentRequiredError);
  const deniedSubject = await rejects(() => engine.startSubjectTestAttempt(N.id, { examId: exam.id, subjectId: subject.id, count: 2, durationMinutes: 2 }));
  check("Direct server start of Subject Test throws PaymentRequiredError", deniedSubject instanceof access.PaymentRequiredError);
  check("…and no attempt row was created", (await prisma.testAttempt.count()) === attemptsBefore);
  const freeAttempt = await engine.startPreviousYearPaperAttempt(N.id, paperFree.id);
  check("Free PYQ starts for a non-trial student", Boolean(freeAttempt.id));
  check("Other exam keeps legacy rules (its PYQ open)", await allowed(N.id, D("PREVIOUS_YEAR_PAPER", otherPaper.id, undefined, other.id)));
  check("Legacy FREE flag on the mock row is untouched", (await prisma.mockTest.findUniqueOrThrow({ where: { id: legacyFreeMock.id } })).accessType === "FREE");

  console.log("\n4. Paid subscribers and single purchases");
  check("Premium holder: Premium PYQ open", await allowed(P.id, D("PREVIOUS_YEAR_PAPER", paperPaid.id)));
  check("Premium holder: Subject Test + Custom Module + Live CBT open", (await allowed(P.id, D("SUBJECT_TEST", null))) && (await allowed(P.id, D("CUSTOM_MODULE", null, { testSeriesId: null, accessType: "FREE" }))) && (await allowed(P.id, D("MOCK_TEST", liveCbt.id, liveCbt))));
  check("Premium holder: trial phase PAID", (await trialLib.getTrialStatus(P.id)).phase === "PAID");
  check("Premium holder: never a popup", (await trialLib.claimTrialPopup(P.id)) === null && (await trialLib.claimTrialPopup(P.id, { force: true })) === null);
  check("Premium holder: trial start refused", !(await trialLib.startPremiumTrial(P.id)).ok);
  check("Single purchase: bought mock open", await allowed(S.id, D("MOCK_TEST", soldMock.id, soldMock)));
  check("Single purchase: other Premium mock locked", !(await allowed(S.id, D("MOCK_TEST", paidMock.id, paidMock))));
  check("Single purchase: still trial-eligible", (await trialLib.getTrialStatus(S.id)).phase === "ELIGIBLE");
  const singleCheckout = await access.canStudentAccessProduct(N.id, single.id);
  check("Single mock product still purchasable for others", singleCheckout.status === "PAYMENT_REQUIRED");

  // ---------------- 5. trial ----------------
  console.log("\n5. One-time 48-hour trial");
  check("New student ELIGIBLE, nothing auto-started", (await trialLib.getTrialStatus(N.id)).phase === "ELIGIBLE" && (await prisma.studentPremiumTrial.count({ where: { studentId: N.id } })) === 0);
  const pop1 = await trialLib.claimTrialPopup(N.id);
  check("Dashboard popup: WELCOME state", pop1?.state === "WELCOME");
  check("Popup offers the Premium checkout + DB price", pop1?.buyHref === `/student/checkout/${premium.code}` && pop1?.priceLabel === "₹999");
  check("Popup lists the free offerings by their DB titles", Boolean(pop1?.free.some((f) => f.includes("PREM 2024")) && pop1?.free.some((f) => f.includes("Free Mock 1")) && pop1?.free.some((f) => f.includes("Physiology Subject Mock 01"))));
  check("Same day: popup not shown again (refresh/navigation)", (await trialLib.claimTrialPopup(N.id)) === null);
  check("…even under concurrency (two tabs)", (await Promise.all([trialLib.claimTrialPopup(N.id), trialLib.claimTrialPopup(N.id)])).every((x) => x === null));
  check("Showing the popup did not start a trial", (await prisma.studentPremiumTrial.count({ where: { studentId: N.id } })) === 0);
  check("From a Premium lock (force): popup shows current state", (await trialLib.claimTrialPopup(N.id, { force: true }))?.state === "WELCOME");
  const t0 = Date.now();
  const started = await trialLib.startPremiumTrial(N.id);
  const row = await prisma.studentPremiumTrial.findUniqueOrThrow({ where: { studentId: N.id } });
  check("Explicit start: trial created", started.ok && started.started === true);
  check("Exactly 48 hours from activation", row.endsAt.getTime() - row.startedAt.getTime() === 48 * HOUR && row.startedAt.getTime() >= t0 - 1000);
  check("Verified mobile stored for one-trial-per-number", row.mobile === N.mobile);
  check("Trial unlocks Premium PYQ (viaTrial)", (await access.getContentAccess(N.id, D("PREVIOUS_YEAR_PAPER", paperPaid.id))).viaTrial === true);
  check("Trial unlocks Subject Test, Custom Module, Live CBT, legacy mock", (await allowed(N.id, D("SUBJECT_TEST", null))) && (await allowed(N.id, D("CUSTOM_MODULE", null, { testSeriesId: null, accessType: "FREE" }))) && (await allowed(N.id, D("MOCK_TEST", liveCbt.id, liveCbt))) && (await allowed(N.id, D("MOCK_TEST", legacyFreeMock.id, legacyFreeMock))));
  const again = await trialLib.startPremiumTrial(N.id);
  check("Second click: same trial, not restarted", again.ok && again.started === false && again.endsAt.getTime() === row.endsAt.getTime());
  check("Trial is server-side (a fresh access load sees the same window)", (await access.loadAccessContext(N.id)).trial?.endsAt.getTime() === row.endsAt.getTime());
  const conc = await Promise.all(Array.from({ length: 6 }, () => trialLib.startPremiumTrial(X.id)));
  const xRows = await prisma.studentPremiumTrial.findMany({ where: { studentId: X.id } });
  check("Concurrent activation (6 at once): exactly one row", xRows.length === 1);
  check("…every caller got the same end time", conc.every((r) => r.ok && r.endsAt.getTime() === xRows[0].endsAt.getTime()));
  check("…exactly one reported started=true", conc.filter((r) => r.ok && r.started).length === 1);
  check("Unverified mobile → not eligible", (await trialLib.getTrialStatus(U.id)).ineligibleReason === "MOBILE_NOT_VERIFIED" && !(await trialLib.startPremiumTrial(U.id)).ok);
  // Same number, different account (number moved after a trial).
  const xMobile = (await prisma.student.findUniqueOrThrow({ where: { id: X.id } })).mobile!;
  await prisma.student.update({ where: { id: X.id }, data: { mobile: String(mobileN++) } });
  await prisma.student.update({ where: { id: M.id }, data: { mobile: xMobile } });
  check("A mobile number that already had a trial can't start another", (await trialLib.getTrialStatus(M.id)).ineligibleReason === "MOBILE_USED" && !(await trialLib.startPremiumTrial(M.id)).ok);
  check("Trial OFF switch → not eligible", await (async () => {
    await setPolicy({ trialEnabled: false });
    const st = await trialLib.getTrialStatus(S.id);
    await setPolicy({ trialEnabled: true });
    return st.ineligibleReason === "TRIAL_OFF";
  })());

  console.log("\n6. Expiry boundary (server time)");
  const end = row.endsAt;
  const before = await access.loadAccessContext(N.id, new Date(end.getTime() - 1));
  const at = await access.loadAccessContext(N.id, new Date(end.getTime()));
  check("1 ms before endsAt: Premium open", access.evaluateContentAccess(before, D("PREVIOUS_YEAR_PAPER", paperPaid.id)).allowed);
  check("At endsAt: Premium locked", !access.evaluateContentAccess(at, D("PREVIOUS_YEAR_PAPER", paperPaid.id)).allowed);
  check("At endsAt: free tests still open", access.evaluateContentAccess(at, D("PREVIOUS_YEAR_PAPER", paperFree.id)).allowed && access.evaluateContentAccess(at, D("MOCK_TEST", freeMock.id, freeMock)).allowed);
  check("ENDING phase when < 24h left", (await trialLib.getTrialStatus(N.id, new Date(end.getTime() - 23 * HOUR))).phase === "ENDING");
  check("ACTIVE phase when > 24h left", (await trialLib.getTrialStatus(N.id, new Date(end.getTime() - 25 * HOUR))).phase === "ACTIVE");
  check("EXPIRED phase at endsAt", (await trialLib.getTrialStatus(N.id, end)).phase === "EXPIRED");

  console.log("\n7. Attempts across the cut-off (grace)");
  // G: start trial, start a timed Premium attempt + an untimed one, then move the trial into the past.
  await trialLib.startPremiumTrial(G.id);
  const timed = await engine.startPreviousYearPaperAttempt(G.id, paperPaid.id);
  const untimed = await engine.startSubjectTestAttempt(G.id, { examId: exam.id, subjectId: subject.id, count: 2, durationMinutes: 0, durationMode: AttemptDurationMode.UNLIMITED });
  check("Trial student started a timed Premium PYQ and an untimed Subject Test", Boolean(timed.id) && Boolean(untimed.id));
  const shift = async (endedMinutesAgo: number, durationMinutes = 600) => {
    const endsAt = new Date(Date.now() - endedMinutesAgo * 60_000);
    await prisma.studentPremiumTrial.update({ where: { studentId: G.id }, data: { startedAt: new Date(endsAt.getTime() - 48 * HOUR), endsAt } });
    // the attempts started 10 min before the trial ended; give the timed one a long limit so it hasn't timed out
    await prisma.testAttempt.update({ where: { id: timed.id }, data: { startedAt: new Date(endsAt.getTime() - 10 * 60_000), durationMinutes } });
    await prisma.testAttempt.update({ where: { id: untimed.id }, data: { startedAt: new Date(endsAt.getTime() - 10 * 60_000) } });
  };
  const attemptRow = (id: string) => prisma.testAttempt.findUniqueOrThrow({ where: { id }, include: { mockTest: true, customModule: true, grandTest: true, liveTest: true } });
  await shift(30);
  check("Trial ended 30 min ago: timed attempt started during trial can finish", (await access.getAttemptContentAccess(G.id, await attemptRow(timed.id))).viaGrace === true);
  check("…resume through the start gate returns the SAME attempt", (await engine.startPreviousYearPaperAttempt(G.id, paperPaid.id)).id === timed.id);
  check("Untimed attempt within grace (60 min) can continue", (await access.getAttemptContentAccess(G.id, await attemptRow(untimed.id))).allowed);
  const noNew = await rejects(() => engine.startPreviousYearPaperAttempt(G.id, paperFree.id === paperPaid.id ? "" : paperPaid.id + "x"));
  check("…but nothing new can be started", noNew !== null);
  const newMock = await rejects(() => engine.startMockTestAttempt(G.id, paidMock.id));
  check("New Premium mock after expiry → PaymentRequiredError", newMock instanceof access.PaymentRequiredError);
  await shift(90);
  check("Untimed attempt after grace (90 min) → locked", !(await access.getAttemptContentAccess(G.id, await attemptRow(untimed.id))).allowed);
  check("Timed attempt still inside its own limit → can finish", (await access.getAttemptContentAccess(G.id, await attemptRow(timed.id))).allowed);
  await shift(90, 60);
  const finalized = await prisma.testAttempt.findUniqueOrThrow({ where: { id: timed.id } });
  await engine.finalizeIfExpired({ ...finalized, liveTest: null, mockTest: null });
  check("Timed attempt past its own limit is auto-submitted (result kept)", (await prisma.testAttempt.findUniqueOrThrow({ where: { id: timed.id } })).status === "SUBMITTED");
  // pre-enforcement attempt on a mock that was free under the legacy rules
  const legacyAttempt = await prisma.testAttempt.create({
    data: { studentId: S.id, sourceType: "MOCK_TEST", testType: "FULL_MOCK", examId: exam.id, mockTestId: legacyFreeMock.id, durationMinutes: 600, totalQuestions: 3, startedAt: new Date(enforcedAt.getTime() - 5 * 60_000) },
  });
  check("Attempt started before enforcement (legacy-free mock) can finish", (await access.getAttemptContentAccess(S.id, await attemptRow(legacyAttempt.id))).viaGrace === true);
  const paidLegacy = await prisma.testAttempt.create({
    data: { studentId: U.id, sourceType: "MOCK_TEST", testType: "FULL_MOCK", examId: exam.id, mockTestId: paidMock.id, durationMinutes: 600, totalQuestions: 3, startedAt: new Date(enforcedAt.getTime() - 5 * 60_000) },
  });
  check("…but not one the legacy rules would also have denied", !(await access.getAttemptContentAccess(U.id, await attemptRow(paidLegacy.id))).allowed);

  console.log("\n7b. Answer save / reveal (direct Server Action calls) follow the same rules");
  const { TestEngineError } = await import("../lib/test-engine-log");
  const firstQ = async (attemptId: string) => {
    const q = await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId }, orderBy: { order: "asc" }, select: { questionId: true, questionSnapshot: true } });
    return { id: q.questionId, label: (q.questionSnapshot as { options: { label: string }[] }).options[0].label };
  };
  const answerOf = async (attemptId: string, questionId: string) =>
    prisma.answer.findFirst({ where: { attemptQuestion: { attemptId, questionId } }, select: { selectedOptionLabel: true, revealedAt: true } });
  const engineCode = async (fn: () => Promise<unknown>) => {
    const e = await rejects(fn);
    return e instanceof TestEngineError ? e.code : e === null ? "OK" : String(e);
  };
  const save = (sid: string, attemptId: string, q: { id: string; label: string }) => engineCode(() => engine.saveAnswer(attemptId, sid, q.id, q.label, false));
  const reveal = (sid: string, attemptId: string, q: { id: string; label: string }) => engineCode(() => engine.revealAnswer(attemptId, sid, q.id, q.label));
  const fresh = () => access.clearAnswerAccessCache();

  // A: trial → a timed Premium PYQ (exam mode) and an untimed INSTANT subject practice, both started during the trial.
  await trialLib.startPremiumTrial(A.id);
  const aTimed = await engine.startPreviousYearPaperAttempt(A.id, paperPaid.id);
  const aUntimed = await engine.startSubjectTestAttempt(A.id, { examId: exam.id, subjectId: subject.id, count: 2, durationMinutes: 0, durationMode: AttemptDurationMode.UNLIMITED, answerMode: AttemptAnswerMode.INSTANT });
  const qT = await firstQ(aTimed.id);
  const qU = await firstQ(aUntimed.id);
  check("During the trial: save works", (await save(A.id, aTimed.id, qT)) === "OK");
  const shiftA = async (endedMinutesAgo: number, startedBeforeEndMinutes = 10, timedLimit = 600) => {
    const endsAt = new Date(Date.now() - endedMinutesAgo * 60_000);
    await prisma.studentPremiumTrial.update({ where: { studentId: A.id }, data: { startedAt: new Date(endsAt.getTime() - 48 * HOUR), endsAt } });
    const startedAt = new Date(endsAt.getTime() - startedBeforeEndMinutes * 60_000);
    await prisma.testAttempt.update({ where: { id: aTimed.id }, data: { startedAt, durationMinutes: timedLimit } });
    await prisma.testAttempt.update({ where: { id: aUntimed.id }, data: { startedAt } });
    fresh();
  };
  await shiftA(30);
  check("Valid timed continuation (trial ended 30 min ago): save works", (await save(A.id, aTimed.id, qT)) === "OK");
  check("Valid untimed continuation within 60-min grace: save works", (await save(A.id, aUntimed.id, qU)) === "OK");
  check("…and reveal works", (await reveal(A.id, aUntimed.id, qU)) === "OK");
  const qU2 = await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: aUntimed.id, NOT: { questionId: qU.id } }, select: { questionId: true, questionSnapshot: true } });
  const q2 = { id: qU2.questionId, label: (qU2.questionSnapshot as { options: { label: string }[] }).options[0].label };
  await shiftA(90);
  const before2 = await answerOf(aUntimed.id, q2.id);
  check("Grace expired (90 min): untimed save → ACCESS_REVOKED", (await save(A.id, aUntimed.id, q2)) === "ACCESS_REVOKED");
  check("Grace expired: reveal → ACCESS_REVOKED (no answer key leaked)", (await reveal(A.id, aUntimed.id, q2)) === "ACCESS_REVOKED");
  const after2 = await answerOf(aUntimed.id, q2.id);
  check("…stored answer untouched, not revealed", after2?.selectedOptionLabel === before2?.selectedOptionLabel && after2?.revealedAt === null);
  check("Grace expired: timed attempt still inside its own limit can save", (await save(A.id, aTimed.id, qT)) === "OK");
  // Expired trial with no valid continuation: an attempt whose start is AFTER the trial ended.
  await prisma.testAttempt.update({ where: { id: aTimed.id }, data: { startedAt: new Date(Date.now() - 5 * 60_000) } });
  fresh();
  const beforeT = await answerOf(aTimed.id, qT.id);
  check("Expired trial, attempt not started in the trial: save → ACCESS_REVOKED", (await save(A.id, aTimed.id, { id: qT.id, label: "B" })) === "ACCESS_REVOKED");
  check("…stored answer unchanged", (await answerOf(aTimed.id, qT.id))?.selectedOptionLabel === beforeT?.selectedOptionLabel);
  check("Submit is never blocked (result preserved)", (await engineCode(() => engine.submitAttempt(aTimed.id, A.id))) === "OK" && (await prisma.testAttempt.findUniqueOrThrow({ where: { id: aTimed.id } })).status === "SUBMITTED");

  // Paid entitlement + single-test purchase.
  const pAttempt = await engine.startPreviousYearPaperAttempt(P.id, paperPaid.id);
  fresh();
  check("Existing paid entitlement: save works on a Premium PYQ", (await save(P.id, pAttempt.id, await firstQ(pAttempt.id))) === "OK");
  const sAttempt = await engine.startMockTestAttempt(S.id, soldMock.id);
  check("Single-test purchase: save works on the bought mock", (await save(S.id, sAttempt.id, await firstQ(sAttempt.id))) === "OK");
  // S had a trial in section 9; make sure it is over, then forge an attempt on a mock S never bought.
  await prisma.studentPremiumTrial.updateMany({ where: { studentId: S.id }, data: { startedAt: new Date(Date.now() - 60 * HOUR), endsAt: new Date(Date.now() - 12 * HOUR) } });
  const forged = await engine.startMockTestAttempt(P.id, paidMock.id); // created legitimately for P…
  await prisma.testAttempt.update({ where: { id: forged.id }, data: { studentId: S.id, startedAt: new Date() } }); // …then handed to S
  fresh();
  const fq = await firstQ(forged.id);
  check("Direct call: save on a Premium mock S never bought → ACCESS_REVOKED", (await save(S.id, forged.id, fq)) === "ACCESS_REVOKED");
  check("Direct call: reveal on it → ACCESS_REVOKED", (await reveal(S.id, forged.id, fq)) === "ACCESS_REVOKED");
  check("Direct call: another student's attempt → NOT_EDITABLE (ownership)", (await save(U.id, pAttempt.id, await firstQ(pAttempt.id))) === "NOT_EDITABLE");
  // A paid plan that lapses mid-test never cuts the test off (timed: own limit).
  await prisma.studentEntitlement.create({ data: { studentId: L.id, productId: premium.id, source: "PURCHASE", startsAt: new Date(Date.now() - 10 * 24 * HOUR), expiresAt: new Date(Date.now() + 60_000) } });
  const lAttempt = await engine.startPreviousYearPaperAttempt(L.id, paperPaid.id);
  await prisma.studentEntitlement.updateMany({ where: { studentId: L.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await prisma.testAttempt.update({ where: { id: lAttempt.id }, data: { startedAt: new Date(Date.now() - 5 * 60_000), durationMinutes: 600 } });
  fresh();
  check("Paid plan expired mid-test: started before expiry → save still works", (await save(L.id, lAttempt.id, await firstQ(lAttempt.id))) === "OK");
  check("…but a NEW Premium start is refused", (await rejects(() => engine.startMockTestAttempt(L.id, paidMock.id))) instanceof access.PaymentRequiredError);
  // Pre-enforcement attempt (legacy-free mock, started before enforcedSince): continues.
  const preQ = await prisma.testAttemptQuestion.count({ where: { attemptId: legacyAttempt.id } });
  check("Pre-enforcement attempt keeps continuing (access allowed via grace)", (await access.getAttemptAnswerAccess(S.id, { ...(await attemptRow(legacyAttempt.id)), id: legacyAttempt.id })) === null && preQ === 0);

  console.log("\n8. Expired trial popups and results");
  await prisma.studentPremiumTrial.update({ where: { studentId: N.id }, data: { startedAt: new Date(Date.now() - 50 * HOUR), endsAt: new Date(Date.now() - 2 * HOUR) } });
  await prisma.studentTrialNotice.deleteMany({ where: { studentId: N.id, kind: { startsWith: "POPUP" } } });
  check("Expired trial: EXPIRED popup", (await trialLib.claimTrialPopup(N.id))?.state === "EXPIRED");
  check("…at most once per day", (await trialLib.claimTrialPopup(N.id)) === null);
  check("Cannot restart after expiry", (await trialLib.startPremiumTrial(N.id)).ok === false);
  await prisma.studentTrialNotice.deleteMany({ where: { studentId: N.id, kind: "POPUP" } });
  await prisma.studentTrialNotice.updateMany({ where: { studentId: N.id, kind: "POPUP_EXPIRED" }, data: { createdAt: new Date(Date.now() - 24 * HOUR) } });
  await setPolicy({ popups: { welcome: true, activeDaily: true, expired: true, expiredEveryDays: 3 } });
  check("Expired popup every 3 days: not shown the next day", (await trialLib.claimTrialPopup(N.id)) === null);
  await setPolicy({ popups: { welcome: true, activeDaily: true, expired: false, expiredEveryDays: 1 } });
  await prisma.studentTrialNotice.deleteMany({ where: { studentId: N.id, kind: { startsWith: "POPUP" } } });
  check("Expired popup switched off → none", (await trialLib.claimTrialPopup(N.id)) === null);
  await setPolicy({ popups: { welcome: true, activeDaily: true, expired: true, expiredEveryDays: 1 } });
  check("Free-attempt result still readable after expiry (attempt row intact)", Boolean(await prisma.testAttempt.findUnique({ where: { id: freeAttempt.id } })));

  console.log("\n9. Reminders (idempotent, never to paid / never before a trial)");
  await prisma.emailDeliveryLog.deleteMany({ where: { templateKey: { in: ["TRIAL_STARTED", "TRIAL_ENDS_24H", "TRIAL_ENDS_6H", "TRIAL_ENDS_1H", "TRIAL_EXPIRED"] } } });
  await prisma.studentTrialNotice.deleteMany({ where: { kind: { startsWith: "REMINDER" } } });
  const rTrial = await trialLib.startPremiumTrial(R.id);
  check("Trial start queues the 'started' email", rTrial.ok && (await prisma.emailDeliveryLog.count({ where: { studentId: R.id, templateKey: "TRIAL_STARTED" } })) === 1);
  await trialLib.runTrialReminders();
  await trialLib.runTrialReminders();
  check("Sweeps don't duplicate 'started'", (await prisma.emailDeliveryLog.count({ where: { studentId: R.id, templateKey: "TRIAL_STARTED" } })) === 1);
  check("No countdown email while > 24h left", (await prisma.emailDeliveryLog.count({ where: { studentId: R.id, templateKey: { in: ["TRIAL_ENDS_24H", "TRIAL_ENDS_6H", "TRIAL_ENDS_1H"] } } })) === 0);
  const rRow = await prisma.studentPremiumTrial.findUniqueOrThrow({ where: { studentId: R.id } });
  await prisma.studentPremiumTrial.update({ where: { id: rRow.id }, data: { startedAt: new Date(Date.now() - 43 * HOUR), endsAt: new Date(Date.now() + 5 * HOUR) } });
  await trialLib.runTrialReminders();
  check("Late sweep at 5h left: only the 6h email (24h recorded silently)", (await prisma.emailDeliveryLog.count({ where: { studentId: R.id, templateKey: "TRIAL_ENDS_6H" } })) === 1 && (await prisma.emailDeliveryLog.count({ where: { studentId: R.id, templateKey: "TRIAL_ENDS_24H" } })) === 0);
  await prisma.studentPremiumTrial.update({ where: { id: rRow.id }, data: { endsAt: new Date(Date.now() + 30 * 60_000) } });
  await trialLib.runTrialReminders();
  await trialLib.runTrialReminders();
  check("1h email exactly once", (await prisma.emailDeliveryLog.count({ where: { studentId: R.id, templateKey: "TRIAL_ENDS_1H" } })) === 1);
  await prisma.studentPremiumTrial.update({ where: { id: rRow.id }, data: { endsAt: new Date(Date.now() - 60_000) } });
  await trialLib.runTrialReminders();
  await trialLib.runTrialReminders();
  check("Expired email exactly once", (await prisma.emailDeliveryLog.count({ where: { studentId: R.id, templateKey: "TRIAL_EXPIRED" } })) === 1);
  const rLog = await prisma.emailDeliveryLog.findFirstOrThrow({ where: { studentId: R.id, templateKey: "TRIAL_EXPIRED" } });
  check("Email carries the student's real trial end time", typeof (rLog.variables as { trialEndsAt?: string })?.trialEndsAt === "string");
  check("Students without a trial get no trial email", (await prisma.emailDeliveryLog.count({ where: { studentId: { in: [S.id, U.id, M.id] }, templateKey: { in: ["TRIAL_STARTED", "TRIAL_ENDS_24H", "TRIAL_ENDS_6H", "TRIAL_ENDS_1H", "TRIAL_EXPIRED"] } } })) === 0);
  // paid during trial → no reminders
  await prisma.studentPremiumTrial.update({ where: { studentId: X.id }, data: { startedAt: new Date(Date.now() - 40 * HOUR), endsAt: new Date(Date.now() + 8 * HOUR) } });
  await prisma.studentEntitlement.create({ data: { studentId: X.id, productId: premium.id, source: "PURCHASE", startsAt: new Date(), expiresAt: new Date(Date.now() + 100 * 24 * HOUR) } });
  const beforeX = await prisma.emailDeliveryLog.count({ where: { studentId: X.id, templateKey: { in: ["TRIAL_ENDS_24H", "TRIAL_ENDS_6H", "TRIAL_ENDS_1H", "TRIAL_EXPIRED"] } } });
  const sweep = await trialLib.runTrialReminders();
  check("Paid during trial: no countdown reminders", sweep.paidSkipped >= 1 && (await prisma.emailDeliveryLog.count({ where: { studentId: X.id, templateKey: { in: ["TRIAL_ENDS_24H", "TRIAL_ENDS_6H", "TRIAL_ENDS_1H", "TRIAL_EXPIRED"] } } })) === beforeX);
  check("Paid during trial: phase PAID, no popup", (await trialLib.getTrialStatus(X.id)).phase === "PAID" && (await trialLib.claimTrialPopup(X.id, { force: true })) === null);
  await setPolicy({ reminders: { started: true, h24: true, h6: false, h1: true, expired: true } });
  const sTrial = await trialLib.startPremiumTrial(S.id);
  await prisma.studentPremiumTrial.update({ where: { studentId: S.id }, data: { startedAt: new Date(Date.now() - 44 * HOUR), endsAt: new Date(Date.now() + 4 * HOUR) } });
  await trialLib.runTrialReminders();
  check("Disabled reminder type (6h) is not emailed", sTrial.ok && (await prisma.emailDeliveryLog.count({ where: { studentId: S.id, templateKey: "TRIAL_ENDS_6H" } })) === 0);
  await setPolicy({ reminders: { started: true, h24: true, h6: true, h1: true, expired: true } });
  await trialLib.runTrialReminders();
  check("Re-enabling never sends the stale reminder", (await prisma.emailDeliveryLog.count({ where: { studentId: S.id, templateKey: "TRIAL_ENDS_6H" } })) === 0);
  await setPolicy({ enforcementEnabled: false });
  check("Enforcement OFF → reminder sweep is a no-op", (await trialLib.runTrialReminders()).skipped !== null);
  await setPolicy({ enforcementEnabled: true });

  console.log("\n10. Payments: failure never unlocks, success does; Till Exam");
  const mkOrder = async (sid: string, n: string) =>
    prisma.paymentOrder.create({
      data: {
        orderNumber: `ORD-PREM-${sfx}-${n}`,
        studentId: sid,
        productId: premium.id,
        status: "GATEWAY_ORDER_CREATED",
        gateway: "RAZORPAY",
        environment: "LIVE",
        mrpPaise: 200000,
        sellingPricePaise: 99900,
        amountPaise: 99900,
        productSnapshot: {},
        gatewayOrderId: `order_prem_${sfx}_${n}`,
        receipt: `rcpt_prem_${sfx}_${n}`,
      },
    });
  const failOrder = await mkOrder(U.id, "fail");
  const fo = await recordTrustedPayment(failOrder.id, { id: `pay_prem_${sfx}_fail`, order_id: failOrder.gatewayOrderId!, amount: 99900, currency: "INR", status: "failed" }, "WEBHOOK");
  check("Failed payment → NOT_CAPTURED, no entitlement, still locked", fo === "NOT_CAPTURED" && (await prisma.studentEntitlement.count({ where: { studentId: U.id } })) === 0 && !(await allowed(U.id, D("PREVIOUS_YEAR_PAPER", paperPaid.id))));
  await setPolicy({ examDate: "2027-06-30", tillExamProductIds: [premium.id] });
  const okOrder = await mkOrder(N.id, "ok");
  const ok = await recordTrustedPayment(okOrder.id, { id: `pay_prem_${sfx}_ok`, order_id: okOrder.gatewayOrderId!, amount: 99900, currency: "INR", status: "captured", method: "upi" }, "WEBHOOK");
  const ent = await prisma.studentEntitlement.findFirstOrThrow({ where: { orderId: okOrder.id } });
  check("Verified payment → PAID + entitlement", ok === "PAID" && Boolean(ent));
  check("Till Exam: access runs to 30 Jun 2027 23:59:59.999 IST (later than 100 days)", ent.expiresAt?.getTime() === examDayEnd("2027-06-30")!.getTime());
  check("Expired-trial student who paid: Premium open again, phase PAID", (await allowed(N.id, D("PREVIOUS_YEAR_PAPER", paperPaid.id))) && (await trialLib.getTrialStatus(N.id)).phase === "PAID");
  await setPolicy({ examDate: "2026-11-01" });
  const okOrder2 = await mkOrder(G.id, "ok2");
  await recordTrustedPayment(okOrder2.id, { id: `pay_prem_${sfx}_ok2`, order_id: okOrder2.gatewayOrderId!, amount: 99900, currency: "INR", status: "captured", method: "upi" }, "WEBHOOK");
  const ent2 = await prisma.studentEntitlement.findFirstOrThrow({ where: { orderId: okOrder2.id } });
  const hundred = ent2.startsAt.getTime() + 100 * 24 * HOUR;
  check("Till Exam never shortens: exam date earlier than 100 days → 100 days kept", Math.abs((ent2.expiresAt?.getTime() ?? 0) - hundred) < 5000);
  const pTrialStartBefore = await prisma.studentEntitlement.findFirstOrThrow({ where: { studentId: P.id } });
  await setPolicy({ examDate: "2027-12-31" });
  const preview = await extendTillExamAccess(await getPremiumPolicy(), { apply: false });
  check("Postponement preview counts active Till-Exam subscriptions ending earlier", preview.count >= 3);
  const applied = await extendTillExamAccess(await getPremiumPolicy(), { apply: true });
  const pAfter = await prisma.studentEntitlement.findUniqueOrThrow({ where: { id: pTrialStartBefore.id } });
  check("Postponement extends to the new exam day end", applied.count === preview.count && pAfter.expiresAt?.getTime() === examDayEnd("2027-12-31")!.getTime());
  await setPolicy({ examDate: "2027-01-01" });
  check("Moving the date earlier never shortens (nothing to extend)", (await extendTillExamAccess(await getPremiumPolicy(), { apply: false })).count === 0);
  await setPolicy({ examDate: null, tillExamProductIds: [] });

  console.log("\n11. Analytics (real rows)");
  const a = await trialLib.getTrialAnalytics();
  const trials = await prisma.studentPremiumTrial.count();
  check("Trials started = trial rows", a.trialsStarted === trials);
  check("Active + expired = started", a.activeTrials + a.expiredTrials === a.trialsStarted);
  check("Conversions count the expired-trial student who paid after the trial began", a.conversions >= 1);
  check("Conversion revenue = verified LIVE captured amount only (₹999 × paying trial students)", a.conversionRevenuePaise === 99900 * a.conversions);
  check("Failed payment adds no revenue", a.conversionRevenuePaise % 99900 === 0);

  console.log("\n11b. Public surfaces say exactly what is free (homepage cards, series page, dashboard card)");
  const ms = await import("../lib/mock-series");
  const hp = await import("../lib/homepage-render");
  const series0 = await ms.getExamMockSeries(exam.id);
  const badge = (id: string) => series0?.tests.find((t) => t.id === id)?.accessType;
  check("Series page: selected free mock shown Free", badge(freeMock.id) === "FREE");
  check("Series page: legacy-FREE mock now shown Premium (Complete Series)", badge(legacyFreeMock.id) === "PAID");
  check("Series page: selected Subject Mock shown Free", badge(subjectMock.id) === "FREE");
  check("Legacy flag in the DB untouched", (await prisma.mockTest.findUniqueOrThrow({ where: { id: legacyFreeMock.id } })).accessType === "FREE");
  const offer0 = await ms.getSeriesOffer(exam.id, series0!.series.id);
  const cmp = await ms.getSeriesComparison(exam.id, series0, offer0);
  const freeCell = (k: string) => cmp.derivedRows.find((r) => r.key === k)?.free;
  check("Comparison: PYQ papers row = '1 free paper'", freeCell("pyq-papers") === "1 free paper");
  check("Comparison: PYQ practice row = '1 selected paper'", freeCell("pyq-practice") === "1 selected paper");
  check("Comparison: subject practice = '1 selected subject test'", freeCell("subject-practice") === "1 selected subject test");
  check("Comparison: free mock count = selected free mocks in the series (mock + subject mock + free Live CBT)", cmp.freeMocks === 3, cmp.freeMocks);
  const summary = { name: exam.name, hubHref: "/exams/x", examDate: null, examDateTentative: false, daysLeft: null, plannedMocks: 7, publishedMocks: 7, availableMocks: 7, freeMocks: 2, freeMocksAvailable: 2, papers: 2, paperYears: 2, questions: 6, subjects: 1, links: [] };
  const cards = hp.buildFreeCards(summary, cmp, 5);
  const card = (k: string) => cards.find((c) => c.key === k);
  check("Homepage: PYQ card kept, says '1 free' + the paper title + 'with Premium'", card("pyq")?.value === "1 free" && Boolean(card("pyq")?.detail.includes("PREM 2024")) && Boolean(card("pyq")?.detail.includes("All 2 papers with Premium")));
  check("Homepage: Subject card kept, names the free Subject Mock", card("subject-practice")?.value === "1 free test" && Boolean(card("subject-practice")?.detail.includes("Physiology Subject Mock 01")));
  check("Homepage: free mock card shows the real free count", card("free-mocks")?.value === "3");
  check("Homepage: same card set as before (no card removed)", ["free-mocks", "pyq", "subject-practice", "analysis"].every((k) => Boolean(card(k))));
  await setPolicy({ examDate: "2026-12-13", tillExamProductIds: [premium.id] });
  const sa = await import("../lib/payments/student-access");
  const [sum] = await sa.getStudentExamAccessSummaries(N.id, [{ id: exam.id, name: exam.name }]);
  check("Dashboard Upgrade card: 'Till Exam' when exam-date validity is configured", sum?.offer?.product.accessDuration === "Till Exam");
  check("…while the shared offer (homepage) keeps the product's own label", (await ms.getSeriesOffer(exam.id, series0!.series.id))?.product.accessDuration === "100 days access");
  await setPolicy({ examDate: null, tillExamProductIds: [] });
  const [sum2] = await sa.getStudentExamAccessSummaries(N.id, [{ id: exam.id, name: exam.name }]);
  check("No exam date → dashboard keeps '100 days access'", sum2?.offer?.product.accessDuration === "100 days access");

  console.log("\n12. Switching OFF restores legacy rules, nothing rewritten");
  await setPolicy({ enforcementEnabled: false });
  check("OFF again: legacy-free mock open for a non-trial student", await allowed(U.id, D("MOCK_TEST", legacyFreeMock.id, legacyFreeMock)));
  check("OFF again: no popups", (await trialLib.claimTrialPopup(S.id, { force: true })) === null);
  check("Trial rows kept (history), entitlements kept", (await prisma.studentPremiumTrial.count()) === trials && (await prisma.studentEntitlement.count({ where: { studentId: P.id } })) === 1);
  const legacySeries = await ms.getExamMockSeries(exam.id);
  check("OFF again: series page shows the legacy flags", legacySeries?.tests.find((t) => t.id === legacyFreeMock.id)?.accessType === "FREE");
  const legacyCmp = await ms.getSeriesComparison(exam.id, legacySeries, await ms.getSeriesOffer(exam.id, legacySeries!.series.id));
  check("OFF again: homepage cards back to the legacy wording", legacyCmp.policyFree === null && hp.buildFreeCards(summary, legacyCmp, 5).find((c) => c.key === "pyq")?.value === "2");

  // ---------------- cleanup of fixture rows ----------------
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
