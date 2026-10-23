"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** The everyday sections; the rest sit under "More" so the importer opens on one obvious workflow. */
export const AI_IMPORTER_SECTIONS = [
  { label: "Import", href: "/admin/ai-importer" },
  { label: "Imports", href: "/admin/ai-importer/jobs" },
  { label: "Review Exceptions", href: "/admin/ai-importer/exceptions" },
  { label: "Import Settings", href: "/admin/ai-importer/settings" },
] as const;

export const AI_IMPORTER_MORE_SECTIONS = [
  { label: "Answer Keys & Verification", href: "/admin/ai-importer/answers" },
  { label: "Import History", href: "/admin/ai-importer/history" },
  { label: "AI Cost Center", href: "/admin/ai-importer/costs" },
  { label: "Format Profiles", href: "/admin/ai-importer/formats" },
  { label: "Taxonomy Reference", href: "/admin/ai-importer/taxonomy" },
  { label: "Original Paper Vault", href: "/admin/ai-importer/vault" },
  { label: "Storage Manager", href: "/admin/ai-importer/storage" },
] as const;

const isActive = (pathname: string, href: string) =>
  href === "/admin/ai-importer" ? pathname === href : pathname === href || pathname.startsWith(href + "/") || (href.endsWith("/exceptions") && pathname.startsWith("/admin/ai-importer/questions/"));

const linkClass = (active: boolean) =>
  cn(
    "rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors",
    active ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
  );

/** Section switcher for Admin → AI Question Importer. */
export function AiImporterSubnav() {
  const pathname = usePathname();
  const moreActive = AI_IMPORTER_MORE_SECTIONS.some((s) => isActive(pathname, s.href));
  return (
    <nav aria-label="AI Question Importer sections" className="flex flex-wrap items-start gap-2" data-testid="ai-importer-subnav">
      {AI_IMPORTER_SECTIONS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={linkClass(active)}>
            {item.label}
          </Link>
        );
      })}
      <details className="group relative" open={moreActive || undefined} data-testid="ai-importer-more">
        <summary className={cn(linkClass(moreActive), "cursor-pointer list-none")}>More</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {AI_IMPORTER_MORE_SECTIONS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={linkClass(active)}>
                {item.label}
              </Link>
            );
          })}
        </div>
      </details>
    </nav>
  );
}
