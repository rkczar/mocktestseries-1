import Link from "next/link";
import { Clock, ListChecks, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResolvedHomepage } from "@/lib/homepage-render";
import { str, pairs, stepList } from "./content-helpers";
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
  const primaryCtaHref = str(content, "primaryCtaHref");
  const secondaryCtaText = str(content, "secondaryCtaText");
  const secondaryCtaHref = str(content, "secondaryCtaHref");
  const stats = resolved.statValues ?? [];

  const hasPromoCopy = Boolean(eyebrow || heading || description || primaryCtaText || secondaryCtaText);
  const panel = resolved.heroPanel;
  // Legacy content has no `panel` — without admin opting in (and with no live
  // data to back it) the analytics preview never renders hard-coded numbers.
  const panelVisible =
    panel === undefined || panel.config.enabled === false
      ? false
      : panel.config.mode === "DEMO"
        ? true
        : panel.config.mode === "LIVE"
          ? panel.liveCount > 0
          : false;

  if (!hasPromoCopy && !panelVisible) return null;

  const liveCells =
    panel?.config.mode === "LIVE"
      ? [
          { label: "Questions Answered", value: panel.live.questionsAnswered },
          { label: "Exams", value: panel.live.activeExams },
          { label: "Mock Tests Attempted", value: panel.live.mockTestsAttempted },
          { label: "AI Explanations", value: panel.live.aiExplanations },
        ]
      : [];

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
          {primaryCtaText && primaryCtaHref ? (
            <Button asChild size="lg" variant="primary">
              <Link href={primaryCtaHref}>{primaryCtaText}</Link>
            </Button>
          ) : null}
          {secondaryCtaText && secondaryCtaHref ? (
            <Button asChild size="lg" variant="outline">
              <Link href={secondaryCtaHref}>{secondaryCtaText}</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {panelVisible && panel ? (
        <div className="relative w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-[var(--shadow-card)] sm:p-7">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-4">
            <span className="text-xs font-medium tracking-[0.08em] text-[var(--color-muted-foreground)] uppercase">
              {panel.config.mode === "DEMO" ? "Sample Result Preview" : "Live Performance"}
            </span>
            {panel.config.mode === "DEMO" && panel.config.showBadge ? (
              <Badge variant="warning" className="text-xs">
                {panel.config.badgeLabel || "Preview"}
              </Badge>
            ) : null}
          </div>

          {panel.config.mode === "DEMO" ? (
            <div className="grid grid-cols-2 gap-4 py-5" style={{ fontFamily: "var(--font-mono)" }}>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Score</span>
                <span className="text-3xl tabular-nums text-[var(--color-foreground)]">
                  {panel.config.score || "—"}
                  {panel.config.maxScore ? (
                    <span className="text-base text-[var(--color-muted-foreground)]">/{panel.config.maxScore}</span>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Percentile</span>
                <span className="text-3xl tabular-nums text-[var(--color-foreground)]">{panel.config.percentile || "—"}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Correct</span>
                <span className="text-lg tabular-nums text-[var(--color-success)]">{panel.config.correct || "—"}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">Time Used</span>
                <span className="text-lg tabular-nums text-[var(--color-foreground)]">{panel.config.time || "—"}</span>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 py-5" style={{ fontFamily: "var(--font-mono)" }}>
              {liveCells.map((cell) => (
                <div key={cell.label} className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-[0.04em] text-[var(--color-muted-foreground)]">{cell.label}</span>
                  <span className="text-2xl tabular-nums text-[var(--color-foreground)]">{cell.value}</span>
                </div>
              ))}
            </div>
          )}

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
      ) : null}
    </section>
  );
}

export function FeaturedExamSection({ content, resolved }: SectionProps) {
  const ctaText = str(content, "ctaText", "View Details");
  const ctaHref = str(content, "ctaHref");
  const secondaryCtaText = str(content, "secondaryCtaText");
  const secondaryCtaHref = str(content, "secondaryCtaHref", "/login");
  const aiExplanationEnabled = content.aiExplanationEnabled === true;
  const exam = resolved.exam;
  const examStats = resolved.examStats;

  // No exam selected from Admin → hide. An unselected "featured exam" must not
  // render marketing copy in place of real exam data.
  if (!exam) return null;

  const primaryHref = ctaHref || resolved.examRoute || `/student/exams/${exam.id}`;

  return (
    <section id="featured-exam" className={SECTION_WRAP}>
      <Card className="mx-auto max-w-3xl overflow-hidden p-0">
        <div className="h-1 w-full bg-[var(--color-primary)]" aria-hidden />
        <CardContent className="flex flex-col gap-4 p-8 sm:p-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info" className="w-fit uppercase">
              {exam.name}
            </Badge>
            {aiExplanationEnabled && examStats && examStats.aiExplanations > 0 ? (
              <Badge variant="success" className="w-fit">
                AI Explanations Available
              </Badge>
            ) : null}
          </div>
          <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{exam.name}</h2>
          <p className="text-[var(--color-muted-foreground)]">{exam.description || str(content, "description")}</p>

          {examStats ? (
            <div className="flex flex-wrap gap-4 text-sm text-[var(--color-muted-foreground)]">
              <span>{examStats.mockTests} Mock Tests</span>
              <span>{examStats.previousYearPapers} Previous Year Papers</span>
              <span>{examStats.questionBank} Questions</span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button asChild size="default" variant="primary" className="w-fit">
              <Link href={primaryHref}>{ctaText}</Link>
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

export function MockTestPromotionSection({ content, resolved }: SectionProps) {
  const badge = str(content, "badge");
  const numberMode = str(content, "numberMode", "LIVE");
  const heading = str(content, "heading");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText");
  const ctaHref = str(content, "ctaHref");

  // LIVE counts come from the database. When there are zero published tests,
  // promoting a number is a lie — the whole section hides until real data or
  // an explicit MANUAL number is configured.
  if (numberMode === "LIVE") {
    const count = resolved.liveMockTestCount ?? 0;
    if (count === 0) return null;
  }

  const number = numberMode === "LIVE" ? String(resolved.liveMockTestCount ?? 0) : str(content, "manualNumber");

  if (!badge && !heading && !description && !number && !ctaText) return null;

  return (
    <section className="border-y border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={`${SECTION_WRAP} flex flex-col items-center gap-4 text-center`}>
        {badge ? (
          <Badge variant="warning" className="uppercase">
            {badge}
          </Badge>
        ) : null}
        {number ? (
          <p
            className="text-5xl tabular-nums leading-none text-[var(--color-foreground)] sm:text-6xl"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {number}
          </p>
        ) : null}
        {heading ? <h2 className="text-xl text-[var(--color-foreground)] sm:text-2xl">{heading}</h2> : null}
        {description ? <p className="max-w-xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        {ctaText && ctaHref ? (
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
  const ctaHref = str(content, "ctaHref");
  const papers = resolved.papers ?? [];

  // Only years that actually exist in the database are shown; an empty result
  // hides the section rather than advertising papers that don't exist.
  if (papers.length === 0) return null;

  const fallbackHref = resolved.paperExamId ? `/student/exams/${resolved.paperExamId}` : "/login";

  return (
    <section id="previous-year-papers" className={SECTION_WRAP}>
      <div className="flex flex-col gap-3">
        {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>

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

      {ctaText ? (
        <div className="mt-8">
          <Button asChild variant="outline">
            <Link href={ctaHref || fallbackHref}>{ctaText}</Link>
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
  const ctaText = str(content, "ctaText");
  const ctaHref = str(content, "ctaHref");

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
        {ctaText && ctaHref ? (
          <div className="mt-8">
            <Button asChild variant="outline">
              <Link href={ctaHref}>
                {ctaText} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function BenefitsSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const description = str(content, "description");
  const features = pairs(content, "features");

  return (
    <section className={SECTION_WRAP}>
      <div className="flex flex-col gap-3">
        {heading ? <h2 className="max-w-lg text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>
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
  const steps = stepList(content, "steps");

  return (
    <section className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {steps.length > 0 ? (
          <ol className="mt-8 grid gap-6 sm:grid-cols-2 md:grid-cols-4">
            {steps.map((step, index) => (
              <li key={`${step.title}-${index}`} className="flex flex-col gap-3">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-badge)] border border-[var(--color-primary)]/40 text-sm tabular-nums text-[var(--color-primary)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-[var(--color-foreground)]">{step.title}</span>
                  {step.description ? <span className="text-xs text-[var(--color-muted-foreground)]">{step.description}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

function daysLabel(daysLeft: number): string {
  if (daysLeft < 0) return "Date passed";
  if (daysLeft === 0) return "Today";
  if (daysLeft === 1) return "1 day left";
  return `${daysLeft} days left`;
}

export function UpcomingExamsSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const defaultCtaText = str(content, "ctaText");
  const upcomingExams = (resolved.upcomingExams ?? []).filter((entry) => entry.exam.upcomingDate && (entry.daysLeft ?? 0) >= 0);
  if (upcomingExams.length === 0) return null;

  return (
    <section className={SECTION_WRAP}>
      {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {upcomingExams.map(({ exam, config, daysLeft }) => {
          const description = config.descriptionOverride || exam.description;
          const ctaText = config.ctaText || defaultCtaText;
          const ctaHref =
            config.ctaHref ||
            (exam.publicPageEnabled && exam.publicSlug ? `/exams/${exam.publicSlug}` : `/student/exams/${exam.id}`);
          return (
            <Card key={exam.id} className="flex flex-col gap-2 p-6">
              <p className="font-medium text-[var(--color-foreground)]">{exam.name}</p>
              {description ? <p className="text-sm text-[var(--color-muted-foreground)]">{description}</p> : null}
              {exam.upcomingDate ? (
                <Badge variant="info" className="mt-1 w-fit">
                  {new Date(exam.upcomingDate).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}
                </Badge>
              ) : null}
              {daysLeft !== null ? (
                <Badge variant={daysLeft <= 14 ? "warning" : "success"} className="w-fit">
                  {daysLabel(daysLeft)}
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
  const featuredTests = resolved.featuredTests ?? [];

  if (series.length === 0 && featuredTests.length === 0) return null;

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
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success" className="w-fit">
                    {s.testCount} test{s.testCount === 1 ? "" : "s"}
                  </Badge>
                  <Badge variant="neutral" className="w-fit">
                    {s.exam.name}
                  </Badge>
                </div>
                {ctaText ? (
                  <Button asChild size="sm" variant="primary" className="mt-2 w-fit">
                    <Link href={`/student/test-series`}>{ctaText}</Link>
                  </Button>
                ) : null}
              </Card>
            ))}
          </div>
        ) : null}

        {featuredTests.length > 0 ? (
          <div className="mt-10">
            <h3 className="text-lg font-semibold text-[var(--color-foreground)]">Featured Tests</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              {featuredTests.map((t) => (
                <Card key={t.id} className="flex flex-col gap-2 p-6">
                  <p className="font-medium text-[var(--color-foreground)]">{t.title}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{t.examName}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                    <span className="flex items-center gap-1">
                      <ListChecks className="h-3.5 w-3.5" aria-hidden /> {t.questionCount} Qs
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" aria-hidden /> {t.durationMinutes} min
                    </span>
                    {t.negativeMarking !== 0 ? (
                      <span className="flex items-center gap-1">−{t.negativeMarking} marking</span>
                    ) : null}
                  </div>
                  <Badge variant={t.status === "PUBLISHED" ? "success" : "info"} className="mt-1 w-fit">
                    {t.status === "PUBLISHED" ? "Available" : "Coming soon"}
                  </Badge>
                  <Button asChild size="sm" variant="primary" className="mt-2 w-fit">
                    <Link href={t.route}>Start Test</Link>
                  </Button>
                </Card>
              ))}
            </div>
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
  const buttonHref = str(content, "buttonHref");
  const secondaryButtonText = str(content, "secondaryButtonText");
  const secondaryButtonHref = str(content, "secondaryButtonHref");

  return (
    <section className="border-t border-[var(--color-border)]">
      <div className={`${SECTION_WRAP} text-center`}>
        {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {description ? <p className="mx-auto mt-3 max-w-xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        {(buttonText && buttonHref) || (secondaryButtonText && secondaryButtonHref) ? (
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {buttonText && buttonHref ? (
              <Button asChild size="lg" variant="primary">
                <Link href={buttonHref}>{buttonText}</Link>
              </Button>
            ) : null}
            {secondaryButtonText && secondaryButtonHref ? (
              <Button asChild size="lg" variant="outline">
                <Link href={secondaryButtonHref}>{secondaryButtonText}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}