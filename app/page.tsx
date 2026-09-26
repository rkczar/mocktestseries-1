import type { Metadata } from "next";
import { getPublishedHomepage, getFallbackHomepage } from "@/lib/homepage";
import { resolveHomepage } from "@/lib/homepage-render";
import { HomepageView } from "@/components/homepage/homepage-view";
import { requirePageVisible } from "@/lib/page-visibility";
import { findPracticeOmrSheet } from "@/lib/omr-sheet";
import { FloatingWhatsAppSupport } from "@/components/support/floating-whatsapp-support";

export async function generateMetadata(): Promise<Metadata> {
  const published = await getPublishedHomepage();
  const seo = (published?.seo as { title?: string; metaDescription?: string } | null) ?? {};
  return {
    title: seo.title || "MockTestSeries.in — Mock Tests, Previous Year Papers & AI Explanations",
    description:
      seo.metaDescription ||
      "Practice with full-length mock tests, previous year papers, and AI-powered explanations for RUHS Medical Officer, NEET UG, and more — all on one platform.",
  };
}

export default async function Home() {
  await requirePageVisible("homepage");
  const published = await getPublishedHomepage();
  const config = published ?? getFallbackHomepage();
  const [homepage, omrSheet] = await Promise.all([resolveHomepage(config), findPracticeOmrSheet()]);

  return (
    <>
      <HomepageView homepage={homepage} omrResourceId={omrSheet?.id ?? null} />
      <FloatingWhatsAppSupport surface="public" />
    </>
  );
}
