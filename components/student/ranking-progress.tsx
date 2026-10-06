import Link from "next/link";
import { Award, Medal, Target, Trophy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatPercent1 } from "@/lib/leaderboard-core";
import type { OverallLeaderboard, OverallRow, RankedTestHistoryRow } from "@/lib/leaderboard";

/*
 * Ranking & Progress (Student Analytics). Server components only: rows are
 * rendered here and never handed to a client component; keys are list
 * positions / own attempt ids — never another student's id.
 */

function YouBadge() {
  return (
    <Badge variant="primary" className="px-1.5 py-0 text-[10px] font-bold tracking-wide">
      YOU
    </Badge>
  );
}

function scoreText(score: number) {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

function SummaryTile({ icon, label, value, sub, testId }: { icon: React.ReactNode; label: string; value: string; sub?: string; testId?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-1 py-4 text-center" data-testid={testId}>
        {icon}
        <p className="text-lg font-semibold text-[var(--color-foreground)]">{value}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
        {sub ? <p className="max-w-full truncate text-[11px] text-[var(--color-muted-foreground)]">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

export function RankingSummary({
  overall,
  history,
  required,
}: {
  overall: OverallLeaderboard;
  history: RankedTestHistoryRow[];
  required: number;
}) {
  const best = history.reduce<RankedTestHistoryRow | null>((b, r) => (!b || r.rank < b.rank || (r.rank === b.rank && r.percentile > b.percentile) ? r : b), null);
  const self = overall.self;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile
          testId="rp-overall-rank"
          icon={<Trophy className="h-5 w-5 text-[var(--color-accent)]" aria-hidden />}
          label="Overall Rank"
          value={self ? `#${self.rank.toLocaleString("en-IN")} / ${overall.totalRanked.toLocaleString("en-IN")}` : "Not available yet"}
        />
        <SummaryTile
          testId="rp-top"
          icon={<Target className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />}
          label="Top %"
          value={self ? `${formatPercent1(self.topPercent)}%` : "—"}
        />
        <SummaryTile
          testId="rp-ranked-tests"
          icon={<Medal className="h-5 w-5 text-[var(--color-success)]" aria-hidden />}
          label="Ranked Tests"
          value={String(overall.selfRankedTests)}
          sub="counting toward Overall Rank"
        />
        <SummaryTile
          testId="rp-best"
          icon={<Award className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />}
          label="Best Test Rank"
          value={best ? `#${best.rank} / ${best.total}` : "—"}
          sub={best?.title}
        />
      </div>
      {!self ? (
        <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="rp-pending">
          {overall.countedTests === 0
            ? "Overall Rank starts once Mock Tests are selected for it."
            : `Complete ${required} ranked tests to receive your Overall Rank. (${overall.selfRankedTests} of ${required} done)`}
        </p>
      ) : (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Average percentile {formatPercent1(self.averagePercentile)} across {self.rankedTests} Overall-Ranking Mock Tests. Previous Year Papers and time taken
          never affect it.
        </p>
      )}
    </div>
  );
}

export function RankedTestHistory({ rows }: { rows: RankedTestHistoryRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ranked Test History</CardTitle>
        <CardDescription>Your ranked attempt on each Mock Test and Previous Year Paper (first Exam-Mode, Standard-time attempt).</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No ranked tests yet.</p>
        ) : (
          <table className="w-full min-w-[560px] text-left text-sm" data-testid="rp-history">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-3">Test</th>
                <th className="py-2 pr-3 text-right">Score</th>
                <th className="py-2 pr-3 text-right">Rank</th>
                <th className="py-2 pr-3 text-right">Percentile</th>
                <th className="py-2 pr-3 text-right">Accuracy</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.attemptId} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5 pr-3">
                    <span className="text-[var(--color-foreground)]">{r.title}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">
                        {r.kind === "MOCK_TEST" ? "Mock Test" : "PYQ"}
                      </Badge>
                      {r.countsTowardOverall ? (
                        <Badge variant="primary" className="px-1.5 py-0 text-[10px]">
                          Overall
                        </Badge>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-right text-[var(--color-foreground)]">
                    {scoreText(r.score)}
                    {r.maxScore !== null ? <span className="text-[var(--color-muted-foreground)]"> / {r.maxScore}</span> : null}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-medium text-[var(--color-foreground)]">
                    #{r.rank} <span className="font-normal text-[var(--color-muted-foreground)]">/ {r.total}</span>
                  </td>
                  <td className="py-2.5 pr-3 text-right text-[var(--color-foreground)]">{formatPercent1(r.percentile)}</td>
                  <td className="py-2.5 pr-3 text-right text-[var(--color-muted-foreground)]">{Math.round(r.accuracy * 100)}%</td>
                  <td className="py-2.5 text-right">
                    <span className="flex justify-end gap-2">
                      <Link href={`/student/attempt/${r.attemptId}/leaderboard`} className="text-xs text-[var(--color-primary)] hover:underline">
                        Leaderboard
                      </Link>
                      <Link href={`/student/attempt/${r.attemptId}/result`} className="text-xs text-[var(--color-primary)] hover:underline">
                        Result
                      </Link>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function OverallTable({ rows, caption, testId }: { rows: OverallRow[]; caption: string; testId: string }) {
  return (
    <table className="w-full text-left text-sm" data-testid={testId}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
          <th scope="col" className="w-14 py-2 pr-2">Rank</th>
          <th scope="col" className="py-2 pr-2">Student</th>
          <th scope="col" className="py-2 pr-2 text-right">
            <span className="sm:hidden" aria-hidden>Avg %ile</span>
            <span className="sr-only sm:not-sr-only">Average Percentile</span>
          </th>
          <th scope="col" className="py-2 text-right">
            <span className="sm:hidden" aria-hidden>Tests</span>
            <span className="sr-only sm:not-sr-only">Ranked Tests</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={`overall-${r.position}`}
            className={cn("border-b border-[var(--color-border)] last:border-0", r.isSelf && "bg-[var(--color-primary)]/10 shadow-[inset_4px_0_0_var(--color-primary)]")}
            data-self={r.isSelf ? "true" : undefined}
            aria-current={r.isSelf ? "true" : undefined}
          >
            <td className="py-2.5 pl-2 pr-2 font-semibold text-[var(--color-foreground)]">#{r.rank}</td>
            <td className="py-2.5 pr-2">
              <span className="flex items-center gap-1.5">
                <span className={cn("truncate", r.isSelf ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-foreground)]")}>{r.displayName}</span>
                {r.isSelf ? <YouBadge /> : null}
              </span>
            </td>
            <td className="py-2.5 pr-2 text-right text-[var(--color-foreground)]">{formatPercent1(r.averagePercentile)}</td>
            <td className="py-2.5 text-right text-[var(--color-muted-foreground)]">{r.rankedTests}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OverallLeaderboardCard({ board, examName, pageHref }: { board: OverallLeaderboard; examName: string; pageHref: (page: number) => string }) {
  return (
    <Card id="overall-leaderboard" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="h-4 w-4 text-[var(--color-accent)]" aria-hidden /> Overall Leaderboard · {examName}
        </CardTitle>
        <CardDescription>
          {board.totalRanked} ranked student{board.totalRanked === 1 ? "" : "s"} · average percentile across Overall-Ranking Mock Tests (3+ tests).
          Equal averages share a rank.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {board.totalRanked === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No one has an Overall Rank yet.</p>
        ) : (
          <>
            {board.self && board.nearby.length > 0 ? (
              <div className="rounded-[var(--radius-card)] border border-[var(--color-primary)]/40 p-3" data-testid="overall-your-position">
                <p className="mb-2 text-sm font-medium text-[var(--color-foreground)]">
                  Your Position ·{" "}
                  <Link href={pageHref(Math.ceil(board.self.position / board.pageSize))} className="text-[var(--color-primary)] hover:underline">
                    Show my page
                  </Link>
                </p>
                <OverallTable rows={board.nearby} caption="Students ranked around you overall" testId="overall-nearby-table" />
              </div>
            ) : null}
            <OverallTable rows={board.rows} caption="Overall leaderboard" testId="overall-table" />
            {board.pageCount > 1 ? (
              <nav className="flex items-center justify-between gap-2" aria-label="Overall leaderboard pages">
                <Button asChild variant="outline" size="sm" disabled={board.page <= 1}>
                  <Link href={pageHref(Math.max(board.page - 1, 1))} aria-disabled={board.page <= 1}>
                    Previous
                  </Link>
                </Button>
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  Page {board.page} of {board.pageCount}
                </span>
                <Button asChild variant="outline" size="sm" disabled={board.page >= board.pageCount}>
                  <Link href={pageHref(Math.min(board.page + 1, board.pageCount))} aria-disabled={board.page >= board.pageCount}>
                    Next
                  </Link>
                </Button>
              </nav>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
