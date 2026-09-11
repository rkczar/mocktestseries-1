import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";

import { updateUpcomingExamAction } from "../../actions";
import { UpcomingExamForm } from "../../UpcomingExamForm";

export const metadata: Metadata = { title: "Edit Upcoming Exam · Admin" };

export default async function EditUpcomingExamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [exam, linkedExams] = await Promise.all([
    prisma.upcomingExam.findUnique({ where: { id } }),
    prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
  ]);
  if (!exam) notFound();

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Edit upcoming exam</h1>
      <div className="mt-6">
        <UpcomingExamForm
          exam={exam}
          linkedExams={linkedExams}
          action={updateUpcomingExamAction}
          submitLabel="Save changes"
        />
      </div>
    </div>
  );
}
