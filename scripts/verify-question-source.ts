/**
 * QB source evidence + review workflow regressions (2026-11-26). Pure: no DB, no AI, no network.
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=postgresql://unused/none npx tsx scripts/verify-question-source.ts
 */
import { reviewCategoryOf } from "@/lib/question-source/review";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
};

// Review categories (Question.reviewReason prefix)
ok("OCR_UNCERTAIN prefix", reviewCategoryOf("OCR_UNCERTAIN — imported as DRAFT…") === "OCR_UNCERTAIN");
ok("ANSWER_UNVERIFIED prefix", reviewCategoryOf("ANSWER_UNVERIFIED — no official key entry") === "ANSWER_UNVERIFIED");
ok("REVIEWED is not a category", reviewCategoryOf("REVIEWED 2026-11-26 10:00 UTC") === null);
ok("legacy free-text reason → null", reviewCategoryOf("AI importer: an image did not survive") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
