import { AiUspSection } from "@/components/home/AiUspSection";
import { FeaturedExamsSection } from "@/components/home/FeaturedExamsSection";
import { FinalCtaSection } from "@/components/home/FinalCtaSection";
import { HeroSection } from "@/components/home/HeroSection";
import { HowItWorksSection } from "@/components/home/HowItWorksSection";
import { PopularTestSeriesSection } from "@/components/home/PopularTestSeriesSection";
import { TrustStrip } from "@/components/home/TrustStrip";
import { UpcomingExamsSection } from "@/components/home/UpcomingExamsSection";
import { WhyUsSection } from "@/components/home/WhyUsSection";
import { getHomepageContent } from "@/lib/content/getHomepageContent";

const FALLBACK_CTA = { label: "", href: "#", variant: "primary" as const };

export default async function HomePage() {
  const content = await getHomepageContent();
  const isVisible = (key: string) => content.sectionVisibility[key] !== false;

  return (
    <>
      {isVisible("hero") ? (
        <HeroSection
          eyebrow={content.heroEyebrow}
          heading={content.heroHeading}
          description={content.heroDescription}
          primaryCta={content.ctaButtons.hero_primary ?? FALLBACK_CTA}
          secondaryCta={content.ctaButtons.hero_secondary ?? FALLBACK_CTA}
        />
      ) : null}

      {isVisible("trust") ? <TrustStrip /> : null}

      {isVisible("featured_exams") ? <FeaturedExamsSection exams={content.featuredExams} /> : null}

      {isVisible("popular_series") ? (
        <PopularTestSeriesSection series={content.popularTestSeries} />
      ) : null}

      {isVisible("ai_usp") ? <AiUspSection /> : null}

      {isVisible("why_us") ? <WhyUsSection /> : null}

      {isVisible("how_it_works") ? <HowItWorksSection /> : null}

      {isVisible("upcoming") ? <UpcomingExamsSection exams={content.upcomingExams} /> : null}

      {isVisible("final_cta") ? (
        <FinalCtaSection
          heading={content.finalCtaHeading}
          body={content.finalCtaBody}
          note={content.finalCtaNote}
          primaryCta={content.ctaButtons.final_primary ?? FALLBACK_CTA}
          secondaryCta={content.ctaButtons.final_secondary ?? FALLBACK_CTA}
        />
      ) : null}
    </>
  );
}
