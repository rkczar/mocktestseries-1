/**
 * Pure self-check of lib/ai-import/suggest.ts (no DB, no AI).
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-suggest.ts
 */
import assert from "node:assert/strict";
import { suggestCorrections } from "@/lib/ai-import/suggest";

const q = (stem: string, opts: string[]) => ({ stem, options: opts.map((text, i) => ({ label: "ABCD"[i], printed: "abcd"[i], text })) });
let n = 0;
const ok = (name: string, fn: () => void) => (fn(), n++, console.log(`ok - ${name}`));

ok("Q37: '|P.T.O.' footer line in option D → suggestion without it", () => {
  const s = suggestCorrections(q("GnRH deficiency with hyposmia is typically seen in", ["Kallmann syndrome", "Turner syndrome", "Klinefelter syndrome", "Wallenberg syndrome\n|P.T.O."]));
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].field, s[0].kind, s[0].to], ["option D", "FOOTER", "Wallenberg syndrome"]);
});
ok("Q50: '2, 3 and 4\\n|P.T.O.' → '2, 3 and 4'", () => {
  const s = suggestCorrections(q("x", ["1 only", "1 and 2", "1, 2 and 3", "2, 3 and 4\n|P.T.O."]));
  assert.equal(s[0].to, "2, 3 and 4");
});
ok("Q44: 'HbAlc' vs second read 'HbA1c' → OCR_CHAR suggestion", () => {
  const stored = q("Which one is correct?", ["a", "b", "c", "Diagnosis of diabetes mellitus is\nindeterminate as HbAlc value is\nnot provided."]);
  const s = suggestCorrections(stored, { stem: "Which one is correct?", options: ["a", "b", "c", "Diagnosis of diabetes mellitus is indeterminate as HbA1c value is not provided."] });
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "OCR_CHAR");
  assert.match(s[0].to, /HbA1c/);
  assert.match(s[0].to, /\nindeterminate/); // line structure kept, only the token changed
});
ok("Q67: 'symp-\\ntoms' with second read 'symptoms' → LINE_HYPHEN", () => {
  const s = suggestCorrections(q("Associated musculoskeletal symp-\ntoms are a feature.", ["a", "b", "c", "d"]), { stem: "Associated musculoskeletal symptoms are a feature.", options: ["a", "b", "c", "d"] });
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "LINE_HYPHEN");
  assert.equal(s[0].to, "Associated musculoskeletal symptoms are a feature.");
});
ok("a real wording change ('correct' vs 'incorrect') → no suggestion", () => {
  assert.equal(suggestCorrections(q("Which statements are correct?", ["a", "b", "c", "d"]), { stem: "Which statements are incorrect?", options: ["a", "b", "c", "d"] }).length, 0);
});
ok("a changed number ('7·5' vs '7-5') → no suggestion", () => {
  assert.equal(suggestCorrections(q("x", ["serum pH 7·5-8", "b", "c", "d"]), { stem: "x", options: ["serum pH 7-5-8", "b", "c", "d"] }).length, 0);
});
ok("merged options ('… (c) …' inside option B) → OPTION_BOUNDARY report", () => {
  const s = suggestCorrections(q("x", ["Aspirin", "Heparin (c) Warfarin", "", "Clopidogrel"]));
  assert.equal(s[0]?.kind, "OPTION_BOUNDARY");
});
ok("clean question, identical second read → nothing", () => {
  const stored = q("Which drug?", ["Aspirin", "Heparin", "Warfarin", "Clopidogrel"]);
  assert.equal(suggestCorrections(stored, { stem: stored.stem, options: stored.options.map((o) => o.text) }).length, 0);
});
console.log(`\n${n} checks passed`);
