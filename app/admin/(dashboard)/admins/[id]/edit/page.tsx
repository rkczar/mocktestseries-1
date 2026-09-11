import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StatusBanner } from "@/components/admin/StatusBanner";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

import { EditAdminForm } from "./EditAdminForm";

export const metadata: Metadata = { title: "Edit Admin · Admin" };

export default async function EditAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const session = await requireAdmin("SUPER_ADMIN");
  const { id } = await params;
  const { success, error } = await searchParams;
  const admin = await prisma.adminUser.findUnique({ where: { id } });
  if (!admin) notFound();

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Edit admin</h1>
      <p className="mt-1 text-sm text-text-muted">{admin.email}</p>
      <StatusBanner success={success} error={error} />
      <div className="mt-6">
        <EditAdminForm admin={admin} isSelf={admin.id === session.user.id} />
      </div>
    </div>
  );
}
