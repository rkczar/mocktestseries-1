"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const AI_ENGINE_SECTIONS = [
  { label: "Overview", href: "/admin/ai" },
  { label: "Providers", href: "/admin/ai/providers" },
  { label: "Models", href: "/admin/ai/models" },
  { label: "Features", href: "/admin/ai/features" },
  { label: "Analytics", href: "/admin/ai/analytics" },
  { label: "Budgets", href: "/admin/ai/budgets" },
  { label: "History", href: "/admin/ai/history" },
] as const;

/** Section switcher for Admin → AI (the sidebar keeps one "AI Solutions" entry). */
export function AiEngineSubnav() {
  const pathname = usePathname();
  return (
    <nav aria-label="AI sections" className="flex flex-wrap gap-2" data-testid="ai-subnav">
      {AI_ENGINE_SECTIONS.map((item) => {
        const active = item.href === "/admin/ai" ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
