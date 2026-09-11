import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";

import { ConfirmDeleteButton } from "@/components/admin/ConfirmDeleteButton";
import { EmptyState } from "@/components/admin/EmptyState";
import { SearchBar } from "@/components/admin/SearchBar";
import { StatusBanner } from "@/components/admin/StatusBanner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { prisma } from "@/lib/db";

import { deleteUpcomingExamAction } from "./actions";

export const metadata: Metadata = { title: "Upcoming Exams · Admin" };

export default async function UpcomingExamsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; success?: string; error?: string }>;
}) {
  const { q, success, error } = await searchParams;
  const rows = await prisma.upcomingExam.findMany({
    where: q ? { title: { contains: q, mode: "insensitive" } } : {},
    orderBy: [{ order: "asc" }],
  });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Upcoming exams</h1>
          <p className="mt-1 text-sm text-text-muted">Shown on the homepage and /upcoming-exams.</p>
        </div>
        <Link
          href="/admin/upcoming-exams/new"
          className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="size-4" /> New entry
        </Link>
      </div>

      <StatusBanner success={success} error={error} />
      <SearchBar action="/admin/upcoming-exams" placeholder="Search title…" defaultValue={q} />

      {rows.length === 0 ? (
        <EmptyState title="No upcoming exams yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Visible</TableHead>
              <TableHead>Order</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold text-text-heading">{row.title}</TableCell>
                <TableCell>{row.status}</TableCell>
                <TableCell>{row.isVisible ? "Yes" : "No"}</TableCell>
                <TableCell>{row.order}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/admin/upcoming-exams/${row.id}/edit`}
                      className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                    >
                      Edit
                    </Link>
                    <ConfirmDeleteButton
                      action={deleteUpcomingExamAction}
                      itemLabel={row.title}
                      hiddenFields={{ id: row.id }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
