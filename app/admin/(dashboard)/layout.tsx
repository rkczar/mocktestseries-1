import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/rbac";
import { Sidebar } from "@/components/admin/sidebar";
import { AdminHeader } from "@/components/admin/header";

export default async function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session?.user) redirect("/admin/login");

  const cookieStore = await cookies();
  const defaultCollapsed = cookieStore.get("admin_sidebar_collapsed")?.value === "1";

  return (
    <div className="flex min-h-screen bg-[var(--color-background)]">
      <Sidebar defaultCollapsed={defaultCollapsed} />
      <div className="flex min-h-screen flex-1 flex-col">
        <AdminHeader adminName={session.user.name ?? "Admin"} role={session.user.role ?? "ADMIN"} />
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
