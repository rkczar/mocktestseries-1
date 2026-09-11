import type { Metadata } from "next";
import { Plus } from "lucide-react";
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

import { deleteTestSeriesAction } from "./actions";

export const metadata: Metadata = { title: "Test Series · Admin" };

export default async function TestSeriesListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; examId?: string; page?: string; success?: string; error?: string }>;
}) {
  const { q, examId, page: pageParam, success, error } = await searchParams;
  const page = parsePage(pageParam);

  const where: Prisma.TestSeriesWhereInput = {
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
    ...(examId ? { examId } : {}),
  };

  const [rows, total, exams] = await Promise.all([
    prisma.testSeries.findMany({
      where,
      include: { exam: true, _count: { select: { tests: true } } },
      orderBy: { order: "asc" },
      ...pageSkipTake(page),
    }),
    prisma.testSeries.count({ where }),
    prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Test series</h1>
          <p className="mt-1 text-sm text-text-muted">Full mocks, previous year papers, subject practice.</p>
        </div>
        <Link
          href="/admin/test-series/new"
          className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="size-4" /> New test series
        </Link>
      </div>

      <StatusBanner success={success} error={error} />
      <SearchBar action="/admin/test-series" placeholder="Search title…" defaultValue={q}>
        <select name="examId" defaultValue={examId ?? ""} className="h-10 rounded-[9px] border border-border-strong bg-surface px-3 text-sm">
          <option value="">All exams</option>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      </SearchBar>

      {rows.length === 0 ? (
        <EmptyState title="No test series found" body="Create one, or adjust your search/filters." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Exam</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Tests</TableHead>
              <TableHead>Popular</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold text-text-heading">{row.title}</TableCell>
                <TableCell>{row.exam.title}</TableCell>
                <TableCell>{row.kind.replace("_", " ")}</TableCell>
                <TableCell>{row._count.tests}</TableCell>
                <TableCell>{row.isPopular ? "Yes" : "No"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/admin/test-series/${row.id}/edit`}
                      className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                    >
                      Edit
                    </Link>
                    <ConfirmDeleteButton
                      action={deleteTestSeriesAction}
                      itemLabel={row.title}
                      hiddenFields={{ id: row.id }}
                      description={`This removes "${row.title}" and its ${row._count.tests} test(s). This can't be undone.`}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={page} totalPages={totalPages} basePath="/admin/test-series" searchParams={{ q, examId }} />
    </div>
  );
}
