import Link from "next/link";
import { examShortName } from "@/lib/exam-editorial-facts";
import { cn } from "@/lib/utils";

/**
 * "All / <exam> / <exam>" chips for student lists that span exams (History, Saved). Renders nothing
 * for a single-exam student, so the one-exam experience is unchanged.
 */
export function ExamFilterChips({
  exams,
  selectedExamId,
  hrefFor,
}: {
  exams: { id: string; code: string; name: string }[];
  selectedExamId: string | undefined;
  hrefFor: (examId: string | null) => string;
}) {
  if (exams.length < 2) return null;
  const chips = [{ id: null as string | null, label: "All exams" }, ...exams.map((e) => ({ id: e.id as string | null, label: examShortName(e.code, e.name) }))];
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Filter by exam">
      {chips.map((c) => (
        <Link
          key={c.id ?? "all"}
          href={hrefFor(c.id)}
          aria-current={(selectedExamId ?? null) === c.id ? "page" : undefined}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            (selectedExamId ?? null) === c.id
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
              : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface)]"
          )}
        >
          {c.label}
        </Link>
      ))}
    </nav>
  );
}
