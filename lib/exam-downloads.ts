import { FSO_OMR_SPEC, type NumberedOmrSpec } from "@/lib/omr-numbered";

/** Exam code of Rajasthan Food Safety Officer (RPSC). The code is part of every FSO Question.code, so it is never renamed. */
export const FSO_EXAM_CODE = "RUHS-FSO";

/** Numbered (1–4) OMR layouts by exam code; exams not listed keep the A–D sheet (lib/omr-sheet.ts). */
const NUMBERED_OMR_SPECS: Record<string, NumberedOmrSpec> = { [FSO_EXAM_CODE]: FSO_OMR_SPEC };

export function numberedOmrSpecFor(examCode: string): NumberedOmrSpec | null {
  return NUMBERED_OMR_SPECS[examCode] ?? null;
}
