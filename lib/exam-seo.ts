import "server-only";
import type { Metadata } from "next";
import type { Exam } from "@prisma/client";
import { displayExamName } from "@/lib/exam-display";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { getSiteUrl } from "@/lib/site-url";
import { defaultSocialImage, examSocialImage, socialMetadata } from "@/lib/social-metadata";

/**
 * Metadata for the public exam hub and its deep pages: one canonical URL
 * per page, the admin's indexability switch, and the exam's social card.
 * `title` is the page's own title; `absoluteTitle` skips the site template
 * (used for the hub's admin-written SEO title).
 */
export async function examPageMetadata({
  exam,
  path,
  title,
  absoluteTitle,
  description,
}: {
  exam: Pick<Exam, "name" | "publicSlug" | "updatedAt">;
  path: string;
  title?: string;
  absoluteTitle?: string;
  description: string;
}): Promise<Metadata> {
  const [seo, siteUrl] = await Promise.all([getSeoSettings(), getSiteUrl()]);
  const fullTitle = absoluteTitle || applyTitleTemplate(seo.titleTemplate, title ?? displayExamName(exam.name));
  const url = `${siteUrl}${path}`;
  const image = examSocialImage(siteUrl, exam, displayExamName(exam.name)) ?? defaultSocialImage(seo, siteUrl);
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    ...socialMetadata({ title: fullTitle, description, url, image, seo }),
  };
}
