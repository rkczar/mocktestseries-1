import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Container } from "@/components/common/Container";
import { TestSeriesCard } from "@/components/home/TestSeriesCard";
import { prisma } from "@/lib/db";

export const metadata: Metadata = {
  title: "Test Series",
  description: "Full mock tests, previous year papers and subject-wise practice, by exam.",
};

export default async function TestSeriesPage() {
  const exams = await prisma.exam.findMany({
    where: { status: { not: "ARCHIVED" }, testSeries: { some: {} } },
    include: { testSeries: { orderBy: { order: "asc" } } },
    orderBy: { order: "asc" },
  });

  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
        Test Series
      </p>
      <h1 className="mt-2 font-display text-[clamp(28px,3.4vw,40px)] leading-[1.1] font-bold tracking-[-.02em] text-text-heading">
        Full mocks, papers and subject practice
      </h1>
      <p className="mt-2 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
        Every test series on the platform, grouped by exam.
      </p>

      {exams.length === 0 ? (
        <p className="mt-8 text-[15px] text-text-faint">
          No test series are published yet — check back soon.
        </p>
      ) : (
        <div className="mt-9 flex flex-col gap-12">
          {exams.map((exam) => (
            <section key={exam.id}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 className="font-display text-[22px] font-bold text-text-heading">{exam.title}</h2>
                <Link
                  href={`/exams/${exam.slug}`}
                  className="inline-flex items-center gap-1.5 text-sm font-bold whitespace-nowrap text-primary"
                >
                  Exam details
                  <ArrowRight className="size-3.5" strokeWidth={2.2} />
                </Link>
              </div>
              <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-5">
                {exam.testSeries.map((series) => (
                  <TestSeriesCard
                    key={series.slug}
                    series={{
                      slug: series.slug,
                      kind: series.kind,
                      title: series.title,
                      description: series.description,
                      metaLabel: series.metaLabel,
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Container>
  );
}
