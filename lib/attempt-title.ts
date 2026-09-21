/**
 * Single place that turns a TestAttempt into the human-facing title used by
 * the instructions, run, result, review, history and dashboard pages. Each
 * test type is resolved here so display never drifts between pages.
 */

export interface TitleableAttempt {
  mockTest?: { title?: string | null } | null;
  customModule?: { title?: string | null } | null;
  previousYearPaper?: { title?: string | null; year?: number | null } | null;
  grandTest?: { title?: string | null } | null;
  liveTest?: { title?: string | null } | null;
  subject?: { name?: string | null } | null;
  exam?: { name?: string | null } | null;
}

export function attemptTitle(attempt: TitleableAttempt): string {
  if (attempt.mockTest?.title) return attempt.mockTest.title;
  if (attempt.customModule?.title) return attempt.customModule.title;
  if (attempt.previousYearPaper?.title) {
    return attempt.previousYearPaper.year
      ? `${attempt.previousYearPaper.title} (${attempt.previousYearPaper.year})`
      : attempt.previousYearPaper.title;
  }
  if (attempt.grandTest?.title) return attempt.grandTest.title;
  if (attempt.liveTest?.title) return attempt.liveTest.title;
  if (attempt.subject?.name) return `${attempt.subject.name} — Subject Test`;
  return attempt.exam?.name ?? "Test";
}

/**
 * Instructions to show on the pre-test overview screen. Mock tests and custom
 * modules carry their own; everything else falls back to the exam-level
 * instructions (subject tests included).
 */
interface InstructableAttempt {
  mockTest?: { instructions?: string | null } | null;
  customModule?: { instructions?: string | null } | null;
  grandTest?: { instructions?: string | null } | null;
  liveTest?: { instructions?: string | null } | null;
  exam?: { instructions?: string | null } | null;
}

export function attemptInstructions(attempt: InstructableAttempt): string | null {
  return (
    attempt.mockTest?.instructions ??
    attempt.customModule?.instructions ??
    attempt.grandTest?.instructions ??
    attempt.liveTest?.instructions ??
    attempt.exam?.instructions ??
    null
  );
}