import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/admin/EmptyState";
import { Pagination } from "@/components/admin/Pagination";
import { SearchBar } from "@/components/admin/SearchBar";
import { StatusBanner } from "@/components/admin/StatusBanner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEFAULT_PAGE_SIZE, pageSkipTake, parsePage } from "@/lib/admin/pagination";
import { prisma } from "@/lib/db";
import type { ExamStatus, Prisma } from "@prisma/client";

export const metadata: Metadata = { title: "Exams · Admin" };

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  COMING_SOON: "Coming soon",
  ARCHIVED: "Archived",
};

export default async function ExamsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; success?: string; error?: string }>;
}) {
  const { q, status, page: pageParam, success, error } = await searchParams;
  const page = parsePage(pageParam);

  const where: Prisma.ExamWhereInput = {
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
    ...(status ? { status: status as ExamStatus } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.exam.findMany({ where, orderBy: { order: "asc" }, ...pageSkipTake(page) }),
    prisma.exam.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Exams</h1>
          <p className="mt-1 text-sm text-text-muted">Adding an exam needs zero homepage code changes.</p>
        </div>
        <Link
          href="/admin/exams/new"
          className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="size-4" /> New exam
        </Link>
      </div>

      <StatusBanner success={success} error={error} />
      <SearchBar action="/admin/exams" placeholder="Search title…" defaultValue={q}>
        <select
          name="status"
          defaultValue={status ?? ""}
          className="h-10 rounded-[9px] border border-border-strong bg-surface px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="COMING_SOON">Coming soon</option>
          <option value="ARCHIVED">Archived</option>
        </select>
      </SearchBar>

      {rows.length === 0 ? (
        <EmptyState title="No exams found" body="Create one, or adjust your search/filters." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Featured</TableHead>
              <TableHead>Order</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <p className="font-semibold text-text-heading">{row.title}</p>
                  <p className="font-mono text-xs text-text-faint">/{row.slug}</p>
                </TableCell>
                <TableCell>{STATUS_LABEL[row.status]}</TableCell>
                <TableCell>{row.isFeatured ? "Yes" : "No"}</TableCell>
                <TableCell>{row.order}</TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/admin/exams/${row.id}/edit`}
                    className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                  >
                    Edit
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={page} totalPages={totalPages} basePath="/admin/exams" searchParams={{ q, status }} />
    </div>
  );
}
