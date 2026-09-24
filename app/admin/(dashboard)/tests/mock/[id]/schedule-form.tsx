"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { AVAILABILITY_MODE_LABELS, RESULT_RELEASE_LABELS, type MockAvailabilityMode } from "@/lib/mock-test-schedule";
import { updateMockTestAccessAction, updateMockTestScheduleAction, type ScheduleFormState } from "../actions";

function SubmitButton({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

const MODE_HELP: Record<MockAvailabilityMode, string> = {
  AVAILABLE_NOW: "Open to students as soon as the test is Published. Never closes.",
  SCHEDULED_RELEASE: "UPCOMING / locked before the release time, AVAILABLE from it onwards. Never closes.",
  FIXED_WINDOW: "UPCOMING before the start, LIVE NOW during the window, CLOSED after the end — no new attempts after it, and in-progress attempts end at it.",
};

/** Step 4 — Schedule & Availability. Server time (IST shown) is the only authority. */
export function ScheduleForm({
  mockTestId,
  mode: initialMode,
  availableFromValue,
  availableUntilValue,
  readOnly,
}: {
  mockTestId: string;
  mode: MockAvailabilityMode;
  availableFromValue: string;
  availableUntilValue: string;
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<ScheduleFormState, FormData>(updateMockTestScheduleAction.bind(null, mockTestId), {});
  const [mode, setMode] = useState<MockAvailabilityMode>(initialMode);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <fieldset className="grid gap-2 sm:grid-cols-3" disabled={readOnly}>
        <legend className="sr-only">Availability mode</legend>
        {(Object.keys(AVAILABILITY_MODE_LABELS) as MockAvailabilityMode[]).map((m) => (
          <label
            key={m}
            className={`flex cursor-pointer flex-col gap-1 rounded-[var(--radius-card)] border p-3 text-sm ${
              mode === m ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-[var(--color-border)]"
            }`}
          >
            <span className="flex items-center gap-2 font-medium text-[var(--color-foreground)]">
              <input type="radio" name="availabilityMode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              {AVAILABILITY_MODE_LABELS[m]}
            </span>
            <span className="text-xs text-[var(--color-muted-foreground)]">{MODE_HELP[m]}</span>
          </label>
        ))}
      </fieldset>

      {mode !== "AVAILABLE_NOW" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="availableFrom">{mode === "FIXED_WINDOW" ? "Start (IST)" : "Release (IST)"}</Label>
            <Input id="availableFrom" name="availableFrom" type="datetime-local" defaultValue={availableFromValue} required disabled={readOnly} />
          </div>
          {mode === "FIXED_WINDOW" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="availableUntil">End (IST)</Label>
              <Input id="availableUntil" name="availableUntil" type="datetime-local" defaultValue={availableUntilValue} required disabled={readOnly} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label="Save Schedule" disabled={readOnly} />
        {readOnly ? <p className="text-xs text-[var(--color-muted-foreground)]">Read-only — Master Admin manages schedules.</p> : null}
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Schedule saved.</p> : null}
      </div>
    </form>
  );
}

/** Step 5 — Access & Result: FREE/PAID, attempt policy, result release and leaderboard. */
export function AccessResultForm({
  mockTestId,
  values,
  isFixedWindow,
  readOnly,
}: {
  mockTestId: string;
  values: {
    accessType: "FREE" | "PAID";
    attemptPolicy: "SINGLE_ATTEMPT" | "MULTIPLE_PRACTICE";
    resultReleaseMode: "IMMEDIATE" | "AFTER_WINDOW" | "CUSTOM_DATE";
    resultReleaseAtValue: string;
    leaderboardEnabled: boolean;
  };
  isFixedWindow: boolean;
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<ScheduleFormState, FormData>(updateMockTestAccessAction.bind(null, mockTestId), {});
  const [release, setRelease] = useState(values.resultReleaseMode);

  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <fieldset className="contents" disabled={readOnly}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="accessType">Access</Label>
          <SelectNative id="accessType" name="accessType" defaultValue={values.accessType}>
            <option value="FREE">FREE — anyone signed in</option>
            <option value="PAID">PAID — needs a Test Series / Exam entitlement</option>
          </SelectNative>
          <p className="text-[11px] text-[var(--color-muted-foreground)]">Prices and entitlements are managed in Payments → Products.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="attemptPolicy">Attempt policy</Label>
          <SelectNative id="attemptPolicy" name="attemptPolicy" defaultValue={values.attemptPolicy}>
            <option value="MULTIPLE_PRACTICE">Multiple practice attempts</option>
            <option value="SINGLE_ATTEMPT">Single attempt</option>
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="resultReleaseMode">Result release</Label>
          <SelectNative id="resultReleaseMode" name="resultReleaseMode" value={release} onChange={(e) => setRelease(e.target.value as typeof release)}>
            {(Object.keys(RESULT_RELEASE_LABELS) as (keyof typeof RESULT_RELEASE_LABELS)[]).map((k) => (
              <option key={k} value={k} disabled={k === "AFTER_WINDOW" && !isFixedWindow}>
                {RESULT_RELEASE_LABELS[k]}
                {k === "AFTER_WINDOW" && !isFixedWindow ? " (needs a Fixed Window)" : ""}
              </option>
            ))}
          </SelectNative>
          <p className="text-[11px] text-[var(--color-muted-foreground)]">
            Until release, students see “Result Pending” — score, answer review and Ask AI stay locked server-side.
          </p>
        </div>
        {release === "CUSTOM_DATE" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resultReleaseAt">Result release (IST)</Label>
            <Input id="resultReleaseAt" name="resultReleaseAt" type="datetime-local" defaultValue={values.resultReleaseAtValue} required />
          </div>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)] sm:col-span-2">
          <input type="checkbox" name="leaderboardEnabled" defaultChecked={values.leaderboardEnabled} />
          Show leaderboard on the result page (first submission per student, ranked by score)
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton label="Save Access & Result" disabled={readOnly} />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      </div>
    </form>
  );
}
