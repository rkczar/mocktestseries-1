import Link from "next/link";
import { cn } from "@/lib/utils";

export interface ExamSubNavProps {
  slug: string;
  active: "overview" | "syllabus" | "previous-year-papers" | "mock-test-series" | "question-bank" | "exam-pattern";
}

const TABS: { key: ExamSubNavProps["active"]; label: string; href: (slug: string) => string }[] = [
  { key: "overview", label: "Overview", href: (s) => `/exams/${s}` },
  { key: "mock-test-series", label: "Mock Test Series", href: (s) => `/exams/${s}/mock-test-series` },
  { key: "syllabus", label: "Syllabus", href: (s) => `/exams/${s}/syllabus` },
  { key: "previous-year-papers", label: "Previous Year Papers", href: (s) => `/exams/${s}/previous-year-papers` },
  { key: "question-bank", label: "Question Bank", href: (s) => `/exams/${s}/question-bank` },
  { key: "exam-pattern", label: "Exam Pattern", href: (s) => `/exams/${s}/exam-pattern` },
];

export function ExamSubNav({ slug, active }: ExamSubNavProps) {
  return (
    <nav
      aria-label="Exam sections"
      className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto border-b border-[var(--color-border)] px-4 sm:mx-0 sm:px-0"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href(slug)}
          className={cn(
            "shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
            tab.key === active
              ? "border-[var(--color-primary)] text-[var(--color-foreground)]"
              : "border-transparent text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
