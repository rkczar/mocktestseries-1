import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Visual breadcrumb trail + matching BreadcrumbList JSON-LD, kept together
 * so the two can never drift apart. `href` omitted on the last crumb (the
 * current page) both visually and in the structured data per schema.org
 * convention (the final item still gets a position, just no separate URL
 * requirement).
 */
export function ExamBreadcrumbs({ crumbs, baseUrl }: { crumbs: Crumb[]; baseUrl: string }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.label,
      ...(c.href ? { item: `${baseUrl}${c.href}` } : {}),
    })),
  };

  return (
    <>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="h-3 w-3" aria-hidden /> : null}
            {c.href ? (
              <Link href={c.href} className="hover:text-[var(--color-foreground)] hover:underline">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-[var(--color-foreground)]">
                {c.label}
              </span>
            )}
          </span>
        ))}
      </nav>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  );
}
