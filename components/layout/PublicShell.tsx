import { getHomepageContent } from "@/lib/content/getHomepageContent";

import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

/**
 * The one universal public-facing shell: header, main content slot, footer, and the boundary
 * that scopes the three-mode appearance system (see globals.css + ModeProvider) to public and
 * student-account pages. Never render this inside /admin or the Test Player.
 */
export async function PublicShell({ children }: { children: React.ReactNode }) {
  const content = await getHomepageContent();

  return (
    <div data-public-scope className="flex min-h-full flex-col">
      <SiteHeader announcement={content.announcement} />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
