/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH (see ops/TEST-ENGINE.md).
 *
 * The ONE student-facing attempt configuration model: time mode + answer
 * review mode, chosen before a NEW attempt exists and frozen onto it
 * (TestAttempt.durationMode / durationMinutes / answerMode). Pure — no
 * prisma, no server-only — so the setup forms (client) and every start
 * action (server) share the exact same choices, labels and validation.
 *
 * Which time modes a test offers is per test type:
 *  - Mock Test / Previous Year Paper: Standard (the admin-configured
 *    duration, FIXED), 1 minute per question, Custom. Never Unlimited — these
 *    tests have no unlimited concept and none is invented here.
 *  - Custom Module / Subject Test practice: 1 minute per question,
 *    Unlimited, Custom (unchanged from before).
 * The server re-validates every value; the forms only collect choices.
 */

/** Hard ceiling for a student-entered CUSTOM duration (minutes). */
export const MAX_CUSTOM_DURATION_MINUTES = 600;

export type TimeMode = "FIXED" | "PER_QUESTION" | "CUSTOM" | "UNLIMITED";
export type AnswerReviewMode = "EXAM" | "INSTANT";

export const FORMAL_TIME_MODES = ["FIXED", "PER_QUESTION", "CUSTOM"] as const satisfies readonly TimeMode[];
export const PRACTICE_TIME_MODES = ["PER_QUESTION", "UNLIMITED", "CUSTOM"] as const satisfies readonly TimeMode[];

export const TIME_MODE_LABELS: Record<TimeMode, string> = {
  FIXED: "Standard test time",
  PER_QUESTION: "1 minute per question",
  CUSTOM: "Custom time",
  UNLIMITED: "Unlimited time",
};

export const ANSWER_MODE_OPTIONS: readonly { value: AnswerReviewMode; label: string; hint: string }[] = [
  {
    value: "EXAM",
    label: "Show answers after completing the test",
    hint: "Exam style: answers and explanations appear in Review after you submit.",
  },
  {
    value: "INSTANT",
    label: "Show answer after each question",
    hint: "Choose an option and tap “Check Answer”. That locks your answer, then shows the correct answer and explanation.",
  },
];

export interface AttemptConfigChoice {
  durationMode: TimeMode;
  /** Only for CUSTOM: whole minutes, 1..MAX_CUSTOM_DURATION_MINUTES. */
  customMinutes?: number;
  answerMode: AnswerReviewMode;
}

/** Whole-minute custom duration, or null when it is not a safe value. */
export function parseCustomMinutes(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= MAX_CUSTOM_DURATION_MINUTES ? raw : null;
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw.trim())) return null;
  return parseCustomMinutes(Number(raw.trim()));
}

/**
 * Reads + validates the setup form fields (`durationMode`, `customMinutes`,
 * `answerMode`). `defaultMode` is used only when the field is absent.
 */
export function parseAttemptConfigForm(
  formData: FormData,
  allowed: readonly TimeMode[],
  defaultMode: TimeMode
): { ok: true; config: AttemptConfigChoice } | { ok: false; error: string } {
  const read = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const durationRaw = read("durationMode") || defaultMode;
  const durationMode = allowed.find((m) => m === durationRaw);
  if (!durationMode) return { ok: false, error: "Choose a valid time option." };

  let customMinutes: number | undefined;
  if (durationMode === "CUSTOM") {
    const parsed = parseCustomMinutes(read("customMinutes"));
    if (parsed === null) {
      return { ok: false, error: `Custom time must be a whole number of minutes between 1 and ${MAX_CUSTOM_DURATION_MINUTES}.` };
    }
    customMinutes = parsed;
  }

  const answerRaw = read("answerMode") || "EXAM";
  if (answerRaw !== "EXAM" && answerRaw !== "INSTANT") return { ok: false, error: "Choose when to see the answers." };
  return { ok: true, config: { durationMode, customMinutes, answerMode: answerRaw } };
}

/** Minutes a choice resolves to for display (the server computes the frozen value itself). */
export function previewMinutes(mode: TimeMode, questionCount: number, standardMinutes: number | null, customMinutes: number | null): number | null {
  if (mode === "UNLIMITED") return null;
  if (mode === "FIXED") return standardMinutes;
  if (mode === "CUSTOM") return customMinutes;
  return Math.max(questionCount, 1);
}
