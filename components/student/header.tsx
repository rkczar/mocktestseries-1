"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { GraduationCap, Menu, X, User, LogOut, Bookmark } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { studentLogoutAction } from "@/app/student/(dashboard)/actions";

const NAV_ITEMS = [
  { label: "My Exams", href: "/student/exams" },
  { label: "Test Series", href: "/student/test-series" },
  { label: "Custom Module", href: "/student/custom-module" },
  { label: "History", href: "/student/history" },
];

export function StudentHeader({ name, studentId }: { name: string; studentId: string }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-surface)]/80">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/student/dashboard" className="flex shrink-0 items-center gap-2 text-[var(--color-foreground)]">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-primary)] text-white">
            <GraduationCap className="h-4 w-4" aria-hidden />
          </span>
          <span className="hidden text-sm font-bold sm:inline" style={{ fontFamily: "var(--font-heading)" }}>
            Mock Test Series.in
          </span>
        </Link>

        <nav className="hidden flex-1 items-center justify-center gap-6 md:flex" aria-label="Student">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "text-sm font-medium transition-colors hover:text-[var(--color-foreground)]",
                pathname.startsWith(item.href) ? "text-[var(--color-foreground)]" : "text-[var(--color-muted-foreground)]"
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)]/15 text-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                aria-label="Account menu"
              >
                <User className="h-4 w-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>
                {name}
                <div className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{studentId}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/student/profile">
                  <User className="h-4 w-4" aria-hidden /> My Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/student/saved">
                  <Bookmark className="h-4 w-4" aria-hidden /> Saved Questions
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  void studentLogoutAction();
                }}
              >
                <LogOut className="h-4 w-4" aria-hidden /> Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] text-[var(--color-foreground)] md:hidden"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <nav className="flex flex-col gap-1 border-t border-[var(--color-border)] px-4 py-3 md:hidden" aria-label="Student mobile">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className="rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-background)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
