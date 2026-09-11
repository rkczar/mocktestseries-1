import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ConfirmDeleteButton } from "@/components/admin/ConfirmDeleteButton";
import { StatusBanner } from "@/components/admin/StatusBanner";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { prisma } from "@/lib/db";

import { createTestAction, deleteTestAction, updateTestSeriesAction } from "../../actions";
import { TestSeriesForm } from "../../TestSeriesForm";

export const metadata: Metadata = { title: "Edit Test Series · Admin" };

export default async function EditTestSeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { id } = await params;
  const { success, error } = await searchParams;
  const [series, exams] = await Promise.all([
    prisma.testSeries.findUnique({ where: { id }, include: { tests: { orderBy: { order: "asc" } } } }),
    prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
  ]);
  if (!series) notFound();

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Edit test series</h1>
      <StatusBanner success={success} error={error} />
      <div className="mt-6">
        <TestSeriesForm series={series} exams={exams} action={updateTestSeriesAction} submitLabel="Save changes" />
      </div>

      <div className="mt-10 max-w-2xl">
        <h2 className="text-lg font-extrabold text-text-heading">Tests</h2>
        {series.tests.length === 0 ? (
          <p className="mt-2 text-sm text-text-faint">No tests in this series yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {series.tests.map((test) => (
              <li
                key={test.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-border bg-surface px-3.5 py-2.5 text-sm"
              >
                <div>
                  <p className="font-semibold text-text-heading">{test.title}</p>
                  <p className="text-xs text-text-faint">
                    {test.totalMarks} marks · {test.durationMin} min ·{" "}
                    {test.isPublished ? "Published" : "Draft"}
                  </p>
                </div>
                <ConfirmDeleteButton
                  action={deleteTestAction}
                  itemLabel={test.title}
                  hiddenFields={{ id: test.id, testSeriesId: series.id }}
                />
              </li>
            ))}
          </ul>
        )}

        <form action={createTestAction} className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] items-end gap-3 rounded-[10px] border border-dashed border-border-strong p-4">
          <input type="hidden" name="testSeriesId" value={series.id} />
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-text-muted">Title</span>
            <input name="title" required className="h-9 w-full rounded-[7px] border border-border-strong px-2.5 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-text-muted">Duration (min)</span>
            <input name="durationMin" type="number" required className="h-9 w-full rounded-[7px] border border-border-strong px-2.5 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-text-muted">Total marks</span>
            <input name="totalMarks" type="number" required className="h-9 w-full rounded-[7px] border border-border-strong px-2.5 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-text-muted">Negative mark</span>
            <input name="negativeMark" type="number" step="0.25" defaultValue={0} className="h-9 w-full rounded-[7px] border border-border-strong px-2.5 text-sm" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm font-semibold text-text-muted">
            <input type="checkbox" name="isPublished" className="size-4 accent-primary" />
            Published
          </label>
          <SubmitButton className="w-fit px-4">Add test</SubmitButton>
        </form>
      </div>
    </div>
  );
}
