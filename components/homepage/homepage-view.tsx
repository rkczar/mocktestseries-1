import type { ResolvedHomepage } from "@/lib/homepage-render";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";
import {
  HeroSection,
  FeaturedExamSection,
  MockTestPromotionSection,
  PreviousYearPapersSection,
  AiUspSection,
  BenefitsSection,
  HowItWorksSection,
  UpcomingExamsSection,
  TestSeriesSection,
  StatisticsSection,
  CtaSection,
} from "./sections";
import type { HomepageSectionKey } from "@prisma/client";
import type { ComponentType } from "react";

type Section = ResolvedHomepage["sections"][number];
type SectionComponentProps = { content: Record<string, unknown>; resolved: Section["resolved"] };

const SECTION_COMPONENTS: Partial<Record<HomepageSectionKey, ComponentType<SectionComponentProps>>> = {
  HERO: HeroSection,
  FEATURED_EXAM: FeaturedExamSection,
  MOCK_TEST_PROMOTION: MockTestPromotionSection,
  PREVIOUS_YEAR_PAPERS: PreviousYearPapersSection,
  AI_USP: AiUspSection,
  BENEFITS: BenefitsSection,
  HOW_IT_WORKS: HowItWorksSection,
  UPCOMING_EXAMS: UpcomingExamsSection,
  TEST_SERIES: TestSeriesSection,
  STATISTICS: StatisticsSection,
  CTA: CtaSection,
};

export function HomepageView({ homepage }: { homepage: ResolvedHomepage }) {
  const byKey = new Map(homepage.sections.map((s) => [s.key, s]));
  const header = byKey.get("HEADER");
  const footer = byKey.get("FOOTER");

  const bodySections = homepage.sections.filter(
    (s) => s.isEnabled && s.key !== "HEADER" && s.key !== "FOOTER"
  );

  return (
    <div className="flex min-h-full flex-col bg-[var(--color-background)]">
      {header?.isEnabled !== false ? (
        <SiteHeader content={(header?.content as Record<string, unknown>) ?? {}} />
      ) : null}

      <main className="flex-1">
        {bodySections.map((section) => {
          const Component = SECTION_COMPONENTS[section.key];
          if (!Component) return null;
          return (
            <Component
              key={section.key}
              content={section.content}
              resolved={section.resolved}
            />
          );
        })}
      </main>

      {footer?.isEnabled !== false ? (
        <SiteFooter content={(footer?.content as Record<string, unknown>) ?? {}} />
      ) : null}
    </div>
  );
}
