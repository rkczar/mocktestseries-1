import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Container } from "@/components/common/Container";
import { StatusBadge } from "@/components/common/StatusBadge";
import { prisma } from "@/lib/db";

export const metadata: Metadata = {
  title: "Exams",
  description: "Every mock-test exam on MockTestSeries.in, live or coming soon.",
};

export default async function ExamsPage() {
  const exams = await prisma.exam.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: { order: "asc" },
  });

  const liveExams = exams.filter((exam) => exam.status === "ACTIVE");
  const comingSoonExams = exams.filter((exam) => exam.status === "COMING_SOON");

  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
        Exams
      </p>
      <h1 className="mt-2 font-display text-[clamp(28px,3.4vw,40px)] leading-[1.1] font-bold tracking-[-.02em] text-text-heading">
        Every exam, in one place
      </h1>
      <p className="mt-2 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
        Live mock test series you can start today, and the exams we&apos;re preparing next.
        Managed entirely from the Admin Panel.
      </p>

      <section className="mt-9">
        <h2 className="font-display text-[clamp(21px,2.2vw,26px)] font-bold text-text-heading">
          Live exams
        </h2>
        {liveExams.length === 0 ? (
          <p className="mt-4 text-[15px] text-text-faint">No live exams right now — check back soon.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3.5">
            {liveExams.map((exam) => (
              <li
                key={exam.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface p-[clamp(20px,3vw,24px)]"
              >
                <div className="min-w-0">
                  <h3 className="text-[19px] font-extrabold text-text-heading">{exam.title}</h3>
                  <p className="mt-1.5 text-sm text-text-faint">{exam.description}</p>
                </div>
                <Link
                  href={`/exams/${exam.slug}`}
                  className="inline-flex items-center gap-2 rounded-[10px] bg-primary px-5 py-3 text-[14.5px] font-bold whitespace-nowrap text-primary-foreground hover:bg-primary-hover"
                >
                  View Details
                  <ArrowRight className="size-4" strokeWidth={2.2} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-11">
        <h2 className="font-display text-[clamp(21px,2.2vw,26px)] font-bold text-text-heading">
          Coming soon
        </h2>
        <p className="mt-1.5 text-sm text-text-faint">Exams being prepared for a future notification.</p>

        {comingSoonExams.length === 0 ? (
          <p className="mt-4 text-[15px] text-text-faint">
            No upcoming exams are listed right now — check back soon.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3.5">
            {comingSoonExams.map((exam) => (
              <li
                key={exam.id}
                className="rounded-2xl border border-border bg-surface p-[clamp(20px,3vw,24px)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-extrabold text-text-heading">{exam.title}</h3>
                    <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-text-muted">
                      {exam.description}
                    </p>
                  </div>
                  <StatusBadge tone="accent" className="whitespace-nowrap">
                    Coming soon
                  </StatusBadge>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4">
                  <span className="text-[13px] text-text-faint">
                    Set up your account now to get notified when it launches.
                  </span>
                  <Link
                    href="/student/register"
                    className="ml-auto rounded-[10px] border border-border-strong px-[17px] py-2.5 text-sm font-bold whitespace-nowrap text-primary hover:bg-accent"
                  >
                    Get notified
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Container>
  );
}
