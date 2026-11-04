/**
 * Local OCR + page-completeness regression suite of the AI Question Importer (no paid AI, no network).
 *
 *   A. Rules (pure): question-number formats, "Option A" labels, stem hygiene, source-text fidelity (the vision model's
 *      "…caused by porphyrias?" rewrite), blank vs ink, cover / rough-work pages, gutter / furniture / deskew, the
 *      forward-jump rule, and the completeness gate (missing at start / middle / end, unexplained pages, expected count).
 *   B. Real papers from the Original Paper Vault (read-only), compared with VERIFIED ground truth where it exists:
 *      RUHS MO 2016 (vector-outline text), CMS 2025 Paper I and II (300 ppi scans), CMS 2024 Paper I (150 ppi scan;
 *      structure only — its Word copy has option-order errors and is NOT ground truth), CMS 2013 Paper I (~90 ppi;
 *      text truth unverified).
 *   C. Database end-to-end on a scratch database (name must contain "ocr_flows"): the real worker pass on the RUHS
 *      paper with paid AI off — page outcomes, questions, original OCR kept, completeness gate, nothing published.
 *
 *   AI_IMPORT_OCR_VAULT=<vault files dir>  AI_IMPORT_OCR_TRUTH=<ground-truth json dir>  [AI_IMPORT_OCR_CACHE=<dir>]
 *   AI_IMPORT_OCR_PYTHON=<python with rapidocr>  [DATABASE_URL=<scratch …ocr_flows> AI_IMPORT_VAULT_DIR=<scratch> STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch>]
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-ocr.ts [A|B|C …]
 *
 * Without the vault / truth folders the real-paper checks are reported as NOT RUN (a failure), never as passed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanStem, markersOf, splitQuestions, type Line } from "@/lib/ai-import/local-parse";
import { joinPreamble, orphanQuestion } from "@/lib/ai-import/pdf-local";
import { sourceDiffSummary, sourceTextDiff } from "@/lib/ai-import/fidelity";
import { anchorTableLabels, findGutter, isFurniture, layoutOcrPage, nonQuestionPage, skewDegrees, type LayoutLine, type OcrPage } from "@/lib/ai-import/ocr-layout";
import { EXPLAINED_OUTCOMES, readOcrPage } from "@/lib/ai-import/ocr-page";
import { lowCountPages, missingNumbers, qualityReport, unexplainedPages, type QualityInput, type QualityQuestion } from "@/lib/ai-import/quality";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

let pass = 0;
let fail = 0;
const results: Record<string, unknown> = {};
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
const only = process.argv.slice(2).map((x) => x.toUpperCase());
const run = (part: string) => !only.length || only.includes(part);

// ---------------------------------------------------------------------------------------------------- A
function partA() {
  section("A. Rules (pure)");
  const L = (t: string): Line => ({ text: t });
  const b1 = splitQuestions(["Question No: 1", "Question: The SA node is situated at the junction of:", "A. SVC and RA", "B. SVC and LA", "C. LA and LV", "D. IVC and RA", "Question No: 2", "Question: Reverse splitting of S2 is seen in:", "A. ASD", "B. Severe MR", "C. LBBB", "D. Pulmonary stenosis"].map(L)).blocks;
  check("“Question No: 1” starts a question (was not recognised: 4 of 120 parsed)", b1.length === 2 && b1[0].number === 1 && b1[1].number === 2, b1.map((b) => b.number));
  const b2 = splitQuestions(["Q. No. 7 A child was born with a birth weight of 3 Kg.", "Option A 700 Kcal", "Option B 800 kcal", "Option C 900 Kcal", "Option D 1,000 kcal", "Correct Option A"].map(L)).blocks;
  check("“Q. No. 7” starts a question", b2.length === 1 && b2[0].number === 7);
  const fam = markersOf("Stem\nOption A  700 Kcal\nOption B  800 kcal\nOption C  900 Kcal\nOption D  1,000 kcal").map((m) => m.family + m.index);
  check("“Option A … Option D” labels are one option run", fam.join() === "Option A0,Option A1,Option A2,Option A3", fam);

  // Forward jump: one missed question must not swallow the rest of the paper.
  const jump = splitQuestions(["1. First question?", "(a) w", "(b) x", "(c) y", "(d) z", "4. Fourth question?", "(a) w", "(b) x", "(c) y", "(d) z", "5. Fifth?", "(a) w", "(b) x", "(c) y", "(d) z"].map(L)).blocks.map((b) => b.number);
  check("a skip after a complete question is accepted (1 → 4 → 5); the gap is left to the completeness check", jump.join() === "1,4,5", jump);
  const open = splitQuestions(["3. Which of the following dosages is used for", "5. mg/kg in children (continued text)", "(a) one", "(b) two", "(c) three", "(d) four"].map(L)).blocks.map((b) => b.number);
  check("no jump while the open question has no options yet (“5.” stays in Q3)", open.join() === "3", open);

  // Stem hygiene
  const opt = (o: string[]) => o.map((t, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: t }));
  const q1 = { stem: "15. Which of the following causes massive splenic enlargement?\n(a) Rickets and Still’s disease\n(b) Amyloid and Gaucher’s disease\n(c) Porphyria and Felty’s syndrome\n(d) Myelofibrosis and Weil’s disease", number: 15, options: opt(["Rickets and Still’s disease", "Amyloid and Gaucher’s disease", "Porphyria and Felty’s syndrome", "Myelofibrosis and Weil’s disease"]), notes: [] as string[] } as Parameters<typeof cleanStem>[0];
  cleanStem(q1);
  check("stem hygiene: printed number and the copied option list are removed; options untouched", q1.stem === "Which of the following causes massive splenic enlargement?" && q1.options[3].text === "Myelofibrosis and Weil’s disease" && !q1.stemHasOptions, q1.stem);
  const q2 = { stem: "Which drug?\n(a) Atorvastatin\n(b) Ezetimibe is preferred here", number: 56, options: opt(["Atorvastatin", "Fenofibrate", "Metformin", "Ezetimibe"]), notes: [] } as Parameters<typeof cleanStem>[0];
  cleanStem(q2);
  check("stem hygiene: option-like lines that are NOT an exact copy are left and flagged (STEM_HAS_OPTIONS)", q2.stem.includes("(a) Atorvastatin") && q2.stemHasOptions === true, q2);
  const q3 = { stem: "Which of the following statements are correct?\n1. Alpha\n2. Beta", number: 3, options: opt(["1 only", "2 only", "Both", "Neither"]), notes: [] } as Parameters<typeof cleanStem>[0];
  cleanStem(q3);
  check("stem hygiene: numbered statements are not options (unchanged, not flagged)", q3.stem.includes("1. Alpha") && !q3.stemHasOptions);

  // Source fidelity — the real rewrite from CMS 2024 Paper I, page 12, Q55.
  const page = "55. Which one of the following disorders are caused by enzymatic defects in the heme biosynthesis pathway ?\n(a) Porphyrias\n(b) Myelodysplastic syndrome\n(c) Hemophilias\n(d) Plasma cell disorders";
  const ai = "Which one of the following disorders are caused by porphyrias ?\nPorphyrias\nMyelodysplastic syndrome\nHemophilia\nPlasma cell disorders";
  const d1 = sourceTextDiff(ai, page, true);
  check("source check catches the Q55 rewrite (enzymatic / biosynthesis / pathway dropped)", ["enzymatic", "biosynthesis", "pathway"].every((w) => d1.dropped.includes(w)) && !!sourceDiffSummary(d1), d1);
  check("…while a one-letter OCR slip is tolerated (“Hemophilias” vs “Hemophilia”)", !d1.dropped.includes("hemophilias") && !d1.added.includes("hemophilia"), d1);
  const d2 = sourceTextDiff("Which of the following is a feature of X? 250 mg weekly", "Which of the following is NOT a feature of X? 250 mg weekly", true);
  check("source check: a dropped negation (“NOT”) is reported", d2.negations.includes("not"), d2);
  const d3 = sourceTextDiff("Mefloquine: 500 mg weekly", "Mefloquine: 250 mg weekly", true);
  check("source check: a changed dose is reported (500 vs 250)", d3.numbers.includes("500") && d3.numbers.includes("250"), d3);
  const d4 = sourceTextDiff("The temperature range in Walk in Freezers (WIF) should be:\n+20C to +80 C", "Q. No. 1  The temperature range in Walk in Freezers (WIF) should be:\nOption A  +20C to +80 C\nCorrect Option  B", true);
  check("source check: labels (“Q. No. 1”, “Option A”, “Correct Option B”) are not differences", !sourceDiffSummary(d4), d4);

  // Blank vs ink; never blank because a text layer is missing.
  const blankPage: OcrPage = { engine: "t", width: 1000, height: 1400, dpi: 200, ink: 0.0001, rereads: 0, seconds: 0, lines: [] };
  const inkPage: OcrPage = { ...blankPage, ink: 0.04 };
  const s0 = { last: 0, sectionIdx: 1 };
  check("no OCR text and no ink → BLANK_VERIFIED", readOcrPage(blankPage, 1, s0).outcome === "BLANK_VERIFIED");
  check("no OCR text but ink on the page → NEEDS_REVIEW (never blank)", readOcrPage(inkPage, 1, s0).outcome === "NEEDS_REVIEW");
  check("NEEDS_REVIEW / NO_QUESTIONS are not explained outcomes", !EXPLAINED_OUTCOMES.includes("NEEDS_REVIEW") && !EXPLAINED_OUTCOMES.includes("NO_QUESTIONS"));
  check("cover page with numbered instructions → not questions", nonQuestionPage(["DO NOT OPEN THIS TEST BOOKLET UNTIL YOU ARE ASKED TO DO SO", "INSTRUCTIONS", "1. Immediately after the commencement of the examination, check the Test Booklet", "2. Encode your Roll Number on the Answer Sheet", "Time Allowed : Two Hours", "Maximum Marks : 250"])?.kind === "COVER");
  check("rough-work page → not questions", nonQuestionPage(["SPACE FOR ROUGH WORK"])?.kind === "ROUGH_WORK");
  check("a real question page is not a cover", nonQuestionPage(["5. Which of the following is the test booklet of …?", "(a) one", "(b) two", "(c) three", "(d) four", "6. Another question?", "(a) w", "(b) x", "(c) y", "(d) z"]) === null);
  check("furniture: page number, booklet code, watermark URL; a question line in the margin band is kept", isFurniture("( 12 – A )", { x: 0.45, y: 0.95, w: 0.1, h: 0.01 }) && isFurniture("KCSP-A-GMPK", { x: 0.05, y: 0.94, w: 0.1, h: 0.01 }) && isFurniture("www.prepp.in", { x: 0.4, y: 0.5, w: 0.2, h: 0.01 }) && !isFurniture("1. Which of the following heart sounds", { x: 0.1, y: 0.05, w: 0.4, h: 0.01 }));
  const col = (x: number, y: number, w = 0.38): LayoutLine => ({ text: "word ".repeat(6), box: { x, y, w, h: 0.012 }, conf: 0.99 });
  const two = [...Array.from({ length: 12 }, (_, i) => col(0.1, 0.1 + i * 0.05)), ...Array.from({ length: 12 }, (_, i) => col(0.53, 0.1 + i * 0.05)), { text: "GENERAL MEDICINE", box: { x: 0.4, y: 0.05, w: 0.2, h: 0.012 }, conf: 0.99 }];
  const g = findGutter(two);
  check("gutter found between columns even with a centred heading crossing it", g !== null && g > 0.48 && g < 0.53, g);
  check("one column → no gutter", findGutter(Array.from({ length: 20 }, (_, i) => col(0.1, 0.05 + i * 0.04, 0.8))) === null);
  const tilt = (deg: number) => Array.from({ length: 6 }, (_, i) => {
    const y = 100 + i * 60;
    const dy = Math.tan((deg * Math.PI) / 180) * 800;
    return { text: "line", score: 0.99, box: [100, y, 900, y + 30 + dy] as [number, number, number, number], poly: [[100, y], [900, y + dy], [900, y + dy + 30], [100, y + 30]] as [number, number][] };
  });
  check("skew measured from line edges (1.2° scan)", Math.abs(skewDegrees({ width: 1000, lines: tilt(1.2) }) - 1.2) < 0.05, skewDegrees({ width: 1000, lines: tilt(1.2) }));
  const deskewed = layoutOcrPage({ engine: "t", width: 1000, height: 1400, dpi: 200, ink: 0.05, rereads: 0, seconds: 0, lines: tilt(1.2) });
  check("deskew is applied to coordinates only (text unchanged, line tops level)", deskewed.lines.every((l) => l.text === "line") && Math.abs(deskewed.lines[0].box.h - deskewed.lines[5].box.h) < 0.01, deskewed.lines.map((l) => l.box.h));
  // Table label vertically centred in its cell is moved to the cell top (positions only).
  const cells: LayoutLine[] = [
    { text: "Correct Option B", box: { x: 0.08, y: 0.20, w: 0.12, h: 0.015 }, conf: 1 },
    { text: "A 30-year-old man presented with", box: { x: 0.21, y: 0.23, w: 0.6, h: 0.015 }, conf: 1 },
    { text: "Q. No. 25", box: { x: 0.08, y: 0.25, w: 0.08, h: 0.015 }, conf: 1 },
    { text: "discomfort. He had chicken salad", box: { x: 0.21, y: 0.25, w: 0.6, h: 0.015 }, conf: 1 },
    { text: "Option A", box: { x: 0.08, y: 0.29, w: 0.08, h: 0.015 }, conf: 1 },
    { text: "Q. No. 24", box: { x: 0.08, y: 0.10, w: 0.08, h: 0.015 }, conf: 1 },
  ];
  anchorTableLabels(cells);
  check("table layout: a centred “Q. No.” label moves to the first line of its cell (text untouched)", Math.abs(cells[2].box.y - 0.23) < 1e-9 && cells[2].text === "Q. No. 25", cells[2]);
  // Continuation across pages
  const prev: ExtractedQuestion = { section: "", number: 22, label: "22", pages: [4], type: "SINGLE_CORRECT", stem: "All of the following … EXCEPT", options: [{ label: "A", printed: "Option A", text: "High burden of yeast" }], printedAnswer: [], contentFormat: "PLAIN", confidence: 0.4, unreadable: [], figures: [], method: "LOCAL_OCR", ocr: { engine: "t", text: "Q. No. 22 …", minConfidence: 0.99, meanConfidence: 0.99, lowLines: [] } };
  const joined = joinPreamble(prev, "Option B  High antigen titre\nOption C  Raised ICP\nOption D  Strong inflammation\nCorrect Option  D", 5);
  check("a question continued on the next page is joined (4 options, pages 4–5, original OCR text extended)", joined?.options.length === 4 && joined.pages.join() === "4,5" && (joined.ocr?.text ?? "").includes("Option B") && joined.printedAnswer.join() === "D", joined);

  // Completeness gate
  const qq = (n: number | null, page = 1): QualityQuestion => ({ fileId: "f", section: "", number: n, printedNumber: null, status: "READY", approved: false, stored: false, verified: null, issueCodes: [], answerStatus: "OFFICIAL_MATCHED", importBlocker: null, rescanPending: false, page });
  check("missing numbers at the start, middle and end (expected 10)", missingNumbers([3, 4, 5, 7, 8].map((n) => qq(n)), 10).join() === "Q1,Q2,Q6,Q9,Q10");
  const base: QualityInput = { expected: null, questions: [1, 2, 3, 4, 5].map((n) => qq(n)), pages: [], unmatchedKeyEntries: 0, failedKeyFiles: 0, verifierExtras: [], ack: null, processed: true, keyMaxNumber: 100 };
  const r1 = qualityReport(base);
  check("expected count unknown → blocker that names what was read and the key size (tail loss detectable once set)", r1.state === "NEEDS_CORRECTION" && r1.blockers.some((b) => /reads up to Q5/.test(b) && /answer key goes up to 100/.test(b)), r1.blockers);
  const r2 = qualityReport({ ...base, expected: 100 });
  check("expected 100, only Q1–Q5 found → the 95 missing at the END block completion", r2.state === "NEEDS_CORRECTION" && r2.missing.length === 95 && r2.missing[94] === "Q100", r2.missing.slice(-2));
  const legacy = [{ status: "DONE", kind: "BLANK", attempts: 0, errorMessage: null, pageNumber: 2, outcome: null }, { status: "DONE", kind: "SCANNED", attempts: 1, errorMessage: null, pageNumber: 3, outcome: "NO_QUESTIONS", outcomeReason: "no question found" }, { status: "DONE", kind: "BLANK", attempts: 0, errorMessage: null, pageNumber: 4, outcome: "BLANK_VERIFIED" }, { status: "DONE", kind: "SCANNED", attempts: 0, errorMessage: null, pageNumber: 1, outcome: "INSTRUCTIONS" }];
  const un = unexplainedPages(legacy);
  check("unexplained pages: an old unchecked BLANK page and a NO_QUESTIONS page; checked blank + instructions are explained", un.map((u) => u.page).join() === "2,3", un);
  const r3 = qualityReport({ ...base, expected: 5, pages: legacy });
  check("…and they block completion", r3.state === "NEEDS_CORRECTION" && r3.blockers.some((b) => /2 page\(s\) not accounted for/.test(b)), r3.blockers);
  const pagesRead = [1, 2, 3, 4, 5, 6].map((p) => ({ status: "DONE", kind: "SCANNED", attempts: 0, errorMessage: null, fileId: "f", pageNumber: p, outcome: "OCR" }));
  const counts = [5, 5, 1, 5, 5, 2];
  const qs: QualityQuestion[] = [];
  let n = 1;
  counts.forEach((c, i) => {
    for (let k = 0; k < c; k++) qs.push(qq(n++, i + 1));
  });
  const low = lowCountPages(qs, pagesRead);
  check("a page with far fewer questions than usual is flagged (not the last page)", low.map((l) => l.page).join() === "3", low);
}

// ---------------------------------------------------------------------------------------------------- B
interface Truth {
  n: number;
  stem: string;
  options: { text: string; correct?: boolean }[];
  job?: string;
}
interface PaperSpec {
  name: string;
  file: string;
  truth?: { file: string; job?: string; verified: boolean };
  expected: number;
  minFourOptions: number;
  maxStemCer?: number;
  maxOptionCer?: number;
  minNumbered: number;
  coverPages?: number[];
}
const PAPERS: PaperSpec[] = [
  { name: "RUHS MO 2016 (vector-outline text)", file: "04/0420b1660f80db6411ecd1036a881f64e5577931ad8e4ed470ec8bd4d7a9a22b.pdf", truth: { file: "gt-ruhs2016.json", verified: true }, expected: 100, minNumbered: 100, minFourOptions: 99, maxStemCer: 0.01, maxOptionCer: 0.02 },
  { name: "CMS 2025 Paper I (300 ppi scan)", file: "28/28ab53a212461aa74c110649db0756498347b716122845ff2a1aed13adc7df7f.pdf", truth: { file: "gt-cms2025.json", job: "cmvoliwef002copkz8nfb9nm6", verified: true }, expected: 120, minNumbered: 119, minFourOptions: 116, maxStemCer: 0.03, maxOptionCer: 0.03, coverPages: [1] },
  { name: "CMS 2025 Paper II (300 ppi scan)", file: "e1/e1db57b2366ffa56fa6d2a9e5b680f7b192b3fcca5de067c9d41852ff05a244c.pdf", truth: { file: "gt-cms2025.json", job: "cmvq10ofi02a1tvkz6drvwa1m", verified: true }, expected: 120, minNumbered: 119, minFourOptions: 116, maxStemCer: 0.03, maxOptionCer: 0.03, coverPages: [1] },
  { name: "CMS 2024 Paper I (150 ppi scan; structure only)", file: "bf/bf4d2c14de8d3ec34a0dfa6a51d803981628bc946220cb1f6c6cbce6192196c2.pdf", expected: 120, minNumbered: 118, minFourOptions: 114, coverPages: [1] },
  { name: "CMS 2013 Paper I (~90 ppi scan; text truth unverified)", file: "20/2091cb0fafcae0e33b99f59500f6780eeafc347366c7abe586d4f2aa6783b50d.pdf", truth: { file: "gt-cms2013-docx.json", verified: false }, expected: 120, minNumbered: 110, minFourOptions: 100, coverPages: [1] },
];

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

async function pageOcr(file: string, sha: string, page: number): Promise<OcrPage & { cached: boolean }> {
  const cacheDir = process.env.AI_IMPORT_OCR_CACHE;
  const cached = cacheDir ? path.join(cacheDir, sha, `p${page}.json`) : null;
  if (cached && existsSync(cached)) {
    const raw = readFileSync(cached, "utf8");
    if (raw.trim()) return { ...(JSON.parse(raw) as OcrPage), cached: true };
  }
  const { ocrPdfPage } = await import("@/lib/ai-import/ocr");
  const o = await ocrPdfPage(file, page);
  if (cached) {
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, JSON.stringify(o));
  }
  return { ...o, cached: false };
}

async function partB() {
  section("B. Real papers (Original Paper Vault, read-only)");
  const VAULT = process.env.AI_IMPORT_OCR_VAULT ?? "";
  const TRUTH = process.env.AI_IMPORT_OCR_TRUTH ?? "";
  if (!VAULT || !existsSync(VAULT)) {
    check("real papers: AI_IMPORT_OCR_VAULT is set and readable", false, "NOT RUN");
    return;
  }
  const { pdfInfo } = await import("@/lib/ai-import/pdf");
  for (const P of PAPERS) {
    console.log(`\n  -- ${P.name}`);
    const file = path.join(VAULT, P.file);
    if (!existsSync(file)) {
      check(`${P.name}: original file present`, false, "NOT RUN");
      continue;
    }
    const sha = path.basename(P.file).split(".")[0];
    const { pages } = await pdfInfo(file);
    const state = { last: 0, sectionIdx: 1 };
    const qs: ExtractedQuestion[] = [];
    const outcomes: { page: number; outcome: string; reason: string }[] = [];
    let previous: ExtractedQuestion | null = null;
    let seconds = 0;
    let fresh = 0;
    for (let p = 1; p <= pages; p++) {
      const o = await pageOcr(file, sha, p);
      seconds += o.seconds;
      if (!o.cached) fresh++;
      const r = readOcrPage(o, p, state);
      outcomes.push({ page: p, outcome: r.outcome, reason: r.reason });
      const joined = r.extraction ? joinPreamble(previous, r.extraction.preamble, p) : null;
      if (joined) qs[qs.length - 1] = joined;
      const orphan = r.extraction && !joined ? orphanQuestion(previous, r.extraction.preamble, p, "LOCAL_OCR", { engine: o.engine, minConfidence: 0, meanConfidence: r.layout.meanConfidence }) : null;
      if (orphan) qs.push(orphan);
      for (const q of r.extraction?.questions ?? []) {
        cleanStem(q);
        qs.push(q);
      }
      if (r.extraction?.questions.length) previous = r.extraction.questions[r.extraction.questions.length - 1];
    }
    const main = qs.filter((q) => !q.section && q.number !== null);
    const unnumbered = qs.filter((q) => q.number === null).length;
    const nums = main.map((q) => q.number).filter((x): x is number => x !== null);
    const missing = Array.from({ length: P.expected }, (_, i) => i + 1).filter((x) => !nums.includes(x));
    const dups = nums.filter((x, i) => nums.indexOf(x) !== i);
    const four = main.filter((q) => q.options.length === 4).length;
    const unexplained = outcomes.filter((o) => !EXPLAINED_OUTCOMES.includes(o.outcome as never));
    const res: Record<string, unknown> = { pages, explainedPages: pages - unexplained.length, questions: qs.length, unnumbered, numbered: new Set(nums).size, missing, duplicates: dups, fourOptions: four, ocrSecondsPerPage: Math.round((seconds / pages) * 10) / 10, freshlyRead: fresh, outcomes: Object.fromEntries([...new Set(outcomes.map((o) => o.outcome))].map((k) => [k, outcomes.filter((o) => o.outcome === k).map((o) => o.page)])) };
    check(`${P.name}: every page has an explained outcome`, unexplained.length === 0, unexplained);
    for (const c of P.coverPages ?? []) check(`${P.name}: page ${c} (cover / instructions) gives no question`, outcomes[c - 1]?.outcome === "INSTRUCTIONS" && !qs.some((q) => q.pages[0] === c), outcomes[c - 1]);
    check(`${P.name}: question numbers 1–${P.expected} found (≥ ${P.minNumbered})`, new Set(nums).size >= P.minNumbered && nums.every((x) => x >= 1 && x <= P.expected), { found: new Set(nums).size, missing });
    check(`${P.name}: no duplicate numbers`, dups.length === 0, dups);
    check(`${P.name}: questions with exactly four options ≥ ${P.minFourOptions}`, four >= P.minFourOptions, { four, of: main.length, short: main.filter((q) => q.options.length !== 4).map((q) => `Q${q.number}:${q.options.length}`) });
    check(`${P.name}: every OCR question keeps its original OCR text and source page/region`, qs.every((q) => q.method === "LOCAL_OCR" && !!q.ocr?.text && q.pages.length > 0 && (q.number === null || !!q.region)));
    check(`${P.name}: no option list left inside a stem`, !qs.some((q) => q.stemHasOptions), qs.filter((q) => q.stemHasOptions).map((q) => q.number));
    if (P.truth && TRUTH && existsSync(path.join(TRUTH, P.truth.file))) {
      let truth = JSON.parse(readFileSync(path.join(TRUTH, P.truth.file), "utf8")) as Truth[];
      if (P.truth.job) truth = truth.filter((t) => t.job === P.truth!.job);
      let stemC = 0;
      let optC = 0;
      let optN = 0;
      let optExact = 0;
      let matched = 0;
      let ansRead = 0;
      let ansOk = 0;
      let terms = 0;
      let termsOk = 0;
      for (const t of truth) {
        const q = main.find((x) => x.number === t.n);
        if (!q) continue;
        matched++;
        const gs = norm(t.stem);
        stemC += lev(gs, norm(q.stem)) / Math.max(1, gs.length);
        t.options.forEach((o, i) => {
          const c = lev(norm(o.text), norm(q.options[i]?.text ?? "")) / Math.max(1, norm(o.text).length);
          optC += c;
          optN++;
          if (c === 0) optExact++;
        });
        const correct = t.options.map((o, i) => (o.correct ? "ABCD"[i] : "")).join("");
        if (q.printedAnswer?.length && correct) {
          ansRead++;
          if (q.printedAnswer.join("") === correct) ansOk++;
        }
        const hyp = norm([q.stem, ...q.options.map((o) => o.text)].join(" "));
        for (const w of norm([t.stem, ...t.options.map((o) => o.text)].join(" ")).match(/[a-z][a-z-]{5,}/g) ?? []) {
          terms++;
          if (hyp.includes(w)) termsOk++;
        }
      }
      const label = P.truth.verified ? "verified" : "UNVERIFIED";
      Object.assign(res, { truth: label, matched: `${matched}/${truth.length}`, stemCer: Math.round((stemC / Math.max(1, matched)) * 10000) / 100, optionCer: Math.round((optC / Math.max(1, optN)) * 10000) / 100, optionsExact: `${optExact}/${optN}`, printedAnswers: `${ansOk}/${ansRead}`, longWordsExact: Math.round((termsOk / Math.max(1, terms)) * 10000) / 100 });
      check(`${P.name}: matches ${label} truth for ≥ ${Math.min(truth.length, P.minNumbered)} questions`, matched >= Math.min(truth.length, P.minNumbered) - 1, res);
      if (P.maxStemCer !== undefined) check(`${P.name}: stem character error ≤ ${P.maxStemCer * 100}% (${label} truth)`, stemC / Math.max(1, matched) <= P.maxStemCer, res.stemCer);
      if (P.maxOptionCer !== undefined) check(`${P.name}: option character error ≤ ${P.maxOptionCer * 100}% (${label} truth)`, optC / Math.max(1, optN) <= P.maxOptionCer, res.optionCer);
      if (ansRead) check(`${P.name}: every printed answer read matches the verified answer`, ansOk === ansRead, res.printedAnswers);
    }
    results[P.name] = res;
    console.log(`     ${JSON.stringify(res)}`);
  }
}

// ---------------------------------------------------------------------------------------------------- C
async function partC() {
  section("C. Database end-to-end (scratch DB, paid AI off)");
  const url = process.env.DATABASE_URL ?? "";
  if (!/ocr_flows/.test(url) || /\/mocktestseries(\?|$)/.test(url)) {
    check("scratch database (name contains “ocr_flows”)", false, "NOT RUN — refusing to touch any other database");
    return;
  }
  for (const v of ["AI_IMPORT_VAULT_DIR", "STORAGE_DIR", "IMPORT_STAGING_DIR"]) {
    if (!process.env[v] || /mocktestseries-shared|ai-import-vault$/.test(process.env[v]!)) {
      check(`${v} points at a scratch folder`, false, process.env[v]);
      return;
    }
  }
  const VAULT = process.env.AI_IMPORT_OCR_VAULT ?? "";
  const src = path.join(VAULT, PAPERS[0].file);
  if (!existsSync(src)) {
    check("RUHS original available", false, "NOT RUN");
    return;
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new Error(`test network guard: request to ${host} refused`);
    return realFetch(input, init);
  }) as typeof fetch;
  const { prisma } = await import("@/lib/prisma");
  const { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis } = await import("@/lib/ai-import/jobs");
  const { runWorker } = await import("@/lib/ai-import/worker");
  const { jobQuality } = await import("@/lib/ai-import/summary");
  const { CHUNK_BYTES, normalizeImporterSettings } = await import("@/lib/ai-import/config");
  const { getImporterSettings, saveImporterSettings } = await import("@/lib/ai-import/settings");
  const { ocrAvailable } = await import("@/lib/ai-import/ocr");
  check("local OCR is available to the worker (AI_IMPORT_OCR_PYTHON)", ocrAvailable());
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const saved = normalizeImporterSettings(await getImporterSettings());
  await saveImporterSettings({ ...saved, aiEnabled: false }, admin.id);
  const questionsBefore = await prisma.question.count();
  const jobs: string[] = [];
  try {
    const jobId = await createJob({ actorId: admin.id, title: `OCR RUHS 2016 ${Date.now().toString(36)}`, examId: exam.id, paperType: "FULL_PAPER" as never, subjectId: null, year: 2016, paperCode: null, previousYearPaperId: null, expectedQuestions: 100 });
    jobs.push(jobId);
    const bytes = readFileSync(src);
    const { fileId, chunks } = await addFile({ jobId, actorId: admin.id, name: "MO_MEDICAL_2016.pdf", size: bytes.length, role: "PAPER" as never, paperFileId: null });
    for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: admin.id, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
    await completeFile({ fileId, actorId: admin.id });
    await requestAnalysis(jobId, admin.id);
    await runWorker(120_000);
    const analysed = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
    const facts = (analysed.analysis as { files?: { facts?: { scannedPages?: number; blankPages?: number } }[] } | null)?.files?.[0]?.facts;
    check("analysis: all 19 pages counted as needing reading (none assumed blank for lack of a text layer)", facts?.scannedPages === 19 && facts?.blankPages === 0, facts);
    await confirmJob({ jobId, actorId: admin.id, examId: exam.id, paperType: analysed.paperType, subjectId: null, year: 2016, paperCode: null, previousYearPaperId: null, confirmedMaxInr: 0 });
    const t0 = Date.now();
    await runWorker(1_800_000);
    const minutes = (Date.now() - t0) / 60000;
    const pages = await prisma.aiImportPage.findMany({ where: { jobId }, orderBy: { pageNumber: "asc" } });
    check("19 pages, every one with a documented outcome (18 read by OCR, 1 blank checked on the page image)", pages.length === 19 && pages.filter((p) => p.outcome === "OCR").length === 18 && pages[18].outcome === "BLANK_VERIFIED", pages.map((p) => `${p.pageNumber}:${p.outcome}`));
    check("original OCR kept per page (text, lines, engine, confidence, ink)", pages.slice(0, 18).every((p) => !!p.ocrText && Array.isArray(p.ocrLines) && !!p.ocrEngine && p.ocrConfidence !== null && p.inkCoverage !== null));
    const qs = await prisma.aiImportQuestion.findMany({ where: { jobId } });
    const data = qs.map((q) => q.data as unknown as ExtractedQuestion);
    check("100 questions Q1–Q100, all LOCAL_OCR, each with its original OCR text", qs.length === 100 && new Set(data.map((d) => d.number)).size === 100 && data.every((d) => d.method === "LOCAL_OCR" && !!d.ocr?.text), { n: qs.length });
    check("questions with exactly four options: 100", qs.filter((q) => q.optionCount === 4).length === 100, qs.filter((q) => q.optionCount !== 4).map((q) => q.sourceLabel));
    const ocrFlag = qs.filter((q) => q.issueCodes.includes("OCR_UNCERTAIN")).map((q) => q.sourceLabel);
    check("the line OCR is unsure of (Q12) is flagged OCR_UNCERTAIN for review", ocrFlag.includes("12"), ocrFlag);
    const ai = await prisma.aiImportAiCall.count({ where: { jobId } });
    check("no AI request was made (₹0)", ai === 0, ai);
    const quality = await jobQuality(jobId);
    check("completeness: nothing missing, no page unaccounted for", !!quality && quality.missing.length === 0 && !quality.blockers.some((b) => /not accounted for|Missing question/.test(b)), quality?.blockers);
    const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
    check("the job is NOT completed by itself (questions wait for review / approval)", job.status === "NEEDS_REVIEW", job.status);
    check("nothing was added to or published in the Question Bank", (await prisma.question.count()) === questionsBefore);
    results["C: RUHS worker run"] = { minutes: Math.round(minutes * 10) / 10, pages: pages.length, questions: qs.length, ocrUncertain: ocrFlag.length, aiCalls: ai, qualityState: quality?.state };
    console.log(`     ${JSON.stringify(results["C: RUHS worker run"])}`);
  } finally {
    await saveImporterSettings(saved, admin.id).catch(() => undefined);
    // AI_IMPORT_OCR_KEEP_JOB=1 keeps the scratch job for a manual look at the admin screens.
    if (process.env.AI_IMPORT_OCR_KEEP_JOB !== "1") for (const id of jobs) await prisma.aiImportJob.delete({ where: { id } }).catch(() => undefined);
    globalThis.fetch = realFetch;
  }
}

async function main() {
  if (run("A")) partA();
  if (run("B")) await partB();
  if (run("C")) await partC();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (process.env.AI_IMPORT_OCR_RESULTS) writeFileSync(process.env.AI_IMPORT_OCR_RESULTS, JSON.stringify(results, null, 1));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
