import { footerCacheControlsEnabled } from "@/lib/cache/config";
import { getHomepageContent } from "@/lib/content/getHomepageContent";

import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

/**
 * The one universal public-facing shell: header, main content slot, footer, and the boundary
 * that scopes the three-mode appearance system (see globals.css + ModeProvider) to public and
 * student-account pages. Never render this inside /admin or the Test Player.
 *
 * Deliberately does NOT call `adminAuth()` (or any other cookies()-reading helper) here: this
 * component wraps every public page, most of which are statically prerendered (no
 * `cacheComponents` in next.config.ts, so this app is on the classic caching model where any
 * runtime API access anywhere in a route's tree forces that whole route to render dynamically
 * per request). Whether the current viewer is an admin is instead checked client-side, inside
 * FooterCacheControls itself — see lib/cache/actions.ts's `checkAdminCacheAccessAction`.
 */
export async function PublicShell({ children }: { children: React.ReactNode }) {
  const content = await getHomepageContent();

  return (
    <div data-public-scope className="flex min-h-full flex-col">
      <SiteHeader announcement={content.announcement} />
      <main className="flex-1">{children}</main>
      <SiteFooter showCacheControls={footerCacheControlsEnabled()} />
    </div>
  );
}
