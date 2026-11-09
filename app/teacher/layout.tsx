import Link from "next/link";
import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { getStaffSession } from "@/lib/rbac";
import { getTeacher } from "@/lib/teacher/session";
import { logoutAction } from "@/app/admin/(dashboard)/actions";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { BrandLogo } from "@/components/brand/BrandLogo";

export const metadata = { title: "Teacher Portal — Mock Test Series.in", robots: { index: false, follow: false } };

const NAV = [
  { href: "/teacher", label: "Dashboard" },
  { href: "/teacher/questions", label: "Questions" },
  { href: "/teacher/tests", label: "Mock Tests" },
  { href: "/teacher/students", label: "Students" },
  { href: "/teacher/payments", label: "Payments" },
  { href: "/teacher/requests", label: "My Requests" },
];

/**
 * Teacher Portal shell (Phase A). Only an active teacher (role TEACHER +
 * ACTIVE profile) gets past this layout; every page and action re-checks
 * the scope itself as well (lib/teacher/scope.ts).
 */
export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const teacher = await getTeacher();
  if (!teacher) {
    const staff = await getStaffSession();
    if (!staff?.user) redirect("/admin/login?callbackUrl=/teacher");
    if (staff.user.role !== "TEACHER") redirect("/admin");
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <h1 className="text-lg font-semibold text-[var(--color-foreground)]">Teacher access is not active</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Your teacher account is suspended or not set up yet. Contact the Master Admin.</p>
        <form action={logoutAction}>
          <button type="submit" className="underline">Sign out</button>
        </form>
      </main>
    );
  }
  return (
    <div className="min-h-screen bg-[var(--color-background)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-card)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <BrandLogo size="sm" href={null} />
            <span className="text-sm text-[var(--color-muted-foreground)]">Teacher Portal</span>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="hidden text-sm font-medium text-[var(--color-foreground)] sm:inline">{teacher.name}</span>
            <form action={logoutAction}>
              <button type="submit" aria-label="Sign out" title="Sign out" className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)]">
                <LogOut className="h-4 w-4" aria-hidden />
              </button>
            </form>
          </div>
        </div>
        <nav aria-label="Teacher" className="mx-auto flex max-w-6xl gap-4 overflow-x-auto px-4 pb-2 text-sm">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="whitespace-nowrap text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6">{children}</main>
    </div>
  );
}
