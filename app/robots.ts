import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings } from "@/lib/seo-settings";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const [seo, siteUrl] = await Promise.all([getSeoSettings(), getSiteUrl()]);

  if (!seo.siteIndexable) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/student", "/api"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
