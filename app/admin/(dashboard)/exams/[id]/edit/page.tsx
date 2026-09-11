import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";

import { archiveExamAction, updateExamAction } from "../../actions";
import { ExamForm } from "../../ExamForm";

export const metadata: Metadata = { title: "Edit Exam · Admin" };

export default async function EditExamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { testSeries: { orderBy: { order: "asc" } } },
  });
  if (!exam) notFound();

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[26px] font-bold text-text-heading">Edit exam</h1>
        {exam.status !== "ARCHIVED" ? (
          <form action={archiveExamAction}>
            <input type="hidden" name="id" value={exam.id} />
            <button
              type="submit"
              className="rounded-[8px] border border-error-border bg-error-tint px-3.5 py-2 text-[13px] font-bold text-error hover:bg-error/10"
            >
              Archive exam
            </button>
          </form>
        ) : null}
      </div>

      <div className="mt-6">
        <ExamForm exam={exam} action={updateExamAction} submitLabel="Save changes" />
      </div>

      <div className="mt-10 max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-text-heading">Test series</h2>
          <Link
            href={`/admin/test-series/new?examId=${exam.id}`}
            className="text-sm font-bold text-primary"
          >
            + Add test series
          </Link>
        </div>
        {exam.testSeries.length === 0 ? (
          <p className="mt-2 text-sm text-text-faint">No test series yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {exam.testSeries.map((series) => (
              <li
                key={series.id}
                className="flex items-center justify-between rounded-[9px] border border-border bg-surface px-3.5 py-2.5 text-sm"
              >
                <span className="font-semibold text-text-heading">{series.title}</span>
                <Link href={`/admin/test-series/${series.id}/edit`} className="font-bold text-primary">
                  Edit
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
