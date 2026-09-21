import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

/**
 * Static public-page visibility switches (Admin -> Website -> Pages &
 * Content). Deliberately does NOT cover exam landing pages — those use
 * Exam.publicPageEnabled/publicSlug directly (see schema.prisma), since
 * visibility there is inherently a per-exam concept, not a static page.
 * This is the single source of truth for the default rows a fresh install
 * seeds (prisma/seed.ts) and for validating a key exists.
 */
export const PAGE_VISIBILITY_DEFAULTS = [
  { key: "homepage", label: "Homepage", route: "/" },
  { key: "exams-directory", label: "All Exams", route: "/exams" },
  { key: "contact", label: "Contact", route: "/contact" },
  { key: "privacy", label: "Privacy", route: "/privacy" },
  { key: "terms", label: "Terms", route: "/terms" },
] as const;

export type PageVisibilityKey = (typeof PAGE_VISIBILITY_DEFAULTS)[number]["key"];

/**
 * All PageVisibility rows, keyed by `key`. A page with no row yet (never
 * toggled) is treated as visible — the table only ever records exceptions,
 * so an empty table means "everything is on," matching the Boolean's own
 * `@default(true)`.
 */
export async function getPageVisibilityMap(): Promise<Map<string, boolean>> {
  const rows = await prisma.pageVisibility.findMany({ select: { key: true, isVisible: true } });
  return new Map(rows.map((r) => [r.key, r.isVisible]));
}

export async function isPageVisible(key: PageVisibilityKey): Promise<boolean> {
  const row = await prisma.pageVisibility.findUnique({ where: { key }, select: { isVisible: true } });
  return row?.isVisible ?? true;
}

/**
 * Call at the top of a public page's Server Component. Renders the App
 * Router's real 404 (not a custom "coming soon" screen) when the page has
 * been switched off — direct URL access gets the same not-found response
 * as a page that never existed, per spec: no hint that the route exists at
 * all, and it works regardless of whether the page is linked from nav.
 */
export async function requirePageVisible(key: PageVisibilityKey): Promise<void> {
  if (!(await isPageVisible(key))) notFound();
}
