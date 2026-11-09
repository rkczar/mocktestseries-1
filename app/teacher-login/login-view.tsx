import { GraduationCap } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { TeacherLoginScreen } from "./login-screen";

/**
 * Teacher Login screen. app/teacher/layout.tsx renders it at /teacher for
 * signed-out visitors. No sign-up: teacher accounts are created by the
 * Master Admin only.
 */
export function TeacherLoginView() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary)] text-white shadow-[var(--shadow-card)]">
            <GraduationCap className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <BrandLogo size="lg" href={null} />
            <p className="text-sm text-[var(--color-muted-foreground)]">Teacher Portal</p>
          </div>
        </div>
        <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-[var(--shadow-card)]">
          <h1 className="mb-1 text-lg font-semibold text-[var(--color-foreground)]">Teacher Login</h1>
          <p className="mb-5 text-sm text-[var(--color-muted-foreground)]">Sign in with the account your Master Admin created for you.</p>
          <TeacherLoginScreen />
        </div>
        <p className="mt-6 text-center text-xs text-[var(--color-muted-foreground)]">Protected area. All access attempts are logged.</p>
      </div>
    </div>
  );
}
