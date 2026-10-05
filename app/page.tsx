import type { Metadata } from "next";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings } from "@/lib/seo-settings";
import { getPublishedHomepage, getFallbackHomepage, DEFAULT_HOMEPAGE_SEO } from "@/lib/homepage";
import { resolveHomepage } from "@/lib/homepage-render";
import { HomepageView } from "@/components/homepage/homepage-view";
import { faqItems } from "@/components/homepage/growth-sections";
import { requirePageVisible } from "@/lib/page-visibility";
import { findPracticeOmrSheet } from "@/lib/omr-sheet";
import { getStudentSession } from "@/lib/student-session";
import { getHomepageReviewsSafe } from "@/lib/reviews";
import { ReviewsSection } from "@/components/homepage/reviews-section";
import { FloatingWhatsAppSupport } from "@/components/support/floating-whatsapp-support";
import { BRAND_NAME, PUBLIC_BRAND_NAME } from "@/lib/brand";
import { safeJsonLd } from "@/lib/json-ld";
import { defaultSocialImage, socialMetadata } from "@/lib/social-metadata";

type HomepageSeo = { title?: string; metaDescription?: string; canonicalUrl?: string; ogTitle?: string; ogDescription?: string };

export async function generateMetadata(): Promise<Metadata> {
  const [published, siteUrl, settings] = await Promise.all([getPublishedHomepage(), getSiteUrl(), getSeoSettings()]);
  const seo = (published?.seo as HomepageSeo | null) ?? {};
  const title = seo.title || DEFAULT_HOMEPAGE_SEO.title;
  const description = seo.metaDescription || DEFAULT_HOMEPAGE_SEO.metaDescription;
  // One canonical homepage URL; an admin override is honoured only on our own origin.
  const canonical = seo.canonicalUrl && seo.canonicalUrl.startsWith(`${siteUrl}/`) ? seo.canonicalUrl : `${siteUrl}/`;
  const ogTitle = seo.ogTitle || title;
  const ogDescription = seo.ogDescription || description;
  const image = defaultSocialImage(settings, siteUrl);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical },
    robots: settings.siteIndexable
      ? { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } }
      : { index: false, follow: false },
    ...socialMetadata({ title: ogTitle, description: ogDescription, url: canonical, image, seo: settings }),
  };
}

export default async function Home() {
  await requirePageVisible("homepage");
  const [published, session, siteUrl] = await Promise.all([getPublishedHomepage(), getStudentSession(), getSiteUrl()]);
  const config = published ?? getFallbackHomepage();
  const studentId = session?.user?.studentId ? (session.user.id ?? null) : null;
  const [homepage, omrSheet, reviews] = await Promise.all([
    resolveHomepage(config, { studentId }),
    findPracticeOmrSheet(),
    // Cached, time-boxed and never throws: no reviews / an error just hides the section.
    getHomepageReviewsSafe(),
  ]);

  // WebSite markup names the site for Google's site-name system: the public
  // brand, with the domain-style wordmark as an alternate name.
  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    name: PUBLIC_BRAND_NAME,
    alternateName: [BRAND_NAME, "mocktestseries.in"],
    url: `${siteUrl}/`,
    inLanguage: "en-IN",
    publisher: { "@id": `${siteUrl}/#organization` },
  };
  // FAQPage only for questions that are visibly rendered on this page.
  const faq = homepage.sections.find((s) => s.key === "FAQ" && s.isEnabled);
  const faqs = faq && faq.content.structuredData !== false ? faqItems(faq.content) : [];
  const faqJsonLd =
    faqs.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqs.map(([question, answer]) => ({
            "@type": "Question",
            name: question,
            acceptedAnswer: { "@type": "Answer", text: answer },
          })),
        }
      : null;

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(websiteJsonLd) }} />
      {faqJsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }} /> : null}
      <HomepageView
        homepage={homepage}
        omrResourceId={omrSheet?.id ?? null}
        studentSignedIn={Boolean(studentId)}
        reviewsSection={reviews ? <ReviewsSection settings={reviews.settings} reviews={reviews.reviews} /> : null}
      />
      <FloatingWhatsAppSupport surface="homepage" />
    </>
  );
}
