import { getPublishedHomepage, getFallbackHomepage } from "@/lib/homepage";
import { resolveHomepage } from "@/lib/homepage-render";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";

/**
 * Same canonical Header/Footer used by the homepage (components/homepage/
 * homepage-view.tsx) — reused here so /contact, /privacy, /terms stay
 * visually and functionally consistent with the rest of the public site,
 * without duplicating the full section-rendering logic that's specific to
 * the homepage body.
 */
export async function getPublicChrome() {
  const published = await getPublishedHomepage();
  const config = published ?? getFallbackHomepage();
  const homepage = await resolveHomepage(config);
  const byKey = new Map(homepage.sections.map((s) => [s.key, s]));
  return {
    header: byKey.get("HEADER"),
    footer: byKey.get("FOOTER"),
    contactInfo: byKey.get("CONTACT_INFO"),
  };
}

export async function PublicPageShell({ children }: { children: React.ReactNode }) {
  const { header, footer, contactInfo } = await getPublicChrome();
  const growWithUsEnabled = (contactInfo?.content as Record<string, unknown> | undefined)?.growWithUsEnabled !== false;

  return (
    <div className="flex min-h-full flex-col bg-[var(--color-background)]">
      {header?.isEnabled !== false ? (
        <SiteHeader content={(header?.content as Record<string, unknown>) ?? {}} growWithUsEnabled={growWithUsEnabled} />
      ) : null}
      <main className="flex-1">{children}</main>
      {footer?.isEnabled !== false ? (
        <SiteFooter
          content={(footer?.content as Record<string, unknown>) ?? {}}
          resolved={footer?.resolved ?? {}}
          growWithUsEnabled={growWithUsEnabled}
        />
      ) : null}
    </div>
  );
}
