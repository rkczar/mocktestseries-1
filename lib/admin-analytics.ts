import "server-only";
import { AttemptStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toIstDateString } from "@/lib/ist-time";

const TREND_DAYS = 14;

/** Builds an oldest-to-newest daily series over the trailing `days` IST calendar days, zero-filling days with no rows. */
function bucketByIstDay(timestamps: Date[], days: number): { date: string; count: number }[] {
  const countByDay = new Map<string, number>();
  for (const ts of timestamps) {
    const key = toIstDateString(ts);
    countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
  }

  const series: { date: string; count: number }[] = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = toIstDateString(cursor);
    series.push({ date: key, count: countByDay.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

/**
 * Platform-wide analytics for Admin → Analytics. Every number is a real
 * server-side aggregate — no hardcoded/demo values. Distinct from the Master
 * Dashboard's point-in-time snapshot counts, this focuses on trends
 * (signups/attempts over time) and performance breakdowns (by exam, subject,
 * difficulty) that the dashboard doesn't cover.
 */
export async function getPlatformAnalytics() {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since14d = new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalStudents,
    activeStudents7d,
    newStudents30d,
    totalAttempts,
    submittedAttempts,
    inProgressAttempts,
    answerCorrectness,
    signupRows,
    attemptRows,
    byExam,
    bySubject,
    difficultyBreakdown,
    avgScorePercentRows,
    distinctCounts,
  ] = await Promise.all([
    prisma.student.count(),
    prisma.student.count({ where: { lastLoginAt: { gte: since7d } } }),
    prisma.student.count({ where: { createdAt: { gte: since30d } } }),
    prisma.testAttempt.count(),
    prisma.testAttempt.count({ where: { status: AttemptStatus.SUBMITTED } }),
    prisma.testAttempt.count({ where: { status: AttemptStatus.IN_PROGRESS } }),
    prisma.answer.groupBy({ by: ["isCorrect"], where: { isCorrect: { not: null } }, _count: { _all: true } }),
    prisma.student.findMany({ where: { createdAt: { gte: since14d } }, select: { createdAt: true } }),
    prisma.testAttempt.findMany({
      where: { status: AttemptStatus.SUBMITTED, submittedAt: { gte: since14d } },
      select: { submittedAt: true },
    }),
    prisma.testAttempt.groupBy({
      by: ["examId"],
      where: { status: AttemptStatus.SUBMITTED },
      _avg: { score: true },
      _count: { examId: true },
      orderBy: { _count: { examId: "desc" } },
      take: 8,
    }),
    prisma.testAttempt.groupBy({
      by: ["subjectId"],
      where: { status: AttemptStatus.SUBMITTED, subjectId: { not: null } },
      _avg: { score: true },
      _count: { subjectId: true },
      orderBy: { _count: { subjectId: "desc" } },
      take: 8,
    }),
    prisma.$queryRaw<{ difficulty: string; total: bigint; correct: bigint }[]>`
      SELECT q.difficulty AS difficulty, COUNT(a.id) AS total, COUNT(*) FILTER (WHERE a."isCorrect" = true) AS correct
      FROM "Answer" a
      JOIN "Question" q ON q.id = a."questionId"
      WHERE a."isCorrect" IS NOT NULL
      GROUP BY q.difficulty
    `,
    prisma.$queryRaw<{ avg_pct: number | null }[]>`
      SELECT AVG(score / NULLIF("maxScore", 0)) * 100 AS avg_pct
      FROM "TestAttempt"
      WHERE status = 'SUBMITTED' AND "maxScore" > 0
    `,
    prisma.$queryRaw<{ enrolled: bigint; attempted: bigint; submitted: bigint }[]>`
      SELECT
        (SELECT COUNT(DISTINCT "studentId") FROM "StudentExamEnrollment") AS enrolled,
        (SELECT COUNT(DISTINCT "studentId") FROM "TestAttempt") AS attempted,
        (SELECT COUNT(DISTINCT "studentId") FROM "TestAttempt" WHERE status = 'SUBMITTED') AS submitted
    `,
  ]);

  const correct = answerCorrectness.find((c) => c.isCorrect === true)?._count._all ?? 0;
  const incorrect = answerCorrectness.find((c) => c.isCorrect === false)?._count._all ?? 0;
  const overallAccuracy = correct + incorrect > 0 ? (correct / (correct + incorrect)) * 100 : null;

  const examIds = byExam.map((e) => e.examId);
  const subjectIds = bySubject.map((s) => s.subjectId).filter((s): s is string => s !== null);
  const [exams, subjects] = await Promise.all([
    prisma.exam.findMany({ where: { id: { in: examIds } }, select: { id: true, name: true } }),
    prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
  ]);
  const examNameById = new Map(exams.map((e) => [e.id, e.name]));
  const subjectNameById = new Map(subjects.map((s) => [s.id, s.name]));

  const difficultyOrder = ["EASY", "MEDIUM", "HARD"];
  const difficultyStats = difficultyOrder
    .map((difficulty) => {
      const row = difficultyBreakdown.find((d) => d.difficulty === difficulty);
      const total = Number(row?.total ?? 0);
      const correctCount = Number(row?.correct ?? 0);
      return { difficulty, total, correct: correctCount, accuracy: total > 0 ? (correctCount / total) * 100 : null };
    })
    .filter((d) => d.total > 0);

  const funnel = distinctCounts[0];

  return {
    totalStudents,
    activeStudents7d,
    newStudents30d,
    totalAttempts,
    submittedAttempts,
    inProgressAttempts,
    totalAnswered: correct + incorrect,
    correct,
    incorrect,
    overallAccuracy,
    averageScorePercent: avgScorePercentRows[0]?.avg_pct != null ? Number(avgScorePercentRows[0].avg_pct) : null,
    signupsByDay: bucketByIstDay(signupRows.map((r) => r.createdAt), TREND_DAYS),
    attemptsByDay: bucketByIstDay(
      attemptRows.map((r) => r.submittedAt!).filter((d): d is Date => d !== null),
      TREND_DAYS
    ),
    examPerformance: byExam.map((e) => ({
      examId: e.examId,
      name: examNameById.get(e.examId) ?? "—",
      attempts: e._count.examId,
      averageScore: e._avg.score,
    })),
    subjectPerformance: bySubject.map((s) => ({
      subjectId: s.subjectId as string,
      name: subjectNameById.get(s.subjectId as string) ?? "—",
      attempts: s._count.subjectId,
      averageScore: s._avg.score,
    })),
    difficultyStats,
    funnel: {
      registered: totalStudents,
      enrolled: Number(funnel?.enrolled ?? 0),
      attempted: Number(funnel?.attempted ?? 0),
      submitted: Number(funnel?.submitted ?? 0),
    },
  };
}
