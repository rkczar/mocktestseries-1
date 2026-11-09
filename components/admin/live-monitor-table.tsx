import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatIst } from "@/lib/ist-time";
import type { LiveCandidateStatus, getLiveCbtMonitor } from "@/lib/live-cbt";

const STATUS: Record<LiveCandidateStatus, { label: string; variant: "neutral" | "primary" | "success" | "error" | "warning" | "info" }> = {
  NOT_STARTED: { label: "Not started", variant: "neutral" },
  ABSENT: { label: "Absent", variant: "error" },
  IN_PROGRESS: { label: "In progress", variant: "warning" },
  SUBMITTED: { label: "Submitted", variant: "success" },
  AUTO_SUBMITTED: { label: "Auto-submitted (time up)", variant: "success" },
  FINALIZED_AFTER_WINDOW: { label: "Auto-submitted (browser closed)", variant: "info" },
};

export const monitorTime = (d: Date | null) => (d ? formatIst(d).replace(/^\d{2} \w{3} \d{4}, /, "") : "—");
const time = monitorTime;
const held = "Held";

type Row = Awaited<ReturnType<typeof getLiveCbtMonitor>>["rows"][number];

/**
 * Candidates table of Admin → Mock Test → Live CBT Monitor, shared with the
 * Teacher Portal's test results page. `released` false shows "Held" instead of
 * scores and ranks (the admin monitor follows the student result release;
 * the Teacher Portal passes true — owner decision 2026-11-08).
 */
export function LiveMonitorTable({ rows, released, studentHref }: { rows: Row[]; released: boolean; studentHref: (studentDbId: string) => string }) {
  return (
    <>
    {rows.length === 0 ? (
      <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No enrolled students or attempts yet.</p>
    ) : (
      <table className="w-full min-w-[980px] text-left text-sm" data-testid="live-monitor-table">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
            <th className="py-2 pr-3">Rank</th>
            <th className="py-2 pr-3">Student</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Enrolled</th>
            <th className="py-2 pr-3">Started</th>
            <th className="py-2 pr-3">Submitted</th>
            <th className="py-2 pr-3">Score</th>
            <th className="py-2 pr-3">Correct / Wrong / Unanswered</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.studentDbId} className="border-b border-[var(--color-border)] last:border-0">
              <td className="py-2 pr-3 font-medium">{released ? (r.rank ?? "—") : r.attemptId ? held : "—"}</td>
              <td className="py-2 pr-3">
                <Link href={studentHref(r.studentDbId)} className="font-medium text-[var(--color-foreground)] underline-offset-2 hover:underline">
                  {r.name}
                </Link>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {r.studentCode}
                  {r.contact ? ` · ${r.contact}` : ""}
                </p>
              </td>
              <td className="py-2 pr-3">
                <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                {r.laterAttempts > 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">+{r.laterAttempts} later practice</p> : null}
              </td>
              <td className="py-2 pr-3 text-xs">{r.enrolledAt ? time(r.enrolledAt) : "Not enrolled"}</td>
              <td className="py-2 pr-3 text-xs">{time(r.startedAt)}</td>
              <td className="py-2 pr-3 text-xs">{time(r.submittedAt)}</td>
              <td className="py-2 pr-3">{!released && r.attemptId ? held : r.score !== null ? `${r.score} / ${r.maxScore ?? "—"}` : "—"}</td>
              <td className="py-2 pr-3 text-xs">{!released && r.attemptId ? held : r.correct !== null ? `${r.correct} / ${r.incorrect} / ${r.unanswered}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    </>
  );
}
