import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { Container } from "@/components/common/Container";
import { requireAdmin } from "@/lib/auth/requireAdmin";

import { adminLogoutAction } from "./dashboard/actions";

export default async function AdminProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();

  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="border-b border-border bg-surface">
        <Container className="flex h-[64px] items-center justify-between">
          <p className="font-display text-lg font-bold text-primary">MockTestSeries.in Admin</p>
          <div className="flex items-center gap-4">
            <span className="text-sm text-text-muted">
              {session.user.name}{" "}
              <span className="font-mono text-xs text-text-faint uppercase">{session.user.role}</span>
            </span>
            <form action={adminLogoutAction}>
              <button
                type="submit"
                className="rounded-[9px] border border-border-strong px-3.5 py-2 text-[13.5px] font-bold text-primary hover:bg-accent"
              >
                Log out
              </button>
            </form>
          </div>
        </Container>
      </header>

      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col lg:flex-row">
        <AdminSidebar role={session.user.role ?? "ADMIN"} />
        <main className="min-w-0 flex-1 px-6 py-7">{children}</main>
      </div>
    </div>
  );
}
