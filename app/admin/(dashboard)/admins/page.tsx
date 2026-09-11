import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";

import { StatusBanner } from "@/components/admin/StatusBanner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Admins & Roles · Admin" };

export default async function AdminsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  await requireAdmin("SUPER_ADMIN");
  const { success, error } = await searchParams;
  const rows = await prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Admins & roles</h1>
          <p className="mt-1 text-sm text-text-muted">Visible to SUPER_ADMIN accounts only.</p>
        </div>
        <Link
          href="/admin/admins/new"
          className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="size-4" /> New admin
        </Link>
      </div>

      <StatusBanner success={success} error={error} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Active</TableHead>
            <TableHead>Last login</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-semibold text-text-heading">{row.name}</TableCell>
              <TableCell>{row.email}</TableCell>
              <TableCell className="font-mono text-xs">{row.role}</TableCell>
              <TableCell>{row.isActive ? "Yes" : "No"}</TableCell>
              <TableCell className="text-text-faint">
                {row.lastLoginAt ? row.lastLoginAt.toLocaleString() : "Never"}
              </TableCell>
              <TableCell className="text-right">
                <Link
                  href={`/admin/admins/${row.id}/edit`}
                  className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                >
                  Edit
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
