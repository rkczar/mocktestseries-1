"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";
import { resolveSubjectId } from "@/lib/questions/resolveSubject";

export type FormState = { error?: string } | undefined;

const schema = z.object({
  examId: z.string().trim().min(1, "Choose an exam"),
  code: z.string().trim().min(1, "Question code is required"),
  paperYear: z.coerce.number().int().min(1990).max(2035),
  questionNumber: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
  subject: z.string().trim().min(1, "Subject is required"),
  topic: z.string().trim().min(1, "Topic is required"),
  subTopic: z.string().trim().optional(),
  stem: z.string().trim().min(1, "Question text is required"),
  optionA: z.string().trim().min(1, "Required"),
  optionB: z.string().trim().min(1, "Required"),
  optionC: z.string().trim().min(1, "Required"),
  optionD: z.string().trim().min(1, "Required"),
  correctAnswer: z.enum(["A", "B", "C", "D"]),
  explanation: z.string().trim().optional(),
  source: z.string().trim().optional(),
  difficulty: z.string().trim().optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]),
});

function parseForm(formData: FormData) {
  return schema.safeParse({
    examId: formData.get("examId"),
    code: formData.get("code"),
    paperYear: formData.get("paperYear"),
    questionNumber: formData.get("questionNumber") || undefined,
    subject: formData.get("subject"),
    topic: formData.get("topic"),
    subTopic: formData.get("subTopic") || undefined,
    stem: formData.get("stem"),
    optionA: formData.get("optionA"),
    optionB: formData.get("optionB"),
    optionC: formData.get("optionC"),
    optionD: formData.get("optionD"),
    correctAnswer: formData.get("correctAnswer"),
    explanation: formData.get("explanation") || undefined,
    source: formData.get("source") || undefined,
    difficulty: formData.get("difficulty") || undefined,
    status: formData.get("status"),
  });
}

export async function createQuestionAction(_prevState: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdminRole();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const existing = await prisma.question.findUnique({ where: { code: parsed.data.code } });
  if (existing) return { error: "A question with this code already exists." };

  const { examId, subject, questionNumber, ...rest } = parsed.data;
  const subjectId = await resolveSubjectId(examId, subject);

  const created = await prisma.question.create({
    data: { examId, subjectId, questionNumber: questionNumber ?? null, ...rest },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "Question",
    entityId: created.id,
    diff: parsed.data,
  });
  redirect("/admin/questions?success=Question created");
}

export async function updateQuestionAction(_prevState: FormState, formData: FormData): Promise<FormState> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const conflict = await prisma.question.findFirst({ where: { code: parsed.data.code, NOT: { id } } });
  if (conflict) return { error: "Another question already uses this code." };

  const { examId, subject, questionNumber, ...rest } = parsed.data;
  const subjectId = await resolveSubjectId(examId, subject);

  await prisma.question.update({
    where: { id },
    data: { examId, subjectId, questionNumber: questionNumber ?? null, ...rest },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "Question",
    entityId: id,
    diff: parsed.data,
  });
  redirect("/admin/questions?success=Question updated");
}

export async function deleteQuestionAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));

  await prisma.question.delete({ where: { id } });

  await writeAuditLog({ adminId: session.user.id, action: "delete", entity: "Question", entityId: id });
  updateTag("homepage");
  redirect("/admin/questions?success=Question deleted");
}
