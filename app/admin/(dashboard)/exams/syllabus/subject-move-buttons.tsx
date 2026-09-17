"use client";

import { MoveButtons } from "./move-buttons";
import { moveSubjectAction } from "./actions";

/**
 * Thin client wrapper so the closure over examId/subjectId is created
 * client-side. `subject-panel.tsx` is a Server Component — it can pass
 * MoveButtons a Server Action reference directly (Next.js has special
 * support for that), but never an inline arrow function wrapping one;
 * that throws "Event handlers cannot be passed to Client Component props"
 * at render time. TopicRow avoids this the same way, by being "use client"
 * itself and building its own onMove closure internally.
 */
export function SubjectMoveButtons({
  examId,
  subjectId,
  label,
  disableUp,
  disableDown,
}: {
  examId: string;
  subjectId: string;
  label: string;
  disableUp: boolean;
  disableDown: boolean;
}) {
  return (
    <MoveButtons
      label={label}
      disableUp={disableUp}
      disableDown={disableDown}
      onMove={(direction) => moveSubjectAction(examId, subjectId, direction)}
    />
  );
}
