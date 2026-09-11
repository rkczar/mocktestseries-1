import "server-only";

export type ScorableQuestion = {
  id: string;
  marks: number;
  correctAnswer: string;
  subjectId: string | null;
  subjectName: string | null;
};

export type SubjectBreakdown = {
  subjectId: string;
  subjectName: string;
  total: number;
  attempted: number;
  correct: number;
  incorrect: number;
  marks: number;
};

export type AttemptAnalytics = {
  totalQuestions: number;
  attempted: number;
  unattempted: number;
  correct: number;
  incorrect: number;
  accuracy: number; // percent of attempted questions answered correctly
  maxMarks: number;
  timeTakenSec: number;
  subjectBreakdown: SubjectBreakdown[];
};

export type AttemptScore = {
  score: number;
  analytics: AttemptAnalytics;
};

/**
 * Uniform negative marking (one penalty value per wrong answer, applied by the test regardless
 * of that question's own mark weight) — the standard scheme for the competitive-exam mocks this
 * app targets, and what Test.negativeMark models.
 */
export function scoreAttempt(
  questions: ScorableQuestion[],
  answers: Record<string, string>,
  negativeMark: number,
  timeTakenSec: number,
): AttemptScore {
  let score = 0;
  let correct = 0;
  let incorrect = 0;
  let attempted = 0;
  const maxMarks = questions.reduce((sum, q) => sum + q.marks, 0);

  const bySubject = new Map<string, SubjectBreakdown>();
  const subjectKey = (q: ScorableQuestion) => q.subjectId ?? "unassigned";
  const subjectName = (q: ScorableQuestion) => q.subjectName ?? "Unassigned";

  for (const question of questions) {
    const key = subjectKey(question);
    if (!bySubject.has(key)) {
      bySubject.set(key, {
        subjectId: key,
        subjectName: subjectName(question),
        total: 0,
        attempted: 0,
        correct: 0,
        incorrect: 0,
        marks: 0,
      });
    }
    const bucket = bySubject.get(key)!;
    bucket.total += 1;

    const studentAnswer = answers[question.id];
    if (!studentAnswer) continue;

    attempted += 1;
    bucket.attempted += 1;

    if (studentAnswer === question.correctAnswer) {
      correct += 1;
      score += question.marks;
      bucket.correct += 1;
      bucket.marks += question.marks;
    } else {
      incorrect += 1;
      score -= negativeMark;
      bucket.incorrect += 1;
      bucket.marks -= negativeMark;
    }
  }

  return {
    score,
    analytics: {
      totalQuestions: questions.length,
      attempted,
      unattempted: questions.length - attempted,
      correct,
      incorrect,
      accuracy: attempted > 0 ? Math.round((correct / attempted) * 1000) / 10 : 0,
      maxMarks,
      timeTakenSec,
      subjectBreakdown: [...bySubject.values()].sort((a, b) => b.total - a.total),
    },
  };
}
