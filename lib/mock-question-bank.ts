import "server-only";
import { QuestionDifficulty, QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Mock Test → Step 3 → Add From Question Bank: server-side search over the
 * WHOLE central Question Bank (every exam), paginated and filtered in the
 * database so the browser never receives the full bank.
 *
 * Cross-exam reuse is intentional here, and it is REFERENCE only: picking a
 * Punjab MO 2021 PYQ question for a RUHS mock writes one MockTestQuestion
 * row (app/admin/(dashboard)/tests/mock/actions.ts). The question keeps its
 * own exam, Previous Year Paper, source and code — question OWNERSHIP and
 * test MEMBERSHIP are independent (see lib/pyq-membership.ts).
 */

export const BANK_PAGE_SIZE = 50;
export const BANK_MAX_BULK_SELECT = 500;
const TEXT_PREVIEW = 220;

export interface BankFilters {
  examId?: string;
  paperId?: string;
  subjectId?: string;
  topicId?: string;
  subTopicId?: string;
  year?: number;
  /** PYQ = linked to a Previous Year Paper; BANK = not linked to any paper. */
  source?: "PYQ" | "BANK";
  difficulty?: QuestionDifficulty;
  /** Empty = Published + Draft. ARCHIVED questions are never offered. */
  status?: "PUBLISHED" | "DRAFT";
  qType?: "TEXT" | "IMAGE";
  q?: string;
  /** Exclude questions already in this Mock Test. */
  excludeMockTestId?: string;
}

/** One Question Bank row offered by Add From Question Bank (text pre-truncated). */
export interface BankRow {
  id: string;
  code: string;
  text: string;
  subjectId: string;
  subjectName: string;
  topicId: string | null;
  topicName: string | null;
  subTopicId: string | null;
  subTopicName: string | null;
  year: number | null;
  examId: string;
  examCode: string;
  examName: string;
  paperTitle: string | null;
  paperYear: number | null;
  isPyq: boolean;
  difficulty: QuestionDifficulty;
  status: QuestionStatus;
  hasImage: boolean;
}

export interface BankFacets {
  subjects: { id: string; name: string }[];
  topics: { id: string; name: string }[];
  subTopics: { id: string; name: string }[];
  years: number[];
}

export interface BankPage {
  rows: BankRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: BankFacets;
}

const DIFFICULTIES = new Set<string>(Object.values(QuestionDifficulty));

/** Coerces untrusted client input into a known-safe filter set (unknown values are dropped, never passed to the DB). */
export function sanitizeBankFilters(input: unknown): BankFilters {
  const f = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && /^[a-z0-9]{1,64}$/i.test(v) ? v : undefined);
  const year = typeof f.year === "number" ? f.year : typeof f.year === "string" && /^\d{4}$/.test(f.year) ? Number(f.year) : undefined;
  return {
    examId: id(f.examId),
    paperId: id(f.paperId),
    subjectId: id(f.subjectId),
    topicId: id(f.topicId),
    subTopicId: id(f.subTopicId),
    year: year && year >= 1900 && year <= 2200 ? year : undefined,
    source: f.source === "PYQ" || f.source === "BANK" ? f.source : undefined,
    difficulty: typeof f.difficulty === "string" && DIFFICULTIES.has(f.difficulty) ? (f.difficulty as QuestionDifficulty) : undefined,
    status: f.status === "PUBLISHED" || f.status === "DRAFT" ? f.status : undefined,
    qType: f.qType === "TEXT" || f.qType === "IMAGE" ? f.qType : undefined,
    q: typeof f.q === "string" && f.q.trim() ? f.q.trim().slice(0, 200) : undefined,
    excludeMockTestId: id(f.excludeMockTestId),
  };
}

type Level = "exam" | "subject" | "topic" | "subTopic" | "all";

/**
 * Builds the WHERE for a filter set. `upTo` limits which taxonomy filters
 * apply so facet option lists cascade (a Topic list is computed under the
 * chosen Exam/Paper/Subject but not under the chosen Topic itself).
 */
export function bankWhere(f: BankFilters, upTo: Level = "all"): Prisma.QuestionWhereInput {
  const and: Prisma.QuestionWhereInput[] = [{ status: f.status ? f.status : { not: QuestionStatus.ARCHIVED } }];
  if (f.examId) and.push({ examId: f.examId });
  if (f.paperId) and.push({ previousYearPaperId: f.paperId });
  if (f.source === "PYQ") and.push({ previousYearPaperId: { not: null } });
  if (f.source === "BANK") and.push({ previousYearPaperId: null });
  const depth = ["exam", "subject", "topic", "subTopic", "all"].indexOf(upTo);
  if (depth >= 1 && f.subjectId) and.push({ subjectId: f.subjectId });
  if (depth >= 2 && f.topicId) and.push({ topicId: f.topicId });
  if (depth >= 3 && f.subTopicId) and.push({ subTopicId: f.subTopicId });
  if (upTo !== "all") return { AND: and };
  if (f.year) and.push({ OR: [{ previousYearPaper: { year: f.year } }, { previousYearPaperId: null, examYear: f.year }] });
  if (f.difficulty) and.push({ difficulty: f.difficulty });
  if (f.qType === "IMAGE") and.push({ OR: [{ imageUrl: { not: null } }, { options: { some: { imageUrl: { not: null } } } }] });
  if (f.qType === "TEXT") and.push({ imageUrl: null, options: { none: { imageUrl: { not: null } } } });
  if (f.q) and.push({ OR: [{ code: { contains: f.q, mode: "insensitive" } }, { text: { contains: f.q, mode: "insensitive" } }] });
  if (f.excludeMockTestId) and.push({ mockTestQuestions: { none: { mockTestId: f.excludeMockTestId } } });
  return { AND: and };
}

const rowSelect = {
  id: true,
  code: true,
  text: true,
  imageUrl: true,
  difficulty: true,
  status: true,
  examYear: true,
  previousYearPaperId: true,
  exam: { select: { id: true, code: true, name: true } },
  subject: { select: { id: true, name: true } },
  topic: { select: { id: true, name: true } },
  subTopic: { select: { id: true, name: true } },
  previousYearPaper: { select: { title: true, year: true } },
  options: { where: { imageUrl: { not: null } }, select: { id: true }, take: 1 },
} satisfies Prisma.QuestionSelect;

type SelectedRow = Prisma.QuestionGetPayload<{ select: typeof rowSelect }>;

export function toBankRow(q: SelectedRow & { options: { id: string }[] }, fullText = false): BankRow {
  return {
    id: q.id,
    code: q.code,
    text: fullText || q.text.length <= TEXT_PREVIEW ? q.text : `${q.text.slice(0, TEXT_PREVIEW)}…`,
    subjectId: q.subject.id,
    subjectName: q.subject.name,
    topicId: q.topic?.id ?? null,
    topicName: q.topic?.name ?? null,
    subTopicId: q.subTopic?.id ?? null,
    subTopicName: q.subTopic?.name ?? null,
    year: q.previousYearPaper?.year ?? q.examYear ?? null,
    examId: q.exam.id,
    examCode: q.exam.code,
    examName: q.exam.name,
    paperTitle: q.previousYearPaper?.title ?? null,
    paperYear: q.previousYearPaper?.year ?? null,
    isPyq: q.previousYearPaperId !== null,
    difficulty: q.difficulty,
    status: q.status,
    hasImage: Boolean(q.imageUrl) || q.options.length > 0,
  };
}

export { rowSelect as bankRowSelect };

async function facetIds(field: "subjectId" | "topicId" | "subTopicId", where: Prisma.QuestionWhereInput): Promise<string[]> {
  const groups = await prisma.question.groupBy({ by: [field], where });
  return groups.map((g) => g[field]).filter((v): v is string => Boolean(v));
}

async function loadFacets(f: BankFilters): Promise<BankFacets> {
  const [subjectIds, topicIds, subTopicIds, paperYears, bankYears] = await Promise.all([
    facetIds("subjectId", bankWhere(f, "exam")),
    f.subjectId ? facetIds("topicId", bankWhere(f, "subject")) : Promise.resolve([]),
    f.topicId ? facetIds("subTopicId", bankWhere(f, "topic")) : Promise.resolve([]),
    prisma.question.groupBy({ by: ["previousYearPaperId"], where: { AND: [bankWhere(f, "exam"), { previousYearPaperId: { not: null } }] } }),
    prisma.question.groupBy({ by: ["examYear"], where: { AND: [bankWhere(f, "exam"), { previousYearPaperId: null, examYear: { not: null } }] } }),
  ]);
  const [subjects, topics, subTopics, papers] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    topicIds.length ? prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
    subTopicIds.length ? prisma.subTopic.findMany({ where: { id: { in: subTopicIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
    prisma.previousYearPaper.findMany({
      where: { id: { in: paperYears.map((p) => p.previousYearPaperId).filter((v): v is string => Boolean(v)) } },
      select: { year: true },
    }),
  ]);
  const years = new Set<number>([...papers.map((p) => p.year), ...bankYears.map((y) => y.examYear).filter((y): y is number => y !== null)]);
  return { subjects, topics, subTopics, years: [...years].sort((a, b) => b - a) };
}

/** One page of matching questions plus cascading facet options. */
export async function searchQuestionBank(f: BankFilters, page: number): Promise<BankPage> {
  const where = bankWhere(f);
  const total = await prisma.question.count({ where });
  const pages = Math.max(1, Math.ceil(total / BANK_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const [rows, facets] = await Promise.all([
    prisma.question.findMany({
      where,
      select: rowSelect,
      // Exam, then newest year, then original paper/import order.
      orderBy: [{ exam: { name: "asc" } }, { examYear: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      skip: (current - 1) * BANK_PAGE_SIZE,
      take: BANK_PAGE_SIZE,
    }),
    loadFacets(f),
  ]);
  return { rows: rows.map((r) => toBankRow(r)), total, page: current, pageSize: BANK_PAGE_SIZE, facets };
}

/** "Select all filtered" — ids only, capped. */
export async function matchingQuestionIds(f: BankFilters): Promise<string[]> {
  const rows = await prisma.question.findMany({
    where: bankWhere(f),
    select: { id: true },
    orderBy: [{ exam: { name: "asc" } }, { examYear: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    take: BANK_MAX_BULK_SELECT,
  });
  return rows.map((r) => r.id);
}
