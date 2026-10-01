import Link from "next/link";
import { Clock, ListChecks, ArrowRight, CheckCircle2, CalendarDays } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResolvedHomepage, ResolvedExamSummary } from "@/lib/homepage-render";
import { displayExamName, formatExamDate } from "@/lib/exam-display";
import { str, pairs, stepList } from "./content-helpers";
import { getStatIcon } from "@/lib/homepage-icons";
import { OfferPrice } from "@/components/public-exam/mock-series-promo";
import { isSafeInternalRoute } from "@/lib/safe-route";
import { StatCountUp } from "./stat-count-up";

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
  // Blank link = the visitor-aware free route (sign-up, or the dashboard when signed in).
  const primaryCtaHref = str(content, "primaryCtaHref") || resolved.startFreeHref || "";
  const secondaryCtaText = str(content, "secondaryCtaText");
  const secondaryCtaHref = str(content, "secondaryCtaHref");
  const trustLine = str(content, "trustLine");
  const stats = resolved.statValues ?? [];
  const exam = resolved.examSummary ?? null;

  const hasPromoCopy = Boolean(eyebrow || heading || description || primaryCtaText || secondaryCtaText);
  const panel = resolved.heroPanel;
  // Legacy content has no `panel` — without admin opting in (and with no live
  // data to back it) the analytics preview never renders hard-coded numbers.
  // The featured exam card, when shown, takes the panel's place.
  const panelVisible =
    exam || panel === undefined || panel.config.enabled === false
      ? false
      : panel.config.mode === "DEMO"
        ? true
        : panel.config.mode === "LIVE"
          ? panel.liveCount > 0
          : false;

  if (!hasPromoCopy && !panelVisible && !exam) return null;

  const liveCells =
    panel?.config.mode === "LIVE"
      ? [
          { label: "Questions Answered", value: panel.live.questionsAnswered },
          { label: "Exams", value: panel.live.activeExams },
          { label: "Mock Tests Attempted", value: panel.live.mockTestsAttempted },
          { label: "AI Explanations", value: panel.live.aiExplanations },
        ]
      : [];
  const sideVisible = Boolean(exam) || panelVisible;

  return (
    <section
      className={`mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pt-10 pb-12 sm:px-6 sm:pt-14 sm:pb-16 lg:gap-14 lg:pt-20 lg:pb-20 ${sideVisible ? "lg:grid-cols-[1.15fr_0.85fr]" : ""}`}
    >
      <div className="flex flex-col items-start gap-5 text-left sm:gap-6">
        {eyebrow ? (
          <Badge variant="primary" className="max-w-full whitespace-normal">
            {eyebrow}
          </Badge>
        ) : null}
        {heading ? (
          <h1 className="max-w-2xl text-2xl leading-[1.08] tracking-[-0.02em] text-[var(--color-foreground)] sm:text-3xl lg:text-4xl">
            {heading}
          </h1>
        ) : null}
        {description ? (
          <p className="max-w-xl text-base leading-relaxed text-[var(--color-muted-foreground)] sm:text-lg">{description}</p>
        ) : null}
        <div className="flex w-full flex-col gap-3 pt-1 sm:w-auto sm:flex-row">
          {primaryCtaText && primaryCtaHref ? (
            <Button asChild size="lg" variant="primary" className="w-full sm:w-auto">
              <Link href={primaryCtaHref}>
                {primaryCtaText} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          ) : null}
          {secondaryCtaText && secondaryCtaHref ? (
            <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
              <Link href={secondaryCtaHref}>{secondaryCtaText}</Link>
            </Button>
          ) : null}
        </div>
        {trustLine ? (
          <p className="flex items-start gap-2 text-sm text-[var(--color-muted-foreground)]">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
            {trustLine}
          </p>
        ) : null}
      </div>

      {exam ? <HeroExamCard exam={exam} /> : null}

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
                <span className="text-xs tracking-[0.04em] text-[var(--color-muted-foreground)]">Score</span>
                <span className="text-3xl tabular-nums text-[var(--color-foreground)]">
                  {panel.config.score || "—"}
                  {panel.config.maxScore ? (
                    <span className="text-base text-[var(--color-muted-foreground)]">/{panel.config.maxScore}</span>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs tracking-[0.04em] text-[var(--color-muted-foreground)]">Percentile</span>
                <span className="text-3xl tabular-nums text-[var(--color-foreground)]">{panel.config.percentile || "—"}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs tracking-[0.04em] text-[var(--color-muted-foreground)]">Correct</span>
                <span className="text-lg tabular-nums text-[var(--color-success)]">{panel.config.correct || "—"}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs tracking-[0.04em] text-[var(--color-muted-foreground)]">Time Used</span>
                <span className="text-lg tabular-nums text-[var(--color-foreground)]">{panel.config.time || "—"}</span>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 py-5" style={{ fontFamily: "var(--font-mono)" }}>
              {liveCells.map((cell) => (
                <div key={cell.label} className="flex flex-col gap-1">
                  <span className="text-xs tracking-[0.04em] text-[var(--color-muted-foreground)]">{cell.label}</span>
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

/** Real facts about the featured exam — date, mocks, papers, questions — beside the hero copy. */
function HeroExamCard({ exam }: { exam: ResolvedExamSummary }) {
  const name = displayExamName(exam.name);
  const facts = [
    exam.plannedMocks > 0 ? { value: exam.plannedMocks, label: "Mock tests planned", note: exam.freeMocks > 0 ? `${exam.freeMocks} free` : null } : null,
    exam.papers > 0 ? { value: exam.papers, label: "Previous year papers", note: `${exam.paperYears} years` } : null,
    exam.questions > 0 ? { value: exam.questions, label: "Practice questions", note: null } : null,
    exam.subjects > 0 ? { value: exam.subjects, label: "Subjects covered", note: null } : null,
  ].filter((f): f is { value: number; label: string; note: string | null } => f !== null);

  return (
    <aside
      aria-label={`${name} at a glance`}
      className="w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]"
    >
      <div className="flex flex-col gap-1 border-b border-[var(--color-border)] p-5 sm:p-6">
        <p className="text-xs font-medium tracking-[0.08em] text-[var(--color-muted-foreground)] uppercase">Now preparing</p>
        <p className="text-lg font-semibold text-[var(--color-foreground)]">{name}</p>
        {exam.examDate ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-muted-foreground)]">
            <CalendarDays className="h-4 w-4" aria-hidden />
            Exam date {formatExamDate(exam.examDate)}
            {exam.daysLeft !== null ? (
              <Badge variant={exam.daysLeft <= 14 ? "warning" : "neutral"}>{daysLabel(exam.daysLeft)}</Badge>
            ) : null}
          </p>
        ) : null}
      </div>
      {facts.length > 0 ? (
        <dl className="grid grid-cols-2">
          {facts.map((f, i) => (
            <div
              key={f.label}
              className={`flex flex-col gap-1 p-5 sm:p-6 ${i % 2 === 1 ? "border-l border-[var(--color-border)]" : ""} ${i >= 2 ? "border-t border-[var(--color-border)]" : ""}`}
            >
              <dt className="order-2 text-xs text-[var(--color-muted-foreground)]">
                {f.label}
                {f.note ? <span className="text-[var(--color-foreground)]"> · {f.note}</span> : null}
              </dt>
              <dd className="order-1 text-2xl leading-none tabular-nums text-[var(--color-foreground)]" style={{ fontFamily: "var(--font-mono)" }}>
                {f.value.toLocaleString("en-IN")}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {exam.hubHref ? (
        <Link
          href={exam.hubHref}
          className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-5 py-4 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)] sm:px-6"
        >
          {name} exam details
          <ArrowRight className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
        </Link>
      ) : null}
    </aside>
  );
}

export function FeaturedExamSection({ content, resolved }: SectionProps) {
  const ctaText = str(content, "ctaText", "View Details");
  const ctaHref = str(content, "ctaHref");
  const secondaryCtaText = str(content, "secondaryCtaText");
  const secondaryCtaHref = str(content, "secondaryCtaHref", "/login");
  const aiExplanationEnabled = content.aiExplanationEnabled === true;
  const showDeepLinks = content.showDeepLinks !== false;
  const exam = resolved.exam;
  const examStats = resolved.examStats;
  const summary = resolved.examSummary ?? null;

  // No exam selected from Admin → hide. An unselected "featured exam" must not
  // render marketing copy in place of real exam data.
  if (!exam) return null;

  const primaryHref = ctaHref || resolved.examRoute || `/student/exams/${exam.id}`;
  const heading = str(content, "heading") || displayExamName(exam.name);
  const description = str(content, "description") || exam.shortDescription || exam.description || "";
  const links = showDeepLinks ? (summary?.links ?? []) : [];
  const facts = summary
    ? [
        summary.examDate ? { label: "Exam date", value: formatExamDate(summary.examDate) } : null,
        summary.plannedMocks > 0 ? { label: "Mock tests", value: `${summary.plannedMocks} planned · ${summary.availableMocks} open` } : null,
        summary.papers > 0 ? { label: "Previous year papers", value: `${summary.papers} papers · ${summary.paperYears} years` } : null,
        summary.questions > 0 ? { label: "Questions", value: summary.questions.toLocaleString("en-IN") } : null,
      ].filter((f): f is { label: string; value: string } => f !== null)
    : [];

  return (
    <section id="featured-exam" className="scroll-mt-20 border-t border-[var(--color-border)]">
      <div className={`${SECTION_WRAP} grid gap-10 ${links.length > 0 ? "lg:grid-cols-[1.1fr_0.9fr] lg:gap-14" : ""}`}>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">Current exam</Badge>
            {aiExplanationEnabled && examStats && examStats.aiExplanations > 0 ? <Badge variant="neutral">AI explanations available</Badge> : null}
          </div>
          <h2 className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">{heading}</h2>
          {description ? <p className="max-w-xl leading-relaxed text-[var(--color-muted-foreground)]">{description}</p> : null}

          {facts.length > 0 ? (
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 border-t border-[var(--color-border)] pt-5 sm:grid-cols-2">
              {facts.map((f) => (
                <div key={f.label} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-[var(--color-muted-foreground)]">{f.label}</dt>
                  <dd className="text-sm font-medium tabular-nums text-[var(--color-foreground)]">{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button asChild size="default" variant="primary" className="w-full sm:w-fit">
              <Link href={primaryHref}>{ctaText}</Link>
            </Button>
            {secondaryCtaText ? (
              <Button asChild size="default" variant="outline" className="w-full sm:w-fit">
                <Link href={secondaryCtaHref}>{secondaryCtaText}</Link>
              </Button>
            ) : null}
          </div>
        </div>

        {links.length > 0 ? (
          <nav aria-label={`${heading} pages`} className="flex flex-col">
            <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Explore {heading}</h3>
            <ul className="mt-3 divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]">
              {links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    className="group flex min-h-11 items-center justify-between gap-3 px-4 py-3 transition-colors first:rounded-t-[var(--radius-card)] last:rounded-b-[var(--radius-card)] hover:bg-[var(--color-surface)]"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-[var(--color-foreground)]">{l.label}</span>
                      <span className="text-xs text-[var(--color-muted-foreground)]">{l.description}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)] transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </section>
  );
}

export function MockTestPromotionSection({ content, resolved }: SectionProps) {
  const badge = str(content, "badge");
  const eyebrow = str(content, "eyebrow");
  // "" (never set in the editor) means the default, LIVE.
  const numberMode = str(content, "numberMode") || "LIVE";
  const heading = str(content, "heading");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText");
  const ctaHref = str(content, "ctaHref");
  const compareText = str(content, "compareText");
  const series = resolved.mockSeries;
  const offer = resolved.offer ?? null;

  // A published canonical Mock Test Series drives this section with REAL
  // data: planned vs available counts, the Product's server-computed price,
  // the visitor-aware CTA, and the canonical landing page — so the homepage
  // offer can never drift from the Exam Hub / series page / checkout.
  if (series?.mockSeries && series.href) {
    const s = series.mockSeries;
    const cta = offer?.cta ?? null;
    const owned = cta?.kind === "OPEN" && Boolean(series.offer?.showPrice);
    // Admin text overrides the purchase label only — never "buy" for owned access.
    const buttonLabel = cta && (cta.kind === "BUY" || cta.kind === "LOGIN_TO_BUY") && ctaText ? ctaText : (cta?.label ?? "View Mock Test Series");
    const buttonHref = cta?.href ?? series.href;
    const benefits = (offer?.benefits ?? []).slice(0, 5);
    return (
      <section id="complete-access" className="scroll-mt-20 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className={SECTION_WRAP}>
          <div className="grid overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)] lg:grid-cols-[1.25fr_0.75fr]">
            <div className="flex flex-col gap-5 p-6 sm:p-8 lg:p-10">
              <div className="flex flex-wrap items-center gap-2">
                {eyebrow ? <span className="text-xs font-medium tracking-[0.08em] text-[var(--color-muted-foreground)] uppercase">{eyebrow}</span> : null}
                {badge ? <Badge variant="warning">{badge}</Badge> : null}
              </div>
              <h2 className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">{heading || s.series.name}</h2>
              {description ? <p className="max-w-xl leading-relaxed text-[var(--color-muted-foreground)]">{description}</p> : null}
              <p className="text-sm text-[var(--color-muted-foreground)]">
                <span className="font-semibold tabular-nums text-[var(--color-foreground)]">{s.planned || s.published}</span>{" "}
                {s.planned > 0 ? "mock tests planned" : "mock tests"} ·{" "}
                <span className="font-semibold tabular-nums text-[var(--color-foreground)]">{s.available}</span> available now
                {s.upcoming > 0 ? <> · {s.upcoming} scheduled</> : null}
              </p>
              {benefits.length > 0 ? (
                <ul className="grid gap-3 border-t border-[var(--color-border)] pt-5 sm:grid-cols-2">
                  {benefits.map((b) => (
                    <li key={b.key} className="flex gap-2.5 text-sm">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                      <span className="flex flex-col">
                        <span className="font-medium text-[var(--color-foreground)]">{b.feature}</span>
                        <span className="text-[var(--color-muted-foreground)]">{b.paid.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="flex flex-col justify-center gap-4 border-t border-[var(--color-border)] p-6 sm:p-8 lg:border-t-0 lg:border-l lg:p-10">
              {owned ? (
                <Badge variant="success" className="w-fit">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> You have Complete Access
                </Badge>
              ) : null}
              <OfferPrice offer={series.offer} size="lg" />
              {offer?.accessDuration && series.offer?.showPrice ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">{offer.accessDuration} · everything in Free included</p>
              ) : null}
              {buttonHref ? (
                <Button asChild size="lg" variant="primary" className="w-full">
                  <Link href={buttonHref}>{buttonLabel}</Link>
                </Button>
              ) : (
                <p className="text-sm text-[var(--color-muted-foreground)]">{cta?.label ?? "Purchases are paused right now."}</p>
              )}
              {compareText && offer?.compareHref ? (
                <Link href={offer.compareHref} className="text-center text-sm font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
                  {compareText}
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    );
  }

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
    <section className="border-t border-[var(--color-border)]">
      <div className={SECTION_WRAP}>
        <div className="flex max-w-2xl flex-col gap-3">
          {heading ? <h2 className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
          {description ? <p className="leading-relaxed text-[var(--color-muted-foreground)]">{description}</p> : null}
        </div>
        {features.length > 0 ? (
          <ul className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
            {features.map(([title, desc]) => (
              <li key={title} className="flex flex-col gap-2 bg-[var(--color-card)] p-5 sm:p-6">
                <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--color-foreground)]">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
                  {title}
                </h3>
                {desc ? <p className="text-sm leading-relaxed text-[var(--color-muted-foreground)]">{desc}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function HowItWorksSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const steps = stepList(content, "steps");

  return (
    <section id="how-it-works" className="scroll-mt-20 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        {heading ? <h2 className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {steps.length > 0 ? (
          <ol className={`mt-10 grid gap-6 sm:grid-cols-2 ${steps.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
            {steps.map((step, index) => (
              <li key={`${step.title}-${index}`} className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
                <span className="text-sm tabular-nums text-[var(--color-muted-foreground)]" style={{ fontFamily: "var(--font-mono)" }} aria-hidden>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-base font-semibold text-[var(--color-foreground)]">{step.title}</h3>
                  {step.description ? <p className="text-sm leading-relaxed text-[var(--color-muted-foreground)]">{step.description}</p> : null}
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
  const canonical = resolved.mockSeries?.mockSeries && resolved.mockSeries.href ? resolved.mockSeries : null;
  // The canonical series is shown unless the admin explicitly picked it.
  const showCanonical = canonical && !series.some((s) => s.id === canonical.mockSeries!.series.id);

  if (series.length === 0 && featuredTests.length === 0 && !showCanonical) return null;

  return (
    <section id="test-series" className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        <div className="flex flex-col gap-3">
          {heading ? <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
          {description ? <p className="max-w-2xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        </div>

        {showCanonical ? (
          <Card className="mt-8 flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-2">
              <p className="font-medium text-[var(--color-foreground)]">{canonical!.mockSeries!.series.name}</p>
              <div className="flex flex-wrap items-center gap-2">
                {canonical!.mockSeries!.planned > 0 ? <Badge variant="neutral">{canonical!.mockSeries!.planned} planned</Badge> : null}
                <Badge variant="success">{canonical!.mockSeries!.available} available now</Badge>
                <Badge variant="neutral">{canonical!.examName}</Badge>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <OfferPrice offer={canonical!.offer} />
              <Button asChild size="sm" variant="primary" className="w-fit">
                <Link href={canonical!.href!}>{ctaText || "View Mock Test Series"}</Link>
              </Button>
            </div>
          </Card>
        ) : null}

        {series.length > 0 ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {series.map((s) => (
              <Card key={s.id} className="flex flex-col gap-2 p-6">
                <p className="font-medium text-[var(--color-foreground)]">{s.name}</p>
                {s.description ? <p className="text-sm text-[var(--color-muted-foreground)]">{s.description}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success" className="w-fit">
                    {s.testCount} planned
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

/** Columns follow the card count: 4 cards are 2 × 2 on phones/tablets and one row on desktop. */
function statGridColumns(count: number): string {
  if (count <= 1) return "grid-cols-1 mx-auto max-w-sm";
  if (count === 2) return "grid-cols-2 mx-auto max-w-3xl";
  if (count === 3) return "grid-cols-1 sm:grid-cols-3";
  if (count === 4) return "grid-cols-2 lg:grid-cols-4";
  return "grid-cols-2 sm:grid-cols-3";
}

export function StatisticsSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const subheading = str(content, "subheading");
  const showModeBadge = content.showModeBadge === true;
  const surface = content.background === "SURFACE";
  const statValues = resolved.statValues ?? [];
  if (statValues.length === 0) return null;

  return (
    <section
      id="platform-stats"
      aria-label={heading || "Platform statistics"}
      className={surface ? "border-y border-[var(--color-border)] bg-[var(--color-surface)]" : undefined}
    >
      <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${heading || subheading ? "py-14 sm:py-20" : "pb-12 sm:pb-16"}`}>
        {heading || subheading ? (
          <div className="mx-auto max-w-2xl text-center">
            {heading ? <h2 className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
            {subheading ? <p className="mt-3 text-[var(--color-muted-foreground)]">{subheading}</p> : null}
          </div>
        ) : null}
        <div className={`${heading || subheading ? "mt-10" : ""} grid gap-3 sm:gap-4 ${statGridColumns(statValues.length)}`}>
          {statValues.map((stat, index) => {
            const Icon = getStatIcon(stat.icon);
            const card = (
              <Card className="flex h-full flex-col gap-3 p-4 transition-colors sm:gap-4 sm:p-6">
                <div className="flex w-full items-start justify-between gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)] sm:h-10 sm:w-10">
                    <Icon className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden />
                  </span>
                  {stat.badge || showModeBadge ? (
                    <div className="hidden items-center gap-1.5 sm:flex">
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
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <p
                    className="text-2xl leading-none tabular-nums tracking-[-0.02em] text-[var(--color-foreground)] sm:text-3xl"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {stat.numeric !== undefined && stat.format ? (
                      <StatCountUp value={stat.numeric} format={stat.format} suffix={stat.suffix} />
                    ) : (
                      stat.value
                    )}
                  </p>
                  <p className="text-xs font-medium text-[var(--color-muted-foreground)] sm:text-sm">{stat.label}</p>
                  {stat.description ? <p className="text-xs text-[var(--color-muted-foreground)]">{stat.description}</p> : null}
                </div>
              </Card>
            );
            const key = `${index}-${stat.label}`;
            return stat.link && isSafeInternalRoute(stat.link) ? (
              <Link key={key} href={stat.link} className="block rounded-[var(--radius-card)] hover:[&>div]:border-[var(--color-primary)]">
                {card}
              </Link>
            ) : (
              <div key={key}>{card}</div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function CtaSection({ content, resolved }: SectionProps) {
  const heading = str(content, "heading");
  const description = str(content, "description");
  const buttonText = str(content, "buttonText");
  // Blank link = the visitor-aware free route.
  const buttonHref = str(content, "buttonHref") || resolved.startFreeHref || "";
  const secondaryButtonText = str(content, "secondaryButtonText");
  const secondaryButtonHref = str(content, "secondaryButtonHref");

  return (
    <section className="border-t border-[var(--color-border)]">
      <div className={`${SECTION_WRAP} text-center`}>
        {heading ? <h2 className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">{heading}</h2> : null}
        {description ? <p className="mx-auto mt-3 max-w-xl text-[var(--color-muted-foreground)]">{description}</p> : null}
        {(buttonText && buttonHref) || (secondaryButtonText && secondaryButtonHref) ? (
          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
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

