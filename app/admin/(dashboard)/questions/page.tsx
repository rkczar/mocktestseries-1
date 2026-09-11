import type { Metadata } from "next";
import { Plus, Upload } from "lucide-react";
import Link from "next/link";

import { ConfirmDeleteButton } from "@/components/admin/ConfirmDeleteButton";
import { EmptyState } from "@/components/admin/EmptyState";
import { Pagination } from "@/components/admin/Pagination";
import { SearchBar } from "@/components/admin/SearchBar";
import { StatusBanner } from "@/components/admin/StatusBanner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEFAULT_PAGE_SIZE, pageSkipTake, parsePage } from "@/lib/admin/pagination";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

import { deleteQuestionAction } from "./actions";

export const metadata: Metadata = { title: "Question Bank · Admin" };

export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    examId?: string;
    year?: string;
    status?: string;
    page?: string;
    success?: string;
    error?: string;
  }>;
}) {
  const { q, examId, year, status, page: pageParam, success, error } = await searchParams;
  const page = parsePage(pageParam);

  const where: Prisma.QuestionWhereInput = {
    ...(q
      ? {
          OR: [
            { stem: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(examId ? { examId } : {}),
    ...(year ? { paperYear: Number(year) } : {}),
    ...(status ? { status: status as "DRAFT" | "PUBLISHED" } : {}),
  };

  const [rows, total, exams] = await Promise.all([
    prisma.question.findMany({
      where,
      include: { exam: true, subject: true },
      orderBy: { createdAt: "desc" },
      ...pageSkipTake(page),
    }),
    prisma.question.count({ where }),
    prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Question bank</h1>
          <p className="mt-1 text-sm text-text-muted">{total} question{total === 1 ? "" : "s"} total.</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/questions/import"
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-border-strong px-4 py-2.5 text-sm font-bold text-primary hover:bg-accent"
          >
            <Upload className="size-4" /> Bulk import
          </Link>
          <Link
            href="/admin/questions/new"
            className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
          >
            <Plus className="size-4" /> New question
          </Link>
        </div>
      </div>

      <StatusBanner success={success} error={error} />
      <SearchBar action="/admin/questions" placeholder="Search question text or code…" defaultValue={q}>
        <select name="examId" defaultValue={examId ?? ""} className="h-10 rounded-[9px] border border-border-strong bg-surface px-3 text-sm">
          <option value="">All exams</option>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
        <input
          type="number"
          name="year"
          placeholder="Year"
          defaultValue={year}
          className="h-10 w-24 rounded-[9px] border border-border-strong bg-surface px-3 text-sm"
        />
        <select name="status" defaultValue={status ?? ""} className="h-10 rounded-[9px] border border-border-strong bg-surface px-3 text-sm">
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
        </select>
      </SearchBar>

      {rows.length === 0 ? (
        <EmptyState title="No questions found" body="Add one manually, bulk import a spreadsheet, or adjust filters." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Question</TableHead>
              <TableHead>Exam · Year</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs">{row.code}</TableCell>
                <TableCell className="max-w-xs truncate whitespace-normal">{row.stem}</TableCell>
                <TableCell>
                  {row.exam.title} · {row.paperYear}
                </TableCell>
                <TableCell>{row.subject?.name ?? "—"}</TableCell>
                <TableCell>{row.status === "PUBLISHED" ? "Published" : "Draft"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/admin/questions/${row.id}/edit`}
                      className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                    >
                      Edit
                    </Link>
                    <ConfirmDeleteButton action={deleteQuestionAction} itemLabel={row.code} hiddenFields={{ id: row.id }} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={page} totalPages={totalPages} basePath="/admin/questions" searchParams={{ q, examId, year, status }} />
    </div>
  );
}
