import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isMockResultReleased } from "@/lib/mock-test-schedule";
import {
  OVERALL_MIN_RANKED_TESTS,
  attemptRankingStatus,
  competitionRanks,
  leaderboardDisplayName,
  rankPercentiles,
  type AttemptRankingStatus,
  type RankableAttempt,
  type RankingTestRef,
} from "@/lib/leaderboard-core";

export type { AttemptRankingStatus, RankingTestRef } from "@/lib/leaderboard-core";
export { OVERALL_MIN_RANKED_TESTS } from "@/lib/leaderboard-core";

/**
 * The one ranking implementation for Mock Tests and Previous Year Papers
 * (per-test leaderboards) and for the exam-level Overall Rank. Rules live in
 * lib/leaderboard-core.ts; this file runs them in PostgreSQL over stored
 * TestAttempt columns (score, counts, modes, startedAt) — never Answer rows,
 * never a write. Per-test ranks are derived on every read; the Overall Rank
 * aggregate is memoized per process for OVERALL_CACHE_MS. Time taken never
 * affects any rank. TestAttempt.isLeaderboardAttempt is legacy and NOT read.
 *
 * Privacy: the raw name never leaves this module. Rows carry only ranks, a
 * First Name + Last Initial display name, the numbers shown, and isSelf.
 * No student id, email, phone or another student's attempt id.
 */

export interface LeaderboardRow {
  /** Shared by equal performance (1, 2, 2, 4). */
  rank: number;
  /** 1-based list position (unique, for paging / the podium). Not a rank. */
  position: number;
  displayName: string;
  isSelf: boolean;
  score: number;
  /** 0..1 */
  accuracy: number;
  correctCount: number;
  /** Informational only — never used for ranking. */
  timeTakenSeconds: number | null;
  percentile: number;
  topPercent: number;
}

export interface Leaderboard {
  totalParticipants: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Positions ((page-1)*pageSize, page*pageSize]. */
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
  /** Always false for a Previous Year Paper. */
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

function testsFilter(mockIds: string[], paperIds: string[]): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (mockIds.length) parts.push(Prisma.sql`(a."sourceType" = 'MOCK_TEST' AND a."mockTestId" IN (${Prisma.join(mockIds)}))`);
  if (paperIds.length) parts.push(Prisma.sql`(a."sourceType" = 'PREVIOUS_YEAR_PAPER' AND a."previousYearPaperId" IN (${Prisma.join(paperIds)}))`);
  return parts.length ? Prisma.join(parts, " OR ") : Prisma.sql`false`;
}

/**
 * The ranking rules as CTEs (att → official → eligible → ranked), for one or
 * many tests at once (partitioned by testKey). Exactly lib/leaderboard-core.ts:
 *   official = earliest-started SUBMITTED competitive attempt per student+test;
 *   dropped when an answer-exposing attempt started before it;
 *   rank = RANK() BY score DESC, accuracy DESC, correct DESC (ties share);
 *   position = the same order, then student id — display order only.
 */
function rankedCte(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    att AS (
      SELECT a.id, a."studentId", a.status, a."answerMode", a."startedAt", a."submittedAt",
             a.score, a."correctCount", a."incorrectCount", a."timeTakenSeconds",
             a."mockTestId", a."previousYearPaperId",
             a."sourceType"::text || ':' || COALESCE(a."mockTestId", a."previousYearPaperId") AS "testKey",
             (a."entryMode" = 'ONLINE' AND a."durationMode" = 'FIXED' AND a."answerMode" = 'EXAM') AS competitive
      FROM "TestAttempt" a
      WHERE ${where}
    ),
    official AS (
      SELECT DISTINCT ON ("testKey", "studentId") *
      FROM att
      WHERE competitive AND status = 'SUBMITTED'
      ORDER BY "testKey", "studentId", "startedAt", id COLLATE "C"
    ),
    eligible AS (
      SELECT o.*,
             COALESCE(o.score, 0) AS score_v,
             COALESCE(o."correctCount", 0) AS correct,
             COALESCE(o."incorrectCount", 0) AS incorrect,
             CASE WHEN COALESCE(o."correctCount", 0) + COALESCE(o."incorrectCount", 0) > 0
                  THEN o."correctCount"::numeric / (o."correctCount" + o."incorrectCount")
                  ELSE 0 END AS accuracy
      FROM official o
      WHERE NOT EXISTS (
        SELECT 1 FROM att p
        WHERE p."testKey" = o."testKey" AND p."studentId" = o."studentId"
          AND NOT p.competitive
          AND (p."answerMode" = 'INSTANT' OR p.status = 'SUBMITTED')
          AND (p."startedAt" < o."startedAt" OR (p."startedAt" = o."startedAt" AND p.id COLLATE "C" < o.id COLLATE "C"))
      )
    ),
    ranked AS (
      SELECT e.*,
             RANK() OVER (PARTITION BY e."testKey" ORDER BY e.score_v DESC, e.accuracy DESC, e.correct DESC)::int AS rank,
             ROW_NUMBER() OVER (PARTITION BY e."testKey" ORDER BY e.score_v DESC, e.accuracy DESC, e.correct DESC, e."studentId" COLLATE "C")::int AS pos,
             COUNT(*) OVER (PARTITION BY e."testKey")::int AS total
      FROM eligible e
    )`;
}

type RawRow = {
  total: number;
  rank: number | null;
  pos: number | null;
  score: number | null;
  correct: number | null;
  incorrect: number | null;
  timeTakenSeconds: number | null;
  isSelf: boolean | null;
  selfAttemptId: string | null;
  name: string | null;
  studentStatus: string | null;
};

function accuracyFrom(correct: number, incorrect: number): number {
  return correct + incorrect > 0 ? correct / (correct + incorrect) : 0;
}

/** Per-test leaderboard page plus the viewer's own position. */
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
      WITH ${rankedCte(testFilter(test))},
      me AS (SELECT pos FROM ranked WHERE "studentId" = ${viewerStudentId})
      SELECT t.total, x.*
      FROM (SELECT COUNT(*)::int AS total FROM ranked) t
      LEFT JOIN LATERAL (
        SELECT r.rank, r.pos, r.score_v::float8 AS score, r.correct::int AS correct, r.incorrect::int AS incorrect,
               r."timeTakenSeconds", (r."studentId" = ${viewerStudentId}) AS "isSelf",
               CASE WHEN r."studentId" = ${viewerStudentId} THEN r.id END AS "selfAttemptId",
               s.name, s.status::text AS "studentStatus"
        FROM ranked r
        JOIN "Student" s ON s.id = r."studentId"
        WHERE r.pos BETWEEN ${from} AND ${to}
           OR r.pos BETWEEN (SELECT pos FROM me) - ${window} AND (SELECT pos FROM me) + ${window}
      ) x ON true
      ORDER BY x.pos`;
  };

  let rows = await run(requestedPage);
  const total = rows[0]?.total ?? 0;
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(requestedPage, pageCount);
  if (page !== requestedPage) rows = await run(page);

  const toRow = (r: RawRow): LeaderboardRow => {
    const rank = r.rank as number;
    const correct = r.correct ?? 0;
    return {
      rank,
      position: r.pos as number,
      displayName: leaderboardDisplayName(r.name, r.studentStatus ?? "ACTIVE"),
      isSelf: r.isSelf === true,
      score: r.score ?? 0,
      accuracy: accuracyFrom(correct, r.incorrect ?? 0),
      correctCount: correct,
      timeTakenSeconds: r.timeTakenSeconds,
      ...rankPercentiles(rank, total),
    };
  };

  const all = rows.filter((r) => r.rank !== null).map((r) => ({ row: toRow(r), selfAttemptId: r.selfAttemptId }));
  const from = (page - 1) * pageSize + 1;
  const to = page * pageSize;
  const onPage = (position: number) => position >= from && position <= to;
  const selfEntry = all.find((x) => x.row.isSelf) ?? null;
  const self = selfEntry?.row ?? null;

  return {
    totalParticipants: total,
    page,
    pageSize,
    pageCount,
    rows: all.filter((x) => onPage(x.row.position)).map((x) => x.row),
    self,
    nearby: self && !onPage(self.position) ? all.filter((x) => !onPage(x.row.position)).map((x) => x.row) : [],
    selfOfficialAttemptId: selfEntry?.selfAttemptId ?? null,
  };
}

/**
 * Admin only (Live CBT Monitor): every ranked row of one test — the same
 * rankedCte rules as getLeaderboard, so the admin sees exactly the ranks
 * students see. Returns the official (ranked) attempt id per student.
 */
export async function getTestRanksForAdmin(test: RankingTestRef): Promise<{ total: number; byStudent: Map<string, { rank: number; attemptId: string }> }> {
  const rows = await prisma.$queryRaw<{ studentId: string; id: string; rank: number; total: number }[]>`
    WITH ${rankedCte(testFilter(test))}
    SELECT "studentId", id, rank, total FROM ranked`;
  return { total: rows[0]?.total ?? 0, byStudent: new Map(rows.map((r) => [r.studentId, { rank: r.rank, attemptId: r.id }])) };
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

// ---------------------------------------------------------------------------
// Overall Rank (per exam)
// ---------------------------------------------------------------------------

/**
 * The exam's Overall-Ranking Mock Tests: Counts Toward Overall Ranking ON,
 * leaderboard ON (a counted test shows each student's percentile), and the
 * result already released (a held result never feeds a visible number).
 * Previous Year Papers are never included — by construction here and by the
 * TestRankingConfig CHECK constraint.
 */
export async function getOverallRankingMockTests(examId: string, now: Date = new Date()) {
  const mocks = await prisma.mockTest.findMany({
    where: { examId, rankingConfig: { is: { countsTowardOverall: true, leaderboardEnabled: true } } },
    select: { id: true, title: true, availableUntil: true, resultReleaseMode: true, resultReleaseAt: true },
  });
  return mocks.filter((m) => isMockResultReleased(m, now));
}

interface OverallAggregate {
  studentId: string;
  name: string;
  status: string;
  /** Ranked Overall-Ranking Mock Tests (may be < OVERALL_MIN_RANKED_TESTS). */
  tests: number;
  /** Sum of the per-test percentiles in tenths (exact integers). */
  sumTenths: number;
}

interface OverallRanked extends OverallAggregate {
  rank: number;
  position: number;
}

interface OverallSnapshot {
  examId: string;
  countedTests: number;
  /** Eligible (≥ OVERALL_MIN_RANKED_TESTS) students, ranked. */
  ranked: OverallRanked[];
  /** Every student with ≥1 ranked counted test → their count (for "x of 3"). */
  testsByStudent: Map<string, number>;
  computedAt: number;
}

/** Overall Rank is recomputed at most once per this interval per process (PM2 instance). */
export const OVERALL_CACHE_MS = 60_000;
const overallCache = new Map<string, OverallSnapshot>();

/** Called after an admin changes a test's ranking settings (this process); other instances refresh within OVERALL_CACHE_MS. */
export function clearOverallRankingCache() {
  overallCache.clear();
}

/**
 * Overall Score = the student's average per-test percentile over the exam's
 * Overall-Ranking Mock Tests they are ranked on (each percentile exactly as
 * shown on that test's leaderboard). At least OVERALL_MIN_RANKED_TESTS tests
 * required. Higher average = better; an exactly equal average shares the
 * rank. No raw marks, no weighting, no time.
 */
async function computeOverall(examId: string): Promise<OverallSnapshot> {
  const mocks = await getOverallRankingMockTests(examId);
  const ids = mocks.map((m) => m.id);
  const rows = ids.length
    ? await prisma.$queryRaw<{ studentId: string; tests: number; sumTenths: number; name: string; status: string }[]>`
        WITH ${rankedCte(testsFilter(ids, []))},
        pct AS (
          SELECT "studentId", LEAST(ROUND(1000.0 * (total - rank) / total), 999)::int AS tenths
          FROM ranked
        )
        SELECT p."studentId", COUNT(*)::int AS tests, SUM(p.tenths)::int AS "sumTenths", s.name, s.status::text AS status
        FROM pct p
        JOIN "Student" s ON s.id = p."studentId"
        GROUP BY p."studentId", s.name, s.status`
    : [];

  const testsByStudent = new Map(rows.map((r) => [r.studentId, r.tests]));
  const eligible = rows.filter((r) => r.tests >= OVERALL_MIN_RANKED_TESTS);
  // avgA vs avgB exactly: sumA/testsA vs sumB/testsB by cross-multiplication.
  const better = (a: OverallAggregate, b: OverallAggregate) => b.sumTenths * a.tests - a.sumTenths * b.tests;
  eligible.sort((a, b) => better(a, b) || (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0));
  const ranks = competitionRanks(eligible, (a, b) => better(a, b) === 0);
  return {
    examId,
    countedTests: ids.length,
    ranked: eligible.map((r, i) => ({ ...r, rank: ranks[i], position: i + 1 })),
    testsByStudent,
    computedAt: Date.now(),
  };
}

async function getOverallSnapshot(examId: string, opts: { fresh?: boolean } = {}): Promise<OverallSnapshot> {
  const cached = overallCache.get(examId);
  if (!opts.fresh && cached && Date.now() - cached.computedAt < OVERALL_CACHE_MS) return cached;
  const snapshot = await computeOverall(examId);
  overallCache.set(examId, snapshot);
  return snapshot;
}

export interface OverallRow {
  rank: number;
  position: number;
  displayName: string;
  isSelf: boolean;
  /** Average per-test percentile, one decimal. */
  averagePercentile: number;
  rankedTests: number;
  topPercent: number;
}

export interface OverallStanding {
  /** Overall-Ranking Mock Tests currently counted in this exam. */
  countedTests: number;
  /** Students with an Overall Rank. */
  totalRanked: number;
  /** The viewer's ranked counted tests (shown even when below the minimum). */
  selfRankedTests: number;
  self: OverallRow | null;
}

function toOverallRow(r: OverallRanked, total: number, viewer: string): OverallRow {
  return {
    rank: r.rank,
    position: r.position,
    displayName: leaderboardDisplayName(r.name, r.status),
    isSelf: r.studentId === viewer,
    averagePercentile: Math.round(r.sumTenths / r.tests) / 10,
    rankedTests: r.tests,
    topPercent: rankPercentiles(r.rank, total).topPercent,
  };
}

/** The viewer's Overall Rank in one exam (dashboard card / Ranking & Progress). */
export async function getOverallStanding(examId: string, studentId: string, opts: { fresh?: boolean } = {}): Promise<OverallStanding> {
  const snap = await getOverallSnapshot(examId, opts);
  const mine = snap.ranked.find((r) => r.studentId === studentId);
  return {
    countedTests: snap.countedTests,
    totalRanked: snap.ranked.length,
    selfRankedTests: snap.testsByStudent.get(studentId) ?? 0,
    self: mine ? toOverallRow(mine, snap.ranked.length, studentId) : null,
  };
}

export interface OverallLeaderboard extends OverallStanding {
  page: number;
  pageSize: number;
  pageCount: number;
  rows: OverallRow[];
  nearby: OverallRow[];
}

/** Overall Leaderboard page for one exam plus the viewer's ±window. */
export async function getOverallLeaderboard(
  examId: string,
  studentId: string,
  opts: { page?: number; pageSize?: number; window?: number; fresh?: boolean } = {}
): Promise<OverallLeaderboard> {
  const snap = await getOverallSnapshot(examId, opts);
  const total = snap.ranked.length;
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? 50), 1), 100);
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Math.trunc(Number.isFinite(opts.page) ? (opts.page as number) : 1), 1), pageCount);
  const window = Math.min(Math.max(Math.trunc(opts.window ?? 2), 0), 10);
  const rows = snap.ranked.slice((page - 1) * pageSize, page * pageSize).map((r) => toOverallRow(r, total, studentId));
  const mine = snap.ranked.find((r) => r.studentId === studentId);
  const self = mine ? toOverallRow(mine, total, studentId) : null;
  const onPage = self ? self.position > (page - 1) * pageSize && self.position <= page * pageSize : true;
  const nearby =
    self && !onPage
      ? snap.ranked.slice(Math.max(self.position - 1 - window, 0), self.position + window).map((r) => toOverallRow(r, total, studentId))
      : [];
  return {
    countedTests: snap.countedTests,
    totalRanked: total,
    selfRankedTests: snap.testsByStudent.get(studentId) ?? 0,
    self,
    page,
    pageSize,
    pageCount,
    rows,
    nearby,
  };
}

// ---------------------------------------------------------------------------
// Ranking & Progress: the viewer's ranked tests in one exam
// ---------------------------------------------------------------------------

export interface RankedTestHistoryRow {
  kind: "MOCK_TEST" | "PREVIOUS_YEAR_PAPER";
  title: string;
  /** The viewer's OWN official attempt (for result / leaderboard links). */
  attemptId: string;
  submittedAt: Date | null;
  score: number;
  maxScore: number | null;
  accuracy: number;
  rank: number;
  total: number;
  percentile: number;
  topPercent: number;
  countsTowardOverall: boolean;
}

/**
 * Every Mock Test / Previous Year Paper of the exam the viewer is ranked on
 * (leaderboard on, Mock result released), newest first. Same rules and query
 * as the per-test leaderboards.
 */
export async function getStudentRankedTests(examId: string, studentId: string, now: Date = new Date()): Promise<RankedTestHistoryRow[]> {
  const attempted = await prisma.testAttempt.findMany({
    where: { studentId, examId, status: "SUBMITTED", sourceType: { in: ["MOCK_TEST", "PREVIOUS_YEAR_PAPER"] } },
    select: { mockTestId: true, previousYearPaperId: true, sourceType: true },
    distinct: ["mockTestId", "previousYearPaperId"],
  });
  const mockIds = [...new Set(attempted.filter((a) => a.sourceType === "MOCK_TEST" && a.mockTestId).map((a) => a.mockTestId!))];
  const paperIds = [...new Set(attempted.filter((a) => a.sourceType === "PREVIOUS_YEAR_PAPER" && a.previousYearPaperId).map((a) => a.previousYearPaperId!))];
  const [mocks, papers] = await Promise.all([
    mockIds.length
      ? prisma.mockTest.findMany({
          where: { id: { in: mockIds } },
          select: { id: true, title: true, leaderboardEnabled: true, availableUntil: true, resultReleaseMode: true, resultReleaseAt: true, rankingConfig: { select: { leaderboardEnabled: true, countsTowardOverall: true } } },
        })
      : [],
    paperIds.length
      ? prisma.previousYearPaper.findMany({ where: { id: { in: paperIds } }, select: { id: true, title: true, year: true, rankingConfig: { select: { leaderboardEnabled: true } } } })
      : [],
  ]);
  const shownMocks = mocks.filter((m) => (m.rankingConfig?.leaderboardEnabled ?? m.leaderboardEnabled) && isMockResultReleased(m, now));
  const shownPapers = papers.filter((p) => p.rankingConfig?.leaderboardEnabled ?? true);
  if (shownMocks.length + shownPapers.length === 0) return [];

  const rows = await prisma.$queryRaw<
    { mockTestId: string | null; previousYearPaperId: string | null; id: string; submittedAt: Date | null; score: number; correct: number; incorrect: number; rank: number; total: number }[]
  >`
    WITH ${rankedCte(testsFilter(shownMocks.map((m) => m.id), shownPapers.map((p) => p.id)))}
    SELECT r."mockTestId", r."previousYearPaperId", r.id, r."submittedAt", r.score_v::float8 AS score,
           r.correct::int AS correct, r.incorrect::int AS incorrect, r.rank, r.total
    FROM ranked r
    WHERE r."studentId" = ${studentId}`;

  const maxScores = new Map(
    (await prisma.testAttempt.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, maxScore: true } })).map((a) => [a.id, a.maxScore])
  );
  return rows
    .map((r): RankedTestHistoryRow => {
      const mock = r.mockTestId ? shownMocks.find((m) => m.id === r.mockTestId) : undefined;
      const paper = r.previousYearPaperId ? shownPapers.find((p) => p.id === r.previousYearPaperId) : undefined;
      return {
        kind: mock ? "MOCK_TEST" : "PREVIOUS_YEAR_PAPER",
        title: mock ? mock.title : paper ? (paper.year ? `${paper.title} (${paper.year})` : paper.title) : "Test",
        attemptId: r.id,
        submittedAt: r.submittedAt,
        score: r.score,
        maxScore: maxScores.get(r.id) ?? null,
        accuracy: accuracyFrom(r.correct, r.incorrect),
        rank: r.rank,
        total: r.total,
        ...rankPercentiles(r.rank, r.total),
        countsTowardOverall: !!mock?.rankingConfig?.countsTowardOverall && !!mock.rankingConfig.leaderboardEnabled,
      };
    })
    .sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0));
}
