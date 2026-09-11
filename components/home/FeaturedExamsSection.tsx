import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { SectionHeading } from "@/components/common/SectionHeading";
import type { FeaturedExamDTO } from "@/lib/content/types";

import { ExamCard, ExamCardPlaceholder } from "./ExamCard";

const PLACEHOLDER_HELPERS: React.ReactNode[] = [
  "Admin-added exams appear here automatically, in the order set in the Admin Panel. No homepage code changes needed.",
  <>
    Each card links to its own exam page at{" "}
    <span className="font-mono text-[13px] text-text-muted">/exams/[slug]</span>.
  </>,
];

export function FeaturedExamsSection({ exams }: { exams: FeaturedExamDTO[] }) {
  const placeholderCount = Math.max(0, 3 - exams.length);

  return (
    <section id="featured-exams" className="py-[clamp(56px,7vw,92px)]">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="mb-6.5 flex flex-wrap items-end justify-between gap-3.5">
          <SectionHeading eyebrow="Featured Exams" title="Start with the exam you are preparing for" />
          <Link
            href="/exams"
            className="inline-flex items-center gap-1.5 text-[14.5px] font-bold whitespace-nowrap text-primary"
          >
            All exams
            <ArrowRight className="size-4" strokeWidth={2.2} />
          </Link>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] gap-5">
          {exams.map((exam) => (
            <ExamCard key={exam.slug} exam={exam} />
          ))}
          {Array.from({ length: placeholderCount }).map((_, i) => (
            <ExamCardPlaceholder key={i} helper={PLACEHOLDER_HELPERS[i % PLACEHOLDER_HELPERS.length]} />
          ))}
        </div>
      </div>
    </section>
  );
}
