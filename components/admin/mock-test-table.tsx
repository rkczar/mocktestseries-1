import Link from "next/link";
import type { MockTestStatus, MockResultRelease, AccessType, MockCoverageType } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { formatIst } from "@/lib/ist-time";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_MODE_LABELS,
  deriveAvailabilityMode,
  deriveMockTestAvailability,
} from "@/lib/mock-test-schedule";

export const COVERAGE_LABELS: Record<MockCoverageType, string> = {
  FULL_SYLLABUS: "Full Syllabus",
  PARTIAL_SYLLABUS: "Partial Syllabus",
  SUBJECT_WISE: "Subject-wise",
};

export interface MockTestTableRow {
  id: string;
  order: number;
  title: string;
  status: MockTestStatus;
  accessType: AccessType;
  examId: string;
  examName: string;
  seriesName: string | null;
  coverageType: MockCoverageType;
  coverageText?: string;
  availableFrom: Date | null;
  availableUntil: Date | null;
  resultReleaseMode: MockResultRelease;
  questionCount: number;
  targetQuestionCount: number | null;
  attempts: number;
}

/** Prisma `select` that yields everything toMockTestTableRow needs. */
export const MOCK_TEST_TABLE_SELECT = {
  id: true,
  order: true,
  title: true,
  status: true,
  accessType: true,
  examId: true,
  coverageType: true,
  availableFrom: true,
  availableUntil: true,
  resultReleaseMode: true,
  targetQuestionCount: true,
  exam: { select: { name: true } },
  testSeries: { select: { name: true } },
  _count: { select: { questions: true, testAttempts: true } },
} as const;

export function toMockTestTableRow(m: {
  id: string;
  order: number;
  title: string;
  status: MockTestStatus;
  accessType: AccessType;
  examId: string;
  coverageType: MockCoverageType;
  availableFrom: Date | null;
  availableUntil: Date | null;
  resultReleaseMode: MockResultRelease;
  targetQuestionCount: number | null;
  exam: { name: string };
  testSeries: { name: string } | null;
  _count: { questions: number; testAttempts: number };
}): MockTestTableRow {
  return {
    id: m.id,
    order: m.order,
    title: m.title,
    status: m.status,
    accessType: m.accessType,
    examId: m.examId,
    examName: m.exam.name,
    seriesName: m.testSeries?.name ?? null,
    coverageType: m.coverageType,
    availableFrom: m.availableFrom,
    availableUntil: m.availableUntil,
    resultReleaseMode: m.resultReleaseMode,
    questionCount: m._count.questions,
    targetQuestionCount: m.targetQuestionCount,
    attempts: m._count.testAttempts,
  };
}

export function bulkImportHrefFor(row: { id: string; examId: string }) {
  return `/admin/questions/bulk-import?examId=${row.examId}&target=MOCK_TEST&mockTestId=${row.id}&from=mock`;
}

/**
 * One Mock Test table for every admin surface that lists them (Tests → All
 * Tests / Mock Tests, Test Series detail). Zero-question tests are flagged
 * NEEDS QUESTIONS with direct Add From Question Bank / Bulk Import actions.
 */
export function MockTestTable({ rows, showSeries = true, canManage }: { rows: MockTestTableRow[]; showSeries?: boolean; canManage: boolean }) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No mock tests yet.</p>;
  }
  const now = new Date();
  return (
    <table className="w-full min-w-[980px] text-left text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
          <th className="py-2 pr-3">No.</th>
          <th className="py-2 pr-3">Mock Test</th>
          {showSeries ? <th className="py-2 pr-3">Test Series / Exam</th> : null}
          <th className="py-2 pr-3">Questions</th>
          <th className="py-2 pr-3">Schedule</th>
          <th className="py-2 pr-3">Availability</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2 pr-3">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => {
          const state = deriveMockTestAvailability(m, now);
          const needs = m.questionCount === 0;
          return (
            <tr key={m.id} className="border-b border-[var(--color-border)] align-top last:border-0">
              <td className="py-2.5 pr-3 text-[var(--color-muted-foreground)]">{m.order}</td>
              <td className="py-2.5 pr-3">
                <Link href={`/admin/tests/mock/${m.id}`} className="font-medium text-[var(--color-foreground)] hover:underline">
                  {m.title}
                </Link>
                <span className="block text-xs text-[var(--color-muted-foreground)]">
                  {COVERAGE_LABELS[m.coverageType]}
                  {m.coverageText ? `: ${m.coverageText}` : ""} · {m.accessType}
                </span>
              </td>
              {showSeries ? (
                <td className="py-2.5 pr-3 text-xs text-[var(--color-muted-foreground)]">
                  {m.seriesName ?? "Standalone"}
                  <span className="block">{m.examName}</span>
                </td>
              ) : null}
              <td className="py-2.5 pr-3">
                {needs ? (
                  <Badge variant="warning">Needs Questions</Badge>
                ) : (
                  <Badge variant={m.targetQuestionCount !== null && m.questionCount !== m.targetQuestionCount ? "info" : "success"}>
                    {m.questionCount}
                    {m.targetQuestionCount !== null ? ` / ${m.targetQuestionCount}` : ""}
                  </Badge>
                )}
              </td>
              <td className="py-2.5 pr-3 text-xs text-[var(--color-muted-foreground)]">
                {AVAILABILITY_MODE_LABELS[deriveAvailabilityMode(m)]}
                {m.availableFrom ? <span className="block">{formatIst(m.availableFrom)}</span> : null}
                {m.availableUntil ? <span className="block">→ {formatIst(m.availableUntil)}</span> : null}
              </td>
              <td className="py-2.5 pr-3">
                <Badge variant={state === "LIVE_NOW" ? "warning" : state === "AVAILABLE" ? "success" : state === "CLOSED" ? "neutral" : "info"}>
                  {AVAILABILITY_LABELS[state]}
                </Badge>
              </td>
              <td className="py-2.5 pr-3">
                <Badge variant={m.status === "PUBLISHED" ? "success" : m.status === "DRAFT" ? "warning" : "neutral"}>{m.status}</Badge>
                {m.attempts > 0 ? <span className="block text-[11px] text-[var(--color-muted-foreground)]">{m.attempts} attempts</span> : null}
              </td>
              <td className="py-2.5 pr-3">
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <Link href={`/admin/tests/mock/${m.id}`} className="text-[var(--color-primary)] hover:underline">
                    Edit
                  </Link>
                  <Link href={`/admin/tests/mock/${m.id}#questions`} className="text-[var(--color-primary)] hover:underline">
                    {needs ? "Add From Question Bank" : "Manage Questions"}
                  </Link>
                  {canManage ? (
                    <Link href={bulkImportHrefFor(m)} className="text-[var(--color-primary)] hover:underline">
                      Bulk Import Questions
                    </Link>
                  ) : null}
                  <Link href={`/admin/tests/mock/${m.id}/preview`} className="text-[var(--color-primary)] hover:underline">
                    Preview
                  </Link>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
