/**
 * Answer-key matching regressions (2026-11-22 global audit). Pure: no DB, no AI, no OCR, no network.
 *   1. Paper identity: a garbled printed header never overrides the job / PYQ identity (CMS 2026 P-I "NTDC-O-KPMS"
 *      with paper code 1; CMS 2022 P-II with no paper code but PYQ title "UPSC CMS PAPER 2"); unknown stays UNKNOWN.
 *   2. Numbering: an AI page right after a local-OCR page is not a gap (CMS 2024 P-II scan pages 10 → 11); real gaps
 *      and duplicates on AI pages are still flagged; local-OCR reads are never flagged.
 *   3. Verify All Answers: an unconfirmed key's entries say "Key Not Confirmed — Confirm Key", not "not mapped".
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=postgresql://unused/none npx tsx scripts/verify-key-matching.ts
 */
import { comparePaperIds, keyConfirmable, paperIdentity } from "@/lib/ai-import/key-check";
import { keyDecidesAnswer } from "@/lib/ai-import/post";
import { keyPageContinues, keyPageNeedsOcr } from "@/lib/ai-import/keys";
import { numberSequenceProblems, type NumberedRead } from "@/lib/ai-import/local-parse";
import { compareAnswer } from "@/lib/ai-import/verify-answers-core";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
};
const none = { paperCode: null, pyqPaperCode: null, pyqTitle: null, expectedQuestions: 120 };
const key = (paper: string | null, series: string | null) => ({ paper, series, set: null, exam: null, totalQuestions: null });

// 1. Identity
const garbled = { paper: "NTDC-O-KPMS", series: null, totalQuestions: null, source: "printed on page 2 of the question paper" };
const id1 = paperIdentity(garbled, { ...none, paperCode: "1" });
ok("garbled printed header does not override paper code 1", id1.paper === "1", id1);
ok("…so a Paper I key MATCHES", comparePaperIds(key("Paper I", null), id1).state === "MATCH");
ok("…and a Paper II key is still a MISMATCH", comparePaperIds(key("II", null), id1).state === "MISMATCH");
const id2 = paperIdentity(null, { ...none, pyqTitle: "UPSC CMS PAPER 2" });
ok("no paper code: PYQ title gives Paper 2", id2.paper === "UPSC CMS PAPER 2" && comparePaperIds(key("II", null), id2).state === "MATCH", id2);
ok("PYQ title Paper 2 vs a Paper I key → MISMATCH", comparePaperIds(key("I", null), id2).state === "MISMATCH");
const id3 = paperIdentity({ paper: "Paper-II", series: "B", totalQuestions: null, source: "printed" }, { ...none, paperCode: "1" });
ok("a readable printed paper number wins over the job code", id3.paper === "Paper-II" && id3.series === "B", id3);
const id4 = paperIdentity(null, { ...none, paperCode: "A", pyqTitle: "UPSC CMS PAPER 2" });
ok("series-only paper code + PYQ title → Paper 2, Series A", id4.paper === "UPSC CMS PAPER 2" && id4.series === "A", id4);
const id5 = paperIdentity(garbled, { ...none, pyqTitle: "UPSC CMS 2024 Question Paper" });
ok("nothing usable → UNKNOWN (fail closed)", id5.paper === null && comparePaperIds(key("II", null), id5).state === "UNKNOWN", id5);
ok("key prints only a series, paper series unknown → UNKNOWN (needs Confirm Key)", comparePaperIds(key(null, "A"), id1).state === "UNKNOWN");

// 2. Numbering (CMS 2024 P-II scan: page 10 local Q44–45, page 11 AI Q46–50, page 12 AI Q51)
const r = (id: string, page: number, number: number | null, ai: boolean): NumberedRead => ({ id, page, section: "", number, flag: ai });
const seq = [...[31, 32, 33, 34, 35].map((n) => r(`q${n}`, 8, n, true)), ...[36, 37, 38, 39, 40].map((n) => r(`q${n}`, 9, n, false)), r("q41", 10, 41, false), r("q42", 10, 42, false), r("q43", 10, 43, false), r("q44", 10, 44, false), r("q45", 10, 45, false), ...[46, 47, 48, 49, 50].map((n) => r(`q${n}`, 11, n, true)), r("q51", 12, 51, true)];
ok("AI page after a local page: no false gap", numberSequenceProblems(seq).size === 0, [...numberSequenceProblems(seq)]);
const oldWay = numberSequenceProblems(seq.filter((x) => x.flag)).size; // pre-fix behaviour: AI reads only
ok("pre-fix input (AI reads only) reproduces the false gap on page 11", oldWay === 5, oldWay);
const gap = [r("a1", 10, 44, false), r("a2", 10, 45, false), r("b1", 11, 47, true), r("b2", 11, 48, true)];
ok("a real gap on an AI page is still flagged (Q46 missing)", numberSequenceProblems(gap).size === 2 && numberSequenceProblems(gap).has("b1"));
const dup = [r("a1", 10, 44, false), r("a2", 10, 45, false), r("b1", 11, 45, true), r("b2", 11, 46, true)];
ok("an AI page repeating a local number is flagged", numberSequenceProblems(dup).has("b1"));
const localGap = [r("a1", 10, 44, false), r("a2", 10, 47, false), r("b1", 11, 48, true)];
ok("a gap inside a local page never flags the local reads", ![...numberSequenceProblems(localGap).keys()].some((k) => k.startsWith("a")));
ok("reads without flag keep the old behaviour (flagged)", numberSequenceProblems([{ id: "x", page: 2, section: "", number: 5 }, { id: "y", page: 2, section: "", number: 9 }]).size === 2);

// 3. Verify All Answers wording for an unconfirmed key
const v = compareAnswer({ saved: ["C"], keys: [{ rawValue: "C", fileProblem: "Key Not Confirmed — Confirm Key: identity unknown" }], unmapped: [], parse: () => ({ labels: ["C"], problem: null }) });
ok("unconfirmed key → UNVERIFIED with Confirm Key wording (never MATCH)", v.verdict === "UNVERIFIED" && /Confirm Key/.test(v.reason), v);
const m = compareAnswer({ saved: ["C"], keys: [{ rawValue: "C", fileProblem: null }], unmapped: [], parse: () => ({ labels: ["C"], problem: null }) });
ok("confirmed key equal to the saved answer → MATCH", m.verdict === "MATCH");

// 4. Official key with no printed paper / series (CMS 2016 P-II, 2020 P-I/P-II scans, 2026-11-26)
const cms20p2 = paperIdentity(null, { ...none, pyqTitle: "UPSC CMS PAPER 2" });
ok("key printing nothing → UNKNOWN (fail closed until an admin confirms)", comparePaperIds(null, cms20p2).state === "UNKNOWN");
ok("correct match: Paper 2 key on Paper 2 → MATCH", comparePaperIds(key("2", null), cms20p2).state === "MATCH");
ok("genuine mismatch: Paper I key on Paper 2 → MISMATCH", comparePaperIds(key("I", null), cms20p2).state === "MISMATCH");
ok("UNKNOWN key can be confirmed", keyConfirmable("UNKNOWN"));
ok("PROVISIONAL key can be re-confirmed as OFFICIAL (was a dead end)", keyConfirmable("PROVISIONAL"));
ok("MISMATCH / MATCH / CONFIRMED can never be (re)confirmed", !keyConfirmable("MISMATCH") && !keyConfirmable("MATCH") && !keyConfirmable("CONFIRMED"));
ok("unconfirmed / provisional key row never decides the answer", !keyDecidesAnswer([{ rawValue: "B", wrongPaper: true }], ["A", "B", "C", "D"]));
ok("confirmed official key row decides the answer by question number", keyDecidesAnswer([{ rawValue: "B", wrongPaper: false }], ["A", "B", "C", "D"]));

// 5. Scanned key with a short watermark text layer (CMS 2018, 2026-11-26)
ok("empty text layer → OCR", keyPageNeedsOcr("", 0));
ok("84-char watermark, no pairs → OCR", keyPageNeedsOcr("x".repeat(84), 0));
ok("text key with pairs → no OCR", !keyPageNeedsOcr("1 A 2 B ".repeat(60), 120));
ok("long non-key text, no pairs → no OCR", !keyPageNeedsOcr("word ".repeat(200), 0));

// 6. Last page of a 3-column grid (CMS 2015 P-I key page 2, 2026-11-26)
const kp = (n: number) => ({ number: n, section: "", value: "A" }) as never;
const page1 = [...Array.from({ length: 35 }, (_, i) => [i + 1, i + 41, i + 81]).flat()].map(kp);
const page2 = [36, 76, 116, 37, 77, 117, 38, 78, 118, 39, 79, 119, 40, 80, 120].map(kp);
ok("page 2 rows complete the key read from page 1", keyPageContinues(page1, page2));
ok("page repeating earlier numbers is not a continuation", !keyPageContinues(page1, [1, 2, 3, 41, 42].map(kp)));
ok("no earlier page → no continuation", !keyPageContinues([], page2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
