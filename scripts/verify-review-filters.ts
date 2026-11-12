/**
 * Pure self-check of lib/ai-import/review-filters.ts and the Quality summary counters (no DB, no AI).
 *   npx tsx scripts/verify-review-filters.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";
import { qualityReport, type QualityQuestion } from "@/lib/ai-import/quality";
import {
  PROBLEM_CODES, PROBLEM_ADVANCED, PROBLEM_MAIN, STATUS_ADVANCED, STATUS_MAIN, STRUCTURE_CODES, TAXONOMY_CODES, VERIFY_ADVANCED, VERIFY_MAIN,
  chipCounts, dbWhere, matches, parseFilters, type FilterRow,
} from "@/lib/ai-import/review-filters";

let n = 0;
const ok = (name: string, cond: boolean, info?: unknown) => {
  assert.ok(cond, `${name} ${info !== undefined ? JSON.stringify(info) : ""}`);
  n++;
  console.log(`ok - ${name}`);
};

// 1. Code lists copied from paper-verify.ts have not drifted.
const pv = readFileSync(new URL("../lib/ai-import/paper-verify.ts", import.meta.url), "utf8");
ok("STRUCTURE_CODES equals paper-verify.ts", pv.includes(`export const STRUCTURE_CODES = ${JSON.stringify(STRUCTURE_CODES).replace(/,/g, ", ")};`));
ok("TAXONOMY_CODES equals paper-verify.ts", pv.includes(`export const TAXONOMY_CODES = ${JSON.stringify(TAXONOMY_CODES).replace(/,/g, ", ")};`));
ok("every problem code is a known issue code", Object.values(PROBLEM_CODES).flat().every((c) => c in ISSUE_DEFS), Object.values(PROBLEM_CODES).flat().filter((c) => !(c in ISSUE_DEFS)));
ok("every problem group has a label (main or advanced)", Object.keys(PROBLEM_CODES).every((k) => k in PROBLEM_MAIN || k in PROBLEM_ADVANCED));
ok("formula group has the ad4d344 codes", ["FORMULA_TEXT_CORRUPT", "FORMULA_NEEDS_MANUAL_VERIFICATION"].every((c) => PROBLEM_CODES.formula.includes(c)));

// 2. Every OLD URL value still resolves to itself (nothing removed).
const OLD_STATUS = ["approval", ...Object.keys(QUESTION_STATUS_LABELS)];
const OLD_VERIFY = ["verified", "eligible", "v1-problems", "v2-disagree", "v2-noresult", "v2-notrun", "unverified", "field-problems", "memory"];
const OLD_PROBLEM = ["structure", "taxonomy", "subject-mismatch", "taxonomy-disagree", "classifier-failed", "model-failure", "answer", "answer-unverified", "reference", "ocr", "source-mismatch", "stem-options", "bilingual"];
ok("old status values parse", OLD_STATUS.every((s) => parseFilters({ status: s }).status === s));
ok("status absent / unknown / exceptions → default list; all → no filter", parseFilters({}).status === "exceptions" && parseFilters({ status: "bogus" }).status === "exceptions" && parseFilters({ status: "exceptions" }).status === "exceptions" && parseFilters({ status: "all" }).status === null);
ok("old verify values parse", OLD_VERIFY.every((v) => parseFilters({ verify: v }).verify === v));
ok("old problem values parse", OLD_PROBLEM.every((p) => parseFilters({ problem: p }).problem === p));
ok("every issue code parses; unknown dropped", Object.keys(ISSUE_DEFS).every((c) => parseFilters({ issue: c }).issue === c) && parseFilters({ issue: "NOPE", verify: "nope", problem: "nope" }).issue === undefined);
ok("new values parse", ["withdrawn", "imported", "unresolved"].every((s) => parseFilters({ status: s }).status === s) && parseFilters({ verify: "notrun" }).verify === "notrun" && ["text", "formula", "options", "answer-key", "images", "duplicates", "rescan"].every((p) => parseFilters({ problem: p }).problem === p));
ok("old problem groups keep their exact code lists", PROBLEM_CODES.structure === STRUCTURE_CODES && PROBLEM_CODES.taxonomy === TAXONOMY_CODES && PROBLEM_CODES.answer.length === 7 && PROBLEM_CODES["model-failure"].join() === "TAXONOMY_CHECK_FAILED,VERIFY2_FAILED,CLASSIFICATION_FAILED");

// 3. Predicates.
const row = (p: Partial<FilterRow>): FilterRow => ({ status: "READY", answerStatus: "OFFICIAL_MATCHED", issueCodes: [], approved: false, stored: false, importBlocker: null, v1: "passed", v2: "verified", eligible: false, fieldProblem: false, memoryProblem: false, ...p });
const R = {
  ready: row({}),
  readyApproved: row({ approved: true }),
  readyApprovedBlocked: row({ approved: true, importBlocker: "keyless list" }),
  nc: row({ status: "NEEDS_CORRECTION", approved: true, issueCodes: ["FORMULA_TEXT_CORRUPT", "TOPIC_UNCERTAIN"], v2: "stale" }),
  extracted: row({ status: "EXTRACTED", v1: "none", v2: "none" }),
  dup: row({ status: "DUPLICATE" }),
  dupFlag: row({ issueCodes: ["DUPLICATE_NEAR"], v2: "disagree" }),
  rejected: row({ status: "REJECTED", issueCodes: ["ANSWER_UNVERIFIED"] }),
  imported: row({ status: "IMPORTED", stored: true, approved: true }),
  published: row({ status: "PUBLISHED", stored: true, approved: true }),
  withdrawnKey: row({ answerStatus: "WITHDRAWN" }),
  withdrawnFlag: row({ status: "NEEDS_CORRECTION", issueCodes: ["POSSIBLE_WITHDRAWN"], memoryProblem: true, fieldProblem: true }),
};
const all = Object.values(R);
const pick = (sp: Record<string, string>) => Object.entries(R).filter(([, r]) => matches(r, parseFilters(sp))).map(([k]) => k).join();
ok("default (Needs review) = old exception statuses", pick({}) === "nc,extracted,dup,withdrawnFlag", pick({}));
ok("all = every row incl. rejected", pick({ status: "all" }).split(",").length === all.length);
ok("approval = READY, not approved, not stored", pick({ status: "approval" }) === "ready,dupFlag,withdrawnKey", pick({ status: "approval" }));
ok("imported = IMPORTED or PUBLISHED", pick({ status: "imported" }) === "imported,published");
ok("withdrawn = answerStatus WITHDRAWN or POSSIBLE_WITHDRAWN", pick({ status: "withdrawn" }) === "withdrawnKey,withdrawnFlag");
ok("unresolved excludes rejected, stored and approved-ready-importable", pick({ status: "unresolved" }) === "ready,readyApprovedBlocked,nc,extracted,dup,dupFlag,withdrawnKey,withdrawnFlag", pick({ status: "unresolved" }));
ok("verify=verified / unverified are complements", pick({ status: "all", verify: "verified" }).split(",").length + pick({ status: "all", verify: "unverified" }).split(",").length === all.length);
ok("verify=notrun covers V1 none/stale and V2 none/stale", pick({ status: "all", verify: "notrun" }) === "nc,extracted");
ok("verify=v2-notrun keeps the old V2-only rule", pick({ status: "all", verify: "v2-notrun" }) === "nc,extracted");
ok("verify=memory / field-problems", pick({ status: "all", verify: "memory" }) === "withdrawnFlag" && pick({ status: "all", verify: "field-problems" }) === "withdrawnFlag");
ok("problem=formula catches FORMULA_TEXT_CORRUPT", pick({ status: "all", problem: "formula" }) === "nc");
ok("problem=duplicates = status DUPLICATE or duplicate flag", pick({ status: "all", problem: "duplicates" }) === "dup,dupFlag");
ok("issue overrides problem (old behaviour)", pick({ status: "all", problem: "formula", issue: "TOPIC_UNCERTAIN" }) === "nc");
ok("answer-key includes the unverified rejected row only under status=all", pick({ status: "all", problem: "answer-key" }) === "rejected,withdrawnFlag" && pick({ problem: "answer-key" }) === "withdrawnFlag");

// 4. Counts: each chip = rows matching that chip alone.
const c = chipCounts(all);
for (const k of [...Object.keys(STATUS_MAIN), ...Object.keys(STATUS_ADVANCED)]) ok(`count status ${k}`, c.status[k] === all.filter((r) => matches(r, parseFilters({ status: k === "exceptions" ? "" : k }))).length);
for (const k of [...Object.keys(VERIFY_MAIN), ...Object.keys(VERIFY_ADVANCED)]) ok(`count verify ${k}`, c.verify[k] === all.filter((r) => matches(r, parseFilters({ status: "all", verify: k }))).length);
for (const k of Object.keys(PROBLEM_CODES)) ok(`count problem ${k}`, c.problem[k] === all.filter((r) => matches(r, parseFilters({ status: "all", problem: k }))).length);
ok("issue counts are per question (a code listed twice counts once)", chipCounts([row({ issueCodes: ["OCR_UNCERTAIN", "OCR_UNCERTAIN"] })]).issue.OCR_UNCERTAIN === 1);
ok("counts are over the rows given only (per paper)", chipCounts([R.ready]).status.all === 1 && chipCounts([]).status.all === 0);

// 5. DB pre-filter (all-papers view) never drops a row the in-memory match keeps.
const asDb = (w: Record<string, unknown>, r: FilterRow): boolean => {
  const one = (x: Record<string, unknown>): boolean =>
    Object.entries(x).every(([k, v]) => {
      if (k === "AND") return (v as Record<string, unknown>[]).every(one);
      if (k === "OR") return (v as Record<string, unknown>[]).some(one);
      const val = k === "status" ? r.status : k === "answerStatus" ? r.answerStatus : k === "approvedById" ? (r.approved ? "x" : null) : k === "questionId" ? (r.stored ? "x" : null) : undefined;
      if (k === "issueCodes") { const o = v as { has?: string; hasSome?: string[] }; return o.has ? r.issueCodes.includes(o.has) : o.hasSome!.some((cc) => r.issueCodes.includes(cc)); }
      if (v && typeof v === "object") { const o = v as { in?: string[]; not?: string }; return o.in ? o.in.includes(val as string) : val !== o.not; }
      return val === v;
    });
  return one(w);
};
for (const sp of [{}, { status: "all" }, { status: "approval" }, { status: "imported" }, { status: "withdrawn" }, { status: "unresolved" }, { status: "NEEDS_CORRECTION" }, { status: "all", problem: "duplicates" }, { status: "all", problem: "formula" }, { status: "all", issue: "POSSIBLE_WITHDRAWN" }]) {
  const f = parseFilters(sp);
  ok(`dbWhere ${JSON.stringify(sp)} ⊇ in-memory match`, all.every((r) => !matches(r, f) || asDb(dbWhere(f), r)));
}

// 6. Quality summary counters use the same rules; REJECTED rows never feed flag counters.
const qq = (p: Partial<QualityQuestion>): QualityQuestion => ({ fileId: "f", section: "", number: 1, status: "READY", approved: false, stored: false, verified: null, issueCodes: [], answerStatus: "OFFICIAL_MATCHED", importBlocker: null, rescanPending: false, ...p });
const q = qualityReport({ expected: 4, pages: [], unmatchedKeyEntries: 0, failedKeyFiles: 0, verifierExtras: [], ack: null, processed: true, questions: [
  qq({ number: 1 }),
  qq({ number: 2, status: "NEEDS_CORRECTION", approved: true }),
  qq({ number: 3, approved: true, stored: true, status: "IMPORTED" }),
  qq({ number: 4, approved: true }),
  qq({ number: 4, status: "REJECTED", answerStatus: "UNVERIFIED", verified: false, issueCodes: ["TOPIC_UNCERTAIN", "IMAGE_MISSING", "DUPLICATE_NEAR"] }),
] });
ok("awaiting approval = READY, not approved, not stored (NC excluded)", q.awaitingApproval === 1, q.awaitingApproval);
ok("unresolved = Q1 (unapproved) + Q2 (approved but NEEDS_CORRECTION)", q.unresolved === 2, q.unresolved);
ok("extracted counts every record; rejected separate; counted = unique numbers", q.extracted === 5 && q.rejected === 1 && q.counted === 4);
ok("rejected row feeds no flag counter", q.answerKey.unverified === 0 && q.topicUncertain === 0 && q.imageIssues === 0 && q.duplicateCandidates === 0 && q.verifyDisagreed === 0);

console.log(`\n${n} checks passed`);
