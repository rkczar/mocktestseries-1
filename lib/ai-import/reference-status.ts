/**
 * The status of one reference paper, in four explicit words (pure; shared by the paper summary and the reference
 * panel):
 *   stored          — the original file is kept in the vault (always, once added);
 *   text extracted  — questions / answer-key entries were read from it without AI (a digital PDF, DOCX or sheet);
 *   compared        — Verify 1 compared this paper's questions with it (per question, with the differences found);
 *   not compared    — nothing could be read from it (scanned pages / an image need OCR or vision, which is paid AI
 *                     and only ever run after its cost is shown and confirmed), or Verify 1 has not run since.
 * A reference is evidence only: it never changes the question paper.
 */
export type ReferenceState = "text extracted" | "compared" | "not compared";

export interface ReferenceStatus {
  stored: true;
  extracted: { questions: number; key: number } | null;
  /** Questions of this paper Verify 1 compared with the reference (0 = not compared). */
  comparedQuestions: number;
  state: ReferenceState;
  /** Why it is not compared, in plain words. */
  reason: string | null;
}

export function referenceStatus(ref: { questions: number; key: number; scannedPages: number }, comparedQuestions: number): ReferenceStatus {
  const extracted = ref.questions > 0 || ref.key > 0 ? { questions: ref.questions, key: ref.key } : null;
  if (!extracted) return { stored: true, extracted: null, comparedQuestions: 0, state: "not compared", reason: ref.scannedPages > 0 ? `${ref.scannedPages} scanned page(s) without a text layer — reading them needs OCR / vision (paid AI); its estimated cost is shown with Verify 2 and nothing is read without your confirmation` : "no question or answer-key entry could be read from it" };
  if (!comparedQuestions) return { stored: true, extracted, comparedQuestions: 0, state: "text extracted", reason: "Verify 1 has not compared it yet — run Verify 1 (free)" };
  return { stored: true, extracted, comparedQuestions, state: "compared", reason: null };
}

export function referenceStatusText(s: ReferenceStatus): string {
  const ext = s.extracted ? `text extracted (${s.extracted.questions} question(s)${s.extracted.key ? `, ${s.extracted.key} answer-key entries` : ""})` : "no text extracted";
  return `Stored · ${ext} · ${s.state === "compared" ? `compared with ${s.comparedQuestions} question(s)` : `NOT compared — ${s.reason}`}`;
}
