/**
 * Fixture for scripts/verify-leaderboard-ui.mjs (Ranking Phase 1), in a
 * DISPOSABLE copy of production. One password student ("Rahul Kumar") with:
 *   M1  ranked #128 of 132 (130 others + a deleted student) + a later retake
 *   M2  OMR entry only                 → "OMR entry — not ranked"
 *   M3  Practice Mode first, then Standard → "Practice used before…"
 *   M4  leaderboard disabled
 *   P   a Previous Year Paper where Rahul is #1 of 3
 *   M1 + M5 + M6 count toward Overall Rank (M5: Rahul ties #1 with a much
 *   slower student → shared rank); "Other Viewer" has 1 counted test → no
 *   Overall Rank yet
 * plus a MASTER_ADMIN for the Ranking settings forms. Prints JSON (incl. every
 * other student's private identifiers, for the payload leak check).
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/leaderboard-ui-fixture.ts setup > /tmp/lb.json
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/leaderboard-ui-fixture.ts cleanup
 */
import "dotenv/config";
import argon2 from "argon2";
import { QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rankPercentiles } from "@/lib/leaderboard-core";
import { clearOverallRankingCache, getOverallStanding } from "@/lib/leaderboard";

const PASSWORD = "QaLeaderboard!2345";
const ADMIN_USERNAME = "qa-lb-admin";
const TAG = "QALB";
const VIEWER_EMAIL = "qa-lb-viewer@example.test";
const OTHER_EMAIL = "qa-lb-other@example.test";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

async function cleanup() {
  const admin = await prisma.adminUser.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } });
  if (admin) {
    await prisma.loginAttempt.deleteMany({ where: { adminUserId: admin.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: admin.id } }).catch(() => {});
    await prisma.adminUser.delete({ where: { id: admin.id } });
  }
  const students = await prisma.student.findMany({ where: { studentId: { startsWith: `${TAG}-` } }, select: { id: true } });
  const ids = students.map((s) => s.id);
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentLoginAttempt.deleteMany({ where: { OR: [{ studentId: { in: ids } }, { identifier: { in: [VIEWER_EMAIL, OTHER_EMAIL] } }] } });
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentSession.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  const mocks = await prisma.mockTest.findMany({ where: { title: { startsWith: `${TAG} ` } }, select: { id: true } });
  await prisma.testAttempt.deleteMany({ where: { mockTestId: { in: mocks.map((m) => m.id) } } });
  await prisma.mockTest.deleteMany({ where: { id: { in: mocks.map((m) => m.id) } } });
  const papers = await prisma.previousYearPaper.findMany({ where: { title: { startsWith: `${TAG} ` } }, select: { id: true } });
  await prisma.testAttempt.deleteMany({ where: { previousYearPaperId: { in: papers.map((p) => p.id) } } });
  await prisma.previousYearPaper.deleteMany({ where: { id: { in: papers.map((p) => p.id) } } });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "cleanup") return cleanup();
  if (mode !== "setup") throw new Error("usage: leaderboard-ui-fixture.ts setup|cleanup");
  await cleanup();

  const exam = await prisma.exam.findFirstOrThrow({
    where: { isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    orderBy: { questions: { _count: "desc" } },
  });
  const passwordHash = await argon2.hash(PASSWORD);
  const masterRole = await prisma.role.findUniqueOrThrow({ where: { name: "MASTER_ADMIN" }, select: { id: true } });
  await prisma.adminUser.create({ data: { name: "QA Leaderboard Admin", username: ADMIN_USERNAME, passwordHash, roleId: masterRole.id } });

  let n = 0;
  const mkStudent = (name: string, extra: Partial<Prisma.StudentUncheckedCreateInput> = {}) => {
    n += 1;
    return prisma.student.create({
      data: {
        studentId: `${TAG}-${String(n).padStart(4, "0")}`,
        name,
        email: `qa-lb-${n}@example.test`,
        mobile: `+9198${String(76500000 + n)}`,
        authProvider: StudentAuthProvider.CREDENTIALS,
        ...extra,
      },
    });
  };
  const viewer = await mkStudent("Rahul Kumar", { email: VIEWER_EMAIL, passwordHash });
  await prisma.studentProfile.create({ data: { studentId: viewer.id } });
  const other = await mkStudent("Other Viewer", { email: OTHER_EMAIL, passwordHash });
  await prisma.studentProfile.create({ data: { studentId: other.id } });

  const mkMock = (k: number) =>
    prisma.mockTest.create({ data: { examId: exam.id, title: `${TAG} Mock ${k}`, durationMinutes: 120, status: "PUBLISHED", accessType: "FREE" } });
  const [m1, m2, m3, m4, m5, m6] = [await mkMock(1), await mkMock(2), await mkMock(3), await mkMock(4), await mkMock(5), await mkMock(6)];
  for (const m of [m1, m5, m6]) await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: m.id, countsTowardOverall: true } });
  for (const id of [viewer.id, other.id]) await prisma.studentExamEnrollment.create({ data: { studentId: id, examId: exam.id } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2002, title: `${TAG} Paper`, durationMinutes: 120 } });
  await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: m4.id, leaderboardEnabled: false } });
  await prisma.mockTest.update({ where: { id: m4.id }, data: { leaderboardEnabled: false } });

  const t0 = Date.now() - 2 * 864e5;
  const attempt = (studentId: string, target: { mockTestId?: string; previousYearPaperId?: string }, a: Partial<Prisma.TestAttemptUncheckedCreateInput>) =>
    prisma.testAttempt.create({
      data: {
        studentId,
        sourceType: target.mockTestId ? "MOCK_TEST" : "PREVIOUS_YEAR_PAPER",
        testType: target.mockTestId ? "FULL_MOCK" : "PREVIOUS_YEAR_PAPER",
        examId: exam.id,
        ...target,
        durationMinutes: 120,
        totalQuestions: 200,
        maxScore: 200,
        status: "SUBMITTED",
        score: 100,
        correctCount: 100,
        incorrectCount: 20,
        unansweredCount: 80,
        timeTakenSeconds: 5400,
        startedAt: new Date(t0),
        submittedAt: new Date(t0 + 5_400_000),
        ...a,
      },
    });

  // M1: 130 others with scores 200..71, the viewer at 73 → rank 128; one deleted student scoring 0.
  const others: { id: string; studentId: string; email: string | null; mobile: string | null; name: string }[] = [];
  for (let k = 0; k < 130; k++) {
    const s = await mkStudent(`Aspirant${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(97 + Math.floor(k / 26))} Surnamezq${k}`);
    others.push(s);
    const score = k < 127 ? 200 - k : 72 - (k - 127);
    await attempt(s.id, { mockTestId: m1.id }, { score, correctCount: score, incorrectCount: 0 });
  }
  const deleted = await mkStudent("Deleted Student", { status: "DELETED", email: null, mobile: null });
  others.push(deleted);
  await attempt(deleted.id, { mockTestId: m1.id }, { score: 0, correctCount: 0, incorrectCount: 5 });
  const official = await attempt(viewer.id, { mockTestId: m1.id }, { score: 73, correctCount: 73, incorrectCount: 0 });
  const retake = await attempt(viewer.id, { mockTestId: m1.id }, { score: 199, correctCount: 199, incorrectCount: 0, startedAt: new Date(t0 + 864e5), submittedAt: new Date(t0 + 864e5 + 5_000_000) });

  const omr = await attempt(viewer.id, { mockTestId: m2.id }, { entryMode: "OFFLINE_OMR_ENTRY", timeTakenSeconds: 90 });
  await attempt(other.id, { mockTestId: m2.id }, {});
  await attempt(viewer.id, { mockTestId: m3.id }, { answerMode: "INSTANT", durationMode: "UNLIMITED", durationMinutes: 0 });
  const afterPractice = await attempt(viewer.id, { mockTestId: m3.id }, { startedAt: new Date(t0 + 864e5), submittedAt: new Date(t0 + 864e5 + 5_000_000), score: 190, correctCount: 190 });
  await attempt(other.id, { mockTestId: m3.id }, {});
  const disabled = await attempt(viewer.id, { mockTestId: m4.id }, {});

  const pyq = await attempt(viewer.id, { previousYearPaperId: paper.id }, { score: 150, correctCount: 150, incorrectCount: 10 });
  await attempt(other.id, { previousYearPaperId: paper.id }, { score: 120, correctCount: 120 });
  await attempt(others[0].id, { previousYearPaperId: paper.id }, { score: 90, correctCount: 90 });
  const otherM1 = await attempt(other.id, { mockTestId: m1.id }, { score: 10, correctCount: 10, incorrectCount: 90, startedAt: new Date(t0 + 1000) });

  // M5 / M6 (Overall): 130 others again. On M5 Rahul and others[0] tie at 200 — others[0] took 3x as long.
  const m5Viewer = await attempt(viewer.id, { mockTestId: m5.id }, { score: 200, correctCount: 200, incorrectCount: 0, timeTakenSeconds: 2000 });
  for (const [k, s] of others.slice(0, 130).entries()) {
    await attempt(s.id, { mockTestId: m5.id }, k === 0 ? { score: 200, correctCount: 200, incorrectCount: 0, timeTakenSeconds: 6000 } : { score: 199 - k, correctCount: 199 - k, incorrectCount: 0 });
    await attempt(s.id, { mockTestId: m6.id }, { score: 150 - k, correctCount: 150 - k, incorrectCount: 0 });
  }
  await attempt(viewer.id, { mockTestId: m6.id }, { score: 100, correctCount: 100, incorrectCount: 0 });
  clearOverallRankingCache();
  const overall = await getOverallStanding(exam.id, viewer.id, { fresh: true });

  const total = 133; // 130 + deleted + viewer + other
  console.log(
    JSON.stringify({
      password: PASSWORD,
      adminUsername: ADMIN_USERNAME,
      viewer: { email: VIEWER_EMAIL, id: viewer.id, studentId: viewer.studentId, mobile: viewer.mobile },
      other: { email: OTHER_EMAIL, id: other.id },
      expected: {
        rank: 128,
        total,
        ...rankPercentiles(128, total),
        pyq: { rank: 1, total: 3, ...rankPercentiles(1, 3) },
        overall: { rank: overall.self?.rank, total: overall.totalRanked, topPercent: overall.self?.topPercent, rankedTests: overall.selfRankedTests, averagePercentile: overall.self?.averagePercentile },
      },
      examId: exam.id,
      examName: exam.name,
      mocks: { m1: m1.id, m2: m2.id, m3: m3.id, m4: m4.id, m5: m5.id, m6: m6.id },
      paperId: paper.id,
      attempts: { m5: m5Viewer.id, official: official.id, retake: retake.id, omr: omr.id, afterPractice: afterPractice.id, disabled: disabled.id, pyq: pyq.id, otherM1: otherM1.id },
      privateValues: others.flatMap((s) => [s.id, s.studentId, s.email, s.mobile, `Surnamezq`].filter(Boolean)).concat([other.id]),
    })
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
