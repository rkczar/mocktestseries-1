"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const STUDIO_SECTIONS = [
  { label: "Create Post", href: "/admin/instagram" },
  { label: "PYQ Series", href: "/admin/instagram/pyq" },
  { label: "Most Missed MCQ", href: "/admin/instagram/most-missed" },
  { label: "Drafts", href: "/admin/instagram/drafts" },
  { label: "Published History", href: "/admin/instagram/history" },
  { label: "Templates & Branding", href: "/admin/instagram/templates" },
  { label: "Settings", href: "/admin/instagram/settings" },
] as const;

/** Section switcher for Admin → Instagram (the sidebar keeps one "Instagram" entry). */
export function StudioSubnav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Instagram sections" className="flex flex-wrap gap-2">
      {STUDIO_SECTIONS.map((item) => {
        const active = item.href === "/admin/instagram" ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
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
