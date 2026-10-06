import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AttemptStatus, TestType } from "@prisma/client";
import { Trophy } from "lucide-react";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getOwnedAttempt } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { getAttemptRanking } from "@/lib/leaderboard";
import { isMockResultReleased } from "@/lib/mock-test-schedule";
import { ATTEMPT_RANKING_STATUS_LABEL, formatPercent1 } from "@/lib/leaderboard-core";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StudentShell } from "@/components/student/shell";
import { LeaderboardPodium, LeaderboardTable, RANKING_RULE_NOTE, YourPositionCard } from "@/components/student/leaderboard";

export const metadata = { title: "Leaderboard — Mock Test Series.in" };

const PAGE_SIZE = 50;

/**
 * Per-test leaderboard (Mock Test / Previous Year Paper), reached from the
 * student's own submitted attempt: ownership, submission and the Mock Test
 * result-release gate are the attempt's, so nobody sees a board for a test
 * they haven't taken or before its results are out.
 */
export default async function AttemptLeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ attemptId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { attemptId } = await params;
  const { page: pageParam } = await searchParams;
  const student = await requireStudentOrLogin();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status !== AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}`);
  if (attempt.testType === TestType.FULL_MOCK && attempt.mockTest && !isMockResultReleased(attempt.mockTest)) {
    redirect(`/student/attempt/${attemptId}/result`);
  }

  const requestedPage = Number.parseInt(pageParam ?? "1", 10);
  const ranking = await getAttemptRanking(attempt, { page: Number.isFinite(requestedPage) ? requestedPage : 1, pageSize: PAGE_SIZE });
  if (!ranking?.board) redirect(`/student/attempt/${attemptId}/result`);
  const { board, status } = ranking;
  const title = attemptTitle(attempt);
  const base = `/student/attempt/${attemptId}/leaderboard`;
  const self = board.self;
  const tableRows = board.page === 1 ? board.rows.filter((r) => r.rank > 3) : board.rows;

  return (
    <StudentShell student={student}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8 sm:px-6">
        <Link href={`/student/attempt/${attemptId}/result`} className="text-xs text-[var(--color-primary)] hover:underline">
          ← Back to Result
        </Link>
        <div className="text-center">
          <Trophy className="mx-auto h-9 w-9 text-[var(--color-accent)]" aria-hidden />
          <h1 className="mt-2 text-xl font-semibold text-[var(--color-foreground)]">Leaderboard</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {title} · {board.totalParticipants} ranked participant{board.totalParticipants === 1 ? "" : "s"}
          </p>
          <p className="mx-auto mt-1 max-w-xl text-xs text-[var(--color-muted-foreground)]">{RANKING_RULE_NOTE}</p>
        </div>

        {self ? (
          <Card className="border-[var(--color-primary)]/40 bg-[var(--color-primary)]/5" data-testid="leaderboard-self-summary">
            <CardContent className="grid grid-cols-3 gap-3 py-4 text-center">
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Your Rank</p>
                <p className="text-lg font-bold text-[var(--color-foreground)]">
                  #{self.rank} <span className="text-sm font-medium text-[var(--color-muted-foreground)]">/ {board.totalParticipants}</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Percentile</p>
                <p className="text-lg font-bold text-[var(--color-foreground)]">{formatPercent1(self.percentile)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Top</p>
                <p className="text-lg font-bold text-[var(--color-foreground)]">{formatPercent1(self.topPercent)}%</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <p className="text-center">
            <Badge variant="neutral">{status === "OFFICIAL" ? "Not ranked" : ATTEMPT_RANKING_STATUS_LABEL[status]}</Badge>
          </p>
        )}

        {self && board.nearby.length > 0 ? (
          <YourPositionCard rows={board.nearby} self={self} myPageHref={`${base}?page=${Math.ceil(self.rank / board.pageSize)}`} />
        ) : null}

        {board.totalParticipants === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">No ranked attempts yet.</CardContent>
          </Card>
        ) : (
          <>
            {board.page === 1 ? <LeaderboardPodium rows={board.rows} /> : null}
            {tableRows.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Ranks {tableRows[0].rank}–{tableRows[tableRows.length - 1].rank}
                  </CardTitle>
                  <CardDescription>Score, then accuracy, correct answers, time taken and submission time break ties.</CardDescription>
                </CardHeader>
                <CardContent>
                  <LeaderboardTable rows={tableRows} caption={`Leaderboard ranks ${tableRows[0].rank} to ${tableRows[tableRows.length - 1].rank}`} testId="leaderboard-table" />
                </CardContent>
              </Card>
            ) : null}
            {board.pageCount > 1 ? (
              <nav className="flex items-center justify-between gap-2" aria-label="Leaderboard pages">
                <Button asChild variant="outline" size="sm" disabled={board.page <= 1}>
                  <Link href={`${base}?page=${Math.max(board.page - 1, 1)}`} aria-disabled={board.page <= 1}>
                    Previous
                  </Link>
                </Button>
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  Page {board.page} of {board.pageCount}
                </span>
                <Button asChild variant="outline" size="sm" disabled={board.page >= board.pageCount}>
                  <Link href={`${base}?page=${Math.min(board.page + 1, board.pageCount)}`} aria-disabled={board.page >= board.pageCount}>
                    Next
                  </Link>
                </Button>
              </nav>
            ) : null}
          </>
        )}
      </div>
    </StudentShell>
  );
}
