import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/rbac";
import { Sidebar } from "@/components/admin/sidebar";
import { AdminHeader } from "@/components/admin/header";

export default async function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session?.user) redirect("/admin/login");

  return (
    <div className="flex min-h-screen bg-[var(--color-background)]">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <AdminHeader adminName={session.user.name ?? "Admin"} role={session.user.role ?? "ADMIN"} />
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
