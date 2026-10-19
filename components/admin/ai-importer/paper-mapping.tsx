import Link from "next/link";
import type { JobMapping } from "@/lib/ai-import/job-view";
import { JOB_STATUS_LABELS } from "@/lib/ai-import/config";

/**
 * The exam and Previous Year Paper an import is attached to — shown at the top of every importer
 * screen so the target is never hidden behind the exam name.
 */
export function PaperMapping({ m, compact = false }: { m: JobMapping; compact?: boolean }) {
  const item = (label: string, value: React.ReactNode, testId: string) => (
    <div className="flex min-w-0 flex-col" data-testid={testId}>
      <dt className="text-[11px] uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm font-medium [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
  return (
    <section aria-label="Exam and paper of this import" className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3" data-testid="paper-mapping" data-paper-id={m.paper?.id ?? ""} data-exam-id={m.examId}>
      <dl className={`grid gap-x-4 gap-y-2 ${compact ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}>
        {item("Exam", m.examName, "pm-exam")}
        {item(
          "Previous Year Paper",
          m.paperMissing ? <span className="text-[var(--color-error)]">The linked paper record no longer exists — select a paper</span> : m.paper ? m.paper.title : <span className="text-[var(--color-muted-foreground)]">None — Question Bank only</span>,
          "pm-paper",
        )}
        {item("Paper year", m.year ?? "—", "pm-year")}
        {item("Paper code / set", m.paperCode ?? "—", "pm-code")}
        {!compact && m.subjectName && item("Subject", m.subjectName, "pm-subject")}
        {!compact && item("Expected questions", m.expectedQuestions ?? <span className="text-[var(--color-warning)]">Not confirmed</span>, "pm-expected")}
        {!compact && item("Import job", <Link className="font-mono text-xs underline" href={`/admin/ai-importer/jobs/${m.jobId}`}>{m.jobId}</Link>, "pm-job")}
        {!compact && item("Import status", JOB_STATUS_LABELS[m.status] ?? m.status, "pm-status")}
      </dl>
    </section>
  );
}
