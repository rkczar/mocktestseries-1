"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const AI_IMPORTER_SECTIONS = [
  { label: "New Import", href: "/admin/ai-importer" },
  { label: "Processing Jobs", href: "/admin/ai-importer/jobs" },
  { label: "Review Exceptions", href: "/admin/ai-importer/exceptions" },
  { label: "Answer Keys & Verification", href: "/admin/ai-importer/answers" },
  { label: "Import History", href: "/admin/ai-importer/history" },
  { label: "AI Cost Center", href: "/admin/ai-importer/costs" },
  { label: "Original Paper Vault", href: "/admin/ai-importer/vault" },
  { label: "Storage Manager", href: "/admin/ai-importer/storage" },
  { label: "Import Settings", href: "/admin/ai-importer/settings" },
] as const;

/** Section switcher for Admin → AI Question Importer. */
export function AiImporterSubnav() {
  const pathname = usePathname();
  return (
    <nav aria-label="AI Question Importer sections" className="flex flex-wrap gap-2" data-testid="ai-importer-subnav">
      {AI_IMPORTER_SECTIONS.map((item) => {
        const active =
          item.href === "/admin/ai-importer"
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(item.href + "/") || (item.href.endsWith("/exceptions") && pathname.startsWith("/admin/ai-importer/questions/"));
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
