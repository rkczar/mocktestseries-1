import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/admin/EmptyState";
import { Pagination } from "@/components/admin/Pagination";
import { SearchBar } from "@/components/admin/SearchBar";
import { StatusBanner } from "@/components/admin/StatusBanner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEFAULT_PAGE_SIZE, pageSkipTake, parsePage } from "@/lib/admin/pagination";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export const metadata: Metadata = { title: "Students · Admin" };

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; success?: string; error?: string }>;
}) {
  const { q, status, page: pageParam, success, error } = await searchParams;
  const page = parsePage(pageParam);

  const where: Prisma.StudentWhereInput = {
    ...(q
      ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] }
      : {}),
    ...(status === "active" ? { isActive: true } : status === "inactive" ? { isActive: false } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.student.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { attempts: true } } },
      ...pageSkipTake(page),
    }),
    prisma.student.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));

  return (
    <div>
      <div className="mb-5">
        <h1 className="font-display text-[26px] font-bold text-text-heading">Students</h1>
        <p className="mt-1 text-sm text-text-muted">{total} registered student{total === 1 ? "" : "s"}.</p>
      </div>

      <StatusBanner success={success} error={error} />
      <SearchBar action="/admin/students" placeholder="Search name or email…" defaultValue={q}>
        <select name="status" defaultValue={status ?? ""} className="h-10 rounded-[9px] border border-border-strong bg-surface px-3 text-sm">
          <option value="">All students</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
        </select>
      </SearchBar>

      {rows.length === 0 ? (
        <EmptyState title="No students found" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold text-text-heading">{row.name}</TableCell>
                <TableCell>{row.email}</TableCell>
                <TableCell>{row._count.attempts}</TableCell>
                <TableCell className="text-text-faint">{row.createdAt.toLocaleDateString()}</TableCell>
                <TableCell>{row.isActive ? "Active" : "Deactivated"}</TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/admin/students/${row.id}`}
                    className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                  >
                    View
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={page} totalPages={totalPages} basePath="/admin/students" searchParams={{ q, status }} />
    </div>
  );
}
