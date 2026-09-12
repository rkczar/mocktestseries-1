import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResolvedHomepage } from "@/lib/homepage-render";
import { str, pairs, list } from "./content-helpers";
import { getStatIcon } from "@/lib/homepage-icons";

type SectionProps = {
  content: Record<string, unknown>;
  resolved: ResolvedHomepage["sections"][number]["resolved"];
};

const SECTION_WRAP = "mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20";

export function HeroSection({ content, resolved }: SectionProps) {
  const eyebrow = str(content, "eyebrow");
  const heading = str(content, "heading");
  const description = str(content, "description");
  const primaryCtaText = str(content, "primaryCtaText");
  const primaryCtaHref = str(content, "primaryCtaHref", "#");
  const secondaryCtaText = str(content, "secondaryCtaText");
  const secondaryCtaHref = str(content, "secondaryCtaHref", "#");
  const stats = resolved.statValues ?? [];

  return (
    <section className={`${SECTION_WRAP} grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16`}>
      <div className="flex flex-col items-start gap-6 text-left">
        {eyebrow ? (
          <Badge variant="primary" className="uppercase">
            {eyebrow}
          </Badge>
        ) : null}
        {heading ? (
          <h1 className="max-w-xl text-4xl leading-[1.05] tracking-[-0.02em] text-[var(--color-foreground)] sm:text-5xl">
            {heading}
          </h1>
        ) : null}
        {description ? (
          <p className="max-w-lg text-base leading-relaxed text-[var(--color-muted-foreground)] sm:text-lg">
            {description}
          </p>
        ) : null}
        <div className="flex flex-col gap-3 pt-2 sm:flex-row">
          {primaryCtaText ? (
            <Button asChild size="lg" variant="primary">
              <Link href={primaryCtaHref}>{primaryCtaText}</Link>
            </Button>
          ) : null}
          {secondaryCtaText ? (
            <Button asChild size="lg" variant="outline">
              <Link href={secondaryCtaHref}>{secondaryCtaText}</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Code-native "scorecard" panel — the product's own readout, standing in for */}
      {/* the embedded product-mockup panel of the reference style.                  */}
      <div className="relative w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-[var(--shadow-card)] sm:p-7">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-4">
          <span className="text-xs font-medium tracking-[0.08em] text-[var(--color-muted-foreground)] uppercase">
            Result Scorecard
          </span>
          <span className="flex h-2 w-2 rounded-full bg-[var(--color-success)]" aria-hidden />
        </div>
        <div className="grid grid-cols-2 gap-4 py-5" style={{ fontFamily: "var(--font-mono)" }}>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Score</span>
            <span className="text-3xl tabular-nums text-[var(--color-foreground)]">184<span className="text-base text-[var(--color-muted-foreground)]">/200</span></span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Percentile</span>
            <span className="text-3xl tabular-nums text-[var(--color-foreground)]">96.4</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Correct</span>
            <span className="text-lg tabular-nums text-[var(--color-success)]">168</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Time Used</span>
            <span className="text-lg tabular-nums text-[var(--color-foreground)]">02:46:12</span>
          </div>
        </div>
        {stats.length > 0 ? (
          <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-[var(--color-border)] pt-4">
            {stats.slice(0, 3).map((stat) => (
              <div key={stat.label} className="flex items-baseline gap-1.5">
                <span className="text-sm tabular-nums text-[var(--color-foreground)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {stat.value}
                </span>
                <span className="text-xs text-[var(--color-muted-foreground)]">{stat.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function FeaturedExamSection({ content, resolved }: SectionProps) {
  const title = str(content, "title", "Featured Exam");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText", "View Details");
  const secondaryCtaText = str(content, "secondaryCtaText");
  const secondaryCtaHref = str(content, "secondaryCtaHref", "#previous-year-papers");
  const aiExplanationEnabled = content.aiExplanationEnabled === true;
  const exam = resolved.exam;
  const examStats = resolved.examStats;

  return (
    <section id="featured-exam" className={SECTION_WRAP}>
      <Card className="mx-auto max-w-3xl overflow-hidden p-0">
        <div className="h-1 w-full bg-[var(--color-primary)]" aria-hidden />
        <CardContent className="flex flex-col gap-4 p-8 sm:p-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info" className="w-fit uppercase">
              {exam ? exam.name : title}
            </Badge>
            {aiExplanationEnabled && examStats && examStats.aiExplanations > 0 ? (
              <Badge variant="success" className="w-fit">
                AI Explanations Available
              </Badge>
            ) : null}
          </div>
          <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{exam?.name ?? title}</h2>
          <p className="text-[var(--color-muted-foreground)]">{exam?.description || description}</p>

          {examStats ? (
            <div className="flex flex-wrap gap-4 text-sm text-[var(--color-muted-foreground)]">
              <span>{examStats.mockTests} Mock Tests</span>
              <span>{examStats.previousYearPapers} Previous Year Papers</span>
              <span>{examStats.questionBank} Questions</span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button asChild size="default" variant="primary" className="w-fit">
              <Link href="#test-series">{ctaText}</Link>
            </Button>
            {secondaryCtaText ? (
              <Button asChild size="default" variant="outline" className="w-fit">
                <Link href={secondaryCtaHref}>{secondaryCtaText}</Link>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

export function MockTestPromotionSection({ content }: SectionProps) {
  const badge = str(content, "badge");
  const numberDisplayed = str(content, "numberDisplayed");
  const heading = str(content, "heading");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText");
  const ctaHref = str(content, "ctaHref", "#test-series");

  return (
    <section className="border-y border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={`${SECTION_WRAP} flex flex-col items-center gap-4 text-center`}>
        {badge ? (
          <Badge variant="warning" className="uppercase">
            {badge}
          </Badge>
        ) : null}
        {numberDisplayed ? (
          <p
            className="text-5xl tabular-nums leading-none text-[var(--color-foreground)] sm:text-6xl"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {numberDisplayed}
          </p>
        ) : null}
        {heading ? <h2 className="text-xl text-[var(--color-foreground)] sm:text-2xl">{heading}</h2> : null}
        {description ? <p className="max-w-xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        {ctaText ? (
          <Button asChild size="default" variant="primary">
            <Link href={ctaHref}>{ctaText}</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function PreviousYearPapersSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText");
  const ctaHref = str(content, "ctaHref", "#");
  const papers = resolved.papers ?? [];

  return (
    <section id="previous-year-papers" className={SECTION_WRAP}>
      <div className="flex flex-col gap-3">
        {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>

      {papers.length > 0 ? (
        <div className="mt-8 grid grid-cols-2 border-t border-l border-[var(--color-border)] sm:grid-cols-3 md:grid-cols-5">
          {papers.map((paper) => (
            <div
              key={paper.id}
              className="flex flex-col gap-1 border-r border-b border-[var(--color-border)] p-4 text-center"
            >
              <p className="text-lg tabular-nums text-[var(--color-foreground)]" style={{ fontFamily: "var(--font-mono)" }}>
                {paper.year}
              </p>
              <p className="text-xs text-[var(--color-muted-foreground)]">{paper.title}</p>
            </div>
          ))}
        </div>
      ) : null}

      {ctaText ? (
        <div className="mt-8">
          <Button asChild variant="outline">
            <Link href={ctaHref}>{ctaText}</Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function AiUspSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const description = str(content, "description");
  const features = pairs(content, "features");

  return (
    <section className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        <div className="flex flex-col gap-3">
          {heading ? <h2 className="max-w-lg text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
          {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        </div>
        {features.length > 0 ? (
          <div className="mt-8 grid gap-x-8 gap-y-6 border-t border-[var(--color-border)] pt-6 sm:grid-cols-2">
            {features.map(([title, desc]) => (
              <div key={title} className="flex gap-3">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" aria-hidden />
                <div>
                  <p className="font-medium text-[var(--color-foreground)]">{title}</p>
                  <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function BenefitsSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const features = pairs(content, "features");

  return (
    <section className={SECTION_WRAP}>
      {heading ? <h2 className="max-w-lg text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
      {features.length > 0 ? (
        <div className="mt-8 grid gap-x-8 gap-y-6 border-t border-[var(--color-border)] pt-6 sm:grid-cols-3">
          {features.map(([title, desc]) => (
            <div key={title} className="flex flex-col gap-1.5">
              <p className="font-medium text-[var(--color-foreground)]">{title}</p>
              <p className="text-sm text-[var(--color-muted-foreground)]">{desc}</p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function HowItWorksSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const steps = list(content, "steps");

  return (
    <section className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {steps.length > 0 ? (
          <ol className="mt-8 grid gap-6 sm:grid-cols-2 md:grid-cols-4">
            {steps.map((step, index) => (
              <li key={step} className="flex flex-col gap-3">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-badge)] border border-[var(--color-primary)]/40 text-sm tabular-nums text-[var(--color-primary)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-sm text-[var(--color-foreground)]">{step}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

export function UpcomingExamsSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const defaultCtaText = str(content, "ctaText");
  const upcomingExams = resolved.upcomingExams ?? [];
  if (upcomingExams.length === 0) return null;

  return (
    <section className={SECTION_WRAP}>
      {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {upcomingExams.map(({ exam, config }) => {
          const description = config.descriptionOverride || exam.description;
          const ctaText = config.ctaText || defaultCtaText;
          const ctaHref = config.ctaHref || "#featured-exam";
          return (
            <Card key={exam.id} className="flex flex-col gap-2 p-6">
              <p className="font-medium text-[var(--color-foreground)]">{exam.name}</p>
              {description ? <p className="text-sm text-[var(--color-muted-foreground)]">{description}</p> : null}
              {exam.upcomingDate ? (
                <Badge variant="info" className="mt-1 w-fit">
                  {new Date(exam.upcomingDate).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}
                </Badge>
              ) : null}
              {ctaText ? (
                <Link href={ctaHref} className="mt-2 text-sm font-medium text-[var(--color-primary)] hover:underline">
                  {ctaText}
                </Link>
              ) : null}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

export function TestSeriesSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText");
  const series = resolved.testSeries ?? [];

  return (
    <section id="test-series" className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        <div className="flex flex-col gap-3">
          {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
          {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        </div>

        {series.length > 0 ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {series.map((s) => (
              <Card key={s.id} className="flex flex-col gap-2 p-6">
                <p className="font-medium text-[var(--color-foreground)]">{s.name}</p>
                {s.description ? <p className="text-sm text-[var(--color-muted-foreground)]">{s.description}</p> : null}
                <Badge variant="success" className="mt-1 w-fit">
                  {s.testCount} test{s.testCount === 1 ? "" : "s"}
                </Badge>
                {ctaText ? (
                  <Button asChild size="sm" variant="primary" className="mt-2 w-fit">
                    <Link href="#featured-exam">{ctaText}</Link>
                  </Button>
                ) : null}
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

const STAT_MODE_BADGE_VARIANT = { LIVE: "success", DEMO: "warning", MANUAL: "info" } as const;

export function StatisticsSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const showModeBadge = content.showModeBadge === true;
  const statValues = resolved.statValues ?? [];
  if (statValues.length === 0) return null;

  return (
    <section className={SECTION_WRAP}>
      {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {statValues.map((stat) => {
          const Icon = getStatIcon(stat.icon);
          const card = (
            <Card className="flex h-full flex-col gap-2 p-6 transition-shadow hover:shadow-md">
              <div className="flex items-center justify-between">
                <Icon className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
                <div className="flex items-center gap-1.5">
                  {stat.badge ? (
                    <Badge variant="warning" className="text-xs">
                      {stat.badge}
                    </Badge>
                  ) : null}
                  {showModeBadge ? (
                    <Badge variant={STAT_MODE_BADGE_VARIANT[stat.mode]} className="text-xs">
                      {stat.mode}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <p
                className="text-3xl tabular-nums text-[var(--color-foreground)] sm:text-4xl"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {stat.value}
              </p>
              <p className="text-sm font-medium text-[var(--color-foreground)]">{stat.label}</p>
              {stat.description ? <p className="text-xs text-[var(--color-muted-foreground)]">{stat.description}</p> : null}
            </Card>
          );
          return stat.link ? (
            <Link key={stat.label} href={stat.link} className="block">
              {card}
            </Link>
          ) : (
            <div key={stat.label}>{card}</div>
          );
        })}
      </div>
    </section>
  );
}

export function CtaSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const description = str(content, "description");
  const buttonText = str(content, "buttonText");
  const buttonHref = str(content, "buttonHref", "#");

  return (
    <section className="border-t border-[var(--color-border)]">
      <div className={`${SECTION_WRAP} text-center`}>
        {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {description ? <p className="mx-auto mt-3 max-w-xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        {buttonText ? (
          <Button asChild size="lg" variant="primary" className="mt-6">
            <Link href={buttonHref}>{buttonText}</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
