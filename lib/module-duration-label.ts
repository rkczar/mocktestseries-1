import type { AttemptDurationMode } from "@prisma/client";

/**
 * Human label for a Custom Module's time setting, matching exactly what
 * lib/test-attempt.ts#startFromCustomModuleRow will freeze onto the attempt.
 */
export function moduleDurationLabel(m: { durationMode: AttemptDurationMode; durationMinutes: number | null; questionCount: number }): string {
  switch (m.durationMode) {
    case "UNLIMITED":
      return "No time limit";
    case "PER_QUESTION":
      return `${Math.max(m.questionCount, 1)} min (1/question)`;
    case "CUSTOM":
      return `${m.durationMinutes ?? 0} min`;
    default:
      return `${m.durationMinutes ?? 30} min`;
  }
}
