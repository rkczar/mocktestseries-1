import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";

import { ConfirmDeleteButton } from "@/components/admin/ConfirmDeleteButton";
import { EmptyState } from "@/components/admin/EmptyState";
import { StatusBanner } from "@/components/admin/StatusBanner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { prisma } from "@/lib/db";

import { deletePricingPlanAction } from "./actions";

export const metadata: Metadata = { title: "Pricing · Admin" };

export default async function PricingPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const { success, error } = await searchParams;
  const rows = await prisma.pricingPlan.findMany({ orderBy: { order: "asc" } });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Pricing</h1>
          <p className="mt-1 text-sm text-text-muted">Shown on the public /pricing page.</p>
        </div>
        <Link
          href="/admin/pricing/new"
          className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="size-4" /> New plan
        </Link>
      </div>

      <StatusBanner success={success} error={error} />

      {rows.length === 0 ? (
        <EmptyState title="No pricing plans yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Popular</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold text-text-heading">{row.name}</TableCell>
                <TableCell>
                  ₹{(row.priceInPaise / 100).toLocaleString("en-IN")} / {row.period}
                </TableCell>
                <TableCell>{row.isPopular ? "Yes" : "No"}</TableCell>
                <TableCell>{row.isActive ? "Yes" : "No"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Link
                      href={`/admin/pricing/${row.id}/edit`}
                      className="rounded-[8px] border border-border-strong px-3 py-1.5 text-[13px] font-bold text-primary hover:bg-accent"
                    >
                      Edit
                    </Link>
                    <ConfirmDeleteButton action={deletePricingPlanAction} itemLabel={row.name} hiddenFields={{ id: row.id }} />
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
