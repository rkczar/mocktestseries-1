"use server";

import { redirect } from "next/navigation";

import { requireStudent } from "@/lib/auth/requireStudent";
import { prisma } from "@/lib/db";

export async function startAttemptAction(formData: FormData): Promise<void> {
  const testId = String(formData.get("testId"));
  const { student } = await requireStudent(`/student/tests/${testId}`);

  const test = await prisma.test.findUnique({
    where: { id: testId },
    select: { id: true, isPublished: true },
  });
  if (!test || !test.isPublished) redirect("/student/dashboard?error=Test not available");

  const inProgress = await prisma.testAttempt.findFirst({
    where: { studentId: student.id, testId, submittedAt: null },
    orderBy: { startedAt: "desc" },
  });

  const attempt =
    inProgress ?? (await prisma.testAttempt.create({ data: { studentId: student.id, testId } }));

  redirect(`/student/tests/${testId}/attempt/${attempt.id}`);
}
