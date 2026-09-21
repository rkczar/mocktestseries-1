"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { textToPairList } from "@/lib/homepage-field-codec";

const examSchema = z.object({
  name: z.string().min(2).max(200),
  code: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9-]+$/, "Use uppercase letters, numbers, and hyphens only"),
  year: z.coerce.number().int().min(2000).max(2100).optional().or(z.literal("").transform(() => undefined)),
  description: z.string().max(2000).optional(),
});

export interface ExamFormState {
  error?: string;
  success?: boolean;
}

export async function createExamAction(_prev: ExamFormState, formData: FormData): Promise<ExamFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const parsed = examSchema.safeParse({
    name: formData.get("name"),
    code: formData.get("code")?.toString().toUpperCase(),
    year: formData.get("year"),
    description: formData.get("description"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const existing = await prisma.exam.findUnique({ where: { code: parsed.data.code } });
  if (existing) return { error: "An exam with this code already exists." };

  const exam = await prisma.exam.create({ data: parsed.data });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "EXAM_CREATED",
      entityType: "Exam",
      entityId: exam.id,
      metadata: { name: exam.name, code: exam.code },
    },
  });

  revalidatePath("/admin/exams");
  revalidatePath("/admin");
  return { success: true };
}

export async function toggleExamActiveAction(examId: string, isActive: boolean) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const exam = await prisma.exam.update({ where: { id: examId }, data: { isActive } });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: isActive ? "EXAM_ACTIVATED" : "EXAM_DEACTIVATED",
      entityType: "Exam",
      entityId: exam.id,
    },
  });

  revalidatePath("/admin/exams");
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Edit Exam (Section 6/7/8) — full field edit, including renaming Name/Code.
// Renaming never recreates the Exam row, so its id and every Subject/Topic/
// Question/PYQ/Test/Enrollment relationship is preserved automatically.
// ---------------------------------------------------------------------------

const editExamSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2).max(200),
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9-]+$/, "Use uppercase letters, numbers, and hyphens only"),
  year: z.coerce.number().int().min(2000).max(2100).optional().or(z.literal("").transform(() => undefined)),
  examDate: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .or(z.literal("").transform(() => undefined)),
  isUpcoming: z.coerce.boolean().optional().default(false),
  upcomingDate: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined))
    .or(z.literal("").transform(() => undefined)),
  isActive: z.coerce.boolean().optional().default(false),
  order: z.coerce.number().int().min(0).max(100000).optional().default(0),
  negativeMarking: z.coerce.number().min(0).max(1).optional().or(z.literal("").transform(() => undefined)),
  durationMinutes: z.coerce.number().int().min(1).max(1000).optional().or(z.literal("").transform(() => undefined)),
  instructions: z.string().max(5000).optional(),
  description: z.string().max(2000).optional(),

  // Public exam landing page (/exams/[slug]) — see the
  // 20260921120000_add_public_exam_page_and_page_visibility migration.
  publicPageEnabled: z.coerce.boolean().optional().default(false),
  publicSlug: z
    .string()
    .trim()
    .max(120)
    .regex(/^[a-z0-9-]*$/, "Lowercase letters, numbers, and hyphens only")
    .optional()
    .transform((v) => (v ? v : undefined)),
  shortDescription: z.string().max(300).optional(),
  overview: z.string().max(5000).optional(),
  conductingAuthority: z.string().max(300).optional(),
  eligibility: z.string().max(3000).optional(),
  examPatternInfo: z.string().max(3000).optional(),
  totalQuestions: z.coerce.number().int().min(0).max(2000).optional().or(z.literal("").transform(() => undefined)),
  totalMarks: z.coerce.number().int().min(0).max(2000).optional().or(z.literal("").transform(() => undefined)),
  examMode: z.string().max(100).optional(),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(300).optional(),
  importantDatesText: z.string().max(3000).optional(),
  faqItemsText: z.string().max(8000).optional(),
});

export interface EditExamFormState {
  error?: string;
  success?: boolean;
}

export async function editExamAction(_prev: EditExamFormState, formData: FormData): Promise<EditExamFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const parsed = editExamSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    code: formData.get("code")?.toString().toUpperCase(),
    year: formData.get("year"),
    examDate: formData.get("examDate"),
    isUpcoming: formData.get("isUpcoming") === "on" || formData.get("isUpcoming") === "true",
    upcomingDate: formData.get("upcomingDate"),
    isActive: formData.get("isActive") === "on" || formData.get("isActive") === "true",
    order: formData.get("order"),
    negativeMarking: formData.get("negativeMarking"),
    durationMinutes: formData.get("durationMinutes"),
    instructions: formData.get("instructions"),
    description: formData.get("description"),
    publicPageEnabled: formData.get("publicPageEnabled") === "on" || formData.get("publicPageEnabled") === "true",
    publicSlug: formData.get("publicSlug")?.toString().trim().toLowerCase(),
    shortDescription: formData.get("shortDescription"),
    overview: formData.get("overview"),
    conductingAuthority: formData.get("conductingAuthority"),
    eligibility: formData.get("eligibility"),
    examPatternInfo: formData.get("examPatternInfo"),
    totalQuestions: formData.get("totalQuestions"),
    totalMarks: formData.get("totalMarks"),
    examMode: formData.get("examMode"),
    seoTitle: formData.get("seoTitle"),
    seoDescription: formData.get("seoDescription"),
    importantDatesText: formData.get("importantDatesText"),
    faqItemsText: formData.get("faqItemsText"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { id, ...data } = parsed.data;

  const existingByCode = await prisma.exam.findUnique({ where: { code: data.code }, select: { id: true } });
  if (existingByCode && existingByCode.id !== id) {
    return { error: "Another exam already uses this code." };
  }

  if (data.publicPageEnabled && !data.publicSlug) {
    return { error: "A public URL slug is required to enable the public page." };
  }

  if (data.publicSlug) {
    const existingBySlug = await prisma.exam.findUnique({ where: { publicSlug: data.publicSlug }, select: { id: true } });
    if (existingBySlug && existingBySlug.id !== id) {
      return { error: "Another exam already uses this public URL slug." };
    }
  }

  const importantDates = textToPairList(data.importantDatesText ?? "").map(([label, date]) => ({ label, date }));
  const faqItems = textToPairList(data.faqItemsText ?? "").map(([question, answer]) => ({ question, answer }));

  const before = await prisma.exam.findUnique({ where: { id }, select: { name: true, code: true } });
  if (!before) return { error: "Exam not found." };

  const exam = await prisma.exam.update({
    where: { id },
    data: {
      name: data.name,
      code: data.code,
      year: data.year ?? null,
      examDate: data.examDate ?? null,
      isUpcoming: data.isUpcoming,
      upcomingDate: data.upcomingDate ?? null,
      isActive: data.isActive,
      order: data.order,
      negativeMarking: data.negativeMarking ?? null,
      durationMinutes: data.durationMinutes ?? null,
      instructions: data.instructions || null,
      description: data.description || null,
      publicPageEnabled: data.publicPageEnabled,
      publicSlug: data.publicSlug ?? null,
      shortDescription: data.shortDescription || null,
      overview: data.overview || null,
      conductingAuthority: data.conductingAuthority || null,
      eligibility: data.eligibility || null,
      examPatternInfo: data.examPatternInfo || null,
      totalQuestions: data.totalQuestions ?? null,
      totalMarks: data.totalMarks ?? null,
      examMode: data.examMode || null,
      seoTitle: data.seoTitle || null,
      seoDescription: data.seoDescription || null,
      importantDates,
      faqItems,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "EXAM_UPDATED",
      entityType: "Exam",
      entityId: exam.id,
      metadata: { before, after: { name: exam.name, code: exam.code } },
    },
  });

  revalidatePath("/admin/exams");
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath("/student/exams/[examId]", "page");
  revalidatePath("/exams");
  revalidatePath("/exams/[slug]", "page");
  revalidatePath("/exams/[slug]/syllabus", "page");
  revalidatePath("/exams/[slug]/previous-year-papers", "page");
  revalidatePath("/exams/[slug]/mock-tests", "page");
  revalidatePath("/exams/[slug]/question-bank", "page");
  revalidatePath("/exams/[slug]/exam-pattern", "page");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Delete Exam (Section 9) — relationship-safe. Blocks when the Exam has any
// recorded student history (TestAttempt/StudentExamEnrollment); otherwise
// lets the existing onDelete: Cascade relations clean up Subjects/Topics/
// Questions/PYQ Papers/Test Series/Mock/Custom/Grand/Live Tests.
// ---------------------------------------------------------------------------

export interface ExamDeleteImpact {
  subjects: number;
  topics: number;
  questions: number;
  papers: number;
  mockTests: number;
  customModules: number;
  grandTests: number;
  liveTests: number;
  testAttempts: number;
  enrollments: number;
  blocked: boolean;
}

export async function getExamDeleteImpact(examId: string): Promise<ExamDeleteImpact> {
  await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const [subjects, topics, questions, papers, mockTests, customModules, grandTests, liveTests, testAttempts, enrollments] = await Promise.all([
    prisma.subject.count({ where: { examId } }),
    prisma.topic.count({ where: { subject: { examId } } }),
    prisma.question.count({ where: { examId } }),
    prisma.previousYearPaper.count({ where: { examId } }),
    prisma.mockTest.count({ where: { examId } }),
    prisma.customModule.count({ where: { examId } }),
    prisma.grandTest.count({ where: { examId } }),
    prisma.liveTest.count({ where: { examId } }),
    prisma.testAttempt.count({ where: { examId } }),
    prisma.studentExamEnrollment.count({ where: { examId } }),
  ]);

  return {
    subjects,
    topics,
    questions,
    papers,
    mockTests,
    customModules,
    grandTests,
    liveTests,
    testAttempts,
    enrollments,
    blocked: testAttempts > 0 || enrollments > 0,
  };
}

export async function deleteExamAction(examId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, name: true, code: true } });
  if (!exam) throw new Error("Exam not found.");

  const impact = await getExamDeleteImpact(examId);
  if (impact.blocked) {
    throw new Error(
      "This exam has recorded student test attempts or enrollments and cannot be deleted — deactivate it instead to preserve history."
    );
  }

  await prisma.exam.delete({ where: { id: examId } });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "EXAM_DELETED",
      entityType: "Exam",
      entityId: examId,
      metadata: { name: exam.name, code: exam.code, impact: { ...impact } },
    },
  });

  revalidatePath("/admin/exams");
  revalidatePath("/admin");
  revalidatePath("/");
}
