import type { Metadata } from "next";

import { requireAdmin } from "@/lib/auth/requireAdmin";

import { CreateAdminForm } from "./CreateAdminForm";

export const metadata: Metadata = { title: "New Admin · Admin" };

export default async function NewAdminPage() {
  await requireAdmin("SUPER_ADMIN");

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">New admin account</h1>
      <div className="mt-6">
        <CreateAdminForm />
      </div>
    </div>
  );
}
