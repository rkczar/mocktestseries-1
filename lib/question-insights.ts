import "server-only";
import { Prisma, QuestionDifficulty, QuestionSource, QuestionStatus, TestType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { formatIst, istStartOfDay, parseIstDateTimeLocal } from "@/lib/ist-time";
import { SHARE_SITE_URL, examDisplayName } from "@/lib/whatsapp-share-template";
import { answerKeyIssue, answerKeyString, buildCopyBlocks, hasAnyImage, type CopyBlockSize, type CopyIssue, type CopyQuestion } from "@/lib/question-insights-format";

/**
 * Admin → Analytics → Question Insights: which questions students struggled
 * with in a period, aggregated entirely in PostgreSQL (never by loading
 * attempts into memory).
 *
 * The answer universe is the existing unified attempt engine
 * (lib/test-attempt.ts): every test type writes TestAttempt +
 * TestAttemptQuestion + exactly ONE Answer row per attempt-question (unique
 * attemptQuestionId — autosaves update that row in place, so they can never
 * inflate counts). `Answer.isCorrect` is written only by submitAttempt,
 * scored against the attempt's frozen question snapshot, and stays NULL for
 * unanswered questions. So a "valid answered attempt" here is an Answer with
 * isCorrect IS NOT NULL on a SUBMITTED attempt, dated by the attempt's
 * submittedAt — the final answer state, never an in-progress autosave.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_RANGE_DAYS = 366;
export const PAGE_SIZE = 25;
export const MIN_ATTEMPT_CHOICES = [1, 5, 10, 20, 50] as const;
export const DEFAULT_MIN_ATTEMPTS = 5;
export const TOP_CHOICES = [10, 20, 50] as const;
export const MAX_COPY_QUESTIONS = 100;

export const RANGE_PRESETS = ["today", "yesterday", "7d", "30d", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const TABS = ["wrong", "attempted", "reported", "saved", "ai"] as const;
export type InsightTab = (typeof TABS)[number];

export const SORTS = ["wrong", "wrongPct", "attempts", "reports", "saves"] as const;
export type InsightSort = (typeof SORTS)[number];

export const TEST_TYPE_LABELS: Record<TestType, string> = {
  FULL_MOCK: "Mock Test",
  SUBJECT_TEST: "Subject Test",
  GRAND_TEST: "Grand Test",
  LIVE_TEST: "Live Test",
  PREVIOUS_YEAR_PAPER: "Previous Year Paper",
  CUSTOM_MODULE: "Custom Module",
};

const id = z
  .string()
  .trim()
  .regex(/^[a-z0-9]{10,40}$/i)
  .optional()
  .catch(undefined);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

/** Every filter is validated against a whitelist/enum here; anything else falls back to its default. Values reach SQL only as bound parameters. */
const filterSchema = z.object({
  tab: z.enum(TABS).catch("wrong"),
  range: z.enum(RANGE_PRESETS).catch("today"),
  from: isoDate,
  to: isoDate,
  examId: id,
  subjectId: id,
  topicId: id,
  subTopicId: id,
  testType: z.nativeEnum(TestType).optional().catch(undefined),
  source: z.nativeEnum(QuestionSource).optional().catch(undefined),
  difficulty: z.nativeEnum(QuestionDifficulty).optional().catch(undefined),
  status: z.nativeEnum(QuestionStatus).optional().catch(undefined),
  min: z.coerce
    .number()
    .refine((n) => (MIN_ATTEMPT_CHOICES as readonly number[]).includes(n))
    .catch(DEFAULT_MIN_ATTEMPTS),
  sort: z.enum(SORTS).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

export type InsightFilters = z.infer<typeof filterSchema> & { sort: InsightSort };

export function parseInsightFilters(raw: Record<string, string | string[] | undefined>): InsightFilters {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === "string" && value !== "") flat[k] = value;
  }
  const parsed = filterSchema.parse(flat);
  return { ...parsed, sort: parsed.sort ?? (parsed.tab === "attempted" ? "attempts" : "wrong") };
}

/** Serializes filters back to a query string (defaults omitted), for links, the CSV export and server actions. */
export function insightFiltersToQuery(f: InsightFilters, overrides: Partial<Record<keyof InsightFilters, string | number | undefined>> = {}): string {
  const merged: Record<string, string | number | undefined> = { ...f, ...overrides };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "page" && Number(v) === 1) continue;
    if ((k === "from" || k === "to") && merged.range !== "custom") continue;
    params.set(k, String(v));
  }
  return params.toString();
}

// ---------------------------------------------------------------------------
// Date range (Asia/Kolkata calendar days — the server itself runs in UTC)
// ---------------------------------------------------------------------------

export interface ResolvedRange {
  preset: RangePreset;
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
  label: string;
  /** Wording for the copied headline, e.g. "TODAY" / "(LAST 7 DAYS)". */
  headlineSuffix: string;
  error?: string;
}

function istDayLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(d);
}

export function resolveRange(f: Pick<InsightFilters, "range" | "from" | "to">, now = new Date()): ResolvedRange {
  const todayStart = istStartOfDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const until = (end: Date) => (end.getTime() > now.getTime() ? `now (${formatIst(now)})` : formatIst(end));
  const make = (preset: RangePreset, from: Date, to: Date, headlineSuffix: string, error?: string): ResolvedRange => ({
    preset,
    from,
    to,
    headlineSuffix,
    error,
    label: `${formatIst(from)} → ${until(to)}`,
  });

  switch (f.range) {
    case "yesterday":
      return make("yesterday", new Date(todayStart.getTime() - DAY_MS), todayStart, "YESTERDAY");
    case "7d":
      return make("7d", new Date(todayStart.getTime() - 6 * DAY_MS), tomorrowStart, "(LAST 7 DAYS)");
    case "30d":
      return make("30d", new Date(todayStart.getTime() - 29 * DAY_MS), tomorrowStart, "(LAST 30 DAYS)");
    case "custom": {
      const from = f.from ? parseIstDateTimeLocal(`${f.from}T00:00`) : null;
      const toStart = f.to ? parseIstDateTimeLocal(`${f.to}T00:00`) : null;
      if (!from || !toStart) return { ...make("today", todayStart, tomorrowStart, "TODAY"), error: "Pick both a start and an end date." };
      if (toStart < from) return { ...make("today", todayStart, tomorrowStart, "TODAY"), error: "The end date is before the start date." };
      const to = new Date(toStart.getTime() + DAY_MS);
      if ((to.getTime() - from.getTime()) / DAY_MS > MAX_CUSTOM_RANGE_DAYS) {
        return { ...make("today", todayStart, tomorrowStart, "TODAY"), error: `Custom ranges are limited to ${MAX_CUSTOM_RANGE_DAYS} days.` };
      }
      const sameDay = f.from === f.to;
      const suffix = sameDay ? `(${istDayLabel(from).toUpperCase()})` : `(${istDayLabel(from).toUpperCase()} – ${istDayLabel(toStart).toUpperCase()})`;
      return make("custom", from, to, suffix);
    }
    default:
      return make("today", todayStart, tomorrowStart, "TODAY");
  }
}

// ---------------------------------------------------------------------------
// SQL building blocks — every value is a bound parameter; only whitelisted
// ORDER BY fragments are raw.
// ---------------------------------------------------------------------------

function questionConds(f: InsightFilters): Prisma.Sql {
  const c: Prisma.Sql[] = [];
  if (f.examId) c.push(Prisma.sql`q."examId" = ${f.examId}`);
  if (f.subjectId) c.push(Prisma.sql`q."subjectId" = ${f.subjectId}`);
  if (f.topicId) c.push(Prisma.sql`q."topicId" = ${f.topicId}`);
  if (f.subTopicId) c.push(Prisma.sql`q."subTopicId" = ${f.subTopicId}`);
  if (f.source) c.push(Prisma.sql`q.source = CAST(${f.source} AS "QuestionSource")`);
  if (f.difficulty) c.push(Prisma.sql`q.difficulty = CAST(${f.difficulty} AS "QuestionDifficulty")`);
  if (f.status) c.push(Prisma.sql`q.status = CAST(${f.status} AS "QuestionStatus")`);
  return c.length ? Prisma.sql` AND ${Prisma.join(c, " AND ")}` : Prisma.empty;
}

/** FROM/WHERE for valid answered attempts in the window (alias a = Answer, t = TestAttempt, q = Question). */
function answeredBase(f: InsightFilters, r: ResolvedRange, extraJoin: Prisma.Sql = Prisma.empty): Prisma.Sql {
  const testType = f.testType ? Prisma.sql` AND t."testType" = CAST(${f.testType} AS "TestType")` : Prisma.empty;
  return Prisma.sql`
    FROM "TestAttempt" t
    JOIN "Answer" a ON a."attemptId" = t.id
    JOIN "Question" q ON q.id = a."questionId"${extraJoin}
    WHERE t.status = 'SUBMITTED'
      AND t."submittedAt" >= ${r.from} AND t."submittedAt" < ${r.to}
      AND a."isCorrect" IS NOT NULL${testType}${questionConds(f)}`;
}

function idList(ids: string[]): Prisma.Sql {
  return Prisma.join(ids.map((x) => Prisma.sql`${x}`));
}

const ORDER_BY: Record<InsightSort, Prisma.Sql> = {
  wrong: Prisma.raw(`wrong DESC, attempts DESC, qid`),
  wrongPct: Prisma.raw(`wrong_pct DESC, attempts DESC, qid`),
  attempts: Prisma.raw(`attempts DESC, wrong DESC, qid`),
  reports: Prisma.raw(`reports DESC, wrong DESC, qid`),
  saves: Prisma.raw(`saves DESC, wrong DESC, qid`),
};

interface RankedRow {
  qid: string;
  total: number;
}

/** Most Wrong / Most Attempted ranking. Aggregates the window once, joins pre-aggregated reports/saves, sorts, and pages — all in SQL. */
async function rankAnswered(f: InsightFilters, r: ResolvedRange, limit: number, offset: number): Promise<RankedRow[]> {
  return prisma.$queryRaw<RankedRow[]>`
    WITH ans AS (
      SELECT a."questionId" AS qid,
             COUNT(*)::int AS attempts,
             COUNT(*) FILTER (WHERE NOT a."isCorrect")::int AS wrong
      ${answeredBase(f, r)}
      GROUP BY a."questionId"
      HAVING COUNT(*) >= ${f.min}
    ),
    rep AS (
      SELECT "questionId" AS qid, COUNT(*)::int AS reports FROM "ReportedQuestion"
      WHERE "createdAt" >= ${r.from} AND "createdAt" < ${r.to} AND "questionId" IN (SELECT qid FROM ans)
      GROUP BY 1
    ),
    sav AS (
      SELECT "questionId" AS qid, COUNT(*)::int AS saves FROM "SavedQuestion"
      WHERE "createdAt" >= ${r.from} AND "createdAt" < ${r.to} AND "questionId" IN (SELECT qid FROM ans)
      GROUP BY 1
    )
    SELECT ans.qid, (COUNT(*) OVER ())::int AS total
    FROM (
      SELECT ans.*, ans.wrong::float / ans.attempts AS wrong_pct, COALESCE(rep.reports, 0) AS reports, COALESCE(sav.saves, 0) AS saves
      FROM ans LEFT JOIN rep USING (qid) LEFT JOIN sav USING (qid)
    ) ans
    ORDER BY ${ORDER_BY[f.sort]}
    LIMIT ${limit} OFFSET ${offset}`;
}

interface ReportedAgg {
  qid: string;
  total: number;
  reports: number;
  reporters: number;
  open_reports: number;
  last_at: Date;
  types: string[];
}

async function rankReported(f: InsightFilters, r: ResolvedRange, limit: number, offset: number): Promise<ReportedAgg[]> {
  return prisma.$queryRaw<ReportedAgg[]>`
    SELECT rq."questionId" AS qid,
           (COUNT(*) OVER ())::int AS total,
           COUNT(*)::int AS reports,
           COUNT(DISTINCT rq."studentId")::int AS reporters,
           COUNT(*) FILTER (WHERE rq.status = 'OPEN')::int AS open_reports,
           MAX(rq."createdAt") AS last_at,
           array_agg(DISTINCT rq."reportType"::text) AS types
    FROM "ReportedQuestion" rq
    JOIN "Question" q ON q.id = rq."questionId"
    WHERE rq."createdAt" >= ${r.from} AND rq."createdAt" < ${r.to}${questionConds(f)}
    GROUP BY rq."questionId"
    ORDER BY reports DESC, last_at DESC, qid
    LIMIT ${limit} OFFSET ${offset}`;
}

interface CountAgg {
  qid: string;
  total: number;
  n: number;
  students: number;
}

/** SavedQuestion rows are deleted on un-save, so this counts saves made in the window that are still saved. */
async function rankSaved(f: InsightFilters, r: ResolvedRange, limit: number, offset: number): Promise<CountAgg[]> {
  return prisma.$queryRaw<CountAgg[]>`
    SELECT s."questionId" AS qid, (COUNT(*) OVER ())::int AS total, COUNT(*)::int AS n, COUNT(*)::int AS students
    FROM "SavedQuestion" s
    JOIN "Question" q ON q.id = s."questionId"
    WHERE s."createdAt" >= ${r.from} AND s."createdAt" < ${r.to}${questionConds(f)}
    GROUP BY s."questionId"
    ORDER BY n DESC, qid
    LIMIT ${limit} OFFSET ${offset}`;
}

/** Ask AI opens, from the same AI_EXPLANATION_VIEWED log Admin → AI Usage and the student quota read (lib/student-data.ts#logAiAccess). Uses the (activity, createdAt) index. */
async function rankAskedAi(f: InsightFilters, r: ResolvedRange, limit: number, offset: number): Promise<CountAgg[]> {
  return prisma.$queryRaw<CountAgg[]>`
    SELECT q.id AS qid, (COUNT(*) OVER ())::int AS total, COUNT(*)::int AS n, COUNT(DISTINCT sa."studentId")::int AS students
    FROM "StudentActivity" sa
    JOIN "Question" q ON q.id = sa.metadata->>'questionId'
    WHERE sa.activity = 'AI_EXPLANATION_VIEWED'
      AND sa."createdAt" >= ${r.from} AND sa."createdAt" < ${r.to}${questionConds(f)}
    GROUP BY q.id
    ORDER BY n DESC, students DESC, qid
    LIMIT ${limit} OFFSET ${offset}`;
}

interface AnswerStat {
  qid: string;
  attempts: number;
  correct: number;
  wrong: number;
}

/** Window answer stats for a known set of questions (no minimum) — used to enrich a page of rows and for the copied wrong %. */
async function answerStatsFor(ids: string[], f: InsightFilters, r: ResolvedRange): Promise<Map<string, AnswerStat>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<AnswerStat[]>`
    SELECT a."questionId" AS qid,
           COUNT(*)::int AS attempts,
           COUNT(*) FILTER (WHERE a."isCorrect")::int AS correct,
           COUNT(*) FILTER (WHERE NOT a."isCorrect")::int AS wrong
    ${answeredBase(f, r)} AND a."questionId" IN (${idList(ids)})
    GROUP BY a."questionId"`;
  return new Map(rows.map((row) => [row.qid, row]));
}

/** Answers per frozen snapshot answer key, to spot questions whose key changed after students attempted them. */
async function snapshotKeysFor(ids: string[], f: InsightFilters, r: ResolvedRange): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ qid: string; key: string }[]>`
    SELECT DISTINCT a."questionId" AS qid,
           -- A v3 MULTIPLE_CORRECT snapshot freezes its key as the correctLabels set (sorted "A,B,D"); every other snapshot as before.
           COALESCE(CASE WHEN tq."questionSnapshot"->>'questionType' = 'MULTIPLE_CORRECT' AND tq."questionSnapshot"->>'v' = '3'
                         THEN (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(tq."questionSnapshot"->'correctLabels') x)
                         ELSE tq."questionSnapshot"->>'correctLabel' END, '') AS key
    ${answeredBase(f, r, Prisma.sql` JOIN "TestAttemptQuestion" tq ON tq.id = a."attemptQuestionId"`)} AND a."questionId" IN (${idList(ids)})`;
  const map = new Map<string, string[]>();
  for (const row of rows) map.set(row.qid, [...(map.get(row.qid) ?? []), row.key]);
  return map;
}

async function periodCountsFor(ids: string[], r: ResolvedRange) {
  if (ids.length === 0) return { reports: new Map<string, number>(), saves: new Map<string, number>() };
  const [reports, saves] = await Promise.all([
    prisma.reportedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids }, createdAt: { gte: r.from, lt: r.to } }, _count: { _all: true } }),
    prisma.savedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids }, createdAt: { gte: r.from, lt: r.to } }, _count: { _all: true } }),
  ]);
  return {
    reports: new Map(reports.map((x) => [x.questionId, x._count._all])),
    saves: new Map(saves.map((x) => [x.questionId, x._count._all])),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InsightOverview {
  answered: number;
  uniqueQuestions: number;
  correct: number;
  wrong: number;
  accuracy: number | null;
  students: number;
  reports: number;
  reportedQuestions: number;
  /** Answered attempts in the window whose question has since been deleted (Answer.questionId has no FK) — excluded everywhere above. */
  deletedQuestionAnswers: number;
}

export async function getInsightOverview(f: InsightFilters, r: ResolvedRange): Promise<InsightOverview> {
  const testType = f.testType ? Prisma.sql` AND t."testType" = CAST(${f.testType} AS "TestType")` : Prisma.empty;
  const [answers, reports, orphans] = await Promise.all([
    prisma.$queryRaw<{ answered: number; unique_questions: number; correct: number; wrong: number; students: number }[]>`
      SELECT COUNT(*)::int AS answered,
             COUNT(DISTINCT a."questionId")::int AS unique_questions,
             COUNT(*) FILTER (WHERE a."isCorrect")::int AS correct,
             COUNT(*) FILTER (WHERE NOT a."isCorrect")::int AS wrong,
             COUNT(DISTINCT a."studentId")::int AS students
      ${answeredBase(f, r)}`,
    prisma.$queryRaw<{ reports: number; questions: number }[]>`
      SELECT COUNT(*)::int AS reports, COUNT(DISTINCT rq."questionId")::int AS questions
      FROM "ReportedQuestion" rq JOIN "Question" q ON q.id = rq."questionId"
      WHERE rq."createdAt" >= ${r.from} AND rq."createdAt" < ${r.to}${questionConds(f)}`,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM "TestAttempt" t
      JOIN "Answer" a ON a."attemptId" = t.id
      WHERE t.status = 'SUBMITTED' AND t."submittedAt" >= ${r.from} AND t."submittedAt" < ${r.to}
        AND a."isCorrect" IS NOT NULL${testType}
        AND NOT EXISTS (SELECT 1 FROM "Question" q WHERE q.id = a."questionId")`,
  ]);
  const a = answers[0];
  return {
    answered: a.answered,
    uniqueQuestions: a.unique_questions,
    correct: a.correct,
    wrong: a.wrong,
    accuracy: a.answered > 0 ? (a.correct / a.answered) * 100 : null,
    students: a.students,
    reports: reports[0].reports,
    reportedQuestions: reports[0].questions,
    deletedQuestionAnswers: orphans[0].n,
  };
}

export interface InsightRow {
  id: string;
  code: string;
  textPreview: string;
  examName: string;
  subjectName: string;
  topicName: string | null;
  subTopicName: string | null;
  status: QuestionStatus;
  difficulty: QuestionDifficulty;
  reviewRequired: boolean;
  reviewReason: string | null;
  hasImage: boolean;
  /** Public question image URL, only for images in the app's public storage. */
  imageLink: string | null;
  keyIssue: CopyIssue | null;
  /** Some answers in the window were scored against a different answer key than the current one. */
  keyChanged: boolean;
  attempts: number;
  correct: number;
  wrong: number;
  wrongPct: number | null;
  reports: number;
  saves: number;
  reporters?: number;
  openReports?: number;
  lastReportedAt?: Date;
  reportTypes?: string[];
  aiViews?: number;
  aiStudents?: number;
}

const PUBLIC_IMAGE_PREFIX = "/storage/question-images/";

export function publicImageLink(imageUrl: string | null): string | null {
  if (!imageUrl || !imageUrl.startsWith(PUBLIC_IMAGE_PREFIX) || imageUrl.includes("..") || imageUrl.includes("?")) return null;
  return `${SHARE_SITE_URL}${imageUrl}`;
}

function plainPreview(text: string): string {
  const s = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 180 ? `${s.slice(0, 177)}…` : s;
}

async function rankedIds(f: InsightFilters, r: ResolvedRange, limit: number, offset: number) {
  switch (f.tab) {
    case "reported": {
      const rows = await rankReported(f, r, limit, offset);
      return { ids: rows.map((x) => x.qid), total: rows[0]?.total ?? 0, reported: new Map(rows.map((x) => [x.qid, x])) };
    }
    case "saved":
    case "ai": {
      const rows = await (f.tab === "saved" ? rankSaved : rankAskedAi)(f, r, limit, offset);
      return { ids: rows.map((x) => x.qid), total: rows[0]?.total ?? 0, counted: new Map(rows.map((x) => [x.qid, x])) };
    }
    default: {
      const rows = await rankAnswered(f, r, limit, offset);
      return { ids: rows.map((x) => x.qid), total: rows[0]?.total ?? 0 };
    }
  }
}

/**
 * One page of the active tab. Ranking runs in SQL; the page's ≤25 ids are
 * then enriched with three batched lookups (questions, answer stats,
 * reports/saves) — never one query per row.
 */
export async function getInsightRows(f: InsightFilters, r: ResolvedRange): Promise<{ rows: InsightRow[]; total: number }> {
  const offset = (f.page - 1) * PAGE_SIZE;
  const ranked = await rankedIds(f, r, PAGE_SIZE, offset);
  const ids = ranked.ids;
  if (ids.length === 0) return { rows: [], total: ranked.total };

  const [questions, stats, counts, keys] = await Promise.all([
    prisma.question.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        text: true,
        imageUrl: true,
        status: true,
        difficulty: true,
        reviewRequired: true,
        reviewReason: true,
        exam: { select: { name: true } },
        subject: { select: { name: true } },
        topic: { select: { name: true } },
        subTopic: { select: { name: true } },
        options: { select: { label: true, isCorrect: true, imageUrl: true } },
        questionType: true,
      },
    }),
    answerStatsFor(ids, f, r),
    periodCountsFor(ids, r),
    snapshotKeysFor(ids, f, r),
  ]);
  const byId = new Map(questions.map((q) => [q.id, q]));

  const rows: InsightRow[] = [];
  for (const qid of ids) {
    const q = byId.get(qid);
    if (!q) continue;
    const s = stats.get(qid);
    const keyIssue = answerKeyIssue(q.options, q.questionType);
    const currentKey = keyIssue ? null : answerKeyString(q.options);
    const rep = ranked.reported?.get(qid);
    const cnt = ranked.counted?.get(qid);
    rows.push({
      id: q.id,
      code: q.code,
      textPreview: plainPreview(q.text),
      examName: q.exam.name,
      subjectName: q.subject.name,
      topicName: q.topic?.name ?? null,
      subTopicName: q.subTopic?.name ?? null,
      status: q.status,
      difficulty: q.difficulty,
      reviewRequired: q.reviewRequired,
      reviewReason: q.reviewReason,
      hasImage: hasAnyImage(q),
      imageLink: publicImageLink(q.imageUrl),
      keyIssue,
      keyChanged: !keyIssue && (keys.get(qid) ?? []).some((k) => k !== currentKey),
      attempts: s?.attempts ?? 0,
      correct: s?.correct ?? 0,
      wrong: s?.wrong ?? 0,
      wrongPct: s && s.attempts > 0 ? (s.wrong / s.attempts) * 100 : null,
      reports: rep?.reports ?? counts.reports.get(qid) ?? 0,
      saves: f.tab === "saved" ? (cnt?.n ?? 0) : (counts.saves.get(qid) ?? 0),
      ...(rep ? { reporters: rep.reporters, openReports: rep.open_reports, lastReportedAt: rep.last_at, reportTypes: rep.types } : {}),
      ...(f.tab === "ai" && cnt ? { aiViews: cnt.n, aiStudents: cnt.students } : {}),
    });
  }
  return { rows, total: ranked.total };
}

/** The current tab's top-N question ids, for "Select Top N" / "Copy Top N". */
export async function getTopQuestionIds(f: InsightFilters, r: ResolvedRange, n: number): Promise<string[]> {
  const limit = Math.min(Math.max(1, Math.floor(n)), MAX_COPY_QUESTIONS);
  return (await rankedIds(f, r, limit, 0)).ids;
}

/** Rows for the CSV export of the current filtered view (capped). */
export async function getInsightExportRows(f: InsightFilters, r: ResolvedRange, cap = 5000): Promise<InsightRow[]> {
  const out: InsightRow[] = [];
  const pages = Math.ceil(cap / PAGE_SIZE);
  for (let page = 1; page <= pages; page++) {
    const { rows } = await getInsightRows({ ...f, page }, r);
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

const TAB_HEADLINES: Record<InsightTab, string> = {
  wrong: "🔥 MOST MISSED QUESTIONS",
  attempted: "📝 MOST ATTEMPTED QUESTIONS",
  reported: "📌 QUESTIONS IN FOCUS",
  saved: "🔖 MOST SAVED QUESTIONS",
  ai: "🤖 MOST ASKED QUESTIONS",
};

function examLabel(exam: { name: string; year: number | null }): string {
  const year = exam.year ?? Number(exam.name.match(/\b(19|20)\d{2}\b/)?.[0] ?? NaN);
  const display = examDisplayName(exam.name);
  return Number.isFinite(year) && !display.includes(String(year)) ? `${display} ${year}` : display;
}

export interface CopyPreparation {
  blocks: { from: number; to: number; text: string }[];
  includedCount: number;
  excluded: { id: string; code: string; issue: CopyIssue }[];
  imageCodes: string[];
  noAttemptCodes: string[];
  keyChangedCodes: string[];
  missingExplanationCodes: string[];
}

/** Loads the CANONICAL question content (current text, options, stored correct option) for the given ids, in order, and renders the clipboard blocks. */
export async function prepareQuestionCopy(params: {
  ids: string[];
  filters: InsightFilters;
  range: ResolvedRange;
  blockSize: CopyBlockSize;
  includeExplanation: boolean;
}): Promise<CopyPreparation> {
  const ids = Array.from(new Set(params.ids)).slice(0, MAX_COPY_QUESTIONS);
  const [questions, stats, keys, filterExam] = await Promise.all([
    prisma.question.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        text: true,
        imageUrl: true,
        exam: { select: { id: true, name: true, year: true } },
        options: { orderBy: [{ order: "asc" }, { label: "asc" }], select: { label: true, text: true, imageUrl: true, isCorrect: true } },
        aiExplanation: { select: { status: true, isStale: true, content: true } },
        questionType: true,
        matchSpec: true,
      },
    }),
    answerStatsFor(ids, params.filters, params.range),
    snapshotKeysFor(ids, params.filters, params.range),
    params.filters.examId ? prisma.exam.findUnique({ where: { id: params.filters.examId }, select: { name: true, year: true } }) : null,
  ]);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = ids.map((x) => byId.get(x)).filter((q): q is (typeof questions)[number] => Boolean(q));

  const copyQuestions: CopyQuestion[] = ordered.map((q) => {
    const s = stats.get(q.id);
    const ai = q.aiExplanation;
    const concept =
      ai && ai.status === "COMPLETED" && !ai.isStale && typeof (ai.content as { concept?: unknown } | null)?.concept === "string"
        ? ((ai.content as { concept: string }).concept.trim() || null)
        : null;
    return {
      id: q.id,
      code: q.code,
      text: q.text,
      imageUrl: q.imageUrl,
      options: q.options,
      ...(q.questionType !== "SINGLE_CORRECT" ? { questionType: q.questionType, matchSpec: q.matchSpec } : {}),
      wrongPct: s && s.attempts > 0 ? (s.wrong / s.attempts) * 100 : null,
      explanation: concept,
    };
  });

  const exams = new Map(ordered.map((q) => [q.exam.id, q.exam]));
  const exam = filterExam ?? (exams.size === 1 ? [...exams.values()][0] : null);
  const subtitle = exam ? `${examLabel(exam)} | MockTestSeries.in` : "MockTestSeries.in";
  const headline = `${TAB_HEADLINES[params.filters.tab]} ${params.range.headlineSuffix}`;

  const built = buildCopyBlocks({ questions: copyQuestions, headline, subtitle, blockSize: params.blockSize, includeExplanation: params.includeExplanation });
  const excludedIds = new Set(built.excluded.map((e) => e.id));
  const included = copyQuestions.filter((q) => !excludedIds.has(q.id));

  return {
    blocks: built.blocks,
    includedCount: built.includedCount,
    excluded: built.excluded,
    imageCodes: included.filter((q) => hasAnyImage(q)).map((q) => q.code),
    noAttemptCodes: included.filter((q) => q.wrongPct === null).map((q) => q.code),
    keyChangedCodes: included
      .filter((q) => {
        const current = answerKeyString(q.options);
        return (keys.get(q.id) ?? []).some((k) => k !== current);
      })
      .map((q) => q.code),
    missingExplanationCodes: params.includeExplanation ? included.filter((q) => !q.explanation).map((q) => q.code) : [],
  };
}

/** Filter dropdown sources — cascading so lists stay short (subjects of the exam, topics of the subject, sub-topics of the topic). */
export async function getInsightFilterOptions(f: InsightFilters) {
  const [exams, subjects, topics, subTopics] = await Promise.all([
    prisma.exam.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    f.examId
      ? prisma.subject.findMany({ where: { examLinks: { some: { examId: f.examId, isActive: true } } }, orderBy: { name: "asc" }, select: { id: true, name: true } })
      : prisma.subject.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    f.subjectId ? prisma.topic.findMany({ where: { subjectId: f.subjectId }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
    f.topicId ? prisma.subTopic.findMany({ where: { topicId: f.topicId }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } }) : [],
  ]);
  return { exams, subjects, topics, subTopics };
}
