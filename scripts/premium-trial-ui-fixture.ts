/**
 * Fixture for scripts/verify-premium-trial-ui.mjs (Student Dashboard trial
 * popup, Premium locks, Plans & Pricing three-tier comparison, Admin → Free
 * Access & Trial, RBAC).
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-trial-ui-fixture.ts setup > /tmp/ptqa.json
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-trial-ui-fixture.ts policy <on|off>
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-trial-ui-fixture.ts trial <studentDbId>
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-trial-ui-fixture.ts cleanup
 *
 * Refuses to touch a database whose name doesn't contain "premium".
 */
import "dotenv/config";
import argon2 from "argon2";
import { PrismaClient, StudentAuthProvider, QuestionDifficulty, QuestionStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encode } from "next-auth/jwt";

if (!/premium/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *premium* scratch database.");
  process.exit(2);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const TAG = "PTQA";
const EMAIL_DOMAIN = "@ptqa.example.test";
const HOUR = 3_600_000;
const POLICY_KEY = "access.premium_policy";

async function cleanup() {
  const exams = await prisma.exam.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  const examIds = exams.map((e) => e.id);
  const students = await prisma.student.findMany({ where: { email: { endsWith: EMAIL_DOMAIN } }, select: { id: true } });
  const studentIds = students.map((s) => s.id);
  await prisma.answer.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } }).catch(() => undefined);
  await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } }).catch(() => undefined);
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentEntitlement.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.emailDeliveryLog.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.product.deleteMany({ where: { code: { startsWith: "ptqa-" } } });
  await prisma.mockTestQuestion.deleteMany({ where: { mockTest: { examId: { in: examIds } } } });
  await prisma.mockTest.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.testSeries.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.questionOption.deleteMany({ where: { question: { examId: { in: examIds } } } });
  await prisma.question.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.previousYearPaper.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.examSubject.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.subject.deleteMany({ where: { originExamId: { in: examIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.adminUser.deleteMany({ where: { username: { startsWith: "ptqa-" } } });
  await prisma.setting.deleteMany({ where: { key: POLICY_KEY } });
}

async function setup() {
  await cleanup();
  await prisma.setting.upsert({ where: { key: "payments.mode" }, update: { value: { mode: "PAID" } }, create: { key: "payments.mode", value: { mode: "PAID" } } });
  const exam = await prisma.exam.create({
    data: { name: "PTQA MEDICAL OFFICER EXAM 2026", code: `${TAG}-A`, isActive: true, order: -5, publicSlug: "ptqa-mo", publicPageEnabled: true, durationMinutes: 120 },
  });
  const subject = await prisma.subject.create({
    data: { name: "PTQA Physiology", originExamId: exam.id, nameKey: `fixture:${exam.id}:ptqa-physiology`, examLinks: { create: { examId: exam.id, displayOrder: 0 } } },
  });
  const paperFree = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "PTQA MO 2024", durationMinutes: 30 } });
  const paperPaid = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2020, title: "PTQA MO 2020", durationMinutes: 30 } });
  const qs: { id: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    qs.push(
      await prisma.question.create({
        data: {
          examId: exam.id,
          subjectId: subject.id,
          code: `Q-PTQA-${i}-${Date.now().toString(36)}`,
          text: `PTQA question ${i}?`,
          difficulty: QuestionDifficulty.EASY,
          status: QuestionStatus.PUBLISHED,
          previousYearPaperId: i <= 3 ? paperFree.id : paperPaid.id,
          options: { create: [{ label: "A", text: "Alpha", isCorrect: true }, { label: "B", text: "Beta", isCorrect: false }] },
        },
      })
    );
  }
  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: "PTQA Mock Test Series", status: "PUBLISHED", isActive: true } });
  const mock = (title: string, accessType: "FREE" | "PAID", order: number, extra: Record<string, unknown> = {}) =>
    prisma.mockTest.create({
      data: { examId: exam.id, testSeriesId: series.id, title, durationMinutes: 30, accessType, status: "PUBLISHED", order, questions: { create: qs.slice(0, 3).map((q, i) => ({ questionId: q.id, order: i })) }, ...extra },
    });
  const mFree = await mock("PTQA Mock Test 1", "FREE", 1);
  const mLegacy = await mock("PTQA Mock Test 2 (legacy free)", "FREE", 2);
  const mPaid = await mock("PTQA Mock Test 3", "PAID", 3);
  const mSubject = await mock("PTQA Physiology Subject Mock Test 01", "PAID", 4, { coverageType: "SUBJECT_WISE", coverageSubjectIds: [subject.id] });
  const premium = await prisma.product.create({
    data: { code: "ptqa-complete", name: "PTQA Complete Mock Test Series", productType: "TEST_SERIES", examId: exam.id, testSeriesId: series.id, accessType: "PAID", mrpPaise: 200000, sellingPricePaise: 99900, accessDurationType: "DAYS", accessDays: 100, order: -5 },
  });

  let mobile = 6000000000 + Math.floor(Math.random() * 99999999);
  const personas = ["fresh", "fresh2", "paid", "active", "ending", "expired", "locked"] as const;
  const students: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const persona of personas) {
    const s = await prisma.student.create({
      data: {
        studentId: `PTQA-${persona.toUpperCase()}-${Date.now().toString(36)}`,
        name: `Ptqa ${persona}`,
        email: `${persona}${EMAIL_DOMAIN}`,
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
  const now = Date.now();
  await prisma.studentEntitlement.create({ data: { studentId: students.paid, productId: premium.id, source: "PURCHASE", startsAt: new Date(now), expiresAt: new Date(now + 100 * 24 * HOUR) } });
  const trial = (sid: string, startedAgoH: number, totalH = 48) =>
    prisma.studentPremiumTrial.create({ data: { studentId: sid, examId: exam.id, startedAt: new Date(now - startedAgoH * HOUR), endsAt: new Date(now - startedAgoH * HOUR + totalH * HOUR) } });
  await trial(students.active, 1);
  await trial(students.ending, 43);
  await trial(students.expired, 50);

  await prisma.setting.upsert({
    where: { key: POLICY_KEY },
    update: {},
    create: {
      key: POLICY_KEY,
      value: {
        enforcementEnabled: true,
        enforcedSince: new Date(now - HOUR).toISOString(),
        examId: exam.id,
        premiumProductIds: [premium.id],
        freePyqId: paperFree.id,
        freeMockTestId: mFree.id,
        freeSubjectMockTestId: mSubject.id,
        trialEnabled: true,
        trialHours: 48,
        examDate: "2026-12-13",
        tillExamProductIds: [premium.id],
      },
    },
  });

  // Admins: a FULL_ADMIN (view only) next to the seeded MASTER_ADMIN.
  const password = "Ptqa-Admin-Pass-2026";
  const fullRole = await prisma.role.findUnique({ where: { name: "FULL_ADMIN" } });
  const masterRole = await prisma.role.findUnique({ where: { name: "MASTER_ADMIN" } });
  const passwordHash = await argon2.hash(password);
  if (fullRole) await prisma.adminUser.create({ data: { name: "PTQA Full Admin", username: "ptqa-full", email: "ptqa-full@ptqa.example.test", passwordHash, roleId: fullRole.id } });
  if (masterRole) await prisma.adminUser.create({ data: { name: "PTQA Master Admin", username: "ptqa-master", email: "ptqa-master@ptqa.example.test", passwordHash, roleId: masterRole.id } });

  console.log(
    JSON.stringify({
      examId: exam.id,
      examSlug: exam.publicSlug,
      papers: { free: paperFree.id, paid: paperPaid.id },
      mocks: { free: mFree.id, legacy: mLegacy.id, paid: mPaid.id, subject: mSubject.id },
      premium: { id: premium.id, code: premium.code },
      students,
      tokens,
      admin: { password, full: "ptqa-full", master: "ptqa-master" },
    })
  );
}

async function setPolicy(on: boolean) {
  const row = await prisma.setting.findUniqueOrThrow({ where: { key: POLICY_KEY } });
  const value = { ...(row.value as Record<string, unknown>), enforcementEnabled: on };
  await prisma.setting.update({ where: { key: POLICY_KEY }, data: { value } });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "setup") await setup();
  else if (cmd === "cleanup") await cleanup();
  else if (cmd === "policy") await setPolicy(arg === "on");
  else if (cmd === "trial") {
    const t = await prisma.studentPremiumTrial.findUnique({ where: { studentId: arg } });
    console.log(JSON.stringify(t ? { startedAt: t.startedAt, endsAt: t.endsAt, hours: (t.endsAt.getTime() - t.startedAt.getTime()) / HOUR } : null));
  } else {
    console.error("usage: setup | cleanup | policy <on|off> | trial <studentDbId>");
    process.exit(2);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
