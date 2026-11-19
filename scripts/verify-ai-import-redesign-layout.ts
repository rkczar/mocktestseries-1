/**
 * Importer redesign P1 — layout / parse regressions (2026-11-19 audit, AREA=layout). Pure + synthetic: no DB rows, no AI.
 *   1 gutter by fewest crossing lines (CMS 2024 P-II p18 split at 0.721, CMS 2026 P-I p17 at 0.324)
 *   2 no "lost notation" failure on local OCR text      3 one / few-option reads are degenerate (repair + retry run)
 *   4 unnumbered fragment inside an AI question = duplicate  5 printed option letters kept (no shift)
 *   6 "Correct Answer: (B) 1, 2 and 4" = B                7 statement run whose last item carries options and continues
 *   9 low native scan resolution read from pdfimages -list
 *   (8: page outcome when AI is off / first-reading re-scan — DB pipeline, covered by review of process.ts; see report)
 *   /root/mts-scratch/redesign/run-suite.sh scripts/verify-ai-import-redesign-layout.ts
 */
import { findGutter, type LayoutLine } from "@/lib/ai-import/ocr-layout";
import { blockToQuestion, splitQuestions, statementCodeQuestion, takePrintedAnswer, type Line } from "@/lib/ai-import/local-parse";
import { degenerateQuestion, incompleteReading, optionOnlyReasons, repairDegenerateOptions } from "@/lib/ai-import/reading-checks";
import { pageSchema, toExtracted } from "@/lib/ai-import/prompts";
import { scanPpiFromList } from "@/lib/ai-import/pdf";
import { containedIn, mergeContinuation } from "@/lib/ai-import/process";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: unknown, info?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}`, info ?? "");
  }
}

// ---- 1. Gutter ------------------------------------------------------------------------------------------------------
const L = (x: number, end: number, y: number): LayoutLine => ({ text: "word ".repeat(5), box: { x, y, w: end - x, h: 0.012 }, conf: 0.99 });
// p18-like: left column with an indented table (starts creep 0.28…0.474 in < 0.05 steps), right column with hanging
// numbers 0.522–0.534, body 0.573–0.625, and Q83's table whose second cell column starts at 0.726.
const p18: LayoutLine[] = [];
let y = 0.06;
for (let i = 0; i < 10; i++) p18.push(L(i % 3 ? 0.06 : 0.1, 0.47, (y += 0.02)));
for (const x of [0.28, 0.32, 0.36, 0.4, 0.43, 0.474]) p18.push(L(x, Math.min(0.48, x + 0.03), (y += 0.02)));
y = 0.06;
for (const x of [0.522, 0.528, 0.534]) p18.push(L(x, x + 0.02, (y += 0.02)));
for (let i = 0; i < 8; i++) p18.push(L([0.573, 0.6, 0.625][i % 3], 0.95, (y += 0.02)));
for (let i = 0; i < 10; i++) {
  p18.push(L(0.573, 0.7, (y += 0.02)));
  p18.push(L(0.726, 0.95, y));
}
const g18 = findGutter(p18);
ok("1 p18: gutter in the real column gap (not 0.721 inside the table)", g18 !== null && g18 > 0.48 && g18 <= 0.522, g18);
// p17-like: left-column table cells start at 0.327 (one ≥ 0.05 step), right column numbers 0.52 and body 0.56.
const p17: LayoutLine[] = [];
y = 0.06;
for (const x of [0.05, 0.08, 0.12, 0.16, 0.2, 0.24, 0.276]) for (let k = 0; k < 2; k++) p17.push(L(x, 0.47, (y += 0.012)));
for (let i = 0; i < 8; i++) p17.push(L(0.327, 0.47, (y += 0.012)));
for (const x of [0.37, 0.41, 0.45]) p17.push(L(x, 0.475, (y += 0.012)));
y = 0.06;
for (let i = 0; i < 4; i++) p17.push(L(0.52, 0.545, (y += 0.05)));
for (let i = 0; i < 16; i++) p17.push(L(0.56, 0.95, 0.06 + i * 0.012));
const g17 = findGutter(p17);
ok("1 p17: gutter in the real column gap (not 0.324 at a table cell)", g17 !== null && g17 > 0.475 && g17 <= 0.52, g17);
ok("1 one column (short lines) → null", findGutter(Array.from({ length: 20 }, (_, i) => L(0.1, 0.5 + (i % 3) * 0.05, 0.05 + i * 0.03))) === null);
ok("1 one column with a full-width body → null", findGutter(Array.from({ length: 20 }, (_, i) => L(0.08 + (i % 2) * 0.04, 0.9, 0.05 + i * 0.03))) === null);
// Columns touching on a shifted scan (CMS 2025 P-II p5: left ends 0.471, right starts 0.468): the right column stays right.
const touch = [...Array.from({ length: 12 }, (_, i) => L(0.08, 0.471, 0.1 + i * 0.05)), ...Array.from({ length: 12 }, (_, i) => L(0.468, 0.9, 0.1 + i * 0.05))];
const gt = findGutter(touch);
ok("1 touching columns → split just left of the right column", gt !== null && gt <= 0.468 && gt > 0.4, gt);

// ---- 2. Notation on OCR ---------------------------------------------------------------------------------------------
const blk = (text: string) => ({ heading: null, section: "", number: 7, label: "7", lines: text.split("\n").map((t) => ({ text: t })), text });
const sym = "Body temperature of 38.5 °C × 2 days ± chills: next step?\n(a) Observe\n(b) Antipyretic\n(c) Blood culture\n(d) CT scan";
const ocrQ = blockToQuestion(blk(sym), 3, "LOCAL_OCR").q;
ok("2 OCR page: °, ×, ± are not 'lost notation'", ocrQ.confidence >= 0.9 && !ocrQ.notes?.some((n) => /lost notation/.test(n)), ocrQ.notes);
ok("2 text layer still flags them", blockToQuestion(blk(sym), 3, "LOCAL_PDF").q.notes?.some((n) => /lost notation/.test(n)));
ok("2 OCR: replacement characters still flagged", blockToQuestion(blk(sym.replace("Observe", "Obs�rve")), 3, "LOCAL_OCR").q.notes?.some((n) => /unreadable characters/.test(n)));

// ---- 3. Degenerate options ------------------------------------------------------------------------------------------
type DQ = Parameters<typeof degenerateQuestion>[0] & { notes?: string[]; confidence?: number };
const one: DQ = { number: 106, stem: "Which poison smells of garlic?", options: [{ label: "A", printed: "(a)", text: "2 only" }] };
ok("3 one well-formed option is degenerate", !!degenerateQuestion(one) && optionOnlyReasons(incompleteReading([one])));
const stemHas: DQ = { number: 106, stem: "Which poisoning?\n(a) Alcohol (b) Iron (c) Kerosene (d) Organophosphorus", options: [{ label: "A", printed: "(a)", text: "Alcohol" }] };
const [r106] = repairDegenerateOptions([stemHas], () => null);
ok("3 #106 stem-held options recovered", r106.options.length === 4 && r106.options[3].text === "Organophosphorus" && incompleteReading([r106]).length === 0, r106);
const three: DQ = { number: 104, stem: "Jones major criteria include", options: ["Carditis", "Chorea", "Fever"].map((t, i) => ({ label: "ABC"[i], printed: `(${"abc"[i]})`, text: t })) };
const ocr104 = "104. Jones major criteria include\n(a) Carditis\n(b) Chorea\n(c) Fever\n(d) Arthralgia";
ok("3 three options + clean OCR a–d run → degenerate", !!degenerateQuestion(three, ocr104) && incompleteReading([three], (n) => (n === 104 ? ocr104 : null)).length === 1);
const [r104] = repairDegenerateOptions([three], (n) => (n === 104 ? ocr104 : null));
ok("3 #104 repaired from the OCR twin", r104.options.length === 4 && r104.options[3].text === "Arthralgia", r104.options);
ok("3 three options without a source run → not degenerate (nothing to recover)", !degenerateQuestion(three));
ok("3 no options, no run (statements moved back / numerical) → not degenerate", !degenerateQuestion({ number: 4, stem: "Consider:\n1. x\n2. y", options: [] }));
ok("3 four good options → fine", !degenerateQuestion({ ...three, options: [...three.options, { label: "D", printed: "(d)", text: "Arthralgia" }] }, ocr104));

// ---- 4. Duplicate fragment ------------------------------------------------------------------------------------------
const ai21 = "A 42-year-old lady underwent a laparoscopic cholecystectomy, which was complicated by bile leak. The next step is\nERCP and stenting\nRe-laparoscopy\nPercutaneous drainage\nObservation";
const frag = "laparoscopic cholecystectomy, which was complicated by bile leak. The next step is\nERCP and stenting\nRe-laparoscopy\nPercutaneous drainage\nObservation";
ok("4 fragment of AI Q21 is ≥ 0.8 contained", containedIn(frag, ai21) >= 0.8, containedIn(frag, ai21));
ok("4 a different question is not", containedIn("Which vaccine is live?\nBCG\nIPV\nHib\nTd", ai21) < 0.5, containedIn("Which vaccine is live?\nBCG\nIPV\nHib\nTd", ai21));

// ---- 5. Printed letters kept ----------------------------------------------------------------------------------------
const out = pageSchema.parse({ questions: [{ number: 92, type: "SINGLE_CORRECT", stem: "Megaloblastic anaemia is caused by", options: [{ label: "(a)", text: "Iron deficiency" }, { label: "(c)", text: "Folic acid deficiency" }, { label: "(d)", text: "Lead poisoning" }], printed_answer: ["(c)"], figures: [], confidence: 0.9 }] });
const [q92] = toExtracted(out, 19, "m");
ok("5 (a),(c),(d) stay A,C,D", q92.options.map((o) => o.label).join() === "A,C,D", q92.options);
ok("5 printed answer (c) → C (the printed option)", q92.printedAnswer.join() === "C", q92.printedAnswer);
ok("5 missing (b) noted", q92.notes?.some((n) => /\(b\) is missing/.test(n)), q92.notes);
const [qok] = toExtracted(pageSchema.parse({ questions: [{ number: 1, type: "SINGLE_CORRECT", stem: "x", options: ["(a)", "(b)", "(c)", "(d)"].map((l) => ({ label: l, text: l })), printed_answer: ["b"], figures: [] }] }), 1, "m");
ok("5 normal (a)–(d) unchanged", qok.options.map((o) => o.label).join() === "A,B,C,D" && qok.printedAnswer.join() === "B" && !qok.notes?.length);
const [qrom] = toExtracted(pageSchema.parse({ questions: [{ number: 1, type: "SINGLE_CORRECT", stem: "x", options: ["(i)", "(ii)", "(iii)", "(iv)"].map((l) => ({ label: l, text: l })), printed_answer: ["(iii)"], figures: [] }] }), 1, "m");
ok("5 roman labels still positional", qrom.options.map((o) => o.label).join() === "A,B,C,D" && qrom.printedAnswer.join() === "C", qrom);
const pdQ: ExtractedQuestion = { ...q92, options: [q92.options[0]], continuesOnNextPage: true };
const contQ: ExtractedQuestion = { ...q92, stem: "", options: q92.options.slice(1) };
ok("5 continuation join keeps A,C,D", mergeContinuation(pdQ, contQ, 20).options.map((o) => o.label).join() === "A,C,D");

// ---- 6. Answer line -------------------------------------------------------------------------------------------------
const stmtQ = "Which are correct?\n1. A\n2. B\n4. D\n(a) 1 and 2\n(b) 1, 2 and 4\n(c) 2 only\n(d) 4 only\n";
const a1 = takePrintedAnswer(`${stmtQ}Correct Answer: (B) 1, 2 and 4`);
ok("6 'Correct Answer: (B) 1, 2 and 4' → B only, line removed", a1.answer.join() === "B" && !/Correct Answer/.test(a1.text), a1);
const a2 = takePrintedAnswer("Q\n(a) x\n(b) y\n(c) z\n(d) w\nCorrect Answer: (B) 1, 2 and 4");
ok("6 trailing text that is not option B's → B with a note", a2.answer.join() === "B" && /not that option's text/.test(a2.note ?? ""), a2);
ok("6 'Ans: (a) and (c)' → A, C", takePrintedAnswer("Q\n(a) x\n(b) y\n(c) z\n(d) w\nAns: (a) and (c)").answer.join() === "A,C");
ok("6 'Answer: B' unchanged", takePrintedAnswer("Q\n(a) x\n(b) y\n(c) z\n(d) w\nAnswer: B").answer.join() === "B");

// ---- 7. Statement run with options continuing on the next page --------------------------------------------------------
const ln = (t: string): Line => ({ text: t });
const page27 = ["115. Which drug is first line?", "(a) A", "(b) B", "(c) C", "(d) D", "1. It is to be done at the sub-centre.", "2. It needs a register.", "3. It is reported monthly.", "4. It is the primary responsibility of the ANM.", "Which of the statements given above are correct?", "(a) 1 and 2 only", "(b) 2 and 3 only", "(c) 1, 2 and 3"].map(ln);
const st = { last: 114, sectionIdx: 1 };
const sp = splitQuestions(page27, st);
ok("7 statements 1–4 never become S2 Q1–Q4", sp.blocks.every((b) => b.section === "" && b.number >= 115) && st.sectionIdx === 1 && st.last === 115, sp.blocks.map((b) => `${b.section}#${b.number}`));

// ---- Lead item: statement-code question whose stem lost every statement ----------------------------------------------
const co = (xs: string[]) => xs.map((t, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: t }));
ok("L CMS-GS Q27: no statements in stem, code options → statement-code (Verify 1 can flag the loss)", statementCodeQuestion({ stem: "Which of the statements given above are correct?", options: co(["1 and 2 only", "2 and 3 only", "1 and 3 only", "1, 2 and 3"]) }));
ok("L a count question (1 / 2 / 3 / 4) is not", !statementCodeQuestion({ stem: "How many pairs are correctly matched?", options: co(["1", "2", "3", "4"]) }));
ok("L free-text options are not", !statementCodeQuestion({ stem: "Which drug?", options: co(["Aspirin", "Heparin", "Warfarin", "Statin"]) }));

// ---- 9. Low scan resolution ---------------------------------------------------------------------------------------
const list = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n   1     0 image    1240  1754  rgb     3   8  jpeg   no         5  0   150   150 34.1K 0.5%\n   1     1 image      40    40  rgb     3   8  jpeg   no         6  0   600   600 1K 0.5%\n   2     2 image    2480  3508  rgb     3   8  jpeg   no         9  0   300   300 340K 1.3%\n";
ok("9 page 1 scan = 150 ppi (largest image, not the logo)", scanPpiFromList(list, 1) === 150);
ok("9 page 2 scan = 300 ppi", scanPpiFromList(list, 2) === 300);
ok("9 no image → null", scanPpiFromList(list, 3) === null);

console.log(`redesign-layout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
