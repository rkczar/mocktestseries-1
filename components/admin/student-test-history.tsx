import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { AttemptSourceType } from "@prisma/client";

export const SOURCE_LABEL = {
  MOCK_TEST: "Mock Test",
  PREVIOUS_YEAR_PAPER: "Previous Year Paper",
  CUSTOM_MODULE: "Custom Module",
  SUBJECT_TEST: "Subject Test",
  GRAND_TEST: "Grand Test",
  LIVE_TEST: "Live Test",
} as const;

export interface StudentTestHistoryRow {
  id: string;
  sourceType: AttemptSourceType;
  status: string;
  score: number | null;
  maxScore: number | null;
  correctCount: number | null;
  incorrectCount: number | null;
  unansweredCount: number | null;
  startedAt: Date;
  exam: { name: string };
  mockTest: { title: string } | null;
  customModule: { title: string } | null;
  previousYearPaper: { title: string } | null;
  grandTest: { title: string } | null;
  liveTest: { title: string } | null;
  /** Only when the table lists several students (studentHref given). */
  student?: { id: string; name: string; studentId: string };
}

/**
 * The student Test History table — shared by Admin → Students → student and
 * the Teacher Portal's student page (which passes only its exams' attempts).
 */
export function StudentTestHistory({ attempts, studentHref }: { attempts: StudentTestHistoryRow[]; studentHref?: (studentDbId: string) => string }) {
  return (
    <>
    {attempts.length === 0 ? (
      <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No attempts yet.</p>
    ) : (
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
            {studentHref ? <th className="py-2 pr-4">Student</th> : null}
            <th className="py-2 pr-4">Type</th>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Exam</th>
            <th className="py-2 pr-4">Score</th>
            <th className="py-2 pr-4">Correct / Incorrect / Skipped</th>
            <th className="py-2 pr-4">Date</th>
            <th className="py-2 pr-4">Status</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.id} className="border-b border-[var(--color-border)] last:border-0">
              {studentHref && a.student ? (
                <td className="py-2.5 pr-4">
                  <Link href={studentHref(a.student.id)} className="hover:underline">{a.student.name}</Link>
                  <span className="block font-mono text-[10px] text-[var(--color-muted-foreground)]">{a.student.studentId}</span>
                </td>
              ) : null}
              <td className="py-2.5 pr-4">
                <Badge variant="neutral">{SOURCE_LABEL[a.sourceType]}</Badge>
              </td>
              <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                {a.mockTest?.title ?? a.customModule?.title ?? a.previousYearPaper?.title ?? a.grandTest?.title ?? a.liveTest?.title ?? "—"}
              </td>
              <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.exam.name}</td>
              <td className="py-2.5 pr-4">{a.score !== null ? `${a.score} / ${a.maxScore}` : "—"}</td>
              <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                {a.correctCount ?? "—"} / {a.incorrectCount ?? "—"} / {a.unansweredCount ?? "—"}
              </td>
              <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.startedAt.toLocaleDateString()}</td>
              <td className="py-2.5 pr-4">
                <Badge variant={a.status === "SUBMITTED" ? "success" : a.status === "IN_PROGRESS" ? "info" : "neutral"}>
                  {a.status.replace(/_/g, " ")}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    </>
  );
}
