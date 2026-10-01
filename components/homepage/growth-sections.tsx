import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ResolvedHomepage } from "@/lib/homepage-render";
import { str, pairs } from "./content-helpers";

type SectionProps = {
  content: Record<string, unknown>;
  resolved: ResolvedHomepage["sections"][number]["resolved"];
};

const SECTION_WRAP = "mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20";

/**
 * "Free" marker. Semantic colors fail contrast as small text in Day mode
 * (docs/DESIGN-SYSTEM.md §12.4), so the tint carries the color and the word
 * stays in foreground ink — readable in every theme, including Eye-Saver.
 */
export function FreeBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-badge)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-[var(--color-foreground)] ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" aria-hidden />
      FREE
    </span>
  );
}

/**
 * Start for Free — every card comes from lib/homepage-render.ts
 * buildFreeCards, i.e. from the live access engine; nothing here can
 * advertise a paid resource as free. Hidden when nothing is free.
 */
export function FreeStartSection({ content, resolved }: SectionProps) {
  const showFreeBadge = content.showFreeBadge !== false;
  const heading = str(content, "heading");
  const description = str(content, "description");
  const ctaText = str(content, "ctaText");
  const ctaHref = str(content, "ctaHref") || resolved.startFreeHref || "";
  const note = str(content, "note");
  const cards = resolved.freeCards ?? [];
  if (cards.length === 0) return null;

  return (
    <section id="start-free" aria-labelledby="start-free-heading" className="scroll-mt-20 border-t border-[var(--color-border)]">
      <div className={SECTION_WRAP}>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-2xl flex-col gap-3">
            {showFreeBadge ? <FreeBadge className="w-fit" /> : null}
            {heading ? (
              <h2 id="start-free-heading" className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">
                {heading}
              </h2>
            ) : null}
            {description ? <p className="leading-relaxed text-[var(--color-muted-foreground)]">{description}</p> : null}
          </div>
          {ctaText && ctaHref ? (
            <div className="flex flex-col gap-2 lg:items-end">
              <Button asChild size="lg" variant="primary" className="w-full sm:w-fit">
                <Link href={ctaHref}>
                  {ctaText} <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </Button>
              {note ? <p className="text-sm text-[var(--color-muted-foreground)]">{note}</p> : null}
            </div>
          ) : null}
        </div>

        <ul className="mt-10 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {cards.map((card) => (
            <li key={card.key}>
              <Link
                href={card.href}
                className="group flex h-full flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 transition-colors hover:border-[var(--color-primary)]/60 sm:p-6"
              >
                <div className="flex items-center justify-between gap-3">
                  <FreeBadge />
                  <span className="text-lg tabular-nums text-[var(--color-foreground)]" style={{ fontFamily: "var(--font-mono)" }}>
                    {card.value}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-[var(--color-foreground)]">{card.title}</h3>
                <p className="text-sm leading-relaxed text-[var(--color-muted-foreground)]">{card.detail}</p>
                <span className="mt-auto inline-flex items-center gap-1 pt-1 text-sm font-medium text-[var(--color-foreground)]">
                  Open
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  <span className="sr-only"> {card.title}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Long-form preparation guide — normal, visible, readable content (no hidden
 * SEO text). Paragraphs are admin plain text rendered as text nodes.
 */
export function ExamGuideSection({ content }: SectionProps) {
  const eyebrow = str(content, "eyebrow");
  const heading = str(content, "heading");
  const intro = str(content, "intro");
  const blocks = pairs(content, "blocks").filter(([title, body]) => title.trim() || body.trim());
  const disclaimer = str(content, "disclaimer");
  if (!heading && !intro && blocks.length === 0) return null;

  return (
    <section id="exam-guide" aria-labelledby="exam-guide-heading" className="scroll-mt-20 border-t border-[var(--color-border)]">
      <div className={`${SECTION_WRAP} grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16`}>
        <div className="flex flex-col gap-3 lg:sticky lg:top-28 lg:self-start">
          {eyebrow ? <p className="text-xs font-medium tracking-[0.08em] text-[var(--color-muted-foreground)] uppercase">{eyebrow}</p> : null}
          {heading ? (
            <h2 id="exam-guide-heading" className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">
              {heading}
            </h2>
          ) : null}
          {intro ? <p className="leading-relaxed text-[var(--color-muted-foreground)]">{intro}</p> : null}
        </div>
        <div className="flex max-w-2xl flex-col gap-8">
          {blocks.map(([title, body], i) => (
            <div key={`${i}-${title}`} className="flex flex-col gap-2">
              {title ? <h3 className="text-lg font-semibold text-[var(--color-foreground)]">{title}</h3> : null}
              {body ? <p className="leading-relaxed text-[var(--color-muted-foreground)]">{body}</p> : null}
            </div>
          ))}
          {disclaimer ? (
            <p className="border-t border-[var(--color-border)] pt-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">{disclaimer}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Visible questions only — the FAQPage JSON-LD (app/page.tsx) is built from this same list. */
export function faqItems(content: Record<string, unknown>): [string, string][] {
  return pairs(content, "items").filter(([q, a]) => q.trim() && a.trim());
}

/**
 * FAQ as native <details>: keyboard and screen-reader accessible, works
 * without JavaScript, and every answer is in the server-rendered HTML.
 */
export function FaqSection({ content }: SectionProps) {
  const heading = str(content, "heading");
  const items = faqItems(content);
  if (items.length === 0) return null;

  return (
    <section id="faq" aria-labelledby="faq-heading" className="scroll-mt-20 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={`${SECTION_WRAP} grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16`}>
        <h2 id="faq-heading" className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">
          {heading || "Frequently asked questions"}
        </h2>
        <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {items.map(([question, answer], i) => (
            <details key={`${i}-${question}`} className="group">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-4 text-left [&::-webkit-details-marker]:hidden">
                <h3 className="text-base font-medium text-[var(--color-foreground)]">{question}</h3>
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)] transition-transform group-open:rotate-180 motion-reduce:transition-none"
                  aria-hidden
                />
              </summary>
              <p className="pb-5 pr-8 text-sm leading-relaxed text-[var(--color-muted-foreground)]">{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
