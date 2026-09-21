/**
 * The AI Variants catalog itself — no "server-only" import, since this is
 * plain data referenced by both the generation code (lib/ai-explanation-
 * variants.ts) and the client-side variant picker (components/student/
 * explanation-panel.tsx). A small, fixed, code-defined list — never
 * arbitrary client input — hard-capped at 5 entries.
 */
export interface ExplanationVariantDef {
  id: string;
  label: string;
  /** Appended to the same structured-JSON prompt shape used for the default explanation. Server-only concern, but harmless to ship the string to the client. */
  instruction: string;
}

export const EXPLANATION_VARIANTS: ExplanationVariantDef[] = [
  {
    id: "simpler",
    label: "Simpler Explanation",
    instruction: "Explain this in very plain, beginner-friendly language — short sentences, no jargon, as if teaching someone new to the subject.",
  },
  {
    id: "exam-trick",
    label: "Exam Trick & Memory Aid",
    instruction: "Focus heavily on exam-taking tricks, mnemonics, and the specific traps examiners set on this topic — less theory, more \"how to answer this fast and correctly next time.\"",
  },
  {
    id: "step-by-step",
    label: "Step-by-Step Breakdown",
    instruction: "Walk through the reasoning as clear, numbered sequential steps from question to correct answer, as if thinking out loud.",
  },
];

if (EXPLANATION_VARIANTS.length > 5) {
  throw new Error("EXPLANATION_VARIANTS may never exceed 5 entries.");
}

export function getVariantDef(variantId: string): ExplanationVariantDef | undefined {
  return EXPLANATION_VARIANTS.find((v) => v.id === variantId);
}
