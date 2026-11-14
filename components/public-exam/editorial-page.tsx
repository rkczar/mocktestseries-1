import type { ReactNode } from "react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import type { EditorialPage } from "@/lib/exam-editorial-pages";

/** Layout for hand-written exam pages (lib/exam-editorial-pages.ts): official text only, sources listed. */
export function EditorialExamPage({
  siteUrl,
  examName,
  slug,
  crumb,
  page,
  children,
}: {
  siteUrl: string;
  examName: string;
  slug: string;
  crumb: string;
  page: Pick<EditorialPage, "title" | "intro" | "blocks" | "sources" | "checkedOn">;
  children?: ReactNode;
}) {
  return (
    <PublicPageShell surface="EXAM">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <ExamBreadcrumbs
            baseUrl={siteUrl}
            crumbs={[
              { label: "Home", href: "/" },
              { label: "Exams", href: "/exams" },
              { label: examName, href: `/exams/${slug}` },
              { label: crumb },
            ]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">{page.title}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--color-muted-foreground)]">{page.intro}</p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={slug} />
      </div>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6">
        {page.blocks.map((b) => (
          <section key={b.heading} className="max-w-3xl">
            <h2 className="text-xl font-semibold text-[var(--color-foreground)]">{b.heading}</h2>
            {b.quote ? (
              <blockquote className="mt-3 flex flex-col gap-2 border-l-4 border-[var(--color-border)] pl-4 text-sm leading-relaxed text-[var(--color-foreground)]">
                {b.quote.map((q) => (
                  <p key={q}>{q}</p>
                ))}
              </blockquote>
            ) : null}
            {b.paragraphs?.map((p) => (
              <p key={p} className="mt-3 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
                {p}
              </p>
            ))}
            {b.bullets ? (
              <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
                {b.bullets.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
        {children}
        <section className="max-w-3xl">
          <h2 className="text-base font-semibold text-[var(--color-foreground)]">Official sources</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {page.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-foreground)] underline underline-offset-4">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Checked on {page.checkedOn}. The official documents always prevail.</p>
        </section>
      </div>
    </PublicPageShell>
  );
}
