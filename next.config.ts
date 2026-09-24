import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    // The public Mock Test Series page moved to one canonical URL; keep old
    // links, bookmarks and indexed URLs working (and pass SEO equity) with a
    // permanent redirect instead of two near-identical indexable pages.
    return [{ source: "/exams/:slug/mock-tests", destination: "/exams/:slug/mock-test-series", permanent: true }];
  },
};

export default nextConfig;
