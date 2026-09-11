import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/admin/", "/student/dashboard", "/api/"],
    },
    sitemap: "https://mocktestseries.in/sitemap.xml",
  };
}
