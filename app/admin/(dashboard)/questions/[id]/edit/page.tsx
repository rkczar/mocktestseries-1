import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";

import { updateQuestionAction } from "../../actions";
import { QuestionForm } from "../../QuestionForm";

export const metadata: Metadata = { title: "Edit Question · Admin" };

export default async function EditQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [question, exams] = await Promise.all([
    prisma.question.findUnique({ where: { id }, include: { subject: true } }),
    prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
  ]);
  if (!question) notFound();

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Edit question</h1>
      <div className="mt-6">
        <QuestionForm question={question} exams={exams} action={updateQuestionAction} submitLabel="Save changes" />
      </div>
    </div>
  );
}
