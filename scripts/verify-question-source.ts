/**
 * QB source evidence + review workflow regressions (2026-11-26). Pure: no DB, no AI, no network.
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=postgresql://unused/none npx tsx scripts/verify-question-source.ts
 */
import { reviewCategoryOf } from "@/lib/question-source/review";
import { bandsByNumber, numbersFromBboxXml, numbersFromOcr, questionBands } from "@/lib/question-source/capture";

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

// Question crop band (whole question even when its stored region is partial — CMS 2017 P-II Q26)
const R = (y: number, h: number) => ({ x: 0.1, y, w: 0.8, h });
const sib = (n: number, p: number[], r: ReturnType<typeof R> | null) => ({ section: "", number: n, pages: p, region: r });
const b1 = questionBands(sib(26, [4], R(0.88, 0.05)), [sib(25, [4], R(0.6, 0.1)), sib(27, [5], R(0.05, 0.1))]);
ok("partial own region → band from previous question's end to page bottom", b1.length === 1 && b1[0].box!.y < 0.7 && b1[0].box!.y + b1[0].box!.h >= 0.99, b1);
const b2 = questionBands(sib(10, [2], R(0.4, 0.1)), [sib(9, [2], R(0.2, 0.1)), sib(11, [2], R(0.6, 0.1))]);
ok("between neighbours on one page", b2[0].box!.y < 0.3 && b2[0].box!.y > 0.25 && b2[0].box!.y + b2[0].box!.h > 0.59 && b2[0].box!.y + b2[0].box!.h < 0.62, b2);
const b3 = questionBands(sib(30, [6, 7], R(0.8, 0.15)), [sib(31, [7], R(0.3, 0.1))]);
ok("two-page question → two bands", b3.length === 2 && b3[0].page === 6 && b3[1].page === 7 && b3[1].box!.h < 0.35, b3);
ok("no positions at all → whole page", questionBands(sib(5, [1], null), [])[0].box === null);

// Printed question-number positions (real positions; AI regions are coarse guesses)
const xml = '<page width="595" height="842"><line xMin="103" yMin="469" xMax="527" yMax="481"><word xMin="103" yMin="469" xMax="118" yMax="481">25.</word></line><line xMin="103" yMin="630" xMax="520" yMax="642"><word xMin="103" yMin="630" xMax="118" yMax="642">26.</word></line><line xMin="300" yMin="700" xMax="520" yMax="712"><word xMin="300" yMin="700" xMax="318" yMax="712">27.</word></line></page>';
const nx = numbersFromBboxXml(xml);
ok("text layer: 25 and 26 found at the left margin", Math.abs(nx.get(26)!.y - 630 / 842) < 1e-6 && nx.has(25), [...nx]);
ok("text layer: a right-column question number is kept (two-column papers)", nx.has(27));
const no = numbersFromOcr([{ text: "26. A 40-year-old man", box: [150, 1200, 1400, 1240] }, { text: "(a) 26 mg", box: [300, 1300, 900, 1330] }], 2339);
ok("OCR lines: question number found, option text ignored", Math.abs(no.get(26)!.y - 1200 / 2339) < 1e-6 && no.size === 1, [...no]);

const P = (x: number, y: number) => ({ x, y });
const one = bandsByNumber(26, 4, 4, new Map([[25, P(0.17, 0.55)], [26, P(0.17, 0.75)]]), new Map());
ok("single column: from its number to the page bottom", one![0].box.x === 0 && one![0].box.w === 1 && Math.abs(one![0].box.y - 0.738) < 1e-3 && one![0].box.y + one![0].box.h > 0.99, one);
const cols = new Map([[40, P(0.1, 0.56)], [41, P(0.1, 0.9)], [43, P(0.55, 0.3)], [44, P(0.55, 0.57)]]);
const two = bandsByNumber(40, 8, 8, cols, cols);
ok("two columns: own column only, down to the next number in that column", two![0].box.x === 0 && two![0].box.w < 0.6 && two![0].box.y + two![0].box.h < 0.9, two);
const right = bandsByNumber(44, 8, 8, cols, cols);
ok("right column question cropped to the right half", right![0].box.x > 0.4, right);
ok("number not found → null (fallback)", bandsByNumber(99, 1, 1, cols, cols) === null);

// Statement lists ("1. … 2. …") inside a question are indented: never taken as question numbers
const st = numbersFromOcr([{ text: "1. Which of the following", box: [150, 300, 1400, 340] }, { text: "1. Liothyronine", box: [260, 400, 900, 430] }, { text: "2. Levothyroxine", box: [260, 450, 900, 480] }, { text: "2. A 40-year-old", box: [150, 900, 1400, 940] }], 2000, 1650);
ok("question number kept over an indented statement number", Math.abs(st.get(1)!.x - 150 / 1650) < 1e-6 && Math.abs(st.get(2)!.y - 0.45) < 1e-6, [...st]);
const q1 = bandsByNumber(1, 1, 1, new Map([[1, P(0.09, 0.15)], [2, P(0.16, 0.225)], [3, P(0.09, 0.6)]]), new Map());
ok("Q1 crop runs past an indented '2.' to the next question at the same indentation", Math.abs(q1![0].box.y + q1![0].box.h - 0.596) < 1e-3, q1);

// Review B1/B2: List-II numbers mid-page never make a page two-column; "(2)" option labels are not question numbers
const ml = bandsByNumber(7, 3, 3, new Map([[7, P(0.09, 0.1)], [1, P(0.5, 0.2)], [2, P(0.5, 0.25)], [3, P(0.5, 0.3)], [4, P(0.5, 0.35)], [8, P(0.09, 0.6)]]), new Map());
ok("match-list numbers mid-page → still single column", ml![0].box.x === 0 && ml![0].box.w === 1, ml);
const op = numbersFromOcr([{ text: "(2) Hypertension", box: [150, 300, 900, 340] }, { text: "2. A child", box: [150, 900, 1400, 940] }], 2000, 1650);
ok("option label (2) is not question 2", Math.abs(op.get(2)!.y - 0.45) < 1e-6, [...op]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
