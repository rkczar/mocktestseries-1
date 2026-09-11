import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { SectionHeading } from "@/components/common/SectionHeading";
import type { UpcomingExamDTO } from "@/lib/content/types";

import { UpcomingExamRow } from "./UpcomingExamRow";

export function UpcomingExamsSection({ exams }: { exams: UpcomingExamDTO[] }) {
  if (exams.length === 0) return null;

  return (
    <section className="border-y border-border bg-surface py-[clamp(56px,7vw,92px)]">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3.5">
          <SectionHeading eyebrow="Upcoming Exams" title="Know what is next" />
          <Link
            href="/upcoming-exams"
            className="inline-flex items-center gap-1.5 text-[14.5px] font-bold whitespace-nowrap text-primary"
          >
            Full calendar
            <ArrowRight className="size-4" strokeWidth={2.2} />
          </Link>
        </div>
        <ul className="flex flex-col gap-2.5">
          {exams.map((exam) => (
            <UpcomingExamRow key={exam.id} exam={exam} />
          ))}
        </ul>
      </div>
    </section>
  );
}
