import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResolvedHomepage } from "@/lib/homepage-render";
import { str, pairs, list } from "./content-helpers";

type SectionProps = {
  content: Record<string, unknown>;
  resolved: ResolvedHomepage["sections"][number]["resolved"];
};

const SECTION_WRAP = "mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20";

export function HeroSection({ content }: SectionProps) {
  const eyebrow = str(content, "eyebrow");
  const heading = str(content, "heading");
  const description = str(content, "description");
  const primaryCtaText = str(content, "primaryCtaText");
  const primaryCtaHref = str(content, "primaryCtaHref", "#");
  const secondaryCtaText = str(content, "secondaryCtaText");
  const secondaryCtaHref = str(content, "secondaryCtaHref", "#");

  return (
    <section className={`${SECTION_WRAP} flex flex-col items-center gap-6 text-center`}>
      {eyebrow ? <Badge variant="primary">{eyebrow}</Badge> : null}
      {heading ? (
        <h1
          className="max-w-3xl text-3xl font-extrabold leading-tight tracking-tight text-[var(--color-foreground)] sm:text-5xl"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {heading}
        </h1>
      ) : null}
      {description ? (
        <p className="max-w-2xl text-base text-[var(--color-muted-foreground)] sm:text-lg">{description}</p>
      ) : null}
      <div className="flex flex-col gap-3 pt-2 sm:flex-row">
        {primaryCtaText ? (
          <Button asChild size="lg" variant="cta">
            <Link href={primaryCtaHref}>{primaryCtaText}</Link>
          </Button>
        ) : null}
        {secondaryCtaText ? (
          <Button asChild size="lg" variant="outline">
            <Link href={secondaryCtaHref}>{secondaryCtaText}</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function FeaturedExamSection({ content, resolved }: SectionProps) {
  const title = str(content, "title", "Featured Exam");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText", "View Details");
  const exam = resolved.exam;

  return (
    <section id="featured-exam" className={SECTION_WRAP}>
      <Card className="mx-auto max-w-3xl p-0">
        <CardContent className="flex flex-col gap-4 p-8 text-center sm:p-10">
          <Badge variant="info" className="mx-auto">
            {exam ? exam.name : title}
          </Badge>
          <h2 className="text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl" style={{ fontFamily: "var(--font-heading)" }}>
            {exam?.name ?? title}
          </h2>
          <p className="text-[var(--color-muted-foreground)]">{exam?.description || description}</p>
          <Button asChild size="default" variant="primary" className="mx-auto">
            <Link href="#test-series">{ctaText}</Link>
          </Button>
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
    <section className={`${SECTION_WRAP} bg-[var(--color-surface)]`}>
      <Card className="flex flex-col items-center gap-4 p-8 text-center sm:p-12">
        {badge ? <Badge variant="warning">{badge}</Badge> : null}
        {numberDisplayed ? (
          <p className="text-5xl font-extrabold text-[var(--color-primary)] sm:text-6xl" style={{ fontFamily: "var(--font-heading)" }}>
            {numberDisplayed}
          </p>
        ) : null}
        {heading ? (
          <h2 className="text-xl font-bold text-[var(--color-foreground)] sm:text-2xl">{heading}</h2>
        ) : null}
        {description ? <p className="max-w-xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        {ctaText ? (
          <Button asChild size="default" variant="cta">
            <Link href={ctaHref}>{ctaText}</Link>
          </Button>
        ) : null}
      </Card>
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
      <div className="flex flex-col items-center gap-3 text-center">
        {heading ? (
          <h2 className="text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl" style={{ fontFamily: "var(--font-heading)" }}>
            {heading}
          </h2>
        ) : null}
        {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>

      {papers.length > 0 ? (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
          {papers.map((paper) => (
            <Card key={paper.id} className="p-4 text-center">
              <p className="text-lg font-bold text-[var(--color-foreground)]">{paper.year}</p>
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{paper.title}</p>
            </Card>
          ))}
        </div>
      ) : null}

      {ctaText ? (
        <div className="mt-8 flex justify-center">
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
    <section className={`${SECTION_WRAP} bg-[var(--color-surface)]`}>
      <div className="flex flex-col items-center gap-3 text-center">
        {heading ? (
          <h2 className="text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl" style={{ fontFamily: "var(--font-heading)" }}>
            {heading}
          </h2>
        ) : null}
        {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>
      {features.length > 0 ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {features.map(([title, desc]) => (
            <Card key={title} className="p-6">
              <p className="font-semibold text-[var(--color-primary)]">{title}</p>
              <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{desc}</p>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function BenefitsSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const features = pairs(content, "features");

  return (
    <section className={SECTION_WRAP}>
      {heading ? (
        <h2
          className="text-center text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {heading}
        </h2>
      ) : null}
      {features.length > 0 ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {features.map(([title, desc]) => (
            <Card key={title} className="p-6">
              <p className="font-semibold text-[var(--color-foreground)]">{title}</p>
              <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{desc}</p>
            </Card>
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
    <section className={`${SECTION_WRAP} bg-[var(--color-surface)]`}>
      {heading ? (
        <h2
          className="text-center text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {heading}
        </h2>
      ) : null}
      {steps.length > 0 ? (
        <ol className="mx-auto mt-8 grid max-w-4xl gap-4 sm:grid-cols-2 md:grid-cols-4">
          {steps.map((step, index) => (
            <li key={step} className="flex flex-col items-center gap-2 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)] text-sm font-bold text-white">
                {index + 1}
              </span>
              <span className="text-sm text-[var(--color-foreground)]">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function UpcomingExamsSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const ctaText = str(content, "ctaText");
  const exams = resolved.exams ?? [];
  if (exams.length === 0) return null;

  return (
    <section className={SECTION_WRAP}>
      {heading ? (
        <h2
          className="text-center text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {heading}
        </h2>
      ) : null}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {exams.map((exam) => (
          <Card key={exam.id} className="flex flex-col gap-2 p-6">
            <p className="font-semibold text-[var(--color-foreground)]">{exam.name}</p>
            {exam.description ? <p className="text-sm text-[var(--color-muted-foreground)]">{exam.description}</p> : null}
            {exam.upcomingDate ? (
              <Badge variant="info" className="mt-1 w-fit">
                {new Date(exam.upcomingDate).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}
              </Badge>
            ) : null}
            {ctaText ? (
              <Link href="#featured-exam" className="mt-2 text-sm font-medium text-[var(--color-primary)] hover:underline">
                {ctaText}
              </Link>
            ) : null}
          </Card>
        ))}
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
    <section id="test-series" className={`${SECTION_WRAP} bg-[var(--color-surface)]`}>
      <div className="flex flex-col items-center gap-3 text-center">
        {heading ? (
          <h2 className="text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl" style={{ fontFamily: "var(--font-heading)" }}>
            {heading}
          </h2>
        ) : null}
        {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>

      {series.length > 0 ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {series.map((s) => (
            <Card key={s.id} className="flex flex-col gap-2 p-6">
              <p className="font-semibold text-[var(--color-foreground)]">{s.name}</p>
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
    </section>
  );
}

export function StatisticsSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const statValues = resolved.statValues ?? [];
  if (statValues.length === 0) return null;

  return (
    <section className={SECTION_WRAP}>
      {heading ? (
        <h2
          className="text-center text-2xl font-bold text-[var(--color-foreground)] sm:text-3xl"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {heading}
        </h2>
      ) : null}
      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {statValues.map((stat) => (
          <div key={stat.label} className="flex flex-col items-center gap-1 text-center">
            <p className="text-3xl font-extrabold text-[var(--color-primary)] sm:text-4xl" style={{ fontFamily: "var(--font-heading)" }}>
              {stat.value}
            </p>
            <p className="text-sm text-[var(--color-muted-foreground)]">{stat.label}</p>
          </div>
        ))}
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
    <section className={`${SECTION_WRAP} bg-[var(--color-primary)] text-center`}>
      {heading ? (
        <h2 className="text-2xl font-bold text-white sm:text-3xl" style={{ fontFamily: "var(--font-heading)" }}>
          {heading}
        </h2>
      ) : null}
      {description ? <p className="mx-auto mt-3 max-w-xl text-white/90">{description}</p> : null}
      {buttonText ? (
        <Button asChild size="lg" variant="cta" className="mt-6">
          <Link href={buttonHref}>{buttonText}</Link>
        </Button>
      ) : null}
    </section>
  );
}
