/**
 * QB source evidence + review workflow regressions (2026-11-26). Pure: no DB, no AI, no network.
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=postgresql://unused/none npx tsx scripts/verify-question-source.ts
 */
import { lateKeyDecision } from "@/lib/question-source/late-key";
import { reviewCategoryOf } from "@/lib/question-source/review";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
};
const base = { status: "DRAFT", answerVerification: "UNVERIFIED", reviewReason: null, answerStatus: "OFFICIAL_MATCHED", label: "12", current: ["C"], official: ["B"], optionLabels: ["A", "B", "C", "D"] };

// Late official key (legacy papers imported without a key)
ok("DRAFT with a different answer → UPDATED to the official key", lateKeyDecision(base).action === "UPDATED");
ok("DRAFT same answer, not yet official → CONFIRMED", lateKeyDecision({ ...base, current: ["B"] }).action === "CONFIRMED");
ok("already OFFICIAL_KEY and same → no change", lateKeyDecision({ ...base, current: ["B"], answerVerification: "OFFICIAL_KEY" }).action === null);
const pub = lateKeyDecision({ ...base, status: "PUBLISHED" });
ok("PUBLISHED with a different answer → FLAGGED, never changed", pub.action === "FLAGGED" && /not changed automatically/.test(pub.reason ?? ""), pub);
ok("…flag is not repeated", lateKeyDecision({ ...base, status: "PUBLISHED", reviewReason: pub.reason }).action === null);
ok("key label not among the options → no change", lateKeyDecision({ ...base, official: ["E"] }).action === null);
ok("key withdraws a DRAFT → FLAGGED (not auto-withdrawn)", lateKeyDecision({ ...base, answerStatus: "WITHDRAWN", official: [] }).action === "FLAGGED");
ok("key withdraws an already WITHDRAWN record → no change", lateKeyDecision({ ...base, answerStatus: "WITHDRAWN", status: "WITHDRAWN", official: [] }).action === null);

// Review categories (Question.reviewReason prefix)
ok("OCR_UNCERTAIN prefix", reviewCategoryOf("OCR_UNCERTAIN — imported as DRAFT…") === "OCR_UNCERTAIN");
ok("ANSWER_UNVERIFIED prefix", reviewCategoryOf("ANSWER_UNVERIFIED — no official key entry") === "ANSWER_UNVERIFIED");
ok("REVIEWED is not a category", reviewCategoryOf("REVIEWED 2026-11-26 10:00 UTC") === null);
ok("legacy free-text reason → null", reviewCategoryOf("AI importer: an image did not survive") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
