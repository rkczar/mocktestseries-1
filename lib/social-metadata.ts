import "server-only";
import type { Metadata } from "next";
import { PUBLIC_BRAND_NAME } from "@/lib/brand";
import { OG_ARTWORK_VERSION, OG_SIZE } from "@/lib/og/constants";
import type { SeoSettings } from "@/lib/seo-settings";

/**
 * Open Graph / Twitter metadata for public pages. Next.js merges metadata
 * shallowly, so a page that sets `openGraph` replaces the layout's whole
 * object, images included; every public page therefore builds its social
 * tags here so none ships without an image.
 *
 * Image precedence: an exam page uses its exam card (/og/exams/[slug]);
 * otherwise Admin → SEO → Default OG Image when set; otherwise the
 * generated site card (/og/default). All URLs are absolute.
 */

export interface SocialImage {
  url: string;
  width?: number;
  height?: number;
  alt: string;
}

export function defaultSocialImage(seo: SeoSettings, siteUrl: string): SocialImage {
  if (seo.defaultOgImage) {
    const url = seo.defaultOgImage.startsWith("/") ? `${siteUrl}${seo.defaultOgImage}` : seo.defaultOgImage;
    return { url, alt: PUBLIC_BRAND_NAME };
  }
  return { url: `${siteUrl}/og/default?v=${OG_ARTWORK_VERSION}`, ...OG_SIZE, alt: `${PUBLIC_BRAND_NAME} — online mock tests, PYQs and AI-powered practice` };
}

export function examSocialImage(siteUrl: string, exam: { publicSlug: string | null; updatedAt: Date }, examName: string): SocialImage | null {
  if (!exam.publicSlug) return null;
  const v = `${OG_ARTWORK_VERSION}.${exam.updatedAt.getTime().toString(36)}`;
  return { url: `${siteUrl}/og/exams/${exam.publicSlug}?v=${v}`, ...OG_SIZE, alt: `${examName} — mock tests and previous year papers on ${PUBLIC_BRAND_NAME}` };
}

export function socialMetadata({
  title,
  description,
  url,
  image,
  seo,
}: {
  title: string;
  description: string;
  /** Omitted only for the layout-wide default, so pages never inherit another page's og:url. */
  url?: string;
  image: SocialImage;
  seo: SeoSettings;
}): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: { type: "website", ...(url ? { url } : {}), title, description, siteName: PUBLIC_BRAND_NAME, locale: "en_IN", images: [image] },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: image.url, alt: image.alt }],
      ...(seo.twitterHandle ? { site: seo.twitterHandle } : {}),
    },
  };
}
