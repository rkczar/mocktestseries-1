import { SiteFooter } from "@/components/layout/SiteFooter";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { getHomepageContent } from "@/lib/content/getHomepageContent";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const content = await getHomepageContent();

  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader announcement={content.announcement} headerPrimaryCta={content.ctaButtons.header_primary} />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
