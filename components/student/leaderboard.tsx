import Link from "next/link";
import { Crown, Medal, Trophy, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ATTEMPT_RANKING_STATUS_LABEL, formatDuration, formatPercent1 } from "@/lib/leaderboard-core";
import type { AttemptRanking, LeaderboardRow } from "@/lib/leaderboard";

/*
 * Leaderboard UI (Ranking Phase 1). Server components only: rows are
 * rendered to markup here and never passed to a client component, and React
 * keys are list positions — no student id reaches the browser. Equal
 * performance shares a rank (1, 2, 2, 4); time taken is shown, never ranked.
 */

export const RANKING_RULE_NOTE =
  "Each student's first attempt taken in Exam Mode with Standard time is ranked. Retakes, practice attempts and OMR entry are not ranked.";

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

/** Result page: Your Rank / Percentile / Top % (or a neutral not-ranked note) + View Leaderboard. */
export function RankSummaryCard({ ranking, leaderboardHref }: { ranking: AttemptRanking; leaderboardHref: string }) {
  if (!ranking.board) {
    return (
      <p className="text-center text-xs text-[var(--color-muted-foreground)]" data-testid="rank-summary-disabled">
        The leaderboard is not enabled for this test.
      </p>
    );
  }
  const { board, status } = ranking;
  const self = board.self;
  const showRank = self && (status === "OFFICIAL" || status === "RETAKE");

  return (
    <Card data-testid="rank-summary" data-rank-status={status}>
      <CardContent className="flex flex-col gap-4 pt-5">
        {status !== "OFFICIAL" ? (
          <Badge variant="neutral" className="w-fit">
            {ATTEMPT_RANKING_STATUS_LABEL[status]}
          </Badge>
        ) : null}
        {showRank && self ? (
          <>
            {status === "RETAKE" ? (
              <p className="text-xs text-[var(--color-muted-foreground)]">Your official rank comes from your first ranked attempt.</p>
            ) : null}
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Your Rank</p>
                <p className="text-xl font-bold text-[var(--color-foreground)]" data-testid="rank-value">
                  #{self.rank} <span className="text-sm font-medium text-[var(--color-muted-foreground)]">/ {board.totalParticipants}</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Percentile</p>
                <p className="text-xl font-bold text-[var(--color-foreground)]" data-testid="percentile-value">
                  {formatPercent1(self.percentile)}
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Top</p>
                <p className="text-xl font-bold text-[var(--color-foreground)]" data-testid="top-value">
                  {formatPercent1(self.topPercent)}%
                </p>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-[var(--color-muted-foreground)]">{RANKING_RULE_NOTE}</p>
        )}
        {board.totalParticipants > 0 ? (
          <Button asChild variant="outline" className="w-full sm:w-auto sm:self-center">
            <Link href={leaderboardHref}>
              <Trophy className="mr-1.5 h-4 w-4" aria-hidden />
              View Leaderboard · {board.totalParticipants} ranked
            </Link>
          </Button>
        ) : (
          <p className="text-center text-xs text-[var(--color-muted-foreground)]">No ranked attempts yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

const PODIUM_STYLE = [
  { icon: Crown, tone: "text-[var(--color-accent)]", order: "sm:order-2", lift: "sm:-mt-3" },
  { icon: Medal, tone: "text-[var(--color-muted-foreground)]", order: "sm:order-1", lift: "" },
  { icon: Medal, tone: "text-[var(--color-warning)]", order: "sm:order-3", lift: "" },
] as const;

export function LeaderboardPodium({ rows }: { rows: LeaderboardRow[] }) {
  const top = rows.filter((r) => r.position <= 3);
  if (top.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end" data-testid="podium">
      {top.map((r) => {
        const style = PODIUM_STYLE[r.position - 1];
        const Icon = style.icon;
        return (
          <Card
            key={`podium-${r.position}`}
            className={cn(style.order, style.lift, r.isSelf && "border-[var(--color-primary)] bg-[var(--color-primary)]/5")}
            data-self={r.isSelf ? "true" : undefined}
            aria-current={r.isSelf ? "true" : undefined}
          >
            <CardContent className="flex items-center gap-3 py-4 sm:flex-col sm:text-center">
              <Icon className={cn("h-7 w-7 shrink-0", style.tone)} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col sm:items-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Rank #{r.rank}</p>
                <p className="flex items-center gap-1.5 truncate font-semibold text-[var(--color-foreground)]">
                  <span className="truncate">{r.displayName}</span>
                  {r.isSelf ? <YouBadge /> : null}
                </p>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {scoreText(r.score)} pts · {Math.round(r.accuracy * 100)}% · {formatDuration(r.timeTakenSeconds)}
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Rank · Name · Score · Accuracy · Time · Percentile. On phones Accuracy and
 * Time move under the name so the table fits 360 px without sideways scroll.
 */
export function LeaderboardTable({ rows, caption, testId }: { rows: LeaderboardRow[]; caption: string; testId?: string }) {
  if (rows.length === 0) return null;
  return (
    <table className="w-full text-left text-sm" data-testid={testId}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
          <th scope="col" className="w-14 py-2 pr-2">Rank</th>
          <th scope="col" className="py-2 pr-2">Student</th>
          <th scope="col" className="py-2 pr-2 text-right">Score</th>
          <th scope="col" className="hidden py-2 pr-2 text-right sm:table-cell">Accuracy</th>
          <th scope="col" className="hidden py-2 pr-2 text-right sm:table-cell">Time</th>
          <th scope="col" className="py-2 text-right">
            <span className="sm:hidden" aria-hidden>%ile</span>
            <span className="sr-only sm:not-sr-only">Percentile</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={`row-${r.position}`}
            className={cn(
              "border-b border-[var(--color-border)] last:border-0",
              r.isSelf && "bg-[var(--color-primary)]/10 shadow-[inset_4px_0_0_var(--color-primary)]"
            )}
            data-self={r.isSelf ? "true" : undefined}
            aria-current={r.isSelf ? "true" : undefined}
          >
            <td className="py-2.5 pl-2 pr-2 font-semibold text-[var(--color-foreground)]">#{r.rank}</td>
            <td className="py-2.5 pr-2">
              <span className="flex items-center gap-1.5">
                <span className={cn("truncate", r.isSelf ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-foreground)]")}>
                  {r.displayName}
                </span>
                {r.isSelf ? <YouBadge /> : null}
              </span>
              <span className="block text-[11px] text-[var(--color-muted-foreground)] sm:hidden">
                {Math.round(r.accuracy * 100)}% · {formatDuration(r.timeTakenSeconds)}
              </span>
            </td>
            <td className="py-2.5 pr-2 text-right text-[var(--color-foreground)]">{scoreText(r.score)}</td>
            <td className="hidden py-2.5 pr-2 text-right text-[var(--color-muted-foreground)] sm:table-cell">{Math.round(r.accuracy * 100)}%</td>
            <td className="hidden py-2.5 pr-2 text-right text-[var(--color-muted-foreground)] sm:table-cell">{formatDuration(r.timeTakenSeconds)}</td>
            <td className="py-2.5 text-right text-[var(--color-foreground)]">{formatPercent1(r.percentile)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Ranks around the viewer when they are not on the visible page — no scrolling through hundreds of rows. */
export function YourPositionCard({ rows, self, myPageHref }: { rows: LeaderboardRow[]; self: LeaderboardRow; myPageHref: string }) {
  return (
    <Card className="border-[var(--color-primary)]/40" data-testid="your-position">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4 text-[var(--color-primary)]" aria-hidden /> Your Position
        </CardTitle>
        <CardDescription>
          #{self.rank} · Percentile {formatPercent1(self.percentile)} · Top {formatPercent1(self.topPercent)}% ·{" "}
          <Link href={myPageHref} className="text-[var(--color-primary)] hover:underline">
            Show my page
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <LeaderboardTable rows={rows} caption="Students ranked around you" testId="your-position-table" />
      </CardContent>
    </Card>
  );
}
