import "server-only";
import { AttemptStatus, AttemptSourceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface LeaderboardEntry {
  rank: number;
  studentId: string;
  displayName: string;
  isSelf: boolean;
  score: number;
  accuracy: number;
  timeTakenSeconds: number;
  submittedAt: Date;
}

export interface MockTestLeaderboard {
  totalParticipants: number;
  entries: LeaderboardEntry[];
  selfEntry: LeaderboardEntry | null;
}

function safeDisplayName(name: string, studentId: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : `Student ${studentId.slice(-4).toUpperCase()}`;
}

function accuracyOf(correct: number, incorrect: number): number {
  const attempted = correct + incorrect;
  return attempted > 0 ? correct / attempted : 0;
}

/**
 * Leaderboard eligibility is entirely pre-filtered by isLeaderboardAttempt
 * (set once, at first submission — see lib/test-attempt.ts#submitAttempt),
 * so this never has to re-derive "first attempt" itself. Rank is computed
 * live on every read from a deterministic sort — score DESC, accuracy DESC,
 * timeTakenSeconds ASC, submittedAt ASC — and is never persisted, so it can
 * never go stale as new submissions arrive. Never exposes phone/email; only
 * a display name (with a masked fallback) per student.
 */
export async function getMockTestLeaderboard(
  mockTestId: string,
  studentId: string,
  limit = 20
): Promise<MockTestLeaderboard> {
  const attempts = await prisma.testAttempt.findMany({
    where: {
      mockTestId,
      sourceType: AttemptSourceType.MOCK_TEST,
      status: AttemptStatus.SUBMITTED,
      isLeaderboardAttempt: true,
    },
    select: {
      studentId: true,
      score: true,
      correctCount: true,
      incorrectCount: true,
      timeTakenSeconds: true,
      submittedAt: true,
      student: { select: { name: true } },
    },
  });

  const ranked = attempts
    .map((a) => ({
      studentId: a.studentId,
      displayName: safeDisplayName(a.student.name, a.studentId),
      score: a.score ?? 0,
      accuracy: accuracyOf(a.correctCount ?? 0, a.incorrectCount ?? 0),
      timeTakenSeconds: a.timeTakenSeconds ?? 0,
      submittedAt: a.submittedAt ?? new Date(0),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      if (a.timeTakenSeconds !== b.timeTakenSeconds) return a.timeTakenSeconds - b.timeTakenSeconds;
      return a.submittedAt.getTime() - b.submittedAt.getTime();
    })
    .map((entry, index) => ({ ...entry, rank: index + 1, isSelf: entry.studentId === studentId }));

  return {
    totalParticipants: ranked.length,
    entries: ranked.slice(0, limit),
    selfEntry: ranked.find((e) => e.isSelf) ?? null,
  };
}
