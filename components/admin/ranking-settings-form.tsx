"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { updateTestRankingAction, type RankingFormState } from "@/app/admin/(dashboard)/tests/ranking-actions";

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled}>
      {pending ? "Saving…" : "Save Ranking Settings"}
    </Button>
  );
}

/**
 * Ranking & Leaderboard settings (TestRankingConfig) — shared by the Mock
 * Test editor and the Previous Year Paper page. A paper never counts toward
 * Overall Rank, so it gets no control for it, only the explanation.
 */
export function RankingSettingsForm({
  kind,
  testId,
  values,
  readOnly,
}: {
  kind: "MOCK_TEST" | "PREVIOUS_YEAR_PAPER";
  testId: string;
  values: { leaderboardEnabled: boolean; countsTowardOverall: boolean };
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<RankingFormState, FormData>(updateTestRankingAction.bind(null, kind, testId), {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-4" disabled={readOnly}>
        <label className="flex items-start gap-2 text-sm text-[var(--color-foreground)]">
          <input type="checkbox" name="leaderboardEnabled" defaultChecked={values.leaderboardEnabled} className="mt-1" />
          <span>
            <span className="font-medium">Leaderboard Enabled</span>
            <span className="block text-xs text-[var(--color-muted-foreground)]">
              Students see their rank, percentile and the per-{kind === "MOCK_TEST" ? "test" : "paper"} leaderboard after submitting. Each student&apos;s
              first attempt in Exam Mode with Standard time is ranked; retakes, Practice Mode, custom time and OMR entry are not, and a
              student who practised first is not ranked.
            </span>
          </span>
        </label>
        {kind === "MOCK_TEST" ? (
          <label className="flex items-start gap-2 text-sm text-[var(--color-foreground)]">
            <input type="checkbox" name="countsTowardOverall" defaultChecked={values.countsTowardOverall} className="mt-1" />
            <span>
              <span className="font-medium">Counts Toward Overall Ranking</span>
              <span className="block text-xs text-[var(--color-muted-foreground)]">
                Off by default. Prepares this test for the exam-level Overall Rank (coming next): average per-test percentile across
                selected Mock Tests, after at least 3 ranked tests. Students don&apos;t see an Overall Rank yet.
              </span>
            </span>
          </label>
        ) : (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
            Counts Toward Overall Ranking: <strong>not applicable</strong>. Previous Year Papers have their own leaderboard and never contribute
            to Overall Rank.
          </p>
        )}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton disabled={readOnly} />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      </div>
    </form>
  );
}
