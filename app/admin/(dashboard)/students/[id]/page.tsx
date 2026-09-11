import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StatusBanner } from "@/components/admin/StatusBanner";
import { prisma } from "@/lib/db";

import { setStudentActiveAction } from "../actions";

export const metadata: Metadata = { title: "Student · Admin" };

export default async function StudentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { id } = await params;
  const { success, error } = await searchParams;
  const student = await prisma.student.findUnique({
    where: { id },
    include: { attempts: { orderBy: { startedAt: "desc" }, take: 10, include: { test: true } } },
  });
  if (!student) notFound();

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-[26px] font-bold text-text-heading">{student.name}</h1>
      <p className="mt-1 text-sm text-text-muted">{student.email}</p>

      <StatusBanner success={success} error={error} />

      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4 rounded-[12px] border border-border bg-surface p-5 text-sm">
        <div>
          <p className="text-xs font-bold text-text-faint uppercase">Status</p>
          <p className="mt-1 font-semibold text-text-heading">{student.isActive ? "Active" : "Deactivated"}</p>
        </div>
        <div>
          <p className="text-xs font-bold text-text-faint uppercase">Joined</p>
          <p className="mt-1 font-semibold text-text-heading">{student.createdAt.toLocaleDateString()}</p>
        </div>
        <div>
          <p className="text-xs font-bold text-text-faint uppercase">Phone</p>
          <p className="mt-1 font-semibold text-text-heading">{student.phone ?? "—"}</p>
        </div>
      </div>

      <form action={setStudentActiveAction} className="mt-4">
        <input type="hidden" name="id" value={student.id} />
        <input type="hidden" name="isActive" value={(!student.isActive).toString()} />
        <button
          type="submit"
          className={
            student.isActive
              ? "rounded-[9px] border border-error-border bg-error-tint px-4 py-2.5 text-sm font-bold text-error hover:bg-error/10"
              : "rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
          }
        >
          {student.isActive ? "Deactivate account" : "Reactivate account"}
        </button>
      </form>
      {student.isActive ? null : (
        <p className="mt-2 text-xs text-text-faint">
          Deactivated students can&apos;t log in until reactivated.
        </p>
      )}

      <h2 className="mt-9 text-lg font-extrabold text-text-heading">Recent attempts</h2>
      {student.attempts.length === 0 ? (
        <p className="mt-2 text-sm text-text-faint">No test attempts yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {student.attempts.map((attempt) => (
            <li key={attempt.id} className="rounded-[9px] border border-border bg-surface px-3.5 py-2.5 text-sm">
              <p className="font-semibold text-text-heading">{attempt.test.title}</p>
              <p className="text-xs text-text-faint">
                {attempt.startedAt.toLocaleString()} · {attempt.score !== null ? `Score: ${attempt.score}` : "In progress"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
