import type { Metadata } from "next";

import { prisma } from "@/lib/db";

import { createUpcomingExamAction } from "../actions";
import { UpcomingExamForm } from "../UpcomingExamForm";

export const metadata: Metadata = { title: "New Upcoming Exam · Admin" };

export default async function NewUpcomingExamPage() {
  const linkedExams = await prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } });

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">New upcoming exam</h1>
      <div className="mt-6">
        <UpcomingExamForm linkedExams={linkedExams} action={createUpcomingExamAction} submitLabel="Create" />
      </div>
    </div>
  );
}
