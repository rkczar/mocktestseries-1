import type { Metadata } from "next";

import { prisma } from "@/lib/db";

import { createQuestionAction } from "../actions";
import { QuestionForm } from "../QuestionForm";

export const metadata: Metadata = { title: "New Question · Admin" };

export default async function NewQuestionPage() {
  const exams = await prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } });

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">New question</h1>
      <div className="mt-6">
        <QuestionForm exams={exams} action={createQuestionAction} submitLabel="Create question" />
      </div>
    </div>
  );
}
