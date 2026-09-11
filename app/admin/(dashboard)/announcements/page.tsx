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

import { deleteAnnouncementAction } from "./actions";

export const metadata: Metadata = { title: "Announcements · Admin" };

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; success?: string; error?: string }>;
}) {
  const { q, page: pageParam, success, error } = await searchParams;
  const page = parsePage(pageParam);
  const where = q ? { message: { contains: q, mode: "insensitive" as const } } : {};

  const [rows, total] = await Promise.all([
    prisma.announcement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageSkipTake(page),
    }),
    prisma.announcement.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Announcements</h1>
          <p className="mt-1 text-sm text-text-muted">Shown in the site-wide banner when active.</p>
        </div>
        <Link
          href="/admin/announcements/new"
          className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="size-4" /> New announcement
        </Link>
      </div>

      <StatusBanner success={success} error={error} />
      <SearchBar action="/admin/announcements" placeholder="Search message…" defaultValue={q} />

      {rows.length === 0 ? (
        <EmptyState
          title="No announcements yet"
          body="Create one to show a banner across the public site."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Window</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.tag ?? "—"}</TableCell>
                <TableCell className="max-w-xs truncate whitespace-normal">{row.message}</TableCell>
                <TableCell>{row.isActive ? "Yes" : "No"}</TableCell>
                <TableCell className="text-text-faint">
                  {row.startsAt ? new Date(row.startsAt).toLocaleDateString() : "—"} –{" "}
                  {row.endsAt ? new Date(row.endsAt).toLocaleDateString() : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/admin/announcements/${row.id}/edit`}
                      className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                    >
                      Edit
                    </Link>
                    <ConfirmDeleteButton
                      action={deleteAnnouncementAction}
                      itemLabel={row.message}
                      hiddenFields={{ id: row.id }}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination page={page} totalPages={totalPages} basePath="/admin/announcements" searchParams={{ q }} />
    </div>
  );
}
