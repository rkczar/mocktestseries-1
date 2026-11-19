/**
 * Review-reduction fixes (2026-11-19 audit of CMS 2023 Paper I job cmwnthx0q…: 108 of 120 in Needs review) — pure checks
 * (no DB, no AI, no network). Each section fails on a29bd51 and passes after the fix.
 *   A. Key OCR: cells read with a print dot / speck ("C.", "-A.", "64.") are used; misreads ("8" for B, "1.17") never are.
 *   B. Verify 2 comparison: instruction line / dash variants agree; an incomplete second read is a model failure (FAILED),
 *      never VERIFIED; real content differences (l↔1, a changed number) stay DISAGREE; '|P.T.O.' residue is a footer.
 *   C. Classifier answers: FORMAT (no key words) vs SHIFTED (another question's key words) vs INVALID_CODE; schema requires "about".
 *   D. Review grouping: "Subject / topic only" bucket; publish blocking unchanged.
 *   E. (optional) Replay of the real job's exported evidence when IMPORT_EVIDENCE_DIR is set.
 *
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=postgresql://none@127.0.0.1:1/mts_none PG_POOL_MAX=3 npx tsx scripts/verify-ai-import-review-reduction.ts
 */
import { existsSync, readFileSync } from "node:fs";
import type { AiImportQuestion } from "@prisma/client";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import { ocrKeyPairs } from "@/lib/ai-import/keys";
import { readsAgree } from "@/lib/ai-import/process";
import { STRONG_FOOTER } from "@/lib/ai-import/ocr-layout";
import { compareSecondRead } from "@/lib/ai-import/paper-verify";
import { decideClassification, taxonomyCodes } from "@/lib/ai-import/taxonomy-check";
import { OUTPUT_SCHEMAS } from "@/lib/ai-import/output-schemas";
import { TAXONOMY_CODES, classificationOnly, matchStatus, type FilterRow } from "@/lib/ai-import/review-filters";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok" : "FAIL"} - ${name}${ok ? "" : ` ${JSON.stringify(info)?.slice(0, 600)}`}`);
};

// ---------------------------------------------------------------- A. key OCR
{
  // One grid row per question: number cell at x=100, value cell at x=200 (rows 40 px apart).
  const cells: [string, string, number?][] = [["1", "C."], ["2", "-A."], ["3", "À"], ["4", "8"], ["5", "X."], ["6", "D", 0.62], ["7", "B·"], ["8", "AB"], ["9", "a."]];
  const lines = cells.flatMap(([n, v, score], i) => [
    { text: n, score: 0.99, box: [100, 100 + i * 40, 130, 125 + i * 40] },
    { text: v, score: score ?? 0.97, box: [200, 100 + i * 40, 230, 125 + i * 40] },
  ]);
  const got = Object.fromEntries(ocrKeyPairs({ lines, width: 1000, height: 1000 } as never).pairs.map((p) => [p.number, p.raw]));
  check("A1. 'C.' / '-A.' / 'À' / 'B·' are read as C / A / A / B", got[1] === "C" && got[2] === "A" && got[3] === "A" && got[7] === "B", got);
  check("A2. 'X.' is the dropped-question mark X (withdrawn), never a letter", got[5] === "X", got);
  check("A3. a digit misread for a letter ('8'), 'AB' and a low-confidence letter give NO entry", !(4 in got) && !(8 in got) && !(6 in got), got);
  check("A4. a lowercase cell with a dot ('a.') → A", got[9] === "A", got);
  const nums = ocrKeyPairs({ lines: [{ text: "64.", score: 0.99, box: [100, 100, 130, 125] }, { text: "C", score: 0.99, box: [200, 100, 230, 125] }, { text: "1.17", score: 0.99, box: [100, 140, 130, 165] }, { text: "A", score: 0.99, box: [200, 140, 230, 165] }], width: 1000, height: 1000 } as never).pairs;
  check("A5. '64.' is number 64; '1.17' is never 117 or 1", nums.length === 1 && nums[0].number === 64 && nums[0].raw === "C", nums);
}

// ---------------------------------------------------------------- B. Verify 2 comparison
const base: ExtractedQuestion = { number: 1, label: "1", section: null, type: "SINGLE_CORRECT", stem: "", options: [], printedAnswer: [], figures: [], confidence: 0.9, unreadable: [], method: "LOCAL_OCR", contentFormat: "PLAIN" } as unknown as ExtractedQuestion;
const q = (stem: string, opts: string[], extra: Partial<ExtractedQuestion> = {}): ExtractedQuestion => ({ ...base, ...extra, stem, options: opts.map((text, i) => ({ label: "ABCD"[i], text, printed: "ABCD"[i] })) });
const row = (e: ExtractedQuestion) => ({ id: "q1", jobId: "j", fileId: "f", data: e, editedData: null, figures: [], subjectId: null, topicId: null, subTopicId: null, finalAnswer: ["A"], answerStatus: "OFFICIAL_MATCHED", officialAnswer: ["A"], issueCodes: [], questionType: "SINGLE_CORRECT" }) as unknown as AiImportQuestion & { figures: [] };
const cmp = (stored: ExtractedQuestion, second: ExtractedQuestion) => compareSecondRead(row(stored) as never, { model: "m", sourceText: "ocr text", q: second } as never, undefined);
{
  const opts = ["1, 2 and 3", "1, 2 and 4", "1, 3 and 4", "2, 3 and 4"];
  const stem = "Which of the following are typical physical findings in pericardial effusion?\n1. Raised JVP\n2. Hypotension\n3. Oliguria\n4. Water hammer pulse";
  check("B1. the printed instruction line alone is not a disagreement", cmp(q(`${stem}\nSelect the correct answer using the code given below.`, opts), q(stem, opts)).status === "VERIFIED");
  check("B2. hyphen / en dash / line-break hyphen variants agree", readsAgree(q("Hypertrophic obstructive cardio-myopathy", ["2-3 months", "4-5 months", "6-7 months", "8-9 months"]), q("Hypertrophic obstructive cardiomyopathy", ["2–3 months", "4–5 months", "6–7 months", "8–9 months"])).agree);
  const lead = cmp(q(stem, opts), q("1. Raised JVP\n2. Hypotension\n3. Oliguria\n4. Water hammer pulse", opts));
  check("B3. a second read without the lead-in question is FAILED (model output), not VERIFIED, not DISAGREE", lead.status === "FAILED" && /incomplete second read/.test(lead.detail), lead);
  const empty = cmp(q("Typical absence seizures are characterized by", ["a", "b", "c", "d"]), q("", ["a", "b", "c", "d"]));
  check("B4. an empty second-read stem is FAILED (model output)", empty.status === "FAILED", empty);
  // Similarity alone cannot see a short footer tail (Q37 passed it); the per-question footer check flags it instead.
  check("B5. page residue '|P.T.O.' (the scan's reading of '[P.T.O.') is recognised as a footer line; real text is not", STRONG_FOOTER("|P.T.O.") && STRONG_FOOTER("| P.T.O") && !STRONG_FOOTER("Wallenberg syndrome") && !STRONG_FOOTER("2, 3 and 4"));
  check("B6. an OCR l↔1 change ('HbAlc' vs 'HbA1c') stays a disagreement", cmp(q("Which statement is correct?", ["a", "b", "c", "Diagnosis is indeterminate as HbAlc value is not provided."]), q("Which statement is correct?", ["a", "b", "c", "Diagnosis is indeterminate as HbA1c value is not provided."])).status === "DISAGREE");
  check("B7. a changed number ('7·5' vs '7-5') stays a disagreement", cmp(q("Urinary alkalinization aims at", ["serum pH 7·5-8", "b", "c", "d"]), q("Urinary alkalinization aims at", ["serum pH 7-5-8", "b", "c", "d"])).status === "DISAGREE");
  const extra = cmp(q("Short stem", opts), q("A much longer stem with words that the stored question does not have at all", opts));
  check("B8. a second read with DIFFERENT words is still DISAGREE (only a subset counts as incomplete)", extra.status === "DISAGREE", extra);
}

// ---------------------------------------------------------------- C. classifier answers
{
  const T = [{ id: "s1", name: "General Medicine", syllabusDescription: null, topics: [{ id: "t1", name: "Cardiovascular Diseases", syllabusDescription: null, subTopics: [] }] }] as never;
  const codes = taxonomyCodes(T);
  const heart = q("A soft systolic murmur with raised JVP and prominent C-V wave", ["VSD", "MR", "TR", "MVP"]);
  const d = (about: unknown, subject = "S1") => decideClassification({ subject, topic: "T1", subtopic: null, confidence: 0.9, about: about as string }, heart, codes, T, "m");
  check("C1. no key words → failure FORMAT (model output), nothing assigned", d(null).failure === "FORMAT" && d(null).subject === null && d("").failure === "FORMAT");
  check("C2. another question's key words → failure SHIFTED", d(["vitiligo", "melanocytes"]).failure === "SHIFTED");
  check("C3. a code not on this exam's list → failure INVALID_CODE", d(["murmur"], "S9").failure === "INVALID_CODE");
  check("C4. a good answer has no failure and is used", d(["systolic murmur", "jugular"]).failure === undefined && d(["systolic murmur"]).subject === "s1");
  const item = (OUTPUT_SCHEMAS.classify.properties.results.items as { required: string[] }).required;
  check("C5. the classify JSON schema requires 'about' and 'reason' (providers that enforce it cannot drop them)", item.includes("about") && item.includes("reason"), item);
  const post = readFileSync(new URL("../lib/ai-import/post.ts", import.meta.url), "utf8");
  const pv = readFileSync(new URL("../lib/ai-import/paper-verify.ts", import.meta.url), "utf8");
  check("C6. both classifiers retry only unusable answers, once, and keep the original model output", /retryLater/.test(post) && /CLASSIFY_MODEL_OUTPUT/.test(post) && /retryLater/.test(pv) && /VERIFY2_MODEL_OUTPUT/.test(pv));
  check("C7. a 'shift' is counted only from SHIFTED answers (no more regex on the message)", /failure === "SHIFTED"\)\.length/.test(post) && !/x\.d\.rejected && !x\.d\.subject && \/key words\//.test(post));
}

// ---------------------------------------------------------------- D. review grouping
{
  const r = (p: Partial<FilterRow>): FilterRow => ({ status: "NEEDS_CORRECTION", answerStatus: "OFFICIAL_MATCHED", issueCodes: ["TAXONOMY_CHECK_FAILED"], approved: false, stored: false, importBlocker: null, v1: "passed", v2: "verified", eligible: false, fieldProblem: false, memoryProblem: false, ...p });
  check("D1. verified wording + official answer + only taxonomy codes → Subject / topic only (not in Needs review)", classificationOnly(r({})) && matchStatus(r({}), "taxonomy-only") && !matchStatus(r({}), "exceptions"));
  check("D2. an unverified answer keeps it in Needs review", !classificationOnly(r({ answerStatus: "UNVERIFIED", issueCodes: ["ANSWER_UNVERIFIED", "TOPIC_UNCERTAIN"] })) && matchStatus(r({ answerStatus: "UNVERIFIED", issueCodes: ["ANSWER_UNVERIFIED"] }), "exceptions"));
  check("D3. a Verify 2 disagreement / failure keeps it in Needs review", !classificationOnly(r({ v2: "disagree", issueCodes: ["TOPIC_UNCERTAIN", "VERIFY2_DISAGREES"] })) && !classificationOnly(r({ v2: "failed", issueCodes: ["TOPIC_UNCERTAIN", "VERIFY2_FAILED"] })));
  check("D4. Verify 1 not passed / any other publish-blocking code keeps it in Needs review", !classificationOnly(r({ v1: "problems" })) && !classificationOnly(r({ issueCodes: ["TOPIC_UNCERTAIN", "OCR_UNCERTAIN"] })));
  check("D5. every taxonomy code is still publish-blocking (grouping never unblocks import / publish)", TAXONOMY_CODES.every((c) => ISSUE_DEFS[c]?.publishBlocking));
  check("D6. READY questions are never in the bucket", !classificationOnly(r({ status: "READY" })));
}

// ---------------------------------------------------------------- E. replay of the real job (optional, read-only files)
const E = process.env.IMPORT_EVIDENCE_DIR;
if (E && existsSync(`${E}/key-ocr.json`)) {
  const o = JSON.parse(readFileSync(`${E}/key-ocr.json`, "utf8"));
  const truth = new Map([...readFileSync(`${E}/key-truth-manual.txt`, "utf8").split("\n").filter((l) => !l.startsWith("#")).join(" ").matchAll(/\b(\d+)([A-DX])/g)].map((m) => [+m[1], m[2]]));
  const pairs = ocrKeyPairs({ lines: o.lines, width: o.width, height: o.height }, 300).pairs;
  const wrong = pairs.filter((p) => truth.get(p.number) !== p.raw);
  console.log(`   job key replay: ${pairs.length} entries, ${wrong.length} wrong (production code: 77 entries, 0 wrong)`);
  check("E1. real key screenshot: ≥ 100 entries read and 0 wrong against the manual transcription", pairs.length >= 100 && wrong.length === 0, wrong);
  const qs = JSON.parse(readFileSync(`${E}/questions.json`, "utf8")) as (AiImportQuestion & { data: ExtractedQuestion & { paperVerify: { v1: never; v2: { status: string; model: string; second?: { stem: string; options: string[]; printedAnswer: string[] } } } } })[];
  const tally: Record<string, number> = {};
  for (const x of qs) {
    const s = x.data.paperVerify.v2.second;
    if (!s) continue;
    const res = compareSecondRead({ ...x, figures: [] } as never, { model: "m", sourceText: "ocr", q: { ...(x.data as object), stem: s.stem, options: s.options.map((t, i) => ({ label: x.data.options[i]?.label ?? "ABCD"[i], text: t })), printedAnswer: s.printedAnswer ?? [], figures: [] } } as never, x.data.paperVerify.v1);
    tally[res.status] = (tally[res.status] ?? 0) + 1;
  }
  console.log(`   job Verify 2 replay of the 20 stored disagreements: ${JSON.stringify(tally)}`);
  check("E2. real job: 20 disagreements → 7 VERIFIED (formatting) + 9 FAILED (incomplete read) + 4 DISAGREE (real content)", tally.VERIFIED === 7 && tally.FAILED === 9 && tally.DISAGREE === 4, tally);
} else console.log("   (E skipped: set IMPORT_EVIDENCE_DIR to replay the exported job evidence)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
