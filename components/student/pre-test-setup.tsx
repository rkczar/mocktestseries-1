"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnswerModeField, TimeModeField } from "@/components/student/test-mode-fields";
import { FORMAL_TIME_MODES } from "@/lib/attempt-config";
import { startConfiguredTestAction, type PreTestSetupState } from "@/app/student/attempt/resume/actions";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Starting…" : (
        <>
          {label} <ArrowRight className="h-4 w-4" aria-hidden />
        </>
      )}
    </Button>
  );
}

/**
 * Pre-Test Setup for a NEW Mock Test / Previous Year Paper attempt: time mode
 * and answer review mode, then Start. Rendered only after the server's own
 * gates passed (entitlement, Platform Controls, availability) and only when
 * no attempt is running. Defaults (Standard time, answers after the test)
 * are exactly the formal exam. The server action re-validates everything and
 * freezes the choice onto the attempt.
 */
export function PreTestSetup({
  kind,
  testId,
  questionCount,
  standardMinutes,
  submitLabel = "Start Test",
}: {
  kind: "MOCK_TEST" | "PREVIOUS_YEAR_PAPER";
  testId: string;
  questionCount: number;
  standardMinutes: number;
  submitLabel?: string;
}) {
  const [state, formAction] = useActionState<PreTestSetupState, FormData>(startConfiguredTestAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="pre-test-setup">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="testId" value={testId} />
      <Card>
        <CardHeader>
          <CardTitle>Set up your test</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <TimeModeField modes={FORMAL_TIME_MODES} defaultMode="FIXED" questionCount={questionCount} standardMinutes={standardMinutes} />
          <AnswerModeField />
          <p className="text-xs text-[var(--color-muted-foreground)] sm:col-span-2">
            Your choices are locked once the test starts.
            {kind === "MOCK_TEST" ? " Only attempts with Standard time and answers after the test count for the leaderboard." : ""}
          </p>
        </CardContent>
      </Card>
      <SubmitButton label={submitLabel} />
      {state.error ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
        </p>
      ) : null}
    </form>
  );
}
