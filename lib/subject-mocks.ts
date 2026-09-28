import type { MockCoverageType } from "@prisma/client";

/**
 * Subject Mock Tests — a PRESENTATION category of the one canonical MockTest
 * (same builder, same TestAttempt engine, same results). A mock is a Subject
 * Mock when its coverage is SUBJECT_WISE over exactly one canonical Subject
 * (enforced on save in app/admin/(dashboard)/tests/mock/actions.ts); every
 * other mock is Full / General. Nothing here touches question ownership or
 * PYQ membership — a Subject Mock only REFERENCES its questions.
 */
export function subjectMockSubjectId(mock: { coverageType: MockCoverageType; coverageSubjectIds: string[] }): string | null {
  return mock.coverageType === "SUBJECT_WISE" && mock.coverageSubjectIds.length === 1 ? mock.coverageSubjectIds[0] : null;
}
