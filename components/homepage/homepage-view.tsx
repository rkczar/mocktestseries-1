import type { ResolvedHomepage } from "@/lib/homepage-render";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";
import { AskAiDemoSection } from "./ask-ai-demo-section";
import { OmrPracticeCard } from "@/components/omr/omr-practice-card";
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
import type { ComponentType, ReactNode } from "react";

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

export function HomepageView({ homepage, omrResourceId = null }: { homepage: ResolvedHomepage; omrResourceId?: string | null }) {
  const byKey = new Map(homepage.sections.map((s) => [s.key, s]));
  const header = byKey.get("HEADER");
  const footer = byKey.get("FOOTER");
  const contactInfo = byKey.get("CONTACT_INFO");
  const growWithUsEnabled = (contactInfo?.content as Record<string, unknown> | undefined)?.growWithUsEnabled !== false;

  const bodySections = homepage.sections.filter(
    (s) => s.isEnabled && s.key !== "HEADER" && s.key !== "FOOTER"
  );

  return (
    <div className="flex min-h-full flex-col bg-[var(--color-background)]">
      {header?.isEnabled !== false ? (
        <SiteHeader content={(header?.content as Record<string, unknown>) ?? {}} growWithUsEnabled={growWithUsEnabled} />
      ) : null}

      <main className="flex-1">
        {(() => {
          // "Try AI Now" is a major product demo, not a footnote — render it
          // right after Featured Exam (falling back to right after Hero if
          // Featured Exam is disabled/unconfigured, or at the very end as a
          // last resort) instead of always trailing every other section.
          const tryAiNowAfterKey = bodySections.some((s) => s.key === "FEATURED_EXAM")
            ? "FEATURED_EXAM"
            : bodySections.some((s) => s.key === "HERO")
              ? "HERO"
              : null;
          let tryAiNowInserted = tryAiNowAfterKey === null;

          // Practice OMR is a supporting resource: mid-page, after the
          // platform features (AI_USP, else BENEFITS), never above the hero.
          const omrAfterKey = (["AI_USP", "BENEFITS", "HOW_IT_WORKS"] as const).find((k) => bodySections.some((s) => s.key === k)) ?? null;
          let omrInserted = !omrResourceId;
          const omrSection = omrResourceId ? (
            <section key="practice-omr" id="practice-omr" className="border-t border-[var(--color-border)]">
              <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
                <OmrPracticeCard resourceId={omrResourceId} context="homepage" />
              </div>
            </section>
          ) : null;

          const nodes: ReactNode[] = [];
          for (const section of bodySections) {
            const Component = SECTION_COMPONENTS[section.key];
            if (Component) {
              nodes.push(<Component key={section.key} content={section.content} resolved={section.resolved} />);
            }
            if (!tryAiNowInserted && section.key === tryAiNowAfterKey) {
              nodes.push(<AskAiDemoSection key="try-ai-now" />);
              tryAiNowInserted = true;
            }
            if (!omrInserted && section.key === omrAfterKey) {
              nodes.push(omrSection);
              omrInserted = true;
            }
          }
          if (!omrInserted) nodes.push(omrSection);
          if (!tryAiNowInserted) nodes.push(<AskAiDemoSection key="try-ai-now" />);
          return nodes;
        })()}
      </main>

      {footer?.isEnabled !== false ? (
        <SiteFooter
          content={(footer?.content as Record<string, unknown>) ?? {}}
          resolved={footer?.resolved ?? {}}
          growWithUsEnabled={growWithUsEnabled}
        />
      ) : null}
    </div>
  );
}
