"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  ANSWER_MODE_OPTIONS,
  MAX_CUSTOM_DURATION_MINUTES,
  TIME_MODE_LABELS,
  type AnswerReviewMode,
  type TimeMode,
} from "@/lib/attempt-config";

/**
 * The ONE set of attempt-configuration fields, shared by every pre-test
 * form: the Mock/PYQ Pre-Test Setup and UniversalTestSetup (Custom Module,
 * Subject Test). Sequential, not side by side: the student first chooses how
 * to review answers; only "Show answers after completing the test" (Exam
 * Mode) then asks for a duration. "Show answer after each question"
 * (Practice Mode) is untimed, so no time field is rendered or posted. Field
 * names (`answerMode`, `durationMode`, `customMinutes`) are what every start
 * action parses through lib/attempt-config.ts#parseAttemptConfigForm.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function timeHint(mode: TimeMode, questionCount: number, standardMinutes: number | null): string {
  switch (mode) {
    case "FIXED":
      return standardMinutes ? `Use the duration configured for this test (${plural(standardMinutes, "minute")}).` : "Use the duration configured for this test.";
    case "PER_QUESTION":
      return `${plural(questionCount, "question")} = ${plural(Math.max(questionCount, 1), "minute")}`;
    case "UNLIMITED":
      return "No countdown, no auto-submit";
    case "CUSTOM":
      return "Choose your own duration.";
  }
}

function TimeModeField({
  modes,
  defaultMode,
  questionCount,
  standardMinutes = null,
}: {
  modes: readonly TimeMode[];
  defaultMode: TimeMode;
  questionCount: number;
  standardMinutes?: number | null;
}) {
  const [mode, setMode] = useState<TimeMode>(defaultMode);
  const [customMinutes, setCustomMinutes] = useState(String(standardMinutes && standardMinutes <= MAX_CUSTOM_DURATION_MINUTES ? standardMinutes : 30));

  return (
    <fieldset className="flex flex-col gap-1.5" data-testid="time-mode-field">
      <legend className="mb-1.5 text-sm font-medium text-[var(--color-foreground)]">Choose test duration</legend>
      {modes.map((m) => (
        <label key={m} className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name="durationMode"
            value={m}
            checked={mode === m}
            onChange={() => setMode(m)}
            className="mt-1 accent-[var(--color-primary)]"
          />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">{TIME_MODE_LABELS[m]}</span>
            <span className="block text-xs text-[var(--color-muted-foreground)]">{timeHint(m, questionCount, standardMinutes)}</span>
          </span>
        </label>
      ))}
      {mode === "CUSTOM" ? (
        <div className="flex items-center gap-2 pl-6">
          <Input
            id="customMinutes"
            name="customMinutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_CUSTOM_DURATION_MINUTES}
            step={1}
            required
            aria-label="Custom time in minutes"
            value={customMinutes}
            onChange={(e) => setCustomMinutes(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
            className="w-24"
          />
          <span className="text-xs text-[var(--color-muted-foreground)]">minutes total (1–{MAX_CUSTOM_DURATION_MINUTES})</span>
        </div>
      ) : null}
    </fieldset>
  );
}

export function AttemptModeFields({
  timeModes,
  defaultTimeMode,
  questionCount,
  standardMinutes = null,
  defaultAnswerMode = "EXAM",
  onAnswerModeChange,
}: {
  /** Exam Mode duration choices of this test type (lib/attempt-config.ts). */
  timeModes: readonly TimeMode[];
  defaultTimeMode: TimeMode;
  questionCount: number;
  standardMinutes?: number | null;
  defaultAnswerMode?: AnswerReviewMode;
  onAnswerModeChange?: (mode: AnswerReviewMode) => void;
}) {
  const [answerMode, setAnswerMode] = useState<AnswerReviewMode>(defaultAnswerMode);
  return (
    <div className="flex flex-col gap-5" data-testid="attempt-mode-fields" data-answer-mode={answerMode}>
      <fieldset className="flex flex-col gap-2" data-testid="answer-mode-field">
        <legend className="mb-1.5 text-sm font-medium text-[var(--color-foreground)]">How do you want to review answers?</legend>
        {ANSWER_MODE_OPTIONS.map((m) => (
          <label key={m.value} className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="answerMode"
              value={m.value}
              checked={answerMode === m.value}
              onChange={() => {
                setAnswerMode(m.value);
                onAnswerModeChange?.(m.value);
              }}
              className="mt-1 accent-[var(--color-primary)]"
            />
            <span>
              <span className="font-medium text-[var(--color-foreground)]">{m.label}</span>
              <span className="block text-xs text-[var(--color-muted-foreground)]">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {answerMode === "EXAM" ? (
        <TimeModeField modes={timeModes} defaultMode={defaultTimeMode} questionCount={questionCount} standardMinutes={standardMinutes} />
      ) : null}
    </div>
  );
}

/** What the student should expect in the player for the chosen answer mode (setup pages). */
export function AnswerModeNotes({ answerMode }: { answerMode: AnswerReviewMode }) {
  return answerMode === "INSTANT" ? (
    <>
      <li>Select an option to check your answer. Once checked, that answer is locked.</li>
      <li>You then see the correct answer and explanation before moving on. There is no time limit.</li>
    </>
  ) : (
    <>
      <li>The timer starts when you press Start Test and cannot be paused. The test auto-submits when time runs out.</li>
      <li>You can move between questions and change answers until you submit. Answers and explanations are shown in Review after the test.</li>
    </>
  );
}
