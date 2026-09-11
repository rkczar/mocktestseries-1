import type { Metadata } from "next";

import { Container } from "@/components/common/Container";
import { UpcomingExamRow } from "@/components/home/UpcomingExamRow";
import { prisma } from "@/lib/db";

export const metadata: Metadata = {
  title: "Upcoming Exams",
  description: "Every exam notification we're tracking, so you know what's next.",
};

export default async function UpcomingExamsPage() {
  const exams = await prisma.upcomingExam.findMany({
    where: { isVisible: true },
    orderBy: [{ examDate: "asc" }, { order: "asc" }],
  });

  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
        Upcoming Exams
      </p>
      <h1 className="mt-2 font-display text-[clamp(28px,3.4vw,40px)] leading-[1.1] font-bold tracking-[-.02em] text-text-heading">
        Know what is next
      </h1>
      <p className="mt-2 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
        Notification status and expected dates for exams we&apos;re preparing test series for.
      </p>

      {exams.length === 0 ? (
        <p className="mt-8 text-[15px] text-text-faint">
          No upcoming exams are listed right now — check back soon.
        </p>
      ) : (
        <ul className="mt-8 flex flex-col gap-2.5">
          {exams.map((exam) => (
            <UpcomingExamRow
              key={exam.id}
              exam={{
                id: exam.id,
                title: exam.title,
                subtitle: exam.subtitle,
                dateLabel: exam.dateLabel,
                examDate: exam.examDate,
                status: exam.status,
                statusTone: exam.statusTone as "success" | "accent" | "neutral",
                actionLabel: exam.actionLabel,
                actionHref: exam.actionHref,
              }}
            />
          ))}
        </ul>
      )}
    </Container>
  );
}
