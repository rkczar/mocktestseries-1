/**
 * Render regression for the Review Exceptions filters (prod crash digest 4287014052, 2026-11-19:
 * a filter moved from PROBLEM_ADVANCED to PROBLEM_MAIN left the component reading an undefined def).
 * Renders <ReviewFilters> for every filter value of every group, with and without counts. No DB, no AI.
 *   npx tsx scripts/verify-review-filters.render.tsx
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewFilters } from "@/components/admin/ai-importer/review-filters";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import {
  PROBLEM_ADVANCED, PROBLEM_MAIN, STATUS_ADVANCED, STATUS_MAIN, VERIFY_ADVANCED, VERIFY_MAIN,
  chipCounts, parseFilters, type FilterRow,
} from "@/lib/ai-import/review-filters";

let n = 0;
const ok = (name: string, cond: boolean, info?: unknown) => {
  assert.ok(cond, `${name} ${info !== undefined ? JSON.stringify(info) : ""}`);
  n++;
  console.log(`ok - ${name}`);
};
const link = (p: Record<string, string | undefined>) => `/admin/ai-importer/exceptions?${new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined) as [string, string][])}`;
const row = (o: Partial<FilterRow>): FilterRow => ({ status: "NEEDS_CORRECTION", answerStatus: "UNVERIFIED", issueCodes: [], approved: false, stored: false, importBlocker: null, v1: "passed", v2: "verified", eligible: true, fieldProblem: false, memoryProblem: false, ...o });
// Rows across review statuses, every issue code present at least once.
const rows = [
  row({ issueCodes: Object.keys(ISSUE_DEFS) }),
  row({ status: "READY", answerStatus: "OFFICIAL_MATCHED" }),
  row({ status: "READY", approved: true }),
  row({ status: "IMPORTED", stored: true }),
  row({ status: "REJECTED" }),
  row({ status: "EXTRACTING", v1: "notrun", v2: "notrun" }),
];
const countSets = { "no paper (null counts)": null, "empty paper": chipCounts([]), "mixed paper": chipCounts(rows) };
const issueCodes = Object.keys(ISSUE_DEFS);
const render = (sp: Record<string, string>, counts: ReturnType<typeof chipCounts> | null) =>
  renderToStaticMarkup(<ReviewFilters f={parseFilters(sp)} counts={counts} link={link} issueCodes={issueCodes} />);
const ids = (html: string, prefix: string) => [...html.matchAll(new RegExp(`data-testid="(${prefix}-[^"]+)"`, "g"))].map((m) => m[1]);

// 1. Every URL value of every group renders (this is where an undefined def used to throw).
const combos: Record<string, string>[] = [
  {}, { status: "all" }, { status: "exceptions" }, { status: "bogus" },
  ...[...Object.keys(STATUS_MAIN), ...Object.keys(STATUS_ADVANCED)].map((status) => ({ status })),
  ...[...Object.keys(VERIFY_MAIN), ...Object.keys(VERIFY_ADVANCED)].map((verify) => ({ verify })),
  ...[...Object.keys(PROBLEM_MAIN), ...Object.keys(PROBLEM_ADVANCED)].map((problem) => ({ problem })),
  ...issueCodes.map((issue) => ({ issue })),
  { status: "taxonomy-only", verify: "verified", problem: "rescan" },
  { status: "all", problem: "model-failure", issue: issueCodes[0] },
];
for (const [label, counts] of Object.entries(countSets)) {
  const failures: string[] = [];
  for (const sp of combos) {
    try {
      render(sp, counts);
    } catch (e) {
      failures.push(`${JSON.stringify(sp)}: ${(e as Error).message}`);
    }
  }
  ok(`${label}: all ${combos.length} filter combinations render`, failures.length === 0, failures);
}

// 2. Every defined filter is shown exactly once (nothing lost when a def moves, nothing duplicated).
const html = render({}, chipCounts(rows));
const expect = (prefix: string, keys: string[]) => {
  const got = ids(html, prefix).filter((id) => id !== `${prefix}-filters`); // skip the row wrapper
  const want = keys.map((k) => `${prefix}-${k}`).sort();
  const dup = got.filter((id, i) => got.indexOf(id) !== i);
  ok(`${prefix} chips: each defined once, none missing`, dup.length === 0 && JSON.stringify([...got].sort()) === JSON.stringify(want), { dup, missing: want.filter((w) => !got.includes(w)), extra: got.filter((g) => !want.includes(g)) });
};
expect("status", [...Object.keys(STATUS_MAIN), ...Object.keys(STATUS_ADVANCED)].filter((k) => k !== "approval"));
ok("approval chip once", ids(html, "filter").filter((x) => x === "filter-approval").length === 1);
expect("verify", [...Object.keys(VERIFY_MAIN), ...Object.keys(VERIFY_ADVANCED)]);
expect("problem", [...Object.keys(PROBLEM_MAIN), ...Object.keys(PROBLEM_ADVANCED)]);
ok("no main/advanced key overlap", ![STATUS_MAIN, VERIFY_MAIN, PROBLEM_MAIN].some((m, i) => Object.keys(m).some((k) => k in [STATUS_ADVANCED, VERIFY_ADVANCED, PROBLEM_ADVANCED][i])));

// 3. "Verify 2 disagreements" and "Model failures" are main chips, not in Advanced.
const [main, advanced] = html.split('data-testid="advanced-filters"');
ok("rescan + model-failure in the main Problems row", main.includes('data-testid="problem-rescan"') && main.includes('data-testid="problem-model-failure"') && main.includes("Verify 2 disagreements") && main.includes("Model failures"));
ok("rescan + model-failure not repeated in Advanced", !advanced.includes("problem-rescan") && !advanced.includes("problem-model-failure"));

// 4. Active-filter labels for the moved groups.
ok("active label for problem=rescan", render({ problem: "rescan" }, null).includes("Problem: Verify 2 disagreements"));
ok("active label for problem=model-failure", render({ problem: "model-failure" }, null).includes("Problem: Model failures"));
ok("advanced opens for an advanced problem, stays closed for a main one", /advanced-filters"[^>]*open|open=""[^>]*advanced-filters/.test(render({ problem: "structure" }, null)) && !/open=""[^>]*data-testid="advanced-filters"/.test(render({ problem: "rescan" }, null)));

console.log(`\n${n} passed, 0 failed`);
