import type { NextConfig } from "next";
import { LEGACY_REDIRECTS } from "./lib/legacy-redirects";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // nginx already sets X-Content-Type-Options, X-Frame-Options and
  // Referrer-Policy (sites-available/mocktestseries.in); these are the rest.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=()" },
        ],
      },
      {
        // Self-hosted KaTeX CSS/fonts (components/content/rich-text.tsx): the
        // directory name carries the version, so the files never change.
        source: "/vendor/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
  async redirects() {
    return [
      // The public Mock Test Series page moved to one canonical URL; keep old
      // links, bookmarks and indexed URLs working (and pass SEO equity) with a
      // permanent redirect instead of two near-identical indexable pages.
      { source: "/exams/:slug/mock-tests", destination: "/exams/:slug/mock-test-series", permanent: true },
      // Known URLs from the old PHP/static site (lib/legacy-redirects.ts) —
      // explicit entries only; unknown legacy URLs still 404.
      ...LEGACY_REDIRECTS.map(({ source, destination }) => ({ source, destination, permanent: true })),
    ];
  },
};

export default nextConfig;
