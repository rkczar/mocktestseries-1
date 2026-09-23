import { Medal, Trophy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { getMockTestLeaderboard } from "@/lib/leaderboard";

export function Leaderboard({
  data,
  isLeaderboardAttempt,
}: {
  data: Awaited<ReturnType<typeof getMockTestLeaderboard>>;
  isLeaderboardAttempt: boolean;
}) {
  if (data.totalParticipants === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-[var(--color-accent)]" aria-hidden /> Leaderboard
        </CardTitle>
        <CardDescription>
          Ranked by score, then accuracy, then time taken, then submission order — first attempt only.{" "}
          {data.totalParticipants} ranked participant{data.totalParticipants === 1 ? "" : "s"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Badge variant={isLeaderboardAttempt ? "primary" : "neutral"} className="w-fit">
          {isLeaderboardAttempt ? "Leaderboard Attempt" : "Practice Retake (not ranked)"}
        </Badge>

        {data.selfEntry ? (
          <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/5 px-3 py-2 text-sm">
            <span className="font-medium text-[var(--color-foreground)]">
              Your Rank: #{data.selfEntry.rank}
              {data.totalParticipants >= 5
                ? ` (Top ${Math.max(1, Math.round(((data.totalParticipants - data.selfEntry.rank + 1) / data.totalParticipants) * 100))}%)`
                : ""}
            </span>
            <span className="text-[var(--color-muted-foreground)]">
              {data.selfEntry.score.toFixed(2)} pts · {Math.round(data.selfEntry.accuracy * 100)}% accuracy
            </span>
          </div>
        ) : null}

        <div className="flex flex-col divide-y divide-[var(--color-border)]">
          {data.entries.map((entry) => (
            <div key={entry.studentId} className="flex items-center justify-between py-2 text-sm">
              <div className="flex items-center gap-2">
                {entry.rank <= 3 ? <Medal className="h-4 w-4 text-[var(--color-accent)]" aria-hidden /> : null}
                <span className={entry.isSelf ? "font-semibold text-[var(--color-primary)]" : "text-[var(--color-foreground)]"}>
                  #{entry.rank} {entry.displayName}
                  {entry.isSelf ? " (You)" : ""}
                </span>
              </div>
              <span className="text-[var(--color-muted-foreground)]">{entry.score.toFixed(2)} pts</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
