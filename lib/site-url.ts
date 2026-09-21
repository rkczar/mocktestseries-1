import "server-only";
import { getSeoSettings } from "@/lib/seo-settings";

/**
 * The public site's canonical origin, no trailing slash. Prefers the
 * admin-configured SEO canonical base (Admin -> SEO); falls back to the
 * same NEXTAUTH_URL-based default lib/auth-provider-config.ts already uses,
 * so canonical/OG URLs and the auth redirect origin never disagree.
 */
export async function getSiteUrl(): Promise<string> {
  const settings = await getSeoSettings();
  const base = settings.canonicalBase || process.env.NEXTAUTH_URL || "https://mocktestseries.in";
  return base.replace(/\/+$/, "");
}
