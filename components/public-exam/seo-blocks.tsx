import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { safeJsonLd } from "@/lib/json-ld";
import { PUBLIC_BRAND_NAME } from "@/lib/brand";
import { formatShare, type SubjectCount, type SubjectWeightage } from "@/lib/exam-pyq-insights";
import type { FaqItem } from "@/lib/exam-public";

/** Section wrapper with a stable anchor and the homepage heading scale. */
export function ExamSection({
  id,
  title,
  intro,
  action,
  children,
}: {
  id: string;
  title: string;
  intro?: React.ReactNode;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24 border-t border-[var(--color-border)] py-10 sm:py-12">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="flex max-w-3xl flex-col gap-2">
          <h2 id={`${id}-heading`} className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)] sm:text-3xl">
            {title}
          </h2>
          {intro ? <div className="leading-relaxed text-[var(--color-muted-foreground)]">{intro}</div> : null}
        </div>
        {action ? (
          <Link href={action.href} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
            {action.label}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** Compact facts grid (label / value). Renders nothing when empty. */
export function FactGrid({ facts }: { facts: { label: string; value: string }[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
      {facts.map((f) => (
        <div key={f.label} className="flex flex-col gap-1 bg-[var(--color-card)] p-4">
          <dt className="text-xs text-[var(--color-muted-foreground)]">{f.label}</dt>
          <dd className="text-sm font-medium text-[var(--color-foreground)] sm:text-base">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Subject distribution of published previous-year questions. `baseline`
 * (optional) adds a "vs all papers" column on a single paper's page.
 */
export function SubjectWeightageTable({
  rows,
  total,
  caption,
  baseline,
  showPapers = false,
}: {
  rows: (SubjectCount | SubjectWeightage)[];
  total: number;
  caption: string;
  baseline?: Map<string, number>;
  showPapers?: boolean;
}) {
  if (rows.length === 0 || total === 0) return null;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
      <table className="w-full table-fixed text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th scope="col" className="w-[44%] px-3 py-2.5 font-medium sm:w-[38%] sm:px-4">
              Subject
            </th>
            <th scope="col" className="w-[16%] px-2 py-2.5 text-right font-medium sm:px-4">
              Qs
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
              Share
            </th>
            {baseline ? (
              <th scope="col" className="hidden w-[18%] px-4 py-2.5 text-right font-medium sm:table-cell">
                All-paper avg
              </th>
            ) : null}
            {showPapers ? (
              <th scope="col" className="hidden w-[16%] px-4 py-2.5 text-right font-medium sm:table-cell">
                Papers
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => {
            const share = r.count / total;
            return (
              <tr key={r.name} className="bg-[var(--color-card)]">
                <th scope="row" className="break-words px-3 py-2.5 text-left font-normal leading-snug text-[var(--color-foreground)] sm:px-4">
                  {r.name}
                </th>
                <td className="px-2 py-2.5 text-right tabular-nums text-[var(--color-foreground)] sm:px-4">{r.count}</td>
                <td className="px-3 py-2.5 sm:px-4">
                  <div className="flex items-center gap-2">
                    <div className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)] sm:block" aria-hidden>
                      <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }} />
                    </div>
                    <span className="tabular-nums text-[var(--color-muted-foreground)]">{formatShare(share)}</span>
                  </div>
                </td>
                {baseline ? (
                  <td className="hidden px-4 py-2.5 text-right tabular-nums text-[var(--color-muted-foreground)] sm:table-cell">
                    {baseline.has(r.name) ? formatShare(baseline.get(r.name)!) : "—"}
                  </td>
                ) : null}
                {showPapers && "papers" in r ? (
                  <td className="hidden px-4 py-2.5 text-right tabular-nums text-[var(--color-muted-foreground)] sm:table-cell">{r.papers}</td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Visible FAQ plus FAQPage JSON-LD of exactly the visible items. */
export function FaqList({ items }: { items: FaqItem[] }) {
  if (items.length === 0) return null;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      <div className="flex flex-col gap-2">
        {items.map((f, i) => (
          <details key={i} className="group rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 sm:px-5">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-4 py-1 text-sm font-medium text-[var(--color-foreground)] marker:content-none sm:text-base">
              {f.question}
              <span className="mt-0.5 text-[var(--color-muted-foreground)] transition-transform group-open:rotate-45" aria-hidden>
                +
              </span>
            </summary>
            <p className="mt-2 whitespace-pre-line pb-1 text-sm leading-relaxed text-[var(--color-muted-foreground)]">{f.answer}</p>
          </details>
        ))}
      </div>
    </>
  );
}

/** The independence statement, shown once per exam page that discusses the conducting body's exam. */
export function ExamDisclaimer({ authority }: { authority?: string | null }) {
  const body = authority ? authority.split(/[—,(]/)[0].trim() : "the conducting authority";
  return (
    <p className="mt-10 rounded-[var(--radius-card)] border border-[var(--color-border)] px-4 py-3 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
      {PUBLIC_BRAND_NAME} is an independent exam-preparation platform. It is not affiliated with, endorsed by or connected to {body} or
      any government department. Exam details on this page are summarised from public notices; always confirm them on the official
      website before applying or appearing.
    </p>
  );
}
