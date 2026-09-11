import type { Metadata } from "next";

import { prisma } from "@/lib/db";

import { createTestSeriesAction } from "../actions";
import { TestSeriesForm } from "../TestSeriesForm";

export const metadata: Metadata = { title: "New Test Series · Admin" };

export default async function NewTestSeriesPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;
  const exams = await prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } });

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">New test series</h1>
      <div className="mt-6">
        <TestSeriesForm
          exams={exams}
          defaultExamId={examId}
          action={createTestSeriesAction}
          submitLabel="Create test series"
        />
      </div>
    </div>
  );
}
