-- ReportedQuestion has zero rows as of this migration (confirmed before
-- writing it), so renaming rather than adding-and-orphaning is safe: no data
-- depends on the old labels, and the only two call sites that referenced
-- them (components/student/report-question-dialog.tsx, lib/student-data.ts)
-- are updated in the same change. Aligns the taxonomy with Step 6.7:
-- Wrong Answer / Wrong Question / Incorrect Explanation / Image Issue / Other.
ALTER TYPE "ReportType" RENAME VALUE 'WRONG_OPTION' TO 'WRONG_QUESTION';
ALTER TYPE "ReportType" RENAME VALUE 'TYPO' TO 'INCORRECT_EXPLANATION';
ALTER TYPE "ReportType" RENAME VALUE 'DUPLICATE' TO 'IMAGE_ISSUE';
