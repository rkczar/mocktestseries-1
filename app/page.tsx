import type { Metadata } from "next";
import { getPublishedHomepage, getFallbackHomepage } from "@/lib/homepage";
import { resolveHomepage } from "@/lib/homepage-render";
import { HomepageView } from "@/components/homepage/homepage-view";

export async function generateMetadata(): Promise<Metadata> {
  const published = await getPublishedHomepage();
  const seo = (published?.seo as { title?: string; metaDescription?: string } | null) ?? {};
  return {
    title: seo.title || "Mock Test Series.in — RUHS Rajasthan Medical Officer Exam 2026",
    description:
      seo.metaDescription ||
      "Mock tests, previous year papers, and AI-powered explanations for the RUHS Medical Officer Exam 2026.",
  };
}

export default async function Home() {
  const published = await getPublishedHomepage();
  const config = published ?? getFallbackHomepage();
  const homepage = await resolveHomepage(config);

  return <HomepageView homepage={homepage} />;
}
