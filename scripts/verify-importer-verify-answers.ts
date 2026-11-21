/** Verify Answers pure core (synthetic, no DB, no AI): run with `npx tsx scripts/verify-importer-verify-answers.ts`. */
import assert from "node:assert/strict";
import { compareAnswer, vaCategory } from "../lib/ai-import/verify-answers-core";

const parse = (raw: string) => (/^[A-D]$/i.test(raw.trim()) ? { labels: [raw.trim().toUpperCase()], problem: null } : { labels: null, problem: "unreadable" });
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`ok ${n} ${name}`); };
const cmp = (saved: string[], keys: string[], unmapped: string[] = [], fileProblem: string | null = null) =>
  compareAnswer({ saved, keys: keys.map((rawValue) => ({ rawValue, fileProblem })), unmapped, parse });
const ai = (answer: string[], confidence = 0.8, defective = false) => ({ answer, confidence, defective, reason: "r" });

t("match + AI agrees → CONFIRMED, high confidence", () => {
  const m = cmp(["B"], ["B"]);
  const c = vaCategory({ ...m, saved: ["B"] }, ai(["B"]));
  assert.equal(c.category, "CONFIRMED");
  assert.ok(c.confidence > 0.95);
});
t("match, no AI → CONFIRMED (key only, 0.9)", () => assert.deepEqual(vaCategory({ ...cmp(["B"], ["B"]), saved: ["B"] }, null), { category: "CONFIRMED", confidence: 0.9 }));
t("match + AI disagrees → AI_DISAGREES, official kept", () => {
  const m = cmp(["B"], ["B"]);
  assert.equal(vaCategory({ ...m, saved: ["B"] }, ai(["C"])).category, "AI_DISAGREES");
  assert.deepEqual(m.official, ["B"]);
});
t("AI says defective → AI_DISAGREES", () => assert.equal(vaCategory({ ...cmp(["B"], ["B"]), saved: ["B"] }, ai([], 0.6, true)).category, "AI_DISAGREES"));
t("no key → MISSING", () => assert.equal(vaCategory({ ...cmp(["B"], []), saved: ["B"] }, ai(["B"])).category, "MISSING"));
t("key but nothing saved → MISSING", () => assert.equal(vaCategory({ ...cmp([], ["A"]), saved: [] }, null).category, "MISSING"));
t("saved differs from key → INCORRECT_MAPPING", () => assert.equal(vaCategory({ ...cmp(["A"], ["C"]), saved: ["A"] }, ai(["A"])).category, "INCORRECT_MAPPING"));
t("conflicting key entries → DUPLICATE", () => {
  const m = cmp(["A"], ["A", "C"]);
  assert.equal(m.code, "DUPLICATE");
  assert.equal(vaCategory({ ...m, saved: ["A"] }, null).category, "DUPLICATE");
});
t("same value listed twice is not a conflict", () => assert.equal(cmp(["A"], ["A", "(a)"]).verdict, "MATCH"));
t("X / dropped / bonus → WITHDRAWN", () => {
  for (const v of ["X", "Dropped", "bonus", "*"]) assert.equal(vaCategory({ ...cmp([], [v]), saved: [] }, ai(["A"])).category, "WITHDRAWN");
});
t("unmapped entry → MANUAL_REVIEW (UNMAPPED)", () => {
  const m = cmp(["A"], [], ["A"]);
  assert.equal(m.code, "UNMAPPED");
  assert.equal(vaCategory({ ...m, saved: ["A"] }, null).category, "MANUAL_REVIEW");
});
t("key of another paper → MANUAL_REVIEW (WRONG_PAPER)", () => {
  const m = cmp(["A"], ["A"], [], "mismatch");
  assert.equal(m.code, "WRONG_PAPER");
  assert.equal(vaCategory({ ...m, saved: ["A"] }, ai(["A"])).category, "MANUAL_REVIEW");
});
t("unreadable key value → MANUAL_REVIEW", () => assert.equal(vaCategory({ ...cmp(["A"], ["Q?"]), saved: ["A"] }, null).category, "MANUAL_REVIEW"));
t("multiple-correct order-insensitive", () => assert.equal(vaCategory({ verdict: "MATCH", official: ["A", "C"], saved: ["C", "A"] }, ai(["C", "A"])).category, "CONFIRMED"));
console.log(`\n${n}/${n} passed`);
