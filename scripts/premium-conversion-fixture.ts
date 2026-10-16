/**
 * Fixture for scripts/verify-premium-conversion.ts (server-side review
 * authorization) and scripts/verify-premium-conversion-ui.mjs (browser:
 * Unlock buttons, dashboard Upgrade to Premium card, locked review, PWA
 * install CTA).
 *
 *   DATABASE_URL=<scratch *premium*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-conversion-fixture.ts setup > <dir>/pcqa.json
 *   DATABASE_URL=<scratch *premium*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-conversion-fixture.ts layout <default|prod-like|upgrade-hidden>
 *   DATABASE_URL=<scratch *premium*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-conversion-fixture.ts cleanup
 *
 * Personas (all enrolled in one PCQA exam under Premium enforcement):
 *   free         never started the trial; one SUBMITTED attempt of the free 2024 paper
 *   trialActive  trial running; SUBMITTED attempt of the Premium 2020 paper
 *   trialExpired took the Premium paper (and the free one) DURING the trial, which then ended;
 *                saved one Premium question
 *   paid         active Premium entitlement; SUBMITTED Premium paper attempt
 *   paidExpired  Premium entitlement that has expired; SUBMITTED Premium paper attempt from before
 *   other        no attempts (ownership checks)
 *   ineligible   never started a trial, but its mobile already used one (MOBILE_USED)
 *
 * Attempts are created through the real engine (lib/test-attempt.ts), then
 * the trial / entitlement windows are moved into the past — exactly what
 * happens to a real student when time passes. Refuses to touch a database
 * whose name doesn't contain "premium". No network call is made.
 */
import "dotenv/config";
import { StudentAuthProvider, QuestionDifficulty, QuestionStatus } from "@prisma/client";
import { encode } from "next-auth/jwt";

if (!/premium/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *premium* scratch database.");
  process.exit(2);
}

const TAG = "PCQA";
const EMAIL_DOMAIN = "@pcqa.example.test";
const HOUR = 3_600_000;
const POLICY_KEY = "access.premium_policy";
const LAYOUT_KEY = "website.student_dashboard_layout";
/** Production's saved block order on 2026-10-16 (Access & Subscription near the bottom), without the new block. */
const PROD_LIKE_LAYOUT = [
  "live-cbt-promotion", "performance-summary", "overall-rank", "practice-omr", "custom-module", "mock-tests", "previous-year-papers",
  "analytics-progress", "subject-test", "test-schedule", "test-on-the-go", "subjects", "continue-attempt", "recent-activity",
  "weak-topics", "student-reviews", "access-status", "subscription-status", "install-app", "share-review", "telegram-channel",
].map((id) => ({ id, visible: true }));

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { bumpPremiumPolicyCache } = await import("../lib/premium-policy");
  const { bumpPaymentSettingsCache } = await import("../lib/payments/settings");
  const { encryptSecret } = await import("../lib/secret-cipher");

  async function cleanup() {
    const exams = await prisma.exam.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
    const examIds = exams.map((e) => e.id);
    const students = await prisma.student.findMany({ where: { email: { endsWith: EMAIL_DOMAIN } }, select: { id: true } });
    const studentIds = students.map((s) => s.id);
    await prisma.savedQuestion.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.answer.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } }).catch(() => undefined);
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } }).catch(() => undefined);
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentPremiumTrial.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentTrialNotice.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentEntitlement.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentDevice.deleteMany({ where: { studentId: { in: studentIds } } }).catch(() => undefined);
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.product.deleteMany({ where: { code: { startsWith: "pcqa-" } } });
    await prisma.mockTestQuestion.deleteMany({ where: { mockTest: { examId: { in: examIds } } } });
    await prisma.mockTest.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.testSeries.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.questionOption.deleteMany({ where: { question: { examId: { in: examIds } } } });
    await prisma.question.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.examSubject.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.subject.deleteMany({ where: { originExamId: { in: examIds } } });
    await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
    await prisma.setting.deleteMany({ where: { key: { in: [POLICY_KEY, LAYOUT_KEY] } } });
  }

  async function setup() {
    await cleanup();
    await prisma.setting.upsert({ where: { key: "payments.mode" }, update: { value: { mode: "PAID" } }, create: { key: "payments.mode", value: { mode: "PAID" } } });
    // Fake TEST-environment gateway so checkout links render; no request ever reaches Razorpay.
    const rzp = { enabled: true, environment: "TEST", test: { keyId: "rzp_test_PCQA00000000", keySecretCipher: encryptSecret("pcqa-not-a-real-secret") } };
    await prisma.setting.upsert({ where: { key: "api.razorpay" }, update: { value: rzp }, create: { key: "api.razorpay", value: rzp } });
    bumpPaymentSettingsCache();

    const exam = await prisma.exam.create({
      data: { name: "PCQA MEDICAL OFFICER EXAM 2026", code: `${TAG}-A`, isActive: true, order: -6, publicSlug: "pcqa-mo", publicPageEnabled: true, durationMinutes: 120 },
    });
    const subject = await prisma.subject.create({
      data: { name: "PCQA Physiology", originExamId: exam.id, nameKey: `fixture:${exam.id}:pcqa-physiology`, examLinks: { create: { examId: exam.id, displayOrder: 0 } } },
    });
    const paperFree = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "PCQA MO 2024", durationMinutes: 30 } });
    const paperPaid = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2020, title: "PCQA MO 2020", durationMinutes: 30 } });
    const qFree: string[] = [];
    const qPaid: string[] = [];
    const stamp = Date.now().toString(36);
    for (let i = 1; i <= 6; i++) {
      const paid = i > 3;
      const q = await prisma.question.create({
        data: {
          examId: exam.id,
          subjectId: subject.id,
          code: `Q-PCQA-${i}-${stamp}`,
          // Distinctive markers: the UI suite greps raw responses for them.
          text: paid ? `PCQAPAIDQTEXT${i} premium question?` : `PCQAFREEQTEXT${i} free question?`,
          explanation: paid ? `PCQAPAIDEXPLAIN${i}` : `PCQAFREEEXPLAIN${i}`,
          difficulty: QuestionDifficulty.EASY,
          status: QuestionStatus.PUBLISHED,
          previousYearPaperId: paid ? paperPaid.id : paperFree.id,
          options: {
            create: [
              { label: "A", text: paid ? `PCQAPAIDCORRECT${i}` : `PCQAFREECORRECT${i}`, isCorrect: true, order: 0 },
              { label: "B", text: "Beta", isCorrect: false, order: 1 },
            ],
          },
        },
      });
      (paid ? qPaid : qFree).push(q.id);
    }
    const series = await prisma.testSeries.create({ data: { examId: exam.id, name: "PCQA Mock Test Series", status: "PUBLISHED", isActive: true } });
    const mFree = await prisma.mockTest.create({
      data: { examId: exam.id, testSeriesId: series.id, title: "PCQA Mock Test 1", durationMinutes: 30, accessType: "FREE", status: "PUBLISHED", order: 1, questions: { create: qFree.map((questionId, order) => ({ questionId, order })) } },
    });
    const mPaid = await prisma.mockTest.create({
      data: { examId: exam.id, testSeriesId: series.id, title: "PCQA Mock Test 2", durationMinutes: 30, accessType: "PAID", status: "PUBLISHED", order: 2, questions: { create: qPaid.map((questionId, order) => ({ questionId, order })) } },
    });
    const premium = await prisma.product.create({
      data: { code: "pcqa-complete", name: "PCQA Complete Mock Test Series", productType: "TEST_SERIES", examId: exam.id, testSeriesId: series.id, accessType: "PAID", mrpPaise: 200000, sellingPricePaise: 99900, accessDurationType: "DAYS", accessDays: 100, order: -6 },
    });

    const now = Date.now();
    await prisma.setting.upsert({
      where: { key: POLICY_KEY },
      update: {},
      create: {
        key: POLICY_KEY,
        value: {
          enforcementEnabled: true,
          enforcedSince: new Date(now - 72 * HOUR).toISOString(),
          examId: exam.id,
          premiumProductIds: [premium.id],
          freePyqId: paperFree.id,
          freeMockTestId: mFree.id,
          trialEnabled: true,
          trialHours: 48,
          examDate: "2026-12-13",
          tillExamProductIds: [],
          // Popups off: the UI suite tests the dashboard itself, not the trial modal.
          popups: { welcome: false, activeDaily: false, expired: false, expiredEveryDays: 1 },
        },
      },
    });
    bumpPremiumPolicyCache();

    let mobile = 6100000000 + Math.floor(Math.random() * 89999999);
    const personas = ["free", "trialActive", "trialExpired", "paid", "paidExpired", "other", "ineligible"] as const;
    const students: Record<string, string> = {};
    const tokens: Record<string, string> = {};
    for (const persona of personas) {
      const s = await prisma.student.create({
        data: {
          studentId: `PCQA-${persona.toUpperCase()}-${stamp}`,
          name: `Pcqa ${persona}`,
          email: `${persona.toLowerCase()}${EMAIL_DOMAIN}`,
          authProvider: StudentAuthProvider.CREDENTIALS,
          mobile: String(mobile++),
          mobileVerifiedAt: new Date(),
          examEnrollments: { create: { examId: exam.id } },
        },
      });
      students[persona] = s.id;
      tokens[persona] = await encode({
        token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email },
        secret: process.env.AUTH_SECRET!,
        salt: "student-session-token",
      });
    }

    const engine = await import("../lib/test-attempt");
    const { clearAnswerAccessCache } = await import("../lib/payments/access");
    /** Start through the engine, answer the first question correctly, submit. */
    const take = async (studentId: string, paperId: string) => {
      const attempt = await engine.startPreviousYearPaperAttempt(studentId, paperId);
      const first = await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: attempt.id }, orderBy: { order: "asc" } });
      await engine.saveAnswer(attempt.id, studentId, first.questionId, "A", false);
      await engine.submitAttempt(attempt.id, studentId);
      return attempt.id;
    };
    const backdate = (attemptId: string, startedAgoH: number) =>
      prisma.testAttempt.update({ where: { id: attemptId }, data: { startedAt: new Date(now - startedAgoH * HOUR), submittedAt: new Date(now - startedAgoH * HOUR + 0.5 * HOUR) } });

    const attempts: Record<string, string> = {};
    attempts.freeFree = await take(students.free, paperFree.id);

    // trialActive's trial is recorded against `ineligible`'s verified mobile → that student can't start one (MOBILE_USED).
    const ineligibleMobile = (await prisma.student.findUniqueOrThrow({ where: { id: students.ineligible }, select: { mobile: true } })).mobile;
    await prisma.studentPremiumTrial.create({ data: { studentId: students.trialActive, examId: exam.id, mobile: ineligibleMobile, startedAt: new Date(now - HOUR), endsAt: new Date(now + 47 * HOUR) } });
    attempts.trialActivePaid = await take(students.trialActive, paperPaid.id);

    // During the trial…
    await prisma.studentPremiumTrial.create({ data: { studentId: students.trialExpired, examId: exam.id, startedAt: new Date(now - HOUR), endsAt: new Date(now + 47 * HOUR) } });
    attempts.trialExpiredPaid = await take(students.trialExpired, paperPaid.id);
    attempts.trialExpiredFree = await take(students.trialExpired, paperFree.id);
    await prisma.savedQuestion.create({ data: { studentId: students.trialExpired, questionId: qPaid[0] } });
    await prisma.savedQuestion.create({ data: { studentId: students.trialExpired, questionId: qFree[0] } });
    // …then the trial ends (started 50h ago, 48h long).
    await prisma.studentPremiumTrial.update({ where: { studentId: students.trialExpired }, data: { startedAt: new Date(now - 50 * HOUR), endsAt: new Date(now - 2 * HOUR) } });
    await backdate(attempts.trialExpiredPaid, 49);
    await backdate(attempts.trialExpiredFree, 48);

    await prisma.studentEntitlement.create({ data: { studentId: students.paid, productId: premium.id, source: "PURCHASE", startsAt: new Date(now - HOUR), expiresAt: new Date(now + 100 * 24 * HOUR) } });
    attempts.paidPaid = await take(students.paid, paperPaid.id);

    const ent = await prisma.studentEntitlement.create({ data: { studentId: students.paidExpired, productId: premium.id, source: "PURCHASE", startsAt: new Date(now - 10 * 24 * HOUR), expiresAt: new Date(now + HOUR) } });
    attempts.paidExpiredPaid = await take(students.paidExpired, paperPaid.id);
    await prisma.studentEntitlement.update({ where: { id: ent.id }, data: { expiresAt: new Date(now - HOUR) } });
    await backdate(attempts.paidExpiredPaid, 48);
    clearAnswerAccessCache();

    console.log(
      JSON.stringify({
        examId: exam.id,
        papers: { free: paperFree.id, paid: paperPaid.id },
        mocks: { free: mFree.id, paid: mPaid.id },
        questions: { free: qFree, paid: qPaid },
        premium: { id: premium.id, code: premium.code },
        students,
        tokens,
        attempts,
      })
    );
  }

  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "setup") await setup();
  else if (cmd === "cleanup") await cleanup();
  else if (cmd === "layout") {
    if (arg === "prod-like") await prisma.setting.upsert({ where: { key: LAYOUT_KEY }, update: { value: PROD_LIKE_LAYOUT }, create: { key: LAYOUT_KEY, value: PROD_LIKE_LAYOUT } });
    else if (arg === "upgrade-hidden") {
      const value = [...PROD_LIKE_LAYOUT, { id: "premium-upgrade", visible: false }];
      await prisma.setting.upsert({ where: { key: LAYOUT_KEY }, update: { value }, create: { key: LAYOUT_KEY, value } });
    } else await prisma.setting.deleteMany({ where: { key: LAYOUT_KEY } });
  } else {
    console.error("usage: setup | cleanup | layout <default|prod-like|upgrade-hidden>");
    process.exit(2);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
