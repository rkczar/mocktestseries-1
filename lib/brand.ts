/**
 * The single source of truth for the site's brand name. Used both by the
 * text-only <BrandLogo /> component (components/brand/BrandLogo.tsx) and by
 * server-side defaults that need the same string (login branding, copyright
 * line). Never used for ordinary prose references to the site.
 */
export const BRAND_NAME = "MockTestSeries.in";

/**
 * How the brand reads in public prose, page titles and structured data
 * (WebSite.name for Google's site-name system). The wordmark and legal
 * surfaces keep BRAND_NAME; the domain itself (mocktestseries.in) is never
 * changed by this.
 */
export const PUBLIC_BRAND_NAME = "Mock Test Series";
