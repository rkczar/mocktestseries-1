/**
 * Importer recovery (2026-11-11, Phases A–D) — regression suite. Synthetic / copied test text, disposable scratch DB,
 * scratch storage, mock OpenRouter on loopback: never real AI, never production.
 *
 *   npx tsx scripts/importer-recovery-fixtures.ts /tmp/recov
 *   node scripts/mock-openrouter-vision.mjs 3551 /tmp/recov/mock-vision.json &
 *   AI_IMPORT_DISABLE_KICK=1 AI_IMPORT_OCR=off OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3551 FX_TEST_BASE_URL=http://127.0.0.1:3551 \
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> AI_IMPORT_VAULT_DIR=<scratch> DATABASE_URL=<scratch mts_*> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-recovery.ts /tmp/recov
 *
 * A. field-aware Hindi validation · B. formula / image helpers · C. re-scan targets · D. missing-question rows ·
 * E. candidate compare / merge · F. subject / topic suggestion · G. the pipeline: re-scan candidates, cut-outs,
 * continuation pages, missing questions, approval safety, isolation, audit history, classification actions, import.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, ISSUE_DEFS, type ImporterSettings } from "@/lib/ai-import/config";
import { saveImporterSettings, getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker } from "@/lib/ai-import/adapter";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, setExpectedQuestions } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { applyRescan, approveQuestions, editQuestion, keepTaxonomy, missingQuestionRows, requestImport, rescanMissingQuestion, rescanQuestions, revalidateQuestions, setAnswer, setTaxonomy } from "@/lib/ai-import/review";
import { effective } from "@/lib/ai-import/post";
import { bilingualFindings, devanagariProblems, hindiFieldChecks } from "@/lib/ai-import/bilingual";
import { atomCountDiff, formulaPlain, isNonLinguistic, scriptCounts, structureOnlyText } from "@/lib/ai-import/script-text";
import { missingSlots, pixelRect, rescanTarget, toPageBox } from "@/lib/ai-import/rescan-target";
import { gapPages } from "@/lib/ai-import/reading-checks";
import { compareVersions, mergeChoice } from "@/lib/ai-import/versions";
import { isPlaceholder } from "@/lib/ai-import/process";
import { classificationSuggestion, type TaxonomyTree } from "@/lib/ai-import/taxonomy-suggest";
import { loadExamMemory, rememberCorrection } from "@/lib/ai-import/taxonomy-memory";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import type { ClassificationRecord, ExtractedQuestion, TaxonomyVerification } from "@/lib/ai-import/types";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

const CONFIRM_ANY = 1_000_000;
if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR and IMPORT_STAGING_DIR to scratch directories.");
  process.exit(2);
}
const FX = process.argv[2];
const MOCK = process.env.OPENROUTER_TEST_BASE_URL!;

// Network guard: only the loopback mock may be contacted (a pass proves no real AI provider was called).
const blockedHosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    blockedHosts.add(host);
    throw new Error(`test network guard: request to ${host} refused`);
  }
  return realFetch(input, init);
}) as typeof fetch;

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
async function expectError(name: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
    check(name, false, "no error");
  } catch (e) {
    check(name, re.test(e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : e);
  }
}

// ---- Copied production texts (read-only export 2026-11-11, FSO 2019 Q142/Q148/Q150, FSO 2022 Q141) -------------
const PINACOL = [
  "$$\\text{H}_3\\text{C}-\\underset{\\underset{\\text{CH}_3}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\text{CH}_3$$",
  "$$\\text{H}_3\\text{C}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\text{CH}_3$$",
  "$$\\text{H}_3\\text{C}-\\overset{\\overset{\\text{CH}_3}{|}}{\\text{CH}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\text{CH}_3$$",
  "$$\\text{CH}_3-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{H}}{|}}{\\text{C}}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{H}}{|}}{\\text{C}}}-\\text{CH}_3$$",
];
const PINACOL_DESC = ["Chemical structure: H3C - C(CH3)(CH3) - C(CH3)(OH) - CH3", "Chemical structure: H3C - C(CH3)(OH) - C(CH3)(OH) - CH3", "Chemical structure: H3C - CH(CH3) - C(CH3)(OH) - CH3", "Chemical structure: CH3 - C(H)(OH) - C(H)(OH) - CH3"];
const KW = ["$1 \\times 10^{-14}\\text{ M}^{2}$", "$1 \\times 10^{-7}\\text{ M}$", "$1 \\times 10^{-14}\\text{ M}$", "$1 \\times 10^{-9}\\text{ M}^{2}$"];
const Q148_STEM = "$$\\overset{\\overset{\\text{O}}{\\parallel}}{\\text{R}-\\text{C}}-\\text{O}-\\text{H} + \\text{H}-\\text{O}-\\overset{\\overset{\\text{O}}{\\parallel}}{\\text{C}}-\\text{R} \\xrightarrow[\\text{सांद्र } \\ce{H2SO4}]{\\Delta} ?$$";

const L = (xs: string[]) => xs.map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t }));
const q = (en: Partial<ExtractedQuestion>, hi: Partial<NonNullable<ExtractedQuestion["hi"]>> | null): ExtractedQuestion =>
  ({ section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: "English stem", options: L(["a", "b", "c", "d"]), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "AI_VISION", ...en, hi: hi === null ? null : { stem: "", options: [], confidence: 0.95, unreadable: [], sameOptionOrder: true, figuresDiffer: false, ...hi } }) as ExtractedQuestion;
const uncertain = (e: ExtractedQuestion, imgs?: Set<string>) => bilingualFindings(e, imgs).find((f) => f.code === "BILINGUAL_HINDI_UNCERTAIN")?.detail ?? null;
const mismatch = (e: ExtractedQuestion) => bilingualFindings(e).find((f) => f.code === "BILINGUAL_MISMATCH")?.detail ?? null;
const outcome = (e: ExtractedQuestion, field: string, imgs?: Set<string>) => hindiFieldChecks(e, imgs).find((c) => c.field === field)?.outcome;

function pureChecks() {
  section("A. Hindi validation is field-aware (Phase A)");
  const all4 = new Set(["A", "B", "C", "D"]);
  const pin = q({ stem: "Chemical structure of Pinacol is", options: L(PINACOL) }, { stem: "पिनेकॉल की रासायनिक संरचना है", options: L(PINACOL) });
  check("1. Pinacol (FSO 2019 Q150): Hindi stem + 4 structure options → NOT blocked (was 'only 6% Devanagari')", uncertain(pin, all4) === null && !mismatch(pin), bilingualFindings(pin, all4));
  check("   …stem 'Hindi text verified', every option 'non-linguistic'", outcome(pin, "Hindi question text", all4) === "HINDI_VERIFIED" && ["A", "B", "C", "D"].every((x) => outcome(pin, `Hindi option ${x}`, all4) === "NON_LINGUISTIC"), hindiFieldChecks(pin, all4));
  check("   …and without image records the LaTeX structures alone are still non-linguistic", uncertain(pin) === null);
  const k142 = q({ stem: "The value of $\\text{K}_{\\text{w}}$ at 298 K is", options: L(KW) }, { stem: "298 K पर $\\text{K}_{\\text{w}}$ का मान है", options: L(KW) });
  check("3. Hindi maths stem + formula options (FSO 2019 Q142) → not blocked (was 'only 15%')", uncertain(k142) === null && outcome(k142, "Hindi question text") === "HINDI_VERIFIED", hindiFieldChecks(k142));
  const q148 = q({ stem: Q148_STEM.replace("सांद्र ", "conc. "), options: L(["Anhydride", "Ketone", "Carboxylic acid", "Aldehyde"]) }, { stem: Q148_STEM, options: L(["एनहाइड्राइड", "कीटोन", "कार्बोक्सिलिक अम्ल", "एल्डिहाइड"]) });
  check("   formula stem with Hindi inside \\text{…} (FSO 2019 Q148) → not blocked (was 'only 20%')", uncertain(q148) === null, hindiFieldChecks(q148));
  const cell = ["Mitochondria", "Ribosome", "Golgi body", "Lysosome"];
  const tech = q({ stem: "Which is the powerhouse of the cell?", options: L(cell) }, { stem: "कोशिका का ऊर्जा घर कौन है?", options: L(cell) });
  check("2. Hindi stem + English scientific terms printed the same in both versions → 'English text verified', not blocked", uncertain(tech) === null && outcome(tech, "Hindi option A") === "ENGLISH_VERIFIED", hindiFieldChecks(tech));
  const mixed = q({ stem: "Who gave the structure of DNA?", options: L(["Watson and Crick", "Mendel", "Darwin", "Lamarck"]) }, { stem: "DNA की संरचना किसने दी?", options: L(["वाटसन और क्रिक", "मेंडल", "डार्विन", "लैमार्क"]) });
  check("10. Mixed Hindi–English stem (DNA) → 'mixed verified', not blocked", uncertain(mixed) === null && outcome(mixed, "Hindi question text") === "MIXED_VERIFIED", hindiFieldChecks(mixed));
  const enStem = q({ stem: "pH of 0.01 M HCl", options: L(["1", "2", "3", "4"]) }, { stem: "pH of 0.01 M HCl", options: L(["एक", "दो", "तीन", "चार"]) });
  check("9. English question text with Hindi options → stem 'English verified' (same as English), options Hindi", outcome(enStem, "Hindi question text") === "ENGLISH_VERIFIED" && outcome(enStem, "Hindi option A") === "HINDI_VERIFIED" && uncertain(enStem) === null, hindiFieldChecks(enStem));
  const smudge = q({ stem: "Who contributed?", options: L(["a", "b", "c", "d"]) }, { stem: "जयपुर में किसने योगदान दिया ?", options: L(["जयनारायण व्यास", "अर्जुनलाल सेठी", "माणिक्य लाल वर्मा", "भोगीलाल पांड्या"]), unreadable: ["Slight ink smudge above 'माणिक्य' in option (3), though text remains clear"] });
  check("   a reader note that says the text is clear (FSO 2022 Q141) is not a doubt", uncertain(smudge) === null);

  section("A. Genuine Hindi OCR errors still block — each names its field (case 11)");
  const metals = L(["Iron", "Copper", "Zinc", "Lead"]);
  const hiOpts = L(["लोहा", "तांबा", "जस्ता", "सीसा"]);
  const g = (stem: string, extra: Partial<NonNullable<ExtractedQuestion["hi"]>> = {}) => uncertain(q({ stem: "Which metal is used in galvanisation?", options: metals }, { stem, options: hiOpts, ...extra }));
  check("vowel sign without its letter → blocked, 'Hindi question text: possible OCR error'", /Hindi question text: possible OCR error — a vowel sign/.test(g("जस्तीकरण में ि कस धातु का प्रयोग होता है") ?? ""), g("जस्तीकरण में ि कस धातु का प्रयोग होता है"));
  check("Latin letters joined to a Hindi word → blocked", /Latin letters joined/.test(g("जस्तीकरण मेंa किस धातु का प्रयोग होता है") ?? ""));
  check("two vowel signs in a row (काे) → blocked", /two vowel signs/.test(g("जस्तीकरण में किस धातु काे प्रयोग होता है") ?? ""));
  check("duplicated text (a repeated two-word phrase) → blocked", /are repeated/.test(g("जस्तीकरण में किस धातु किस धातु का प्रयोग होता है") ?? ""));
  check("…but intentional reduplication (कौन कौन) is fine", devanagariProblems("निम्न में से कौन कौन सी धातु है?").length === 0);
  check("OCR garbage in Latin letters ('3π HRH Tor') → blocked", /only 0% of its words are Devanagari/.test(g("3π HRH Tor Fe galvanise") ?? ""));
  check("a 'Hindi' version that is a copy of the English → blocked (Hindi column not read)", /no Devanagari at all/.test(uncertain(q({ stem: "Which metal is used in galvanisation?", options: metals }, { stem: "Which metal is used in galvanisation?", options: metals })) ?? ""));
  const optGarbage = uncertain(q({ stem: "Which is the powerhouse of the cell?", options: L(cell) }, { stem: "कोशिका का ऊर्जा घर कौन है?", options: L(["Mitochondria", "Ribosome", "Golgi body", "HRH Tor"]) }));
  check("a garbled OPTION is named: 'Hindi option D: …'", /Hindi option D: only 0%/.test(optGarbage ?? ""), optGarbage);
  check("an empty Hindi stem while English has words → missing (blocking code BILINGUAL_HINDI_MISSING)", bilingualFindings(q({ stem: "x" }, { stem: "", options: hiOpts }))[0]?.code === "BILINGUAL_HINDI_MISSING");
  check("a real unreadable note is a doubt on its field ('Hindi option C')", /Hindi option C: the reader could not read/.test(g("जस्तीकरण में किस धातु का प्रयोग होता है", { unreadable: ["option (3) second word illegible"] }) ?? ""));
  check("low reader confidence and a disagreeing second read still block", !!g("जस्तीकरण में किस धातु का प्रयोग होता है", { confidence: 0.5 }) && !!g("जस्तीकरण में किस धातु का प्रयोग होता है", { secondReadAgreement: 0.4 }));
  check("an administrator-confirmed Hindi version is trusted for the reading checks (unchanged rule)", g("3π HRH Tor", { confirmedById: "admin" }) === null);
  check("the issue label is 'Hindi text needs review' (no bare 'Hindi text uncertain')", ISSUE_DEFS.BILINGUAL_HINDI_UNCERTAIN.label === "Hindi text needs review" && ISSUE_DEFS.BILINGUAL_HINDI_UNCERTAIN.blocking);

  section("A. Match the Following: English List I / List II take part in the numbers check (case 5)");
  const mtfOpts = ["A-1, B-2, C-3, D-4", "A-2, B-1, C-4, D-3", "A-3, B-4, C-1, D-2", "A-4, B-3, C-2, D-1"];
  const mtf = q({ type: "MATCH_THE_FOLLOWING", stem: "Match List I with List II", listI: ["A", "B", "C", "D"].map((key, i) => ({ key, text: `Vitamin ${["A", "B1", "C", "D"][i]}` })), listII: ["1", "2", "3", "4"].map((key, i) => ({ key, text: ["Night blindness", "Beri-beri", "Scurvy", "Rickets"][i] })), options: L(mtfOpts) }, { stem: "सूची I को सूची II से सुमेलित कीजिए\nA. विटामिन A  B. विटामिन B1  C. विटामिन C  D. विटामिन D\n1. रतौंधी  2. बेरी-बेरी  3. स्कर्वी  4. रिकेट्स", options: L(mtfOpts) });
  check("MTF with lists printed inside the Hindi text → no 'numbers differ' (was FSO Q106/107/110)", mismatch(mtf) === null, mismatch(mtf));
  check("…a real number difference is still a mismatch", /numbers differ/.test(mismatch(q({ stem: "value 0.60" }, { stem: "मान 0.66", options: L(["a", "b", "c", "d"]) })) ?? ""));
  const withEx = q({ stem: "x", hints: { explanation: "Ionic product of water." } }, { stem: "जल", options: L(["क", "ख", "ग", "घ"]) });
  check("the explanation is checked on its own field (English, never blocking)", hindiFieldChecks(withEx).some((c) => c.field === "Explanation" && c.outcome === "ENGLISH_VERIFIED"));

  section("B. Formula / structure helpers (structure image decision)");
  check("LaTeX command names are not English letters (\\text, \\underset …)", scriptCounts(PINACOL[0]).latin === 0 && isNonLinguistic(PINACOL[0]));
  check("chemical formulas and single-letter symbols are not words (H2SO4, NaCl, K)", scriptCounts("H2SO4 NaCl K x").latin === 0);
  check("…English words are counted", scriptCounts("Mitochondria is here").latinWords.length === 3);
  check("structure-only text detected; prose and numbers are not structures", structureOnlyText(PINACOL[1]) && !structureOnlyText("Mitochondria") && !structureOnlyText("$1 \\times 10^{-7}$"));
  check("formula → readable alt text", formulaPlain(PINACOL[0]).startsWith("H3C-") && !/\\/.test(formulaPlain(PINACOL[0])), formulaPlain(PINACOL[0]));
  check("formula vs image description: same atoms → no warning (all 4 Pinacol options)", PINACOL.every((t, i) => atomCountDiff(t, PINACOL_DESC[i]) === null));
  check("…a description in words is never read as atoms ('option B' is not boron)", atomCountDiff(PINACOL[1], "Chemical structure option B") === null && atomCountDiff(PINACOL[1], "Diagram for option B") === null);
  check("…an O lost in the formula → warning names the atom", atomCountDiff(PINACOL[1].replace("OH", "H"), PINACOL_DESC[1]) === "O: 1 vs 2", atomCountDiff(PINACOL[1].replace("OH", "H"), PINACOL_DESC[1]));

  section("C. Re-scan targets: own band, stacked continuation, whole page with reason");
  const reg = (y: number, h: number) => ({ x: 0.05, y, w: 0.9, h });
  const others = [{ section: "", number: 46, pages: [5], region: reg(0.1, 0.2) }, { section: "", number: 48, pages: [5], region: reg(0.6, 0.2) }, { section: "", number: 49, pages: [6], region: reg(0.05, 0.2) }];
  const t1 = rescanTarget({ section: "", number: 46, pages: [5], region: reg(0.1, 0.2) }, others, false);
  check("a question with a stored region → only its band (full width, ± margin)", t1.kind === "REGION" && t1.page === 5 && Math.abs(t1.box.y - 0.075) < 1e-9 && Math.abs(t1.box.h - 0.25) < 1e-9 && t1.box.x === 0 && t1.box.w === 1, t1);
  const t2 = rescanTarget({ section: "", number: 48, pages: [5, 6], region: reg(0.8, 0.15) }, others, false);
  check("8. a question across two pages → STACK of its band on p5 + p6 down to the next question", t2.kind === "STACK" && t2.pages.join() === "5,6" && Math.abs(t2.boxes[0].y - 0.775) < 1e-9 && Math.abs(t2.boxes[1].y + t2.boxes[1].h - 0.075) < 1e-9, t2);
  const t3 = rescanTarget({ section: "", number: 46, pages: [5], region: null }, others, false);
  check("no stored region → whole page, with the reason", t3.kind === "PAGES" && /no position/.test(t3.why), t3);
  const t4 = rescanTarget({ section: "", number: 47, pages: [5], region: null }, others, true);
  check("6. missing Q47 → the band between Q46 and Q48 on its page", t4.kind === "REGION" && Math.abs(t4.box.y - 0.275) < 1e-9 && Math.abs(t4.box.y + t4.box.h - 0.625) < 1e-9 && /between Q46 and Q48/.test(t4.why), t4);
  const t5 = rescanTarget({ section: "", number: 47, pages: [5], region: null }, [{ section: "", number: 46, pages: [5], region: reg(0.1, 0.5) }, { section: "", number: 48, pages: [5], region: reg(0.6, 0.2) }], true);
  check("…no room between the neighbours → whole page, explained", t5.kind === "PAGES" && /no room/.test(t5.why), t5);
  const t6 = rescanTarget({ section: "", number: 47, pages: [5, 6], region: null }, [{ section: "", number: 46, pages: [5], region: reg(0.6, 0.2) }, { section: "", number: 48, pages: [6], region: reg(0.3, 0.2) }], true);
  check("…a missing number between the end of p5 and the top of p6 → stacked bands", t6.kind === "STACK" && t6.pages.join() === "5,6", t6);
  const t7 = rescanTarget({ section: "S2", number: 47, pages: [5], region: null }, others, true);
  check("…neighbours of ANOTHER section are not used (whole page)", t7.kind === "PAGES", t7);
  const parts = [{ page: 5, box: { x: 0, y: 0.775, w: 1, h: 0.225 }, top: 0, height: 0.5, width: 1 }, { page: 6, box: { x: 0, y: 0, w: 1, h: 0.225 }, top: 0.5, height: 0.5, width: 1 }];
  const m1 = toPageBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, parts);
  const m2 = toPageBox({ x: 0.1, y: 0.6, w: 0.2, h: 0.1 }, parts);
  check("cut-out boxes map back to their own page (top part → p5, lower part → p6)", m1.page === 5 && Math.abs(m1.box.y - (0.775 + 0.2 * 0.225)) < 1e-9 && m2.page === 6 && Math.abs(m2.box.y - 0.2 * 0.225) < 1e-9, [m1, m2]);
  const px = pixelRect({ x: 0, y: 0.9, w: 1, h: 0.2 }, 1000, 2000);
  check("pixel rectangles stay inside the page image", px.top === 1800 && px.top + px.height <= 2000 && px.width === 1000, px);

  section("D. Missing-question rows: reliable only");
  const run = (nums: number[], sec = "", status = "EXTRACTED") => nums.map((n) => ({ fileId: "f", section: sec, number: n, pages: [Math.ceil(n / 4)], status }));
  const s1 = missingSlots(run(Array.from({ length: 120 }, (_, i) => i + 1).filter((n) => n !== 47)), 120, new Map([["f", 30]]), gapPages);
  check("1. Q1–Q120 with Q47 missing → exactly one row 'Q47', predicted page 12", s1.slots.length === 1 && s1.slots[0].label === "Q47" && s1.slots[0].pages.join() === "12", s1);
  const s2 = missingSlots([...run([1, 2, 3, 4, 5]), ...run([1, 2, 4], "S2")], null, new Map([["f", 5]]), gapPages);
  check("a section that restarts at 1 is its own run: only S2 Q3 missing (no false gaps)", s2.slots.map((x) => x.label).join() === "S2 Q3", s2);
  const s3 = missingSlots(run([1, 2, 2, 4]), null, new Map([["f", 5]]), gapPages);
  check("repeated numbering → no rows, explained", !s3.slots.length && /repeats/.test(s3.notes.join()), s3);
  const s4 = missingSlots(run([101, 102, 104]), null, new Map([["f", 30]]), gapPages);
  check("numbering that starts at Q101 → Q1–Q100 are NOT missing (only Q103)", s4.slots.map((x) => x.number).join() === "103" && /starts at Q101/.test(s4.notes.join()), s4);
  const s5 = missingSlots([...run([1, 2, 4]), ...run([3], "", "REJECTED")], null, new Map([["f", 5]]), gapPages);
  check("a rejected / withdrawn question has a row → never missing", !s5.slots.length, s5);
  const s6 = missingSlots(run([1, 100]), null, new Map([["f", 30]]), gapPages);
  check("too many gaps → no rows (check failed pages first), explained", !s6.slots.length && /too many/.test(s6.notes.join()), s6);
  const s7 = missingSlots(run([1, 2, 3]), 5, new Map([["f", 5]]), gapPages);
  check("trailing numbers only up to the administrator's expected count", s7.slots.map((x) => x.number).join() === "4,5", s7);

  section("E. Candidate comparison and explicit Save (Phase B)");
  const cur = q({ type: "MATCH_THE_FOLLOWING", listI: [{ key: "A", text: "x" }], listII: [{ key: "1", text: "y" }] }, { stem: "पुराना", options: L(["क", "ख", "ग", "घ"]), confirmedById: "admin" });
  const nxt = q({ type: "MATCH_THE_FOLLOWING", listI: [{ key: "A", text: "x2" }], listII: [{ key: "1", text: "y" }] }, { stem: "नया", options: L(["क", "ख", "ग", "घ2"]) });
  const rows = compareVersions(cur, [], nxt, [{ owner: "OPTION", optionLabel: "D", mappingStatus: "OK", description: "Diagram for option D" } as never]);
  const field = (f: string) => rows.find((r) => r.field === f);
  check("12. comparison covers Hindi text, Hindi options, List I / List II, options and images", !field("hi:stem")?.same && !field("hi:option:D")?.same && field("hi:option:A")?.same === true && !field("lists")?.same && !field("figures")?.same && /Diagram for option D/.test(field("figures")?.rescan ?? ""), rows.map((r) => [r.field, r.same]));
  const merged = mergeChoice(cur, nxt, new Set(["hi:option:D", "lists"] as never));
  check("saving chosen fields: Hindi option D + lists taken, Hindi stem kept, Hindi confirmation reset", merged.hi?.options[3].text === "घ2" && merged.hi?.stem === "पुराना" && merged.listI?.[0].text === "x2" && merged.hi?.confirmedById === null, merged.hi);
  check("an English-only question shows no Hindi rows", !compareVersions(q({}, null), [], q({}, null), []).some((r) => r.field.startsWith("hi:")));
  check("a placeholder (empty admin row) is recognised", isPlaceholder({ method: "ADMIN", stem: "", options: L(["", "", "", ""]) }) && !isPlaceholder({ method: "ADMIN", stem: "x", options: [] }));

  section("F. Subject / topic suggestion (Phase D)");
  const tree: TaxonomyTree[] = [
    { id: "chem", name: "Chemistry", topics: [{ id: "org", name: "Organic", subTopics: [{ id: "alc", name: "Alcohols" }] }, { id: "phy", name: "Physical", subTopics: [] }] },
    { id: "phys", name: "Physics", topics: [{ id: "mech", name: "Mechanics", subTopics: [] }] },
  ];
  const names = new Map(tree.flatMap((s) => [[s.id, s.name] as const, ...s.topics.map((t) => [t.id, t.name] as const)]));
  const name = (x: string | null | undefined) => (x ? (names.get(x) ?? null) : null);
  const local = (subjectId: string, topicId: string | null, subTopicId: string | null = null) => ({ at: "", kind: "ok", subjectId: "phys", topicId: "mech", subTopicId: null, confidence: 0.6, source: "local classifier", reason: "", ai: null, local: { status: "CLASSIFIED", subjectId, topicId, subTopicId, subjectConfidence: 0.8, topicConfidence: 0.7, method: "local terms", reason: "matched “pinacol”, “diol”", candidates: [], evidenceQuestions: 0 } }) as unknown as ClassificationRecord;
  const cur2 = { subjectId: "phys", topicId: "mech", subTopicId: null };
  const sg = classificationSuggestion({ current: cur2, adminDecided: false, record: local("chem", "org", "alc"), v1: null, v2: null, tree, name });
  check("11. Chemistry question filed under Physics → suggestion Chemistry › Organic › Alcohols, with reason and evidence", sg?.subject === "Chemistry" && sg.topic === "Organic" && sg.subTopic === "Alcohols" && /Physics › Mechanics/.test(sg.reason) && sg.evidence.some((x) => /pinacol/.test(x)), sg);
  const v2: TaxonomyVerification = { status: "DISAGREEMENT", stored: cur2, found: { subjectId: "chem", topicId: "phy", subTopicId: null }, confidence: 0.9, method: "mockvision/checker", findings: ["Verify 2 files it under Chemistry › Physical"] };
  const sg2 = classificationSuggestion({ current: cur2, adminDecided: false, record: local("chem", "phy"), v1: null, v2, tree, name });
  check("…an independent Verify 2 disagreement comes first; an agreeing source is listed as evidence", sg2?.topic === "Physical" && /Verify 2/.test(sg2.source) && sg2.evidence.some((x) => /agrees/.test(x)), sg2);
  check("…a topic outside the suggested subject is never suggested (hierarchy kept)", classificationSuggestion({ current: cur2, adminDecided: false, record: local("chem", "mech"), v1: null, v2: null, tree, name })?.topicId === null);
  check("…ids outside the exam's taxonomy are never suggested", classificationSuggestion({ current: cur2, adminDecided: false, record: local("bio", "cell"), v1: null, v2: null, tree, name }) === null);
  check("…nothing over an administrator's decision", classificationSuggestion({ current: cur2, adminDecided: true, record: local("chem", "org"), v1: null, v2, tree, name }) === null);
  check("…nothing when the evidence agrees with the current classification", classificationSuggestion({ current: { subjectId: "chem", topicId: "org", subTopicId: null }, adminDecided: false, record: local("chem", "org"), v1: null, v2: null, tree, name }) === null);
  check("…a missing optional subtopic is not a reason to suggest", classificationSuggestion({ current: { subjectId: "chem", topicId: "org", subTopicId: null }, adminDecided: false, record: local("chem", "org", null), v1: null, v2: null, tree, name }) === null);
}

async function upload(actor: string, jobId: string, file: string) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role: "PAPER" as never, paperFileId: null });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  return { fileId, ...(await completeFile({ fileId, actorId: actor })) };
}
async function setSettings(patch: (s: ImporterSettings) => ImporterSettings, actor: string) {
  await saveImporterSettings(patch(normalizeImporterSettings(await getImporterSettings())), actor);
}
const mockStats = async () => (await (await realFetch(`${MOCK}/__mock/stats`)).json()) as { byMarker: Record<string, number>; byModel: Record<string, number> };

async function main() {
  pureChecks();
  if (!FX) throw new Error("fixture directory missing");
  const suffix = Date.now().toString(36);
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.create({ data: { name: `RC Exam ${suffix}`, code: `RC-${suffix}`, isActive: true, languageMode: "BILINGUAL" } });
  const chem = await createFixtureSubject(prisma, { examId: exam.id, name: `RC Chemistry ${suffix}` });
  const organic = await createFixtureTopic(prisma, { subjectId: chem.id, name: `RC Organic ${suffix}` });
  const bio = await createFixtureSubject(prisma, { examId: exam.id, name: `RC Biology ${suffix}` });
  const cellT = await createFixtureTopic(prisma, { subjectId: bio.id, name: `RC Cell ${suffix}` });
  const phys = await createFixtureSubject(prisma, { examId: exam.id, name: `RC Physics ${suffix}` });
  const mech = await createFixtureTopic(prisma, { subjectId: phys.id, name: `RC Mechanics ${suffix}` });

  section("G. Pipeline on a bilingual scanned paper (mock vision, ₹0)");
  await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
  check("OpenRouter (mock) connection test", (await testOpenRouterConnection()).ok);
  await setOpenRouterEnabled(true);
  await syncCatalog();
  await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
  const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
  await setSettings((s) => ({ ...s, aiEnabled: true, selection: { mode: "manual" }, importerModels: mockIds, models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null }, privacy: { dataCollection: "deny", zdr: false } }), actor);
  await realFetch(`${MOCK}/__mock/reset`, { method: "POST" });
  const jobId = await createJob({ actorId: actor, title: `RC paper ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  const paper = await upload(actor, jobId, "recovery-paper.pdf");
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  await setExpectedQuestions({ jobId, actorId: actor, expected: 11 });
  const j0 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  await confirmJob({ jobId, actorId: actor, examId: j0.examId, paperType: j0.paperType, subjectId: j0.subjectId, year: j0.year, paperCode: j0.paperCode, previousYearPaperId: j0.previousYearPaperId, confirmedMaxInr: CONFIRM_ANY });
  await runWorker(300_000);
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  check("job processed", job.status === "NEEDS_REVIEW", { s: job.status, e: job.errorMessage, p: job.pauseReason });
  const all = async () => prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true, versions: true }, orderBy: { orderIndex: "asc" } });
  const byNo = async (n: number) => (await all()).find((x) => effective(x).number === n)!;
  const qs0 = await all();
  check("10 questions read (Q8 not read by the first pass)", qs0.length === 10 && !qs0.some((x) => effective(x).number === 8), qs0.map((x) => effective(x).number));

  const q1 = await byNo(1);
  check("1. Pinacol: Hindi stem + structure options → no 'Hindi text needs review'", !q1.issueCodes.includes("BILINGUAL_HINDI_UNCERTAIN"), { codes: q1.issueCodes, issues: q1.issues });
  check("   …4 option images, one per option", q1.figures.length === 4 && ["A", "B", "C", "D"].every((l) => q1.figures.some((f) => f.owner === "OPTION" && f.optionLabel === l)), q1.figures.map((f) => [f.owner, f.optionLabel]));
  check("   …option D formula (one O less than its image) → review warning naming option D (non-blocking)", q1.issueCodes.includes("OPTION_FORMULA_IMAGE_DIFFERS") && /option D \(O: 1 vs 2\)/.test(((q1.issues as Record<string, string>) ?? {}).OPTION_FORMULA_IMAGE_DIFFERS ?? "") && !ISSUE_DEFS.OPTION_FORMULA_IMAGE_DIFFERS.blocking, q1.issues);
  check("3. Kw: Hindi maths stem + formula options → not blocked", !(await byNo(3)).issueCodes.some((c) => c.startsWith("BILINGUAL")), (await byNo(3)).issues);
  const q4 = await byNo(4);
  check("4. genuine Hindi OCR error → still blocked, message names the field and the text", q4.issueCodes.includes("BILINGUAL_HINDI_UNCERTAIN") && /Hindi question text: possible OCR error/.test(((q4.issues as Record<string, string>) ?? {}).BILINGUAL_HINDI_UNCERTAIN ?? "") && /Hindi text needs review/.test(importBlocker(q4, await getImporterSettings()) ?? ""), q4.issues);
  check("5. MTF with English List I / List II → no 'Hindi and English versions differ'", !(await byNo(5)).issueCodes.includes("BILINGUAL_MISMATCH"), (await byNo(5)).issues);
  const q10 = await byNo(10);
  check("Q10 was joined across pages 2–3 by the first read", q10.pages.join() === "2,3", q10.pages);

  section("G. Missing question rows (case 6 / 15)");
  const miss = await missingQuestionRows(jobId);
  check("exactly one missing row: Q8, expected on page 2", miss.slots.length === 1 && miss.slots[0].label === "Q8" && miss.slots[0].pages.join() === "2", miss);
  await expectError("a number that is not missing is refused, nothing created", () => rescanMissingQuestion({ jobId, fileId: paper.fileId, section: "", number: 99, actorId: actor }), /not a missing number/);
  check("…no row was created for it", (await prisma.aiImportQuestion.count({ where: { jobId } })) === 10);

  // Isolation baseline: every question's content, approval and figures.
  const snap = async () => new Map((await all()).map((x) => [x.id, JSON.stringify({ d: { ...(x.data as object), classification: undefined, checks: undefined, paperVerify: undefined }, e: x.editedData, a: x.approvedById, f: x.figures.map((f) => f.id).sort(), s: x.subjectId, t: x.topicId })]));
  const page1 = await prisma.aiImportPage.findFirstOrThrow({ where: { fileId: paper.fileId, pageNumber: 1 } });
  const versionsBefore = await prisma.aiImportQuestionVersion.count({ where: { jobId } });

  const r8 = await rescanMissingQuestion({ jobId, fileId: paper.fileId, section: "", number: 8, actorId: actor });
  check("re-scan of missing Q8 reads only its band between Q7 and Q9", r8.reads.some((x) => /only its part of page 2 \(between Q7 and Q9 on page 2\)/.test(x)), r8.reads);
  const ph = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: r8.questionId } });
  check("…an empty placeholder row exists at Q8, page 2", isPlaceholder(effective(ph)) && effective(ph).number === 8 && ph.pages.join() === "2");
  const before8 = await snap();
  await runWorker(300_000);
  let stats = await mockStats();
  check("…the mock received the Q8 cut-out (marker 7), not a whole page", (stats.byMarker["7"] ?? 0) === 1, stats.byMarker);
  const ph2 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: r8.questionId }, include: { versions: true } });
  const cand8 = ph2.versions.find((v) => v.kind === "RESCAN" && v.status === "PENDING");
  check("15. the reading waits as a PENDING candidate; the placeholder is still empty (no automatic fill)", !!cand8 && /missing from the first read/.test((cand8.data as unknown as ExtractedQuestion).stem) && isPlaceholder(effective(ph2)) && ph2.issueCodes.includes("RESCAN_PENDING"), { v: ph2.versions.map((v) => [v.kind, v.status]), codes: ph2.issueCodes });
  check("…its region was mapped back to page coordinates (inside Q7–Q9 band)", (() => { const r = (cand8?.data as unknown as ExtractedQuestion)?.region; return !!r && r.y > 0.4 && r.y + r.h < 0.65; })(), (cand8?.data as unknown as ExtractedQuestion)?.region);
  const after8 = await snap();
  check("13. no other question changed", [...before8].every(([id, s]) => id === r8.questionId || after8.get(id) === s));
  const rows8 = compareVersions(effective(ph2), [], cand8!.data as unknown as ExtractedQuestion, []);
  await applyRescan(cand8!.id, actor, rows8.filter((r) => !r.same).map((r) => r.field));
  const ph3 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: r8.questionId } });
  check("…explicit Save fills Q8 (stem + Hindi); the empty extraction stays in `data`", /missing from the first read/.test(effective(ph3).stem) && !!effective(ph3).hi?.stem && isPlaceholder(ph3.data as unknown as ExtractedQuestion), effective(ph3).stem);
  check("…and the missing row is gone", !(await missingQuestionRows(jobId)).slots.length);

  section("G. Row re-scan of an incorrectly extracted question (case 7) — cut-out, candidate, Save");
  const q2 = await byNo(2);
  check("first read of Q2 is garbled", /Garbled/.test(effective(q2).stem));
  const before2 = await snap();
  const r2 = await rescanQuestions([q2.id], "question", actor);
  check("the row re-scan reads only Q2's part of page 1", r2.pages === 1 && r2.reads.some((x) => /Q2: only its part of page 1/.test(x)), r2);
  await runWorker(300_000);
  stats = await mockStats();
  check("…the mock received Q2's cut-out (marker 4)", (stats.byMarker["4"] ?? 0) === 1, stats.byMarker);
  let q2r = await byNo(2);
  const cand2 = q2r.versions.find((v) => v.kind === "RESCAN" && v.status === "PENDING");
  check("Q2 itself NOT changed: the correct reading waits as a candidate", /Garbled/.test(effective(q2r).stem) && !!cand2 && (cand2.data as unknown as ExtractedQuestion).stem === "Which is the powerhouse of the cell?" && q2r.issueCodes.includes("RESCAN_PENDING"), { stem: effective(q2r).stem, v: q2r.versions.map((v) => [v.kind, v.status]) });
  check("…its region mapped back to page 1 (≈ 0.32)", Math.abs(((cand2?.data as unknown as ExtractedQuestion)?.region?.y ?? 0) - 0.32) < 0.01, (cand2?.data as unknown as ExtractedQuestion)?.region);
  const after2 = await snap();
  check("13. no other question changed", [...before2].every(([id, s]) => id === q2.id || after2.get(id) === s));
  const page1b = await prisma.aiImportPage.findUniqueOrThrow({ where: { id: page1.id } });
  check("…page 1's own reading and outcome are kept; the re-scan is appended to its log", JSON.stringify((page1b.rawOutput as { ai?: unknown }).ai) === JSON.stringify((page1.rawOutput as { ai?: unknown }).ai) && page1b.outcome === page1.outcome && page1b.outcomeReason === page1.outcomeReason && ((page1b.rawOutput as { rescanReads?: unknown[] }).rescanReads?.length ?? 0) === 1);
  const rows2 = compareVersions(effective(q2r), [], cand2!.data as unknown as ExtractedQuestion, []);
  check("12. the comparison shows the English text as different, the Hindi text as same", rows2.some((r) => r.field === "stem" && !r.same) && rows2.some((r) => r.field === "hi:stem" && r.same), rows2.map((r) => [r.field, r.same]));
  await applyRescan(cand2!.id, actor, ["stem"]);
  q2r = await byNo(2);
  check("…Save takes the stem; the garbled first read stays in `data`; ADMIN_EDIT version recorded", effective(q2r).stem === "Which is the powerhouse of the cell?" && /Garbled/.test((q2r.data as unknown as ExtractedQuestion).stem) && q2r.versions.some((v) => v.kind === "ADMIN_EDIT") && q2r.versions.some((v) => v.id === cand2!.id && v.status === "APPLIED"));

  section("G. Re-scan of an APPROVED question (case 9)");
  await setTaxonomy(q2.id, actor, bio.id, cellT.id);
  await setAnswer(q2.id, actor, ["A"]);
  await revalidateQuestions(jobId, [q2.id]);
  const ap = await approveQuestions([q2.id], actor);
  check("Q2 approved", ap.approved === 1, ap);
  const r2b = await rescanQuestions([q2.id], "question", actor);
  await runWorker(300_000);
  q2r = await byNo(2);
  const cand2b = q2r.versions.find((v) => v.kind === "RESCAN" && v.status === "PENDING");
  check("the approval stays and the content is unchanged; the reading waits as a candidate", !!q2r.approvedById && !!cand2b && effective(q2r).stem === "Which is the powerhouse of the cell?" && r2b.questions === 1, { a: q2r.approvedById, v: q2r.versions.map((v) => [v.kind, v.status]) });
  check("…while the candidate waits, Q2 cannot be imported", /Re-scan result waiting/.test(importBlocker(q2r, await getImporterSettings()) ?? ""), importBlocker(q2r, await getImporterSettings()));
  await applyRescan(cand2b!.id, actor, []);
  q2r = await byNo(2);
  check("…'Keep the current question' (nothing taken) keeps the approval", !!q2r.approvedById && q2r.versions.find((v) => v.id === cand2b!.id)?.status === "APPLIED");
  await editQuestion(q2.id, actor, { stem: "Which is the powerhouse of the cell? [edited]", options: effective(q2r).options, type: effective(q2r).type, contentFormat: effective(q2r).contentFormat, hi: { stem: effective(q2r).hi!.stem, options: effective(q2r).hi!.options.map((o) => ({ text: o.text })) } });
  await revalidateQuestions(jobId, [q2.id]);
  check("(an edit withdraws the approval — existing rule)", !(await byNo(2)).approvedById);
  await approveQuestions([q2.id], actor);
  await rescanQuestions([q2.id], "question", actor);
  await runWorker(300_000);
  q2r = await byNo(2);
  const cand2c = q2r.versions.find((v) => v.kind === "RESCAN" && v.status === "PENDING")!;
  check("10. a manually corrected AND approved question: manual text kept, approval kept until Save", effective(q2r).stem.endsWith("[edited]") && !!q2r.approvedById && !!cand2c);
  await applyRescan(cand2c.id, actor, ["stem"]);
  q2r = await byNo(2);
  check("…saving a changed field withdraws the approval (re-approval needed)", !q2r.approvedById && effective(q2r).stem === "Which is the powerhouse of the cell?");
  await expectError("…a 4th re-scan of Q2 is refused (3 verification passes per question, unchanged)", () => rescanQuestions([q2.id], "question", actor), /already had 3 verification passes/);

  section("G. Manually corrected question, whole-page re-scan (case 10)");
  const q7 = await byNo(7);
  await editQuestion(q7.id, actor, { stem: `${effective(q7).stem} [manual]`, options: effective(q7).options, type: effective(q7).type, contentFormat: effective(q7).contentFormat, hi: { stem: effective(q7).hi!.stem, options: effective(q7).hi!.options.map((o) => ({ text: o.text })) } });
  const before7 = await snap();
  const r7 = await rescanQuestions([q7.id], "page", actor);
  check("'Re-scan its source page' reads the whole page", r7.reads.some((x) => /whole page 2/.test(x)), r7.reads);
  await runWorker(300_000);
  const after7 = await snap();
  check("…no question's content changed (Q6, Q7 manual text, Q9, Q10, Q8)", [...before7].every(([id, s]) => after7.get(id) === s));
  const q7r = await byNo(7);
  check("…Q7's manual text kept; its reading waits as a candidate", effective(q7r).stem.endsWith("[manual]") && q7r.versions.some((v) => v.kind === "RESCAN" && v.status === "PENDING"));

  section("G. A cut-out that finds nothing (NOT_FOUND) and a question across two pages (case 8)");
  const q3 = await byNo(3);
  const before3 = await snap();
  await rescanQuestions([q3.id], "question", actor);
  await runWorker(300_000);
  const q3r = await byNo(3);
  check("Q3 not found in its band → NOT_FOUND recorded, Q3 untouched, no candidate", q3r.versions.some((v) => v.kind === "RESCAN" && v.status === "NOT_FOUND") && !q3r.versions.some((v) => v.status === "PENDING") && (await snap()).get(q3.id) === before3.get(q3.id));
  const r10 = await rescanQuestions([q10.id], "question", actor);
  check("Q10 (pages 2–3) is read as ONE stacked image", r10.pages === 1 && r10.reads.some((x) => /pages 2 \+ 3 together/.test(x)), r10.reads);
  await runWorker(300_000);
  stats = await mockStats();
  check("…the mock received the stacked cut-out (marker 6)", (stats.byMarker["6"] ?? 0) === 1, stats.byMarker);
  const c10 = (await byNo(10)).versions.find((v) => v.kind === "RESCAN" && v.status === "PENDING");
  const f10 = ((c10?.figures as { pageNumber: number; optionLabel: string | null; box: { y: number }; width: number; source: string }[] | null) ?? [])[0];
  check("…the candidate spans pages 2–3 with all 4 options", (c10?.data as unknown as ExtractedQuestion)?.pages.join() === "2,3" && (c10?.data as unknown as ExtractedQuestion)?.options.length === 4, c10?.data);
  check("…option D's image is cut from the ORIGINAL page 3 at its page position", !!f10 && f10.pageNumber === 3 && f10.optionLabel === "D" && Math.abs(f10.box.y - 0.05) < 0.01 && f10.width > 0 && f10.source !== "MISSING", f10);

  section("G. Version and audit history preserved (case 14)");
  const versionsAfter = await prisma.aiImportQuestionVersion.count({ where: { jobId } });
  const events = await prisma.aiImportEvent.findMany({ where: { jobId, type: { in: ["RESCAN_REQUESTED", "RESCAN_DONE", "RESCAN_APPLIED"] } } });
  check("versions only grow (never deleted or replaced)", versionsAfter > versionsBefore && (await prisma.aiImportQuestionVersion.count({ where: { jobId, status: "AUTO_APPLIED" } })) === 0, { versionsBefore, versionsAfter });
  check("every request, reading and decision is in the job's event log and the audit log", events.filter((e) => e.type === "RESCAN_REQUESTED").length === 7 && events.filter((e) => e.type === "RESCAN_DONE").length === 7 && (await prisma.auditLog.count({ where: { action: "AI_IMPORT_RESCAN_REQUESTED", entityId: jobId } })) === 7, events.map((e) => e.type));

  section("G. Subject / topic suggestion actions (case 11)");
  const tree = await getExamTaxonomy(prisma, exam.id);
  const q1n = await byNo(1);
  const rec: ClassificationRecord = { at: new Date().toISOString(), kind: "ok", subjectId: phys.id, topicId: mech.id, subTopicId: null, confidence: 0.6, source: "local classifier", reason: "", ai: null, local: { status: "CLASSIFIED", subjectId: chem.id, topicId: organic.id, subTopicId: null, subjectConfidence: 0.85, topicConfidence: 0.75, method: "local terms", reason: "matched “pinacol”, “structure”", candidates: [], evidenceQuestions: 0 } };
  await prisma.aiImportQuestion.update({ where: { id: q1n.id }, data: { subjectId: phys.id, topicId: mech.id, taxonomySource: "AI (mock)", data: { ...(q1n.data as object), classification: rec } as never } });
  const nm = new Map(tree.flatMap((s) => [[s.id, s.name] as const, ...s.topics.map((t) => [t.id, t.name] as const)]));
  const sug = classificationSuggestion({ current: { subjectId: phys.id, topicId: mech.id, subTopicId: null }, adminDecided: false, record: rec, v1: null, v2: null, tree, name: (x) => (x ? (nm.get(x) ?? null) : null) });
  check("Pinacol filed under Physics › Mechanics → suggestion Chemistry › Organic with evidence", sug?.subjectId === chem.id && sug.topicId === organic.id && sug.evidence.some((x) => /pinacol/.test(x)), sug);
  await keepTaxonomy(q1n.id, actor);
  let q1k = await byNo(1);
  check("'Keep current' records the administrator's decision; ids unchanged; nothing suggested afterwards", q1k.taxonomySource === "admin" && q1k.subjectId === phys.id && classificationSuggestion({ current: { subjectId: q1k.subjectId, topicId: q1k.topicId, subTopicId: null }, adminDecided: q1k.taxonomySource === "admin", record: rec, v1: null, v2: null, tree, name: () => null }) === null && (await prisma.auditLog.count({ where: { action: "AI_IMPORT_TAXONOMY_KEPT", entityId: q1n.id } })) === 1);
  await expectError("'Use suggestion' cannot set a topic of another subject (hierarchy validated)", () => setTaxonomy(q1n.id, actor, phys.id, organic.id), /does not belong to the subject/);
  await setTaxonomy(q1n.id, actor, chem.id, organic.id);
  q1k = await byNo(1);
  check("'Use suggestion' sets Chemistry › Organic through the validated edit", q1k.subjectId === chem.id && q1k.topicId === organic.id && q1k.taxonomySource === "admin");
  const memBefore = await loadExamMemory(exam.id);
  await rememberCorrection({ examId: exam.id, jobId, questionId: q1n.id, e: effective(q1k), subjectId: chem.id, topicId: organic.id, subTopicId: null, actorId: actor, bulk: false });
  const mem = await loadExamMemory(exam.id);
  check("an unapproved example is stored PROPOSED only — never an active classification example", (mem?.corrections ?? []).length === (memBefore?.corrections ?? []).length && (mem?.proposedCorrections ?? []).some((p) => p.questionId === q1n.id), { active: mem?.corrections?.length, proposed: mem?.proposedCorrections?.length });

  section("G. Import as Draft: the structure IMAGE is the option, the formula is alt text");
  await setAnswer(q1n.id, actor, ["B"]);
  await revalidateQuestions(jobId, [q1n.id]);
  const ap1 = await approveQuestions([q1n.id], actor);
  check("Q1 approved (the formula/image warning is a reviewed flag, not a blocker)", ap1.approved === 1, ap1);
  await requestImport(jobId, actor, "DRAFT", null);
  await runWorker(300_000);
  const q1i = await byNo(1);
  const saved = q1i.questionId ? await prisma.question.findUnique({ where: { id: q1i.questionId }, include: { options: true, assets: true } }) : null;
  check("Q1 imported as Draft", !!saved && saved.status === "DRAFT", { qid: q1i.questionId, st: saved?.status, j: (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } })).errorMessage });
  const optAssets = saved?.assets.filter((a) => a.role === "OPTION") ?? [];
  check("…every option shows its original image, with no AI formula as option text (English and Hindi)", !!saved && saved.options.length === 4 && saved.options.every((o) => o.text === "" && !o.textHi) && optAssets.length === 4, saved?.options.map((o) => [o.label, o.text.slice(0, 20), o.textHi]));
  check("…the AI formula is kept as the image's alt text, marked unverified (screen readers)", optAssets.every((a) => /^Structure \(AI transcription, unverified\): /.test(a.alt)), optAssets.map((a) => a.alt.slice(0, 60)));
  // The Question Bank's existing media pipeline stores a WebP copy (unchanged by this work); the original crop stays in
  // the importer vault. The copy keeps the original's full pixel size (never downscaled) and its own option.
  check("…each option image keeps the original crop's full size and its own option (original kept in the vault)", optAssets.every((a) => q1i.figures.some((f) => f.optionLabel === a.optionLabel && f.width === a.width && f.height === a.height)), optAssets.map((a) => [a.optionLabel, a.width, a.height]));

  section("Safety");
  stats = await mockStats();
  check("only the loopback mock was contacted (no real AI provider)", blockedHosts.size === 0, [...blockedHosts]);
  check("only the mock reader was used for page readings", Object.keys(stats.byModel).every((m) => m.startsWith("mock")), stats.byModel);
  const spent = (await prisma.aiBudgetReservation.aggregate({ where: { feature: { startsWith: "qimport_" } }, _sum: { settledInr: true } }))._sum.settledInr ?? 0;
  console.log(`  (mock ledger, not real money: ₹${spent.toFixed(4)})`);
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    return prisma.$disconnect().then(() => process.exit(fail ? 1 : 0));
  })
  .catch(async (e) => {
    console.error(e);
    console.log(`\n${pass} passed, ${fail + 1} failed`);
    await prisma.$disconnect();
    process.exit(1);
  });
