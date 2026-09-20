"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { QuestionSource } from "@prisma/client";

const schema = z.object({
  examId: z.string().min(1, "Select an exam"),
  year: z.coerce.number().int().min(1990).max(2100),
  title: z.string().min(2).max(200),
  paperCode: z.string().trim().max(60).optional(),
});

export interface PaperFormState {
  error?: string;
  success?: boolean;
}

function revalidatePaperPages() {
  revalidatePath("/admin/exams/previous-year-papers");
  revalidatePath("/admin/questions");
  revalidatePath("/");
}

export async function createPaperAction(_prev: PaperFormState, formData: FormData): Promise<PaperFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = schema.safeParse({
    examId: formData.get("examId"),
    year: formData.get("year"),
    title: formData.get("title"),
    paperCode: formData.get("paperCode"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const paper = await prisma.previousYearPaper.create({
    data: { ...parsed.data, paperCode: parsed.data.paperCode || null },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "PYP_CREATED", entityType: "PreviousYearPaper", entityId: paper.id },
  });

  revalidatePaperPages();
  return { success: true };
}

export async function togglePaperActiveAction(paperId: string, isActive: boolean) {
  await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  await prisma.previousYearPaper.update({ where: { id: paperId }, data: { isActive } });
  revalidatePaperPages();
}

const editSchema = z.object({
  id: z.string().min(1),
  year: z.coerce.number().int().min(1990).max(2100),
  title: z.string().min(2).max(200),
  paperCode: z.string().trim().max(60).optional(),
  order: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

export async function editPaperAction(_prev: PaperFormState, formData: FormData): Promise<PaperFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = editSchema.safeParse({
    id: formData.get("id"),
    year: formData.get("year"),
    title: formData.get("title"),
    paperCode: formData.get("paperCode"),
    order: formData.get("order"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const { id, ...data } = parsed.data;
  const paper = await prisma.previousYearPaper.update({
    where: { id },
    data: { year: data.year, title: data.title, paperCode: data.paperCode || null, order: data.order },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "PYP_UPDATED", entityType: "PreviousYearPaper", entityId: paper.id },
  });

  revalidatePaperPages();
  return { success: true };
}

export interface PaperDeleteImpact {
  questions: number;
  testAttempts: number;
  blocked: boolean;
}

export async function getPaperDeleteImpact(paperId: string): Promise<PaperDeleteImpact> {
  await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const [questions, testAttempts] = await Promise.all([
    prisma.question.count({ where: { previousYearPaperId: paperId } }),
    prisma.testAttempt.count({ where: { previousYearPaperId: paperId } }),
  ]);
  return { questions, testAttempts, blocked: questions > 0 || testAttempts > 0 };
}

export async function deletePaperAction(paperId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const paper = await prisma.previousYearPaper.findUnique({ where: { id: paperId }, select: { title: true } });
  if (!paper) throw new Error("Paper not found.");

  const impact = await getPaperDeleteImpact(paperId);
  if (impact.blocked) {
    throw new Error("This paper still has linked Questions or recorded Test Attempts — unlink/remove those first, or deactivate the paper instead.");
  }

  await prisma.previousYearPaper.delete({ where: { id: paperId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "PYP_DELETED", entityType: "PreviousYearPaper", entityId: paperId, metadata: { title: paper.title } },
  });

  revalidatePaperPages();
}

// ---------------------------------------------------------------------------
// Build Paper from Question Bank (Sections 16-20)
// ---------------------------------------------------------------------------

export interface CandidateQuestion {
  id: string;
  code: string;
  text: string;
  subjectName: string;
  topicName: string | null;
  status: string;
  source: string;
}

/**
 * Question Bank questions eligible to be linked to this paper: same Exam +
 * Year, not already linked to a *different* paper (never silently steal a
 * question from another paper), optionally narrowed by Subject/Topic.
 * Section 18's "N matching Question Bank questions found" count is this
 * list's length before the Admin filters/selects further.
 */
export async function getPaperCandidateQuestions(
  paperId: string,
  filters?: { subjectId?: string; topicId?: string }
): Promise<CandidateQuestion[]> {
  await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const paper = await prisma.previousYearPaper.findUnique({ where: { id: paperId }, select: { examId: true, year: true } });
  if (!paper) throw new Error("Paper not found.");

  const questions = await prisma.question.findMany({
    where: {
      examId: paper.examId,
      examYear: paper.year,
      previousYearPaperId: null, // unlinked only — already-linked ones show on the paper detail page instead
      ...(filters?.subjectId ? { subjectId: filters.subjectId } : {}),
      ...(filters?.topicId ? { topicId: filters.topicId } : {}),
    },
    select: { id: true, code: true, text: true, status: true, source: true, subject: { select: { name: true } }, topic: { select: { name: true } } },
    orderBy: { code: "asc" },
    take: 500,
  });

  return questions.map((q) => ({
    id: q.id,
    code: q.code,
    text: q.text,
    subjectName: q.subject.name,
    topicName: q.topic?.name ?? null,
    status: q.status,
    source: q.source,
  }));
}

export async function linkQuestionsToPaperAction(paperId: string, questionIds: string[]) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  if (questionIds.length === 0) return { linked: 0 };

  const paper = await prisma.previousYearPaper.findUnique({ where: { id: paperId }, select: { examId: true, year: true, title: true } });
  if (!paper) throw new Error("Paper not found.");

  // Never silently link unrelated questions — re-check Exam/Year server-side
  // even though the candidate list was already scoped this way.
  const { count } = await prisma.question.updateMany({
    where: { id: { in: questionIds }, examId: paper.examId, examYear: paper.year },
    data: { previousYearPaperId: paperId, source: QuestionSource.PYQ },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "PYP_QUESTIONS_LINKED",
      entityType: "PreviousYearPaper",
      entityId: paperId,
      metadata: { paperTitle: paper.title, requested: questionIds.length, linked: count },
    },
  });

  revalidatePaperPages();
  revalidatePath(`/admin/exams/previous-year-papers/${paperId}`);
  return { linked: count };
}

export async function unlinkQuestionFromPaperAction(paperId: string, questionId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  // Unlink the relationship only — the Question row itself is untouched.
  const { count } = await prisma.question.updateMany({
    where: { id: questionId, previousYearPaperId: paperId },
    data: { previousYearPaperId: null },
  });

  if (count > 0) {
    await prisma.auditLog.create({
      data: { actorId: session.user.id, action: "PYP_QUESTION_UNLINKED", entityType: "PreviousYearPaper", entityId: paperId, metadata: { questionId } },
    });
  }

  revalidatePaperPages();
  revalidatePath(`/admin/exams/previous-year-papers/${paperId}`);
}
