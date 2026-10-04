import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ExamSection } from "@/components/public-exam/seo-blocks";
import { EXAM_INSIGHT_PAGES } from "@/lib/exam-pyq-analysis";

export type ExamResourceKey =
  | "overview"
  | "exam-pattern"
  | "syllabus"
  | "previous-year-papers"
  | "question-bank"
  | "mock-test-series"
  | "weightage"
  | "analysis"
  | "strategy";

const RESOURCES: { key: ExamResourceKey; path: string; title: string; body: string }[] = [
  { key: "overview", path: "", title: "Exam overview", body: "Notification, important dates, eligibility and FAQs." },
  { key: "exam-pattern", path: "/exam-pattern", title: "Exam pattern", body: "Questions, marks, duration and marking scheme." },
  { key: "syllabus", path: "/syllabus", title: "Syllabus", body: "Every subject with its topic-wise list." },
  { key: "previous-year-papers", path: "/previous-year-papers", title: "Previous year papers", body: "Attempt past papers online in the exam format." },
  { key: "weightage", path: `/${EXAM_INSIGHT_PAGES.weightage}`, title: "Subject-wise weightage", body: "How many past-paper questions each subject carried." },
  { key: "analysis", path: `/${EXAM_INSIGHT_PAGES.analysis}`, title: "Previous year paper analysis", body: "Year-by-year subject mix and what changed." },
  { key: "strategy", path: `/${EXAM_INSIGHT_PAGES.strategy}`, title: "Preparation strategy", body: "A step-by-step plan built on the past papers." },
  { key: "question-bank", path: "/question-bank", title: "Question bank", body: "Subject-wise practice questions with explanations." },
  { key: "mock-test-series", path: "/mock-test-series", title: "Mock test series", body: "Full-length, exam-pattern mocks on a schedule." },
];

/**
 * "Related resources" block for the exam's public pages: one descriptive
 * link per sibling page, never the current one. Callers pass `exclude` for
 * pages that don't exist for this exam (no analysis data, no mock series),
 * so the block never links to a 404.
 */
export function ExamResourceLinks({
  slug,
  examName,
  current,
  exclude = [],
}: {
  slug: string;
  examName: string;
  current: ExamResourceKey;
  exclude?: ExamResourceKey[];
}) {
  const items = RESOURCES.filter((r) => r.key !== current && !exclude.includes(r.key));
  return (
    <ExamSection id="related-resources" title={`More ${examName} resources`}>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((r) => (
          <li key={r.key}>
            <Link
              href={`/exams/${slug}${r.path}`}
              className="group flex h-full flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 transition-colors hover:border-[var(--color-primary)]/60"
            >
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--color-foreground)]">
                {r.title}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
              <span className="text-xs leading-relaxed text-[var(--color-muted-foreground)]">{r.body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </ExamSection>
  );
}
