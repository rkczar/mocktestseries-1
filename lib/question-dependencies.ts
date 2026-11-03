import "server-only";
import { prisma } from "@/lib/prisma";
import { loadReferences, type ContainerKind } from "@/lib/question-replacement/plan";

/**
 * Question dependency view (Phase 1 question safety, docs/QUESTION-RETIREMENT.md).
 * Read-only: where a question is used and who has sat it, from the real
 * membership and attempt tables. Every count here is reproducible with plain SQL
 * (scripts/verify-question-safety.ts compares them).
 */

export interface DependencyUse {
  kind: ContainerKind;
  id: string;
  title: string;
  status: string;
  studentOwned: boolean;
  /** 1-based position inside that test / module. */
  position: number;
}

export interface QuestionDependencies {
  id: string;
  code: string;
  status: string;
  retiredAt: Date | null;
  replacedByQuestionId: string | null;
  paperId: string | null;
  paperTitle: string | null;
  paperQuestionNumber: number | null;
  uses: DependencyUse[];
  mockTests: number;
  adminModules: number;
  studentModules: number;
  grandOrLive: number;
  attempts: { inProgress: number; submitted: number; abandoned: number; invalidated: number };
  activeSessions: number;
  aiVariants: number;
  bookmarks: number;
  reports: number;
}

type AttemptRow = { questionId: string; status: string; invalidated: boolean; n: number };

export async function getQuestionDependencies(questionIds: string[]): Promise<Map<string, QuestionDependencies>> {
  const out = new Map<string, QuestionDependencies>();
  if (questionIds.length === 0) return out;
  const [questions, refs, attempts, variants, bookmarks, reports] = await Promise.all([
    prisma.question.findMany({
      where: { id: { in: questionIds } },
      select: {
        id: true,
        code: true,
        status: true,
        retiredAt: true,
        replacedByQuestionId: true,
        paperQuestionNumber: true,
        previousYearPaper: { select: { id: true, title: true, year: true } },
      },
    }),
    loadReferences(prisma, questionIds),
    prisma.$queryRaw<AttemptRow[]>`
      SELECT t."questionId", a.status::text AS status, (a."invalidatedAt" IS NOT NULL) AS invalidated, COUNT(DISTINCT a.id)::int AS n
      FROM "TestAttemptQuestion" t JOIN "TestAttempt" a ON a.id = t."attemptId"
      WHERE t."questionId" = ANY(${questionIds}::text[])
      GROUP BY 1, 2, 3`,
    prisma.question.groupBy({ by: ["parentQuestionId"], where: { parentQuestionId: { in: questionIds } }, _count: { _all: true } }),
    prisma.savedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: questionIds } }, _count: { _all: true } }),
    prisma.reportedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: questionIds } }, _count: { _all: true } }),
  ]);
  const wanted = new Set(questionIds);
  for (const q of questions) {
    out.set(q.id, {
      id: q.id,
      code: q.code,
      status: q.status,
      retiredAt: q.retiredAt,
      replacedByQuestionId: q.replacedByQuestionId,
      paperId: q.previousYearPaper?.id ?? null,
      paperTitle: q.previousYearPaper ? `${q.previousYearPaper.title} (${q.previousYearPaper.year})` : null,
      paperQuestionNumber: q.paperQuestionNumber,
      uses: [],
      mockTests: 0,
      adminModules: 0,
      studentModules: 0,
      grandOrLive: 0,
      attempts: { inProgress: 0, submitted: 0, abandoned: 0, invalidated: 0 },
      activeSessions: 0,
      aiVariants: 0,
      bookmarks: 0,
      reports: 0,
    });
  }
  for (const r of refs) {
    if (!wanted.has(r.questionId)) continue;
    const d = out.get(r.questionId);
    if (!d) continue;
    d.uses.push({ kind: r.kind, id: r.containerId, title: r.title, status: r.status, studentOwned: r.studentOwned, position: r.position });
    if (r.kind === "MOCK_TEST") d.mockTests++;
    else if (r.kind === "CUSTOM_MODULE") {
      if (r.studentOwned) d.studentModules++;
      else d.adminModules++;
    } else d.grandOrLive++;
  }
  for (const a of attempts) {
    const d = out.get(a.questionId);
    if (!d) continue;
    if (a.invalidated) d.attempts.invalidated += a.n;
    else if (a.status === "IN_PROGRESS") d.attempts.inProgress += a.n;
    else if (a.status === "SUBMITTED") d.attempts.submitted += a.n;
    else d.attempts.abandoned += a.n;
  }
  for (const d of out.values()) d.activeSessions = d.attempts.inProgress;
  for (const v of variants) if (v.parentQuestionId) out.get(v.parentQuestionId)!.aiVariants = v._count._all;
  for (const b of bookmarks) out.get(b.questionId)!.bookmarks = b._count._all;
  for (const r of reports) out.get(r.questionId)!.reports = r._count._all;
  return out;
}

export interface PaperDependencySummary {
  paper: { id: string; title: string; year: number; paperCode: string | null; examName: string; isActive: boolean };
  totals: {
    questions: number;
    published: number;
    retired: number;
    archived: number;
    reused: number;
    mockTests: number;
    adminModules: number;
    studentModules: number;
    paperAttempts: { inProgress: number; submitted: number; invalidated: number };
    activeSessions: number;
  };
  questions: QuestionDependencies[];
}

/** Every question linked to the paper (any status), in paper order, with its dependencies. */
export async function getPaperDependencySummary(paperId: string): Promise<PaperDependencySummary | null> {
  const paper = await prisma.previousYearPaper.findUnique({
    where: { id: paperId },
    select: { id: true, title: true, year: true, paperCode: true, isActive: true, exam: { select: { name: true } } },
  });
  if (!paper) return null;
  const rows = await prisma.question.findMany({
    where: { previousYearPaperId: paperId },
    orderBy: [{ paperQuestionNumber: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { code: "asc" }],
    select: { id: true },
  });
  const deps = await getQuestionDependencies(rows.map((r) => r.id));
  const questions = rows.map((r) => deps.get(r.id)!).filter(Boolean);
  const [paperAttempts, sessions] = await Promise.all([
    prisma.testAttempt.groupBy({ by: ["status"], where: { previousYearPaperId: paperId }, _count: { _all: true } }),
    rows.length
      ? prisma.testAttempt.count({ where: { status: "IN_PROGRESS", questions: { some: { questionId: { in: rows.map((r) => r.id) } } } } })
      : Promise.resolve(0),
  ]);
  const invalidated = await prisma.testAttempt.count({ where: { previousYearPaperId: paperId, invalidatedAt: { not: null } } });
  const containers = (kind: ContainerKind, studentOwned?: boolean) =>
    new Set(questions.flatMap((q) => q.uses.filter((u) => u.kind === kind && (studentOwned === undefined || u.studentOwned === studentOwned)).map((u) => u.id))).size;
  return {
    paper: { id: paper.id, title: paper.title, year: paper.year, paperCode: paper.paperCode, examName: paper.exam.name, isActive: paper.isActive },
    totals: {
      questions: questions.length,
      published: questions.filter((q) => q.status === "PUBLISHED" && !q.retiredAt).length,
      retired: questions.filter((q) => q.retiredAt).length,
      archived: questions.filter((q) => q.status === "ARCHIVED" && !q.retiredAt).length,
      reused: questions.filter((q) => q.uses.length > 0).length,
      mockTests: containers("MOCK_TEST"),
      adminModules: containers("CUSTOM_MODULE", false),
      studentModules: containers("CUSTOM_MODULE", true),
      paperAttempts: {
        inProgress: paperAttempts.find((a) => a.status === "IN_PROGRESS")?._count._all ?? 0,
        submitted: paperAttempts.find((a) => a.status === "SUBMITTED")?._count._all ?? 0,
        invalidated,
      },
      activeSessions: sessions,
    },
    questions,
  };
}

/** CSV for the paper dependency table (admin download). */
export function paperDependenciesCsv(summary: PaperDependencySummary): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "paper_no", "question_id", "code", "status", "retired", "mock_tests", "admin_modules", "student_modules", "grand_live",
    "uses (kind:title@position)", "attempts_in_progress", "attempts_submitted", "attempts_invalidated", "active_sessions",
    "ai_variants", "bookmarks", "reports",
  ];
  const lines = summary.questions.map((q) =>
    [
      q.paperQuestionNumber, q.id, q.code, q.status, q.retiredAt ? q.retiredAt.toISOString() : "", q.mockTests, q.adminModules,
      q.studentModules, q.grandOrLive,
      q.uses.map((u) => `${u.kind}${u.studentOwned ? "(student)" : ""}:${u.title}@${u.position}`).join(" | "),
      q.attempts.inProgress, q.attempts.submitted, q.attempts.invalidated, q.activeSessions, q.aiVariants, q.bookmarks, q.reports,
    ].map(esc).join(",")
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}
