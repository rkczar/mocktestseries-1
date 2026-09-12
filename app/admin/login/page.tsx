import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getAdminSession } from "@/lib/rbac";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { LoginForm } from "./login-form";

export const metadata = { title: "Admin Login — Mock Test Series.in" };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await getAdminSession();
  if (session?.user) redirect("/admin");

  const { callbackUrl } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary)] text-white shadow-[var(--shadow-card)]">
            <ShieldCheck className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--color-foreground)]">
              Mock Test Series.in
            </h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">Admin Control Center</p>
          </div>
        </div>

        <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-[var(--shadow-card)]">
          <h2 className="mb-1 text-lg font-semibold text-[var(--color-foreground)]">Sign in</h2>
          <p className="mb-6 text-sm text-[var(--color-muted-foreground)]">
            Authorized administrators only.
          </p>
          <LoginForm callbackUrl={callbackUrl ?? "/admin"} />
        </div>

        <p className="mt-6 text-center text-xs text-[var(--color-muted-foreground)]">
          Protected area. All access attempts are logged.
        </p>
      </div>
    </div>
  );
}
