/** Review categories stored as the prefix of Question.reviewReason (client-safe; existing convention, no new enum). */
export const REVIEW_CATEGORIES = ["REVIEW_REQUIRED", "OCR_UNCERTAIN", "ANSWER_UNVERIFIED", "SOURCE_MISMATCH", "IMAGE_REVIEW_REQUIRED"] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/** The category of a review reason ("OCR_UNCERTAIN — …"); null when none / reviewed. */
export function reviewCategoryOf(reason: string | null | undefined): ReviewCategory | null {
  const head = (reason ?? "").split(/[\s—:-]/)[0];
  return (REVIEW_CATEGORIES as readonly string[]).includes(head) ? (head as ReviewCategory) : null;
}
