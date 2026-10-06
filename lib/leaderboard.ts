import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  attemptRankingStatus,
  leaderboardDisplayName,
  rankPercentiles,
  type AttemptRankingStatus,
  type RankableAttempt,
  type RankingTestRef,
} from "@/lib/leaderboard-core";

export type { AttemptRankingStatus, RankingTestRef } from "@/lib/leaderboard-core";

/**
 * The one ranking implementation (Ranking Phase 1) for Mock Tests and
 * Previous Year Papers. Rules live in lib/leaderboard-core.ts; this file runs
 * them as a single PostgreSQL query over stored TestAttempt columns (score,
 * counts, timeTakenSeconds, modes, startedAt, submittedAt) — never Answer rows,
 * never a write. Ranks are derived on every read, so they can't go stale and
 * historical attempts need no backfill. TestAttempt.isLeaderboardAttempt is
 * a legacy engine flag and is NOT read here.
 *
 * Privacy: the raw name never leaves this module. A row carries only rank,
 * a First Name + Last Initial display name, the numbers shown, and isSelf.
 * No student id, email, phone or attempt id of another student.
 */

export interface LeaderboardRow {
  rank: number;
  displayName: string;
  isSelf: boolean;
  score: number;
  /** 0..1 */
  accuracy: number;
  correctCount: number;
  timeTakenSeconds: number | null;
  percentile: number;
  topPercent: number;
}

export interface Leaderboard {
  totalParticipants: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Ranks ((page-1)*pageSize, page*pageSize]. */
  rows: LeaderboardRow[];
  /** The viewer's own ranked row (null when the viewer is unranked). */
  self: LeaderboardRow | null;
  /** ±window rows around the viewer when the viewer is not on this page. */
  nearby: LeaderboardRow[];
  /** Server-side only: which of the viewer's attempts carries the rank. */
  selfOfficialAttemptId: string | null;
}

export interface RankingConfig {
  leaderboardEnabled: boolean;
  /** Always false for a Previous Year Paper. Phase 2 input; not shown to students. */
  countsTowardOverall: boolean;
}

/** Which ranked test an attempt belongs to; null for every unranked test type (Subject, Custom, Grand, Live). */
export function rankingTestForAttempt(attempt: {
  sourceType: string;
  mockTestId: string | null;
  previousYearPaperId: string | null;
}): RankingTestRef | null {
  if (attempt.sourceType === "MOCK_TEST" && attempt.mockTestId) return { kind: "MOCK_TEST", id: attempt.mockTestId };
  if (attempt.sourceType === "PREVIOUS_YEAR_PAPER" && attempt.previousYearPaperId) {
    return { kind: "PREVIOUS_YEAR_PAPER", id: attempt.previousYearPaperId };
  }
  return null;
}

/**
 * A test with no TestRankingConfig row uses the defaults: leaderboard on
 * (for a Mock Test: the legacy MockTest.leaderboardEnabled column, which the
 * admin form keeps mirrored), not counted toward Overall Rank.
 */
export async function getRankingConfig(test: RankingTestRef): Promise<RankingConfig> {
  if (test.kind === "MOCK_TEST") {
    const row = await prisma.mockTest.findUnique({
      where: { id: test.id },
      select: { leaderboardEnabled: true, rankingConfig: { select: { leaderboardEnabled: true, countsTowardOverall: true } } },
    });
    return {
      leaderboardEnabled: row?.rankingConfig?.leaderboardEnabled ?? row?.leaderboardEnabled ?? true,
      countsTowardOverall: row?.rankingConfig?.countsTowardOverall ?? false,
    };
  }
  const row = await prisma.testRankingConfig.findUnique({ where: { previousYearPaperId: test.id }, select: { leaderboardEnabled: true } });
  return { leaderboardEnabled: row?.leaderboardEnabled ?? true, countsTowardOverall: false };
}

function testFilter(test: RankingTestRef): Prisma.Sql {
  return test.kind === "MOCK_TEST"
    ? Prisma.sql`a."mockTestId" = ${test.id} AND a."sourceType" = 'MOCK_TEST'`
    : Prisma.sql`a."previousYearPaperId" = ${test.id} AND a."sourceType" = 'PREVIOUS_YEAR_PAPER'`;
}

type RawRow = {
  total: number;
  rank: number | null;
  score: number | null;
  correct: number | null;
  incorrect: number | null;
  timeTakenSeconds: number | null;
  isSelf: boolean | null;
  selfAttemptId: string | null;
  name: string | null;
  studentStatus: string | null;
};

/**
 * Per-test leaderboard page plus the viewer's own position. Eligibility and
 * order are exactly lib/leaderboard-core.ts (studentStanding / compareForRank):
 *   official = earliest-started SUBMITTED competitive attempt per student;
 *   dropped when an answer-exposing attempt started before it;
 *   ORDER BY score DESC, accuracy DESC, correct DESC, timeTakenSeconds ASC,
 *            submittedAt ASC, id ASC.
 */
export async function getLeaderboard(
  test: RankingTestRef,
  viewerStudentId: string,
  opts: { page?: number; pageSize?: number; window?: number } = {}
): Promise<Leaderboard> {
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? 50), 1), 100);
  const requestedPage = Math.max(Math.trunc(Number.isFinite(opts.page) ? (opts.page as number) : 1), 1);
  const window = Math.min(Math.max(Math.trunc(opts.window ?? 2), 0), 10);

  const run = (page: number) => {
    const from = (page - 1) * pageSize + 1;
    const to = page * pageSize;
    return prisma.$queryRaw<RawRow[]>`
      WITH att AS (
        SELECT a.id, a."studentId", a.status, a."answerMode", a."startedAt", a."submittedAt",
               a.score, a."correctCount", a."incorrectCount", a."timeTakenSeconds",
               (a."entryMode" = 'ONLINE' AND a."durationMode" = 'FIXED' AND a."answerMode" = 'EXAM') AS competitive
        FROM "TestAttempt" a
        WHERE ${testFilter(test)}
      ),
      official AS (
        SELECT DISTINCT ON ("studentId") *
        FROM att
        WHERE competitive AND status = 'SUBMITTED'
        ORDER BY "studentId", "startedAt", id COLLATE "C"
      ),
      eligible AS (
        SELECT o.*,
               COALESCE(o."correctCount", 0) AS correct,
               COALESCE(o."incorrectCount", 0) AS incorrect,
               CASE WHEN COALESCE(o."correctCount", 0) + COALESCE(o."incorrectCount", 0) > 0
                    THEN o."correctCount"::numeric / (o."correctCount" + o."incorrectCount")
                    ELSE 0 END AS accuracy
        FROM official o
        WHERE NOT EXISTS (
          SELECT 1 FROM att p
          WHERE p."studentId" = o."studentId"
            AND NOT p.competitive
            AND (p."answerMode" = 'INSTANT' OR p.status = 'SUBMITTED')
            AND (p."startedAt" < o."startedAt" OR (p."startedAt" = o."startedAt" AND p.id COLLATE "C" < o.id COLLATE "C"))
        )
      ),
      ranked AS (
        SELECT e.*,
               ROW_NUMBER() OVER (
                 ORDER BY COALESCE(e.score, 0) DESC, e.accuracy DESC, e.correct DESC,
                          COALESCE(e."timeTakenSeconds", 2147483647) ASC, e."submittedAt" ASC NULLS LAST, e.id COLLATE "C" ASC
               )::int AS rank
        FROM eligible e
      ),
      me AS (SELECT rank FROM ranked WHERE "studentId" = ${viewerStudentId})
      SELECT t.total, x.*
      FROM (SELECT COUNT(*)::int AS total FROM ranked) t
      LEFT JOIN LATERAL (
        SELECT r.rank, COALESCE(r.score, 0)::float8 AS score, r.correct::int AS correct, r.incorrect::int AS incorrect,
               r."timeTakenSeconds", (r."studentId" = ${viewerStudentId}) AS "isSelf",
               CASE WHEN r."studentId" = ${viewerStudentId} THEN r.id END AS "selfAttemptId",
               s.name, s.status::text AS "studentStatus"
        FROM ranked r
        JOIN "Student" s ON s.id = r."studentId"
        WHERE r.rank BETWEEN ${from} AND ${to}
           OR r.rank BETWEEN (SELECT rank FROM me) - ${window} AND (SELECT rank FROM me) + ${window}
      ) x ON true
      ORDER BY x.rank`;
  };

  let rows = await run(requestedPage);
  const total = rows[0]?.total ?? 0;
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(requestedPage, pageCount);
  if (page !== requestedPage) rows = await run(page);

  const toRow = (r: RawRow): LeaderboardRow => {
    const rank = r.rank as number;
    const correct = r.correct ?? 0;
    const attempted = correct + (r.incorrect ?? 0);
    return {
      rank,
      displayName: leaderboardDisplayName(r.name, r.studentStatus ?? "ACTIVE"),
      isSelf: r.isSelf === true,
      score: r.score ?? 0,
      accuracy: attempted > 0 ? correct / attempted : 0,
      correctCount: correct,
      timeTakenSeconds: r.timeTakenSeconds,
      ...rankPercentiles(rank, total),
    };
  };

  const all = rows.filter((r) => r.rank !== null).map((r) => ({ row: toRow(r), selfAttemptId: r.selfAttemptId }));
  const from = (page - 1) * pageSize + 1;
  const to = page * pageSize;
  const onPage = (rank: number) => rank >= from && rank <= to;
  const selfEntry = all.find((x) => x.row.isSelf) ?? null;
  const self = selfEntry?.row ?? null;

  return {
    totalParticipants: total,
    page,
    pageSize,
    pageCount,
    rows: all.filter((x) => onPage(x.row.rank)).map((x) => x.row),
    self,
    nearby: self && !onPage(self.rank) ? all.filter((x) => !onPage(x.row.rank)).map((x) => x.row) : [],
    selfOfficialAttemptId: selfEntry?.selfAttemptId ?? null,
  };
}

/** The viewer's attempts of one test, as the pure rules need them (a handful of rows, indexed). */
export async function getStudentRankableAttempts(test: RankingTestRef, studentId: string): Promise<RankableAttempt[]> {
  return prisma.testAttempt.findMany({
    where:
      test.kind === "MOCK_TEST"
        ? { studentId, mockTestId: test.id, sourceType: "MOCK_TEST" }
        : { studentId, previousYearPaperId: test.id, sourceType: "PREVIOUS_YEAR_PAPER" },
    select: {
      id: true,
      status: true,
      entryMode: true,
      durationMode: true,
      answerMode: true,
      startedAt: true,
      submittedAt: true,
      score: true,
      correctCount: true,
      incorrectCount: true,
      timeTakenSeconds: true,
    },
  });
}

export interface AttemptRanking {
  test: RankingTestRef;
  config: RankingConfig;
  /** How THIS attempt relates to the ranking (meaningless when the leaderboard is disabled). */
  status: AttemptRankingStatus;
  /** null when the leaderboard is disabled for this test. */
  board: Leaderboard | null;
}

/**
 * Everything the result / leaderboard pages need for one owned, SUBMITTED
 * attempt. Returns null for unranked test types. The caller has already
 * enforced ownership and result release.
 */
export async function getAttemptRanking(
  attempt: { id: string; studentId: string; sourceType: string; mockTestId: string | null; previousYearPaperId: string | null },
  opts: { page?: number; pageSize?: number; window?: number } = {}
): Promise<AttemptRanking | null> {
  const test = rankingTestForAttempt(attempt);
  if (!test) return null;
  const config = await getRankingConfig(test);
  if (!config.leaderboardEnabled) return { test, config, status: "NOT_SUBMITTED", board: null };
  const [own, board] = await Promise.all([getStudentRankableAttempts(test, attempt.studentId), getLeaderboard(test, attempt.studentId, opts)]);
  return { test, config, status: attemptRankingStatus(attempt.id, own), board };
}
