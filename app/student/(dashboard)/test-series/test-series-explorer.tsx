"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ClipboardList, Clock, ListChecks, Trophy, CalendarClock, PencilLine, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatIst } from "@/lib/ist-time";
import { startMockTestFromExamAction } from "@/app/student/(dashboard)/exams/[examId]/actions";
import { startOfflineOmrEntryFromTestSeriesAction } from "./actions";

type Availability = "UPCOMING" | "AVAILABLE";

export interface ExplorerTestRow {
  id: string;
  title: string;
  testNumber: number | null;
  coverageLabel: string;
  examName: string;
  questionCount: number;
  durationMinutes: number;
  availableFrom: string | null; // ISO string
  availability: Availability;
  attemptPolicy: "SINGLE_ATTEMPT" | "MULTIPLE_PRACTICE";
  bestScore: number | null;
  latestAttempt: { id: string; status: "IN_PROGRESS" | "SUBMITTED" | "ABANDONED" } | null;
  hasSubmittedAttempt: boolean;
  paperResourceId: string | null;
  /** Server-evaluated entitlement lock (null = accessible). The start action re-checks regardless. */
  lock: { status: "PAYMENT_REQUIRED" | "EXPIRED" | "NOT_AVAILABLE"; href: string | null } | null;
}

export interface ExplorerGroup {
  seriesId: string | null;
  seriesName: string;
  seriesDescription: string | null;
  tests: ExplorerTestRow[];
}

type DisplayStatus = "IN_PROGRESS" | "COMPLETED" | "UPCOMING" | "AVAILABLE";

function displayStatusOf(row: ExplorerTestRow): DisplayStatus {
  if (row.latestAttempt?.status === "IN_PROGRESS") return "IN_PROGRESS";
  if (row.hasSubmittedAttempt) return "COMPLETED";
  if (row.availability === "UPCOMING") return "UPCOMING";
  return "AVAILABLE";
}

const TABS: { key: "ALL" | DisplayStatus; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "AVAILABLE", label: "Available" },
  { key: "UPCOMING", label: "Upcoming" },
  { key: "COMPLETED", label: "Completed" },
];

export function TestSeriesExplorer({ groups }: { groups: ExplorerGroup[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("ALL");

  const filteredGroups = useMemo(() => {
    return groups
      .map((g) => ({
        ...g,
        tests: g.tests.filter((row) => {
          const status = displayStatusOf(row);
          if (tab === "ALL") return true;
          if (tab === "AVAILABLE") return status === "AVAILABLE" || status === "IN_PROGRESS";
          return status === tab;
        }),
      }))
      .filter((g) => g.tests.length > 0);
  }, [groups, tab]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              tab === t.key
                ? "rounded-full border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 text-sm font-medium text-white"
                : "rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-1.5 text-sm font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {filteredGroups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <ClipboardList className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-sm text-[var(--color-muted-foreground)]">No tests in this category right now.</p>
          </CardContent>
        </Card>
      ) : (
        filteredGroups.map((group) => (
          <div key={group.seriesId ?? "standalone"} className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-foreground)]">{group.seriesName}</h2>
              {group.seriesDescription ? (
                <p className="text-xs text-[var(--color-muted-foreground)]">{group.seriesDescription}</p>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.tests.map((row) => (
                <TestCard key={row.id} row={row} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function TestCard({ row }: { row: ExplorerTestRow }) {
  const status = displayStatusOf(row);

  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 pt-5">
        <div>
          {row.testNumber ? <p className="text-[11px] font-semibold text-[var(--color-muted-foreground)]">Mock {row.testNumber}</p> : null}
          <p className="font-medium text-[var(--color-foreground)]">{row.title}</p>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {row.examName} · {row.coverageLabel}
          </p>
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-[var(--color-muted-foreground)]">
          <span className="flex items-center gap-1">
            <ListChecks className="h-3.5 w-3.5" aria-hidden /> {row.questionCount} Qs · {row.questionCount} marks
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden /> {row.durationMinutes} min
          </span>
          {row.bestScore !== null ? (
            <span className="flex items-center gap-1">
              <Trophy className="h-3.5 w-3.5" aria-hidden /> Best: {row.bestScore.toFixed(1)}
            </span>
          ) : null}
        </div>

        {row.availableFrom ? (
          <span className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Scheduled: {formatIst(new Date(row.availableFrom))}
          </span>
        ) : null}

        <div className="flex flex-wrap gap-1">
          {row.lock ? (
            <Badge variant="warning">
              <Lock className="h-3 w-3" aria-hidden /> {row.lock.status === "EXPIRED" ? "Access expired" : "Premium"}
            </Badge>
          ) : null}
          <Badge
            variant={
              status === "UPCOMING" ? "info" : status === "IN_PROGRESS" ? "warning" : status === "COMPLETED" ? "success" : "primary"
            }
          >
            {status === "IN_PROGRESS" ? "In Progress" : status.charAt(0) + status.slice(1).toLowerCase()}
          </Badge>
        </div>

        <div className="mt-auto flex flex-wrap gap-2 pt-2">
          {status === "UPCOMING" ? (
            <Button size="sm" disabled>
              Available {row.availableFrom ? formatIst(new Date(row.availableFrom)) : "soon"}
            </Button>
          ) : status === "IN_PROGRESS" && row.latestAttempt ? (
            <Button asChild size="sm">
              <Link href={`/student/attempt/${row.latestAttempt.id}/run`}>Resume Test</Link>
            </Button>
          ) : status === "COMPLETED" && row.latestAttempt ? (
            <>
              <Button asChild size="sm" variant="outline">
                <Link href={`/student/attempt/${row.latestAttempt.id}/result`}>Result</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/student/attempt/${row.latestAttempt.id}/review`}>Review</Link>
              </Button>
              {row.paperResourceId ? (
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/student/test-resources/${row.paperResourceId}`}>Download Paper</a>
                </Button>
              ) : null}
              {row.attemptPolicy === "MULTIPLE_PRACTICE" ? (
                <form action={startMockTestFromExamAction.bind(null, row.id)}>
                  <Button type="submit" size="sm">
                    Practice Again
                  </Button>
                </form>
              ) : null}
            </>
          ) : row.lock ? (
            row.lock.href ? (
              <Button asChild size="sm">
                <Link href={row.lock.href}>
                  <Lock className="h-3.5 w-3.5" aria-hidden /> {row.lock.status === "EXPIRED" ? "Renew Access" : "Unlock"}
                </Link>
              </Button>
            ) : (
              <Button size="sm" disabled>
                <Lock className="h-3.5 w-3.5" aria-hidden /> Not available
              </Button>
            )
          ) : (
            <>
              <form action={startMockTestFromExamAction.bind(null, row.id)}>
                <Button type="submit" size="sm">
                  Start Test
                </Button>
              </form>
              <form action={startOfflineOmrEntryFromTestSeriesAction.bind(null, row.id)}>
                <Button type="submit" size="sm" variant="outline">
                  <PencilLine className="h-3.5 w-3.5" aria-hidden /> Enter OMR Answers
                </Button>
              </form>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
