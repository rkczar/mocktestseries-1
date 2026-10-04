import Link from "next/link";
import { safeJsonLd } from "@/lib/json-ld";
import { formatDataDate } from "@/lib/exam-pyq-analysis";

/**
 * Shared pieces for the exam analysis pages (weightage, paper analysis,
 * preparation strategy): the answer-first summary, the data stamp, the
 * methodology note and the page's WebPage/Article JSON-LD.
 */

/** Short, direct answer placed right under a heading (answer-first). */
export function QuickAnswer({ label = "Quick answer", children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 p-4 sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-primary)]">{label}</p>
      <div className="mt-1.5 text-sm leading-relaxed text-[var(--color-foreground)] sm:text-base">{children}</div>
    </div>
  );
}

/** "Data as of …" line under the H1. */
export function DataStamp({ iso, byline }: { iso: string | null; byline?: string }) {
  const date = formatDataDate(iso);
  if (!date && !byline) return null;
  return (
    <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
      {byline ? <span>{byline}</span> : null}
      {byline && date ? <span aria-hidden> · </span> : null}
      {date ? (
        <span>
          {byline ? "Updated" : "Data as of"} <time dateTime={iso!.slice(0, 10)}>{date}</time>
        </span>
      ) : null}
    </p>
  );
}

/** Methodology / data note: what the numbers are, where they come from, what they can't say. */
export function MethodNote({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex max-w-3xl list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Inline text link in the pages' standard style. */
export function TextLink({ href, children, rel }: { href: string; children: React.ReactNode; rel?: string }) {
  return (
    <Link href={href} rel={rel} prefetch={false} className="font-medium text-[var(--color-foreground)] underline underline-offset-4 hover:text-[var(--color-primary)]">
      {children}
    </Link>
  );
}

/** WebPage (or Article) structured data for an analysis page, tied to the site's #website / #organization nodes. */
export function InsightJsonLd({
  siteUrl,
  path,
  name,
  description,
  dateModified,
  examName,
  article,
}: {
  siteUrl: string;
  path: string;
  name: string;
  description: string;
  dateModified: string | null;
  examName: string;
  /** Emit an Article authored by the editorial team instead of a plain WebPage. */
  article?: { authorName: string; datePublished: string };
}) {
  const url = `${siteUrl}${path}`;
  const common = {
    "@context": "https://schema.org",
    "@id": `${url}#${article ? "article" : "webpage"}`,
    url,
    name,
    description,
    inLanguage: "en-IN",
    isPartOf: { "@type": "WebSite", "@id": `${siteUrl}/#website` },
    about: { "@type": "Thing", name: examName },
    publisher: { "@id": `${siteUrl}/#organization` },
    ...(dateModified ? { dateModified } : {}),
  };
  const data = article
    ? {
        ...common,
        "@type": "Article",
        headline: name,
        mainEntityOfPage: url,
        datePublished: article.datePublished,
        author: { "@type": "Organization", name: article.authorName, url: siteUrl },
      }
    : { ...common, "@type": "WebPage" };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(data) }} />;
}
