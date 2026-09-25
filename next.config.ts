import type { NextConfig } from "next";
import { LEGACY_REDIRECTS } from "./lib/legacy-redirects";

const nextConfig: NextConfig = {
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
