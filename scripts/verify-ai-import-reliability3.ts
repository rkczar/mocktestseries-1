/**
 * importer-reliability-3 (owner decisions 1–8, 2026-11-05) — scratch database, scratch vault, NO AI request, no network.
 *
 * Real Original Paper Vault samples of CMS 2024 Paper I (AI_IMPORT_REL3_FIXTURES):
 *   cms2024p1-transcription.docx — the Word transcription imported on 2026-11-05 (statements run together in its text)
 *   cms2024p1-key.pdf            — the clean answer key (8-column grid)
 *   CMS_GS_paper1.pdf            — the ORIGINAL scanned paper (read through the RapidOCR cache, AI_IMPORT_OCR_CACHE)
 * Verified truth: scripts/fixtures/ai-import-papers/truth.json (official key transcribed column by column) and the
 * original scan. scripts/fixtures/ai-import-papers/cms2024p1-before.json holds production's BEFORE state (AI answer
 * letters, statuses — no text): what is reconciled, never ground truth.
 * Optional: AI_IMPORT_BANK_STEMS (JSON [{code, text}]) — the Question Bank regression of the statement splitter (pure).
 *
 *   DATABASE_URL=<scratch mts_rel3_*> AI_IMPORT_VAULT_DIR=<scratch> STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch>
 *   AI_IMPORT_REL3_FIXTURES=<dir> AI_IMPORT_OCR_CACHE=<dir> AI_IMPORT_DISABLE_KICK=1 NODE_OPTIONS=--conditions=react-server
 *   npx tsx scripts/verify-ai-import-reliability3.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AiImportAnswerStatus, AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportQuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { putContent } from "@/lib/ai-import/vault";
import { readDocx } from "@/lib/ai-import/docx";
import { blockToQuestion, formatStem, mergedStatements, splitGluedStatements, splitQuestions, statementsOf } from "@/lib/ai-import/local-parse";
import { keyLooksValid, parseKeyText } from "@/lib/ai-import/keys";
import { runPostProcessing } from "@/lib/ai-import/post";
import { eligibleForPublish, fingerprintOf, runVerify1 } from "@/lib/ai-import/paper-verify";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { IMPORTER_SETTING_KEY, ISSUE_DEFS, normalizeImporterSettings } from "@/lib/ai-import/config";
import { answerVerified, importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { checksAllowReady, questionChecks, v2Independence } from "@/lib/ai-import/checks";
import { budgetBlock, capsOf } from "@/lib/ai-import/budget-guard";
import { importerBudgetBlock, reserveForTest, ImporterBudgetError } from "@/lib/ai-import/ai";
import { failureCheckStatus } from "@/lib/ai-import/failure";
import { stampOf } from "@/lib/ai-import/verify-core";
import { parsePdfPageLocal } from "@/lib/ai-import/pdf-local";
import { readOcrPage } from "@/lib/ai-import/ocr-page";
import { ocrQuestion, LOCAL_REFERENCE_OCR, requestLocalReferenceOcr } from "@/lib/ai-import/reference-ocr";
import { runWorker } from "@/lib/ai-import/worker";
import { ocrAvailable } from "@/lib/ai-import/ocr";
import { sourceKeyOf, type ExtractedQuestion, type PaperVerification, type QuestionChecks } from "@/lib/ai-import/types";

const DB = process.env.DATABASE_URL ?? "";
if (!/mts_rel3_/.test(DB) || /\/mocktestseries(\?|$)/.test(DB)) {
  console.error("Refusing to run: DATABASE_URL must be a disposable mts_rel3_* scratch database.");
  process.exit(2);
}
const FX = process.env.AI_IMPORT_REL3_FIXTURES ?? "";
if (!process.env.AI_IMPORT_VAULT_DIR || !FX || !existsSync(path.join(FX, "cms2024p1-transcription.docx"))) {
  console.error("Set AI_IMPORT_VAULT_DIR (scratch) and AI_IMPORT_REL3_FIXTURES (the original papers).");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ""}`);
}
const flat = (s: string) => s.replace(/\s+/g, "");
const RUN = Date.now().toString(36);
const truth = JSON.parse(readFileSync("scripts/fixtures/ai-import-papers/truth.json", "utf8")).papers["cms-2024-p1"].officialKey as Record<string, string>;
const before = JSON.parse(readFileSync("scripts/fixtures/ai-import-papers/cms2024p1-before.json", "utf8")).questions as { n: number; aiAnswer: string[]; finalAnswer: string[]; status: string; v2Classification: string | null; adminTaxonomy: boolean }[];
/** Questions whose numbered statements the Word transcription stores run together (audit 2026-11-05). */
const GLUED = [49, 54, 58, 60, 66, 68, 69, 70, 75, 83, 84, 85, 86, 88, 89, 90, 91, 92, 93, 94, 95, 96, 101, 103, 104, 105, 108, 110, 112, 113, 116, 117, 119];
/** Options of the transcription that differ from the ORIGINAL paper (2026-11-05 comparison with the scan). */
const DOCX_OPTION_DEFECTS = [57, 68, 70, 77, 91, 104, 105];

const Q70 = "Consider the following statements with regard to Vitamin D deficiency:\n1. Vitamin D deficiency is common in northern latitudes.\n2. Vitamin D deficiency is more likely to develop in people with dark skin.\n3. Exposure to UV light is advisable in patients with Vitamin D deficiency.\nWhich of the statements given above are correct?";
const Q119 = "Consider the following statements:\n1. Hepatitis B vaccine has reduced efficacy, if administered intramuscularly.\n2. The maximum time allowed between reconstitution of MMR vaccine and use is 30 minutes.\n3. Maternal antibodies do not interfere with cellular immune response to BCG vaccine.\n4. DTWP is preferred to DTaP for primary immunization in most children.\nWhich of the statements given above are correct?";

/** The original scan read by the deployed OCR pipeline (cache), question by question. */
function scanQuestions(): Map<number, { stem: string; options: string[] }> {
  const dir = path.join(process.env.AI_IMPORT_OCR_CACHE ?? "", "bf4d2c14de8d3ec34a0dfa6a51d803981628bc946220cb1f6c6cbce6192196c2");
  const out = new Map<number, { stem: string; options: string[] }>();
  if (!existsSync(dir)) return out;
  const state = { last: 0, sectionIdx: 1 };
  for (let p = 1; p <= 28; p++) {
    const f = path.join(dir, `p${p}.json`);
    if (!existsSync(f)) continue;
    const d = JSON.parse(readFileSync(f, "utf8"));
    const lines = d.lines.map((l: { text: string; box: number[] }) => ({ text: l.text, box: { x: l.box[0] / d.width, y: l.box[1] / d.height, w: (l.box[2] - l.box[0]) / d.width, h: (l.box[3] - l.box[1]) / d.height } }));
    for (const q of parsePdfPageLocal({ lines, images: [] }, p, state).questions) if (q.number && !out.has(q.number)) out.set(q.number, { stem: q.stem, options: q.options.map((o) => o.text) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
async function pureStatements() {
  section("1. Numbered statements — the real Word transcription (pure)");
  const doc = await readDocx(path.join(FX, "cms2024p1-transcription.docx"));
  const qs = splitQuestions(doc.lines).blocks.map((b) => blockToQuestion(b, 1, "DOCX").q);
  check("120 questions read from the transcription", qs.length === 120, qs.length);
  const by = new Map(qs.map((q) => [q.number!, q]));
  const results = qs.map((q) => ({ n: q.number!, stem: q.stem, f: formatStem(q.stem) }));
  check("FIELD_LABEL: the leading “Question:” label is removed from all 120 (and only it)", results.filter((r) => r.f?.rules.includes("FIELD_LABEL")).length === 120 && results.every((r) => !r.f || !r.f.stem.startsWith("Question")));
  const split = results.filter((r) => r.f?.rules.includes("STATEMENT_BREAKS")).map((r) => r.n);
  check("STATEMENT_BREAKS: 32 of the 33 run-together questions split", split.length === 32 && GLUED.filter((n) => n !== 112).every((n) => split.includes(n)), split);
  check("no question outside the 33 is split", split.every((n) => GLUED.includes(n)), split.filter((n) => !GLUED.includes(n)));
  check("Q112 (a pairs table) is NOT split and stays flagged for manual review", !split.includes(112) && !!mergedStatements(results.find((r) => r.n === 112)!.f?.stem ?? by.get(112)!.stem));
  check("every printed character kept (only the label and whitespace differ)", results.every((r) => !r.f || flat(r.f.stem) === flat(r.stem.replace(/^\s*Question\s*:\s*/, ""))));
  check("after formatting only Q112 still reads as run-together statements", results.filter((r) => mergedStatements(r.f?.stem ?? r.stem)).map((r) => r.n).join() === "112", results.filter((r) => mergedStatements(r.f?.stem ?? r.stem)).map((r) => r.n));
  check("screenshot example Q70 — exact structured text", results.find((r) => r.n === 70)!.f!.stem === Q70, results.find((r) => r.n === 70)!.f!.stem);
  check("screenshot example Q119 — exact structured text", results.find((r) => r.n === 119)!.f!.stem === Q119, results.find((r) => r.n === 119)!.f!.stem);
  check("Q116 “milk:1. 75% …” (a digit after the marker) is split, not left glued", split.includes(116) && statementsOf(results.find((r) => r.n === 116)!.f!.stem).length === 4);
  check("Q104 “… facility, if1. Any …” (a letter before the number) is split", split.includes(104) && statementsOf(results.find((r) => r.n === 104)!.f!.stem).length === 4);
  check("Q101 “10% calcium gluconate” keeps its percentage inside statement 1", /^1\. 10% calcium gluconate intravenously$/m.test(results.find((r) => r.n === 101)!.f!.stem));

  // Verified truth: the ORIGINAL scanned paper. Each split statement must start a line of the scan's question text.
  const scan = scanQuestions();
  if (!scan.size) {
    check("original scan available (AI_IMPORT_OCR_CACHE)", false, "NOT RUN");
    return;
  }
  const N = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, "");
  const rows: { n: number; statements: number; scanStatements: number; boundariesOk: boolean }[] = [];
  for (const n of split) {
    const mine = statementsOf(results.find((r) => r.n === n)!.f!.stem);
    const sc = scan.get(n)?.stem ?? "";
    const scanLines = sc.split("\n").map((l) => N(l.replace(/^\s*\(?\d\s*[.)]\s*/, "")));
    const boundariesOk = mine.every((s) => scanLines.some((l) => l.length >= 4 && N(s.text).startsWith(l.slice(0, Math.min(14, l.length)))));
    const scanStatements = new Set([...sc.matchAll(/(?:^|\n)\s*\(?([1-9])\s*[.)]/g)].map((m) => m[1])).size;
    rows.push({ n, statements: mine.length, scanStatements, boundariesOk });
  }
  const okRows = rows.filter((r) => r.boundariesOk);
  check("statement boundaries agree with the original scan for 31 of 32 splits", okRows.length >= 31, rows.filter((r) => !r.boundariesOk));
  check("Q105: the transcription merged two statements (the original prints four) — the split cannot recover it", !!rows.find((r) => r.n === 105 && !r.boundariesOk) || rows.find((r) => r.n === 105)?.statements === 3);
  writeFileSync(path.join(process.env.AI_IMPORT_VAULT_DIR!, "..", "statement-boundaries.json"), JSON.stringify(rows, null, 1));
}

function pureEdgeCases() {
  section("2. Statement splitter — patterns and medical numbers that must NOT be split");
  const splits: [string, string, number][] = [
    ["(1) / (2) markers", "Consider the following statements:(1) Aspirin inhibits COX.(2) Heparin activates antithrombin.Which of the statements given above is/are correct?", 2],
    ["1) / 2) markers", "Consider the following pairs:1) Wilson disease – ATP7B2) Menkes disease – ATP7ASelect the correct answer using the code given below:", 2],
    ["Roman I. II. III. glued to words", "Which of the following heart sounds are best heard with the bell?I. Opening snapII. Systolic clickIII. Third heart soundSelect the correct answer using the code given below:", 3],
    ["(i) (ii) (iii)", "Consider the following drugs:(i) Warfarin(ii) Heparin(iii) DabigatranWhich of the above are anticoagulants?", 3],
    ["Statement 1: / Statement 2:", "Consider the following statements:Statement 1: Lithium has a narrow therapeutic index.Statement 2: Thiazides raise lithium levels.Which of the statements given above is/are correct?", 2],
    ["Statement I: / Statement II:", "Consider the following:Statement I: Insulin lowers potassium.Statement II: Salbutamol lowers potassium.Which of the above is correct?", 2],
  ];
  for (const [name, text, n] of splits) {
    const r = splitGluedStatements(text);
    const lines = r?.stem.split("\n") ?? [];
    check(`splits ${name}`, !!r && lines.length === n + 2 && r.markers.length === n && flat(r.stem) === flat(text), r?.stem);
  }
  const keep: [string, string][] = [
    ["decimals and units", "A 2.5 kg neonate born at 34.2 weeks was given 0.5 mg of vitamin K. Serum potassium was 5.5 mEq/L. Which of the following is the next step?"],
    ["a date", "A patient admitted on 12.03.2024 with fever since 1.5 weeks. What is the diagnosis?"],
    ["an abbreviation", "On I.V.P. Reverse J deformity is seen in -"],
    ["doses and drug concentrations", "Adrenaline 1:1000, 0.01 mg/kg up to 0.5 mg I.M. is given. 2. Which route is preferred?"],
    ["clinical values", "Hb 7 gm/dl, TLC 40000/mm3, platelets 30000/mm3. Bone marrow shows 2. blasts. What is the diagnosis?"],
    ["a single number then text", "Normal range is 3.5-5.0 mmol/L. 1. Hypokalemia causes U waves. Which is true?"],
    ["a measurement after a list item", "Radius of aorta: 1.2 cm. What is the wall stress?"],
    ["already on separate lines", "Consider the following:\n1. Aspirin\n2. Heparin\nWhich are anticoagulants?"],
  ];
  for (const [name, text] of keep) check(`does not split ${name}`, splitGluedStatements(text) === null, splitGluedStatements(text)?.stem);
  check("“Question:” label rule leaves a question that only says “Question:” alone", formatStem("Question: ") === null);
  check("“Question:” inside the text is never removed", formatStem("Which question: is it?") === null);
  check("“Q. No: 5” style numbering is not the label rule's business", formatStem("Q. 5 Which of the following?") === null);
}

function bankRegression() {
  section("3. Question Bank regression of the formatting rules (pure; nothing is written)");
  const file = process.env.AI_IMPORT_BANK_STEMS;
  if (!file || !existsSync(file)) {
    check("Question Bank stems available (AI_IMPORT_BANK_STEMS)", false, "NOT RUN");
    return;
  }
  const rows = JSON.parse(readFileSync(file, "utf8")) as { code: string; text: string }[];
  const changed = rows.map((r) => ({ r, f: formatStem(r.text) })).filter((x) => x.f);
  console.log(`  ${rows.length} stems; would change: ${changed.map((x) => `${x.r.code} [${x.f!.rules.join(",")}]`).join(", ") || "none"}`);
  check("whitespace-only for every changed stem (no character added, removed or reordered)", changed.every((x) => x.f!.rules.includes("FIELD_LABEL") ? false : flat(x.f!.stem) === flat(x.r.text)));
  check("no Question Bank stem has a “Question:” label removed", changed.every((x) => !x.f!.rules.includes("FIELD_LABEL")));
  for (const x of changed) console.log(`  --- ${x.r.code}\n${x.f!.stem.split("\n").map((l) => `      ${l}`).join("\n")}`);
  // Reviewed 2026-11-05: four run-together lists (W29 is an "(i) Sugar (ii) Jaggery …" sequence) — line breaks only.
  check("only the 4 reviewed run-together lists would be split (HR MO 2020 W29, W47, 01 2021 W80, 01 2024 W1108)", changed.map((x) => x.r.code).sort().join("|") === ["01 2021 W80", "01 2024 W1108", "HR MO 2020 W29", "HR MO 2020 W47"].sort().join("|"), changed.map((x) => x.r.code));
  const w80 = changed.find((x) => x.r.code === "01 2021 W80");
  check("01 2021 W80: “Radius of Aorta: 1.2 cm” stays whole (a decimal is never a marker)", !!w80 && /1\.2 cm/.test(w80.f!.stem) && !/\n2 cm/.test(w80.f!.stem));
  check(`stems scanned: ${rows.length}`, rows.length > 8000, rows.length);
}

function pureKey() {
  section("4. Answer key — the real CMS 2024 Paper I key PDF (text layer, pure)");
  const text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path.join(FX, "cms2024p1-key.pdf"), "-"]).toString("utf8").split("\f")[0];
  const pairs = parseKeyText(text);
  check("all 120 entries read from the 8-column grid", new Set(pairs.map((p) => p.number)).size === 120, pairs.length);
  check("the grid layout (row by row: 1, 16, 31 …) is accepted as a valid key", keyLooksValid(pairs));
  const got = new Map(pairs.map((p) => [p.number, p.raw]));
  const diffs = Object.entries(truth).filter(([n, v]) => got.get(Number(n)) !== v);
  check("120 / 120 equal the official key transcribed column by column (truth.json)", diffs.length === 0, diffs);
  check("Q119 = D (official key)", got.get(119) === "D", got.get(119));
  check("dropped questions kept as printed: Q5 X, Q94 X", got.get(5) === "X" && got.get(94) === "X");
  check("two accepted answers kept as printed: Q48 A/B, Q80 B/D", got.get(48) === "A/B" && got.get(80) === "B/D");
  const column = parseKeyText("Q. No. Key\n1 B\n2 C\n3 A\n4 D\n5 B\n6 C\n7 A\n8 D\n9 B\n10 C\n11 A\n12 D");
  check("a one-column key (column-wise) is valid", keyLooksValid(column) && column.length === 12);
  const rowsKey = parseKeyText("Q.No 1 2 3 4 5 6 7 8 9 10\nAns B C A D B C A D B C");
  check("numbers row + answers row is valid", keyLooksValid(rowsKey) && rowsKey.length === 10);
  const noise = parseKeyText("Question 12 asks about 3 drugs. 45 patients, 7 A beds, 99 B wards and 2 C rooms were seen.");
  check("scattered numbers in ordinary text are not a key", !keyLooksValid(noise), noise);
  const dupes = parseKeyText("1 A 1 B 1 C 2 A 2 B 2 C 3 A 3 B 3 C 4 A 4 B 4 C");
  check("a list that repeats the same numbers is not a key", !keyLooksValid(dupes));
}

function pureChecks() {
  section("5. Check statuses (pure) — failures are never disagreements, never passes");
  const base = { codes: [] as string[], issues: new Map<string, string>(), answerStatus: AiImportAnswerStatus.OFFICIAL_MATCHED, answerConfirmed: false, subjectId: "s", topicId: "t", adminTaxonomy: false, v2: null, v2Classification: null, v1Ran: true };
  const clean = questionChecks(base);
  check("clean question with an official key: content / answer / taxonomy PASSED, Verify 2 NOT_RUN (not required)", clean.content.status === "PASSED" && clean.answer.status === "PASSED" && clean.taxonomy.status === "PASSED" && clean.independent.status === "NOT_RUN" && !clean.independent.required && checksAllowReady(clean));
  const ai = questionChecks({ ...base, answerStatus: AiImportAnswerStatus.UNVERIFIED, codes: ["ANSWER_UNVERIFIED"] });
  check("an AI opinion only: answer NEEDS_REVIEW → never Ready", ai.answer.status === "NEEDS_REVIEW" && !checksAllowReady(ai));
  const differs = questionChecks({ ...base, codes: ["AI_OPINION_DIFFERS"], issues: new Map([["AI_OPINION_DIFFERS", "AI opinion B differs from the official key C"]]) });
  check("an AI opinion that differs from a verified official key: answer PASSED with the warning shown (the key is the source of truth)", differs.answer.status === "PASSED" && /Warning: AI opinion B differs/.test(differs.answer.detail) && checksAllowReady(differs));
  const disputed = questionChecks({ ...base, codes: ["ANSWER_MISMATCH", "AI_OPINION_DIFFERS"] });
  check("a disputed key (printed answer / administrator differs) still FAILS the answer check → never Ready", disputed.answer.status === "FAILED" && !checksAllowReady(disputed));
  const noKey = questionChecks({ ...base, answerStatus: AiImportAnswerStatus.AMBIGUOUS_MAPPING, codes: ["ANSWER_AMBIGUOUS"] });
  check("an ambiguous key mapping fails the answer check → admin review", noKey.answer.status === "FAILED" && !checksAllowReady(noKey));
  const confirmed = questionChecks({ ...base, answerStatus: AiImportAnswerStatus.UNVERIFIED, answerConfirmed: true, codes: [] });
  check("an administrator's confirmed answer passes the answer check", confirmed.answer.status === "PASSED");
  const trunc = { status: "VERIFICATION_FAILED" as const, stored: { subjectId: "s", topicId: "t", subTopicId: null }, found: null, confidence: null, method: "m", findings: ["the classification request failed: Model output failure: the model used its whole output limit of 2500 tokens (reasoning) and returned no answer — cut off at the token limit."], comparedWithV1: "NO_V1" as const };
  const tf = questionChecks({ ...base, codes: ["TAXONOMY_CHECK_FAILED"], v2Classification: trunc });
  check("a cut-off Verify 2 classification: taxonomy OUTPUT_TRUNCATED (not DISAGREEMENT, not PASSED) → never Ready", tf.taxonomy.status === "OUTPUT_TRUNCATED" && !checksAllowReady(tf));
  check("a wording pass does not hide a failed classification", tf.content.status === "PASSED" && tf.taxonomy.status !== "PASSED");
  check("timeout message → TIMEOUT", failureCheckStatus("Provider timed out after 301623ms") === "TIMEOUT" && failureCheckStatus("The operation was aborted") === "TIMEOUT");
  check("invalid JSON / provider error → MODEL_ERROR", failureCheckStatus("Model output failure: the classification answer did not match the expected format") === "MODEL_ERROR" && failureCheckStatus("error code: 520") === "MODEL_ERROR");
  const v2 = (over: Partial<NonNullable<PaperVerification["v2"]>>): NonNullable<PaperVerification["v2"]> => ({ fingerprint: "x", at: "", model: "m", status: "VERIFIED", fields: [], detail: "agree", ...over });
  const same = questionChecks({ ...base, v2: v2({ part: "paper.docx part 9 of 15" }) });
  check("Verify 2 re-reading the same Word text: NEEDS_REVIEW, not required, never an independent pass", v2Independence({ part: "paper.docx part 9 of 15" }) === "SAME_TEXT" && same.independent.status === "NEEDS_REVIEW" && !same.independent.required);
  const src = questionChecks({ ...base, v2: v2({ part: "page 4", independence: "SOURCE" }) });
  check("Verify 2 of the original pages: PASSED and required", src.independent.status === "PASSED" && src.independent.required);
  const failed = questionChecks({ ...base, v2: v2({ status: "FAILED", error: { kind: "model_output", message: "the model's answer was cut off at the output limit", model: "m" } }) });
  check("Verify 2 that failed: OUTPUT_TRUNCATED, required → never Ready", failed.independent.status === "OUTPUT_TRUNCATED" && failed.independent.required && !checksAllowReady(failed));
  const unavail = questionChecks({ ...base, v2: v2({ status: "UNAVAILABLE", detail: "budget" }) });
  check("Verify 2 not sent (budget / unavailable): NOT_RUN, not a failure", unavail.independent.status === "NOT_RUN" && !unavail.independent.required);
  const merged = questionChecks({ ...base, codes: ["STATEMENTS_MERGED"] });
  check("run-together statements: content FAILED → never Ready", merged.content.status === "FAILED" && !checksAllowReady(merged));
  const count = questionChecks({ ...base, codes: ["STATEMENT_COUNT_MISMATCH"] });
  check("options citing a missing statement: content NEEDS_REVIEW → never Ready", count.content.status === "NEEDS_REVIEW" && !checksAllowReady(count));
}

function pureBudget() {
  section("6. Budget rule (pure)");
  const caps = capsOf({ monthlyInr: 10, maxJobInr: 8, totalInr: 10, maxRequestInr: 1 }, { monthlyInr: 10, maxJobInr: 8, totalInr: 10, maxRequestInr: 1 });
  const job = { spentInr: 0, inFlightInr: 0, confirmedMaxInr: 8 };
  check("November already spent ₹13.54: every request refused (month)", budgetBlock({ amountInr: 0.01, caps, job, spend: { monthInr: 13.54, allInr: 89.69 } })?.scope === "month");
  check("even a ₹0 request is refused once the month is over budget", budgetBlock({ amountInr: 0, caps, job, spend: { monthInr: 13.54, allInr: 13.54 } })?.scope === "month");
  check("all-time spend over ₹10: refused (total)", budgetBlock({ amountInr: 0.01, caps, job, spend: { monthInr: 0, allInr: 89.69 } })?.scope === "total");
  check("per-job ₹8: refused when spent + in flight + request > 8", budgetBlock({ amountInr: 0.5, caps, job: { spentInr: 7.2, inFlightInr: 0.4, confirmedMaxInr: 408.9 }, spend: { monthInr: 1, allInr: 1 } })?.scope === "job");
  check("the confirmed ₹408.90 maximum never lifts the ₹8 job cap", budgetBlock({ amountInr: 0.9, caps, job: { spentInr: 7.5, inFlightInr: 0, confirmedMaxInr: 408.9 }, spend: { monthInr: 1, allInr: 1 } })?.scope === "job");
  check("a lower confirmed maximum applies", budgetBlock({ amountInr: 0.3, caps, job: { spentInr: 0.8, inFlightInr: 0, confirmedMaxInr: 1 }, spend: { monthInr: 1, allInr: 1 } })?.scope === "job");
  check("per-request ₹1: a ₹1.20 worst case refused", budgetBlock({ amountInr: 1.2, caps, job, spend: { monthInr: 0, allInr: 0 } })?.scope === "request");
  check("within every limit: allowed", budgetBlock({ amountInr: 0.3, caps, job, spend: { monthInr: 2, allInr: 2 } }) === null);
  const raised = capsOf({ monthlyInr: 500, maxJobInr: 200, totalInr: 1500, maxRequestInr: 5 }, { monthlyInr: 10, maxJobInr: 8, totalInr: 10, maxRequestInr: 1 });
  check("a stored value above the bounds is never used (cannot raise the budget)", raised.monthlyInr === 10 && raised.jobInr === 8 && raised.totalInr === 10 && raised.requestInr === 1);
  const stored = normalizeImporterSettings({ budget: { monthlyInr: 5000, maxJobInr: 200, totalInr: 1500, maxRequestInr: 9 }, publish: { allowUnverifiedAnswers: true } });
  check("settings: budgets clamped to the owner's bounds — ₹1,500 / month, ₹200 total, ₹8 / import, ₹1 / request; allowUnverifiedAnswers forced off", stored.budget.monthlyInr === 1500 && stored.budget.totalInr === 200 && stored.budget.maxJobInr === 8 && stored.budget.maxRequestInr === 1 && stored.publish.allowUnverifiedAnswers === false, stored.budget);
  const policy = capsOf({ monthlyInr: 1500, maxJobInr: 8, totalInr: 200, maxRequestInr: 1 }, { monthlyInr: 1500, maxJobInr: 8, totalInr: 200, maxRequestInr: 1 });
  check("new policy: with ₹89.69 ever spent and ₹13.54 this month, a ₹0.30 request is allowed", budgetBlock({ amountInr: 0.3, caps: policy, job, spend: { monthInr: 13.54, allInr: 89.69 } }) === null);
  check("new policy: the ₹200 initial paid-test cap stops paid AI once used (₹199.80 + ₹0.30 → total)", budgetBlock({ amountInr: 0.3, caps: policy, job, spend: { monthInr: 50, allInr: 199.8 } })?.scope === "total");
  check("new policy: the ₹1,500 month stops paid AI (₹1,499.90 + ₹0.30 → month)", budgetBlock({ amountInr: 0.3, caps: { ...policy, totalInr: 5000 }, job, spend: { monthInr: 1499.9, allInr: 1499.9 } })?.scope === "month");
  check("new policy: per-import ₹8 and per-request ₹1 kept", budgetBlock({ amountInr: 0.5, caps: policy, job: { spentInr: 7.8, inFlightInr: 0, confirmedMaxInr: 50 }, spend: { monthInr: 1, allInr: 1 } })?.scope === "job" && budgetBlock({ amountInr: 1.5, caps: policy, job, spend: { monthInr: 1, allInr: 1 } })?.scope === "request");
}

// ---------------------------------------------------------------------------------------------------------------------
async function scratchExam() {
  const exam = await prisma.exam.create({ data: { name: `SYNTHETIC CMS R3 ${RUN}`, code: `SYNR3${RUN}`.slice(0, 20), isActive: true, durationMinutes: 120, totalQuestions: 120, negativeMarking: 0 } });
  const TAX: Record<string, string[]> = {
    "General Medicine": ["Medical Emergencies", "Hematology", "Nutritional Disorders", "Cardiology", "Infectious Diseases"],
    Dermatology: ["Cutaneous Manifestations of Systemic Disease"],
    Pediatrics: ["Immunization", "Neonatology"],
    Psychiatry: ["Mood Disorders"],
    Microbiology: ["Parasitology"],
  };
  const ids = new Map<string, string>();
  for (const [i, [name, topics]] of Object.entries(TAX).entries()) {
    const s = await prisma.subject.create({ data: { name, nameKey: `${taxonomyNameKey(name)}-r3-${RUN}`, originExamId: exam.id, order: i } });
    ids.set(name, s.id);
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: s.id, displayOrder: i } });
    for (const [t, topic] of topics.entries()) {
      const row = await prisma.topic.create({ data: { subjectId: s.id, name: topic, nameKey: `${taxonomyNameKey(topic)}-r3-${RUN}`, order: t } });
      ids.set(`${name} › ${topic}`, row.id);
      await prisma.examTopic.create({ data: { examId: exam.id, topicId: row.id, displayOrder: t } });
    }
  }
  const pyp = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "UPSC CMS PAPER 1 (R3)" } });
  return { exam, ids, pyp };
}

async function vaultFile(name: string, ext: string) {
  const bytes = readFileSync(path.join(FX, name));
  return { bytes, stored: await putContent("files", bytes, ext) };
}

async function seedSettings() {
  // The production values: Paid AI ON, ₹10 / ₹8 / ₹10, allowUnverifiedAnswers stored ON (must be ignored).
  const value = { aiEnabled: true, budget: { monthlyInr: 10, maxJobInr: 8, totalInr: 10, maxRequestInr: 1, keyReserveUsd: 5, defaultJobCapInr: 8 }, publish: { allowUnverifiedAnswers: true, requireTopic: true }, verification: { independentAnswer: true, secondReadBelow: 0.8, topicMinConfidence: 0.7, nearDuplicateAt: 0.85 }, models: { extract: null, verify: null, classify: null, key: null, extractFallbacks: [] } };
  await prisma.setting.upsert({ where: { key: IMPORTER_SETTING_KEY }, create: { key: IMPORTER_SETTING_KEY, value }, update: { value } });
}

async function seedSpend(inr: number, istMonth: string, tag: string) {
  const { istDay } = istDayMonth();
  await prisma.aiBudgetReservation.create({ data: { requestKey: `qi:seed${tag}${RUN}:${Math.random().toString(36).slice(2)}:1`, feature: "qimport_verify", reservedInr: inr, settledInr: inr, costKnown: true, status: "SETTLED", istDay: istMonth === istDayMonth().istMonth ? istDay : `${istMonth}-15`, istMonth, settledAt: new Date() } });
}
const clearSpend = () => prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });

async function budgetGateway(examId: string, actorId: string) {
  section("7. Budget at the gateway (scratch DB) — concurrent requests, job / month / total caps, pre-flight");
  await clearSpend();
  const job = await prisma.aiImportJob.create({ data: { title: `budget ${RUN}`, examId, createdById: actorId, budgetInr: 408.9, status: AiImportJobStatus.PROCESSING } });
  const fire = async (n: number, amount: number) => {
    const res = await Promise.allSettled(Array.from({ length: n }, (_, i) => reserveForTest({ jobId: job.id, requestKey: `qi:${job.id}:c${RUN}${i}${Math.random().toString(36).slice(2)}:1`, feature: "qimport_classify", amountInr: amount })));
    return { ok: res.filter((r) => r.status === "fulfilled").length, scopes: res.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason instanceof ImporterBudgetError ? r.reason.scope : String(r.reason).slice(0, 80))) };
  };
  // Per-job cap ₹8: 30 concurrent requests of ₹0.30 → exactly 26 fit (7.80); the rest are refused — never 27.
  const a = await fire(30, 0.3);
  check("per job: 30 concurrent ₹0.30 requests → exactly 26 reserved (₹7.80 ≤ ₹8), 4 refused as job", a.ok === 26 && a.scopes.length === 4 && a.scopes.every((s) => s === "job"), a);
  await clearSpend();
  // Month ₹10 (spend recorded earlier this month ₹9.00): 10 concurrent ₹0.30 → exactly 3 fit.
  await seedSpend(9, istDayMonth().istMonth, "m");
  const job2 = await prisma.aiImportJob.create({ data: { title: `budget2 ${RUN}`, examId, createdById: actorId, budgetInr: 8, status: AiImportJobStatus.PROCESSING } });
  const res2 = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reserveForTest({ jobId: job2.id, requestKey: `qi:${job2.id}:m${RUN}${i}:1`, feature: "qimport_verify", amountInr: 0.3 })));
  const ok2 = res2.filter((r) => r.status === "fulfilled").length;
  check("per month: with ₹9.00 spent, 10 concurrent ₹0.30 requests → exactly 3 reserved, 7 refused as month", ok2 === 3 && res2.filter((r) => r.status === "rejected" && (r.reason as ImporterBudgetError).scope === "month").length === 7, ok2);
  await clearSpend();
  // All-time ₹10: last month's ₹9.80 still counts.
  await seedSpend(9.8, "2026-10", "t");
  const res3 = await Promise.allSettled([reserveForTest({ jobId: job2.id, requestKey: `qi:${job2.id}:t${RUN}:1`, feature: "qimport_verify", amountInr: 0.3 })]);
  check("all time: ₹9.80 spent last month + ₹0.30 → refused as total", res3[0].status === "rejected" && (res3[0].reason as ImporterBudgetError).scope === "total");
  await clearSpend();
  await seedSpend(13.54, istDayMonth().istMonth, "nov");
  const settings = { ...(await getImporterSettings()) };
  const pre = await importerBudgetBlock(job2.id, settings);
  check("pre-flight: November's ₹13.54 blocks paid AI before a run starts", pre?.scope === "month", pre);
  check("the refusal says nothing was sent and local work continues", /Nothing was sent/.test(pre?.message ?? "") && /deterministic/.test(pre?.message ?? ""));
  await prisma.aiImportJob.updateMany({ where: { id: { in: [job.id, job2.id] } }, data: { status: AiImportJobStatus.CANCELLED } });
  // November's spend stays seeded for the rest of the suite (no paid call can be made).
}

/** The questions as production's release d989bcf extracted them (its reader from git), with production's answers. */
async function productionStateJob(examId: string, pypId: string, actorId: string, ids: Map<string, string>) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "d989bcf-reader-"));
  writeFileSync(path.join(tmp, "local-parse.ts"), execFileSync("git", ["show", "d989bcf:lib/ai-import/local-parse.ts"]));
  const old = (await import(pathToFileURL(path.join(tmp, "local-parse.ts")).href)) as typeof import("@/lib/ai-import/local-parse");
  const doc = await readDocx(path.join(FX, "cms2024p1-transcription.docx"));
  const qs = old.splitQuestions(doc.lines).blocks.map((b) => old.blockToQuestion(b, 1, "DOCX").q);
  const paper = await vaultFile("cms2024p1-transcription.docx", "docx");
  const key = await vaultFile("cms2024p1-key.pdf", "pdf");
  const job = await prisma.aiImportJob.create({ data: { title: `CMS 2024 P I as production ${RUN}`, examId, createdById: actorId, budgetInr: 408.9, spentInr: 10.858, status: AiImportJobStatus.NEEDS_REVIEW, expectedQuestions: 120, previousYearPaperId: pypId } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.PAPER, originalName: "CMS_2024_Paper_I_General_Medicine_Pediatrics_Without_Answers.docx", ext: "docx", declaredBytes: paper.bytes.length, bytes: paper.bytes.length, sha256: paper.stored.sha256, storageKey: paper.stored.key, status: AiImportFileStatus.PROCESSED, detected: { kind: "docx" }, pageCount: 1, uploadedById: actorId } });
  // The key file exactly as production left it: PROCESSED, "no answer-key entries could be read", no entries.
  const keyFile = await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.ANSWER_KEY, paperFileId: file.id, originalName: "CMS_2024_Paper_I_General_Medicine_Pediatrics_Answer_Key.pdf", ext: "pdf", declaredBytes: key.bytes.length, bytes: key.bytes.length, sha256: key.stored.sha256, storageKey: key.stored.key, status: AiImportFileStatus.PROCESSED, errorMessage: "No answer-key entries could be read (a scanned key needs AI vision, which is off or not configured).", detected: { kind: "pdf" }, pageCount: 1, uploadedById: actorId } });
  const byN = new Map(before.map((b) => [b.n, b]));
  for (const [i, q] of qs.entries()) {
    const b = byN.get(q.number!)!;
    await prisma.aiImportQuestion.create({
      data: {
        jobId: job.id, fileId: file.id, sourceKey: sourceKeyOf(q), sourceNumber: q.number, sourceLabel: q.label, pages: q.pages, orderIndex: i,
        status: b.status as AiImportQuestionStatus, data: q as unknown as Prisma.InputJsonValue, questionType: q.type, optionCount: q.options.length, contentFormat: q.contentFormat, confidence: q.confidence,
        aiAnswer: b.aiAnswer, aiAnswerModel: "google/gemma-3-4b-it", aiAnswerConfidence: 0.8, finalAnswer: b.finalAnswer, answerStatus: AiImportAnswerStatus.UNVERIFIED,
        // Q119: set to B by an administrator at 02:20 UTC (the official key says D).
        ...(q.number === 119 ? { answerConfirmedById: actorId, taxonomySource: "admin", subjectId: ids.get("Pediatrics"), topicId: ids.get("Pediatrics › Immunization") } : {}),
      },
    });
  }
  return { job, file, keyFile, oldStems: new Map(qs.map((q) => [q.number!, q.stem])) };
}

async function productionReplay(examId: string, pypId: string, actorId: string, ids: Map<string, string>) {
  section("8. CMS 2024 Paper I as production left it → new rules (no AI) → Verify 1 (key re-read, formatting)");
  const qbBefore = await prisma.question.count();
  const { job, oldStems } = await productionStateJob(examId, pypId, actorId, ids);
  check("reproduced: 120 questions, stems glued with the “Question:” label (release d989bcf reader)", oldStems.size === 120 && [...oldStems.values()].every((s) => s.startsWith("Question:")) && /deficiency:1\. Vitamin/.test(oldStems.get(70)!));
  const ctx = { job, settings: { ...(await getImporterSettings()), aiEnabled: false }, examName: "", subjectName: null, stillRunning: async () => true };

  // ---- a) The new rules on production's stored state (nothing re-read yet) ----
  await runPostProcessing(ctx);
  let rows = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id }, orderBy: { orderIndex: "asc" }, include: { figures: true } });
  const readyBefore = before.filter((b) => b.status === "READY").map((b) => b.n);
  const wrongReady = readyBefore.filter((n) => truth[String(n)] !== "X" && !truth[String(n)].split("/").includes(before.find((b) => b.n === n)!.finalAnswer.join("")));
  check("production had 36 Ready, 20 of them with an answer that contradicts the official key", readyBefore.length === 36 && wrongReady.length === 20, { readyBefore: readyBefore.length, wrongReady });
  check("now 0 Ready: an AI answer is never an answer", rows.filter((r) => r.status === AiImportQuestionStatus.READY).length === 0);
  for (const n of wrongReady) {
    const r = rows.find((x) => x.sourceNumber === n)!;
    check(`  Q${n} (production: Ready with AI answer ${before.find((b) => b.n === n)!.finalAnswer.join("")}, key ${truth[String(n)]}) → ${r.status}, answer ${r.finalAnswer.join("") || "none"}`, r.status !== AiImportQuestionStatus.READY && r.finalAnswer.length === 0 && r.issueCodes.includes("ANSWER_UNVERIFIED"));
  }
  check("no AI answer substituted anywhere (finalAnswer empty except the administrator's Q119)", rows.every((r) => (r.sourceNumber === 119 ? r.finalAnswer.join() === "B" : r.finalAnswer.length === 0)));
  const unv = rows.find((r) => r.sourceNumber === 70)!;
  check("the reason is shown: the answer key could not be read, nothing substituted, the AI opinion is for reference", /could not be read/.test((unv.issues as Record<string, string>).ANSWER_UNVERIFIED ?? "") && /reference only/.test((unv.issues as Record<string, string>).ANSWER_UNVERIFIED ?? ""), unv.issues);
  check("Q116 is not Ready while its statements are run together (detector now catches “milk:1. 75%”)", rows.find((r) => r.sourceNumber === 116)!.issueCodes.includes("STATEMENTS_MERGED") && rows.find((r) => r.sourceNumber === 116)!.status !== AiImportQuestionStatus.READY);
  check("STATEMENTS_MERGED on all 33 run-together questions (production flagged 29)", GLUED.every((n) => rows.find((r) => r.sourceNumber === n)!.issueCodes.includes("STATEMENTS_MERGED")), GLUED.filter((n) => !rows.find((r) => r.sourceNumber === n)!.issueCodes.includes("STATEMENTS_MERGED")));
  check("the message no longer claims Verify 1 restores breaks from the Word file — it says what will happen", /Run Verify 1 \(free\): it puts each statement on its own line/.test((rows.find((r) => r.sourceNumber === 70)!.issues as Record<string, string>).STATEMENTS_MERGED ?? ""));
  check("Q112: the message says it cannot be separated automatically", /cannot be separated automatically/.test((rows.find((r) => r.sourceNumber === 112)!.issues as Record<string, string>).STATEMENTS_MERGED ?? ""));

  // Production's Verify 2 results: a SAME-TEXT read (document parts) with a cut-off classification for 80 questions.
  const v2Failed = before.filter((b) => b.v2Classification === "VERIFICATION_FAILED").map((b) => b.n);
  const readyV2Failed = before.filter((b) => b.status === "READY" && b.v2Classification === "VERIFICATION_FAILED").map((b) => b.n);
  for (const r of rows) {
    const b = before.find((x) => x.n === r.sourceNumber)!;
    const fp = fingerprintOf(r);
    const d = r.data as unknown as ExtractedQuestion;
    const cls = b.v2Classification === "VERIFICATION_FAILED"
      ? { status: "VERIFICATION_FAILED" as const, stored: { subjectId: r.subjectId, topicId: r.topicId, subTopicId: r.subTopicId }, found: null, confidence: null, method: "google/gemma-4-26b-a4b-it", findings: ["the classification request failed: Model output failure: the model used its whole output limit of 2500 tokens (reasoning) and returned no answer — cut off at the token limit."], comparedWithV1: "NO_V1" as const }
      : r.sourceNumber === 71
        ? { status: "DISAGREEMENT" as const, stored: { subjectId: r.subjectId, topicId: r.topicId, subTopicId: r.subTopicId }, found: { subjectId: ids.get("Dermatology")!, topicId: ids.get("Dermatology › Cutaneous Manifestations of Systemic Disease")!, subTopicId: null }, confidence: 0.75, method: "deepseek/deepseek-v4-flash-vision-exp", findings: ["subject General Medicine vs Dermatology (independent classification, 75%) — reason given: cutaneous manifestation of systemic infection/DIC"], comparedWithV1: "NO_V1" as const }
        : null;
    const pv: PaperVerification = { ...(d.paperVerify ?? {}), v2: { ...stampOf(fp), at: new Date().toISOString(), model: "deepseek/deepseek-v4-flash-vision-exp", status: "VERIFIED", fields: [], detail: "wording, 4 options, answer, numbers / symbols and figures agree", part: "CMS_2024_Paper_I.docx part 9 of 15", classification: cls } };
    await prisma.aiImportQuestion.update({ where: { id: r.id }, data: { data: { ...d, paperVerify: pv } as unknown as Prisma.InputJsonValue } });
  }
  await runPostProcessing(ctx);
  rows = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id }, orderBy: { orderIndex: "asc" }, include: { figures: true } });
  const chk = (n: number) => (rows.find((r) => r.sourceNumber === n)!.data as unknown as ExtractedQuestion).checks as QuestionChecks;
  check(`production's 28 Ready questions with a failed Verify 2 classification → TAXONOMY_CHECK_FAILED, taxonomy OUTPUT_TRUNCATED, not Ready`, readyV2Failed.length === 28 && readyV2Failed.every((n) => { const r = rows.find((x) => x.sourceNumber === n)!; return r.issueCodes.includes("TAXONOMY_CHECK_FAILED") && chk(n).taxonomy.status === "OUTPUT_TRUNCATED" && r.status !== "READY"; }), readyV2Failed.filter((n) => chk(n).taxonomy.status !== "OUTPUT_TRUNCATED"));
  check("all 80 failed classifications reported as failures, none as disagreements", v2Failed.length === 80 && v2Failed.filter((n) => n !== 119).every((n) => chk(n).taxonomy.status === "OUTPUT_TRUNCATED"));
  check("Q119 (subject set by an administrator): the failed check does not override the administrator's choice", !rows.find((r) => r.sourceNumber === 119)!.issueCodes.includes("TAXONOMY_CHECK_FAILED"));
  check("the same-text Verify 2 is shown as Needs review (not required), never as an independent pass", rows.every((r) => { const c = (r.data as unknown as ExtractedQuestion).checks!; return c.independent.status === "NEEDS_REVIEW" && !c.independent.required; }));
  const q71 = rows.find((r) => r.sourceNumber === 71)!;
  const q71c = (q71.data as unknown as ExtractedQuestion).classification;
  check("Q71: Verify 2's Dermatology kept as an alternative next to the stored choice — not silently chosen", (q71c?.alternatives ?? []).some((a) => a.subjectId === ids.get("Dermatology") && /Verify 2/.test(a.source)) && q71.subjectId !== ids.get("Dermatology"), { stored: q71.subjectId, alternatives: q71c?.alternatives });
  check("Q71: taxonomy DISAGREEMENT → not Ready, with the reason recorded", chk(71).taxonomy.status === "DISAGREEMENT" && q71.status !== "READY" && !!q71c?.reason);
  check("every alternative is a record of this exam, its topic inside its subject", rows.every((r) => ((r.data as unknown as ExtractedQuestion).classification?.alternatives ?? []).every((a) => [...ids.values()].includes(a.subjectId) && (!a.topicId || [...ids.values()].includes(a.topicId)))));
  check("no SubTopic is ever assigned (the syllabus has none)", rows.every((r) => !r.subTopicId));

  // ---- b) Verify 1 (free): the key re-read from its text layer, formatting applied, reconciled question by question ----
  const v1 = await runVerify1(job.id, actorId);
  rows = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id }, orderBy: { orderIndex: "asc" }, include: { figures: true } });
  const entries = await prisma.aiImportKeyEntry.count({ where: { jobId: job.id } });
  check("Verify 1 re-read the original key file: 120 entries (file unchanged)", entries === 120, entries);
  const reread = await prisma.aiImportEvent.findFirst({ where: { jobId: job.id, type: "KEY_REREAD" } });
  check("KEY_REREAD event recorded", !!reread && /120 entries/.test(reread.message), reread?.message);
  check("Verify 1 formatted 120 questions (labels) incl. 32 statement lists", v1.formatted === 120, v1.formatted);
  check("Q70 is now the structured screenshot text", (rows.find((r) => r.sourceNumber === 70)!.data as unknown as ExtractedQuestion).stem === Q70);
  check("Q119 is now the structured screenshot text", (rows.find((r) => r.sourceNumber === 119)!.data as unknown as ExtractedQuestion).stem === Q119);
  check("the text as read is kept (data.formatting.original) and a version is in the history", (rows.find((r) => r.sourceNumber === 70)!.data as unknown as ExtractedQuestion).formatting?.original === oldStems.get(70) && (await prisma.aiImportQuestionVersion.count({ where: { jobId: job.id, kind: "EXTRACTION", note: { contains: "formatting rules" } } })) === 120);
  check("STATEMENTS_MERGED is left only on Q112", rows.filter((r) => r.issueCodes.includes("STATEMENTS_MERGED")).map((r) => r.sourceNumber).join() === "112");
  const matched = rows.filter((r) => r.answerStatus === AiImportAnswerStatus.OFFICIAL_MATCHED).map((r) => r.sourceNumber!);
  check("116 questions now match the official key (2 dropped X, 2 with two accepted answers)", matched.length === 116, matched.length);
  check("Q5 and Q94 (X): possible withdrawn, never answered", ["5", "94"].every((n) => { const r = rows.find((x) => x.sourceNumber === Number(n))!; return r.answerStatus === "WITHDRAWN" && !r.finalAnswer.length; }));
  check("Q48 (A/B) and Q80 (B/D): ambiguous for a single-correct question → review", [48, 80].every((n) => rows.find((x) => x.sourceNumber === n)!.answerStatus === "AMBIGUOUS_MAPPING"));
  const q119 = rows.find((r) => r.sourceNumber === 119)!;
  check("Q119: the official key D is read; the administrator's B is kept and flagged — answer check FAILED, not Ready", q119.officialAnswerRaw === "D" && q119.finalAnswer.join() === "B" && q119.issueCodes.includes("ANSWER_MISMATCH") && chk(119).answer.status === "FAILED" && q119.status !== "READY", { off: q119.officialAnswerRaw, final: q119.finalAnswer, codes: q119.issueCodes });
  // Every question production answered differently from the official key, accounted for one by one.
  const wrong = before.filter((b) => truth[String(b.n)] !== "X" && !truth[String(b.n)].split("/").includes(b.finalAnswer.join("")));
  check(`production stored a different answer than the official key on ${wrong.length} questions`, wrong.length === 59, wrong.length);
  for (const b of wrong) {
    const r = rows.find((x) => x.sourceNumber === b.n)!;
    const off = truth[String(b.n)];
    const ac = (r.data as unknown as ExtractedQuestion).checks?.answer;
    const ok = b.n === 119 ? r.issueCodes.includes("ANSWER_MISMATCH") && ac?.status === "FAILED" : off.includes("/") ? r.answerStatus === "AMBIGUOUS_MAPPING" && ac?.status !== "PASSED" : r.finalAnswer.join() === off && r.answerStatus === "OFFICIAL_MATCHED" && r.issueCodes.includes("AI_OPINION_DIFFERS") && ac?.status === "PASSED" && /Warning/.test(ac.detail);
    check(`  Q${b.n}: production ${b.finalAnswer.join("") || "—"} → official ${off}; now ${r.finalAnswer.join("") || "—"} (${r.answerStatus}${r.issueCodes.includes("AI_OPINION_DIFFERS") ? ", AI opinion differs — shown as a warning" : ""})`, ok, { codes: r.issueCodes, answer: ac });
  }
  const rec = await prisma.aiImportEvent.findFirst({ where: { jobId: job.id, type: "KEY_RECONCILED" } });
  check("KEY_RECONCILED event lists every changed answer", !!rec && ((rec.data as { changes?: unknown[] } | null)?.changes?.length ?? 0) >= 116, rec?.message);
  check("Q105 and Q70: options cite statement 4 but the text has 3 — flagged for comparison with the original paper", [105, 70].every((n) => rows.find((r) => r.sourceNumber === n)!.issueCodes.includes("STATEMENT_COUNT_MISMATCH")));
  check("Ready questions all pass every required check and have a verified answer", rows.filter((r) => r.status === "READY").every((r) => checksAllowReady((r.data as unknown as ExtractedQuestion).checks) && answerVerified(r)));
  console.log(`  after Verify 1: ${rows.filter((r) => r.status === "READY").length} Ready, ${rows.filter((r) => r.status === "NEEDS_CORRECTION").length} need correction (synthetic taxonomy has few topics, AI opinions differ on many)`);
  check("nothing approved, nothing in the Question Bank", rows.every((r) => !r.approvedById && !r.questionId) && (await prisma.question.count()) === qbBefore);
  check("no AI call recorded for this job", (await prisma.aiImportAiCall.count({ where: { jobId: job.id } })) === 0);
  return job;
}

async function referenceComparison(jobId: string, actorId: string) {
  section("9. Verify 1 against the ORIGINAL paper (scan read by local OCR) — catches the transcription's own defects");
  const scanFile = await vaultFile("CMS_GS_paper1.pdf", "pdf");
  const refId = `ref-r3-${RUN}`;
  await prisma.aiImportEvent.create({ data: { jobId, type: "REFERENCE_ADDED", message: "Reference CMS_GS_paper1.pdf added", data: { refId, name: "CMS_GS_paper1.pdf", ext: "pdf", kind: "pdf", sha256: scanFile.stored.sha256, storageKey: scanFile.stored.key, bytes: scanFile.bytes.length, pageCount: 28, uploadedAt: new Date().toISOString(), uploadedById: actorId, questions: [], key: [], textChars: 28, note: "28 of 28 page(s) have no text layer (scanned)", scannedPages: 28 } } });
  // The local reading, exactly as the worker's local branch makes it (readOcrPage → ocrQuestion), from the OCR cache.
  const dir = path.join(process.env.AI_IMPORT_OCR_CACHE ?? "", scanFile.stored.sha256);
  if (!existsSync(dir)) return check("OCR cache of the original scan", false, "NOT RUN");
  const numbering = { last: 0, sectionIdx: 1 };
  const questions = [];
  for (let p = 1; p <= 28; p++) {
    const raw = JSON.parse(readFileSync(path.join(dir, `p${p}.json`), "utf8"));
    const r = readOcrPage(raw, p, numbering);
    for (const q of r.extraction?.questions ?? []) questions.push(ocrQuestion({ ...q, confidence: q.ocr?.meanConfidence ?? q.confidence }));
  }
  await prisma.aiImportEvent.create({ data: { jobId, type: "REFERENCE_READ", message: "Reference read by local OCR", data: { refId, model: LOCAL_REFERENCE_OCR, at: new Date().toISOString(), pagesRead: Array.from({ length: 28 }, (_, i) => i + 1), failedPages: [], questions } as unknown as Prisma.InputJsonValue } });
  await runVerify1(jobId, actorId);
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: { orderIndex: "asc" } });
  const conflicts = rows.filter((r) => r.issueCodes.includes("REFERENCE_CONFLICT")).map((r) => r.sourceNumber!);
  const caught = DOCX_OPTION_DEFECTS.filter((n) => conflicts.includes(n));
  console.log(`  reference conflicts on: ${conflicts.join(", ")}`);
  check(`the transcription's option defects found against the original paper: ${caught.length} of ${DOCX_OPTION_DEFECTS.length} (${caught.join(", ")})`, caught.length >= 5, { caught, missed: DOCX_OPTION_DEFECTS.filter((n) => !conflicts.includes(n)) });
  check("Q57 / Q77 (options in another order) reported as an option-order difference", [57, 77].every((n) => /option order differs/.test((rows.find((r) => r.sourceNumber === n)!.issues as Record<string, string>).REFERENCE_CONFLICT ?? "")));
  const extra = conflicts.filter((n) => !DOCX_OPTION_DEFECTS.includes(n));
  check(`other questions flagged by the comparison: ${extra.length} (reviewed in the report)`, extra.length <= 25, extra);
  check("questions with a reference conflict are never Ready", rows.filter((r) => r.issueCodes.includes("REFERENCE_CONFLICT")).every((r) => r.status !== "READY"));
}

async function scanCorrections(jobId: string, actorId: string) {
  section("9b. The 7 transcription defects corrected from the ORIGINAL scan (administrator edit), Verify 1 again");
  const fix = JSON.parse(readFileSync("scripts/fixtures/ai-import-papers/cms2024p1-scan-corrections.json", "utf8")).questions as { n: number; scanPage: number; officialKey: string; keyMapsTo: string; options: string[]; stem?: string; difference: string }[];
  const files = await prisma.aiImportFile.findMany({ where: { jobId }, select: { sha256: true, storageKey: true } });
  const { createHash } = await import("node:crypto");
  const { vaultPath } = await import("@/lib/ai-import/vault");
  const hashes = () => files.filter((f) => f.storageKey).map((f) => createHash("sha256").update(readFileSync(vaultPath(f.storageKey!))).digest("hex"));
  const before = hashes();
  let rows = await prisma.aiImportQuestion.findMany({ where: { jobId, sourceNumber: { in: fix.map((f) => f.n) } } });
  const settings = await getImporterSettings();
  for (const f of fix) {
    const r = rows.find((x) => x.sourceNumber === f.n)!;
    check(`Q${f.n} before correction: not Ready and not publish-eligible (${f.difference})`, r.status !== "READY" && !eligibleForPublish({ ...r, figures: [] } as never, settings, false), { status: r.status, codes: r.issueCodes });
  }
  const { editQuestion } = await import("@/lib/ai-import/review");
  const { effective } = await import("@/lib/ai-import/post");
  for (const f of fix) {
    const r = await prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId, sourceNumber: f.n } });
    const e = effective(r);
    await editQuestion(r.id, actorId, { stem: f.stem ?? e.stem, options: f.options.map((t, i) => ({ label: "ABCD"[i], text: t })), type: e.type, contentFormat: e.contentFormat }, { note: `Corrected from the original scan (CMS_GS_paper1.pdf page ${f.scanPage}): ${f.difference}.` });
  }
  await runVerify1(jobId, actorId);
  rows = await prisma.aiImportQuestion.findMany({ where: { jobId, sourceNumber: { in: fix.map((f) => f.n) } } });
  for (const f of fix) {
    const r = rows.find((x) => x.sourceNumber === f.n)!;
    const e = effective(r);
    const letter = r.finalAnswer.join();
    const mapped = e.options.find((o) => o.label === letter)?.text;
    const conflict = (r.issues as Record<string, string> | null)?.REFERENCE_CONFLICT ?? "";
    check(`Q${f.n} after correction: official key ${f.officialKey} → “${mapped}” (expected “${f.keyMapsTo}”); no option-order / count conflict with the original left`, r.answerStatus === "OFFICIAL_MATCHED" && letter === f.officialKey && mapped === f.keyMapsTo && !/option order differs|option count/.test(conflict) && !r.issueCodes.includes("STATEMENT_COUNT_MISMATCH"), { letter, mapped, codes: r.issueCodes, conflict: conflict.slice(0, 200) });
    const v = await prisma.aiImportQuestionVersion.count({ where: { questionId: r.id, kind: "ADMIN_EDIT" } });
    check(`Q${f.n}: the correction is an administrator edit with history (the extraction is kept)`, !!r.editedData && v >= 1 && (r.data as unknown as ExtractedQuestion).options.map((o) => o.text).join("|") !== f.options.join("|"));
  }
  check("Q105 now has the four statements printed in the original", statementsOf(effective(rows.find((x) => x.sourceNumber === 105)!).stem).length === 4);
  check("the original source files are byte-identical (never modified)", JSON.stringify(hashes()) === JSON.stringify(before));
  console.log(`  after correction: ${rows.filter((r) => r.status === "READY").length} of 7 Ready (the rest have other open checks: ${[...new Set(rows.filter((r) => r.status !== "READY").flatMap((r) => r.issueCodes))].join(", ")})`);
}

async function localReferenceWorker(jobId: string, actorId: string) {
  section("10. Free local OCR of a reference through the worker (2 pages of the original scan, no AI)");
  if (!ocrAvailable()) return check("local OCR engine available (AI_IMPORT_OCR_PYTHON)", false, "NOT RUN");
  // A fresh reference (the one of section 9 is already read).
  const scanFile = await vaultFile("CMS_GS_paper1.pdf", "pdf");
  const refId = `ref-r3w-${RUN}`;
  await prisma.aiImportEvent.create({ data: { jobId, type: "REFERENCE_ADDED", message: "Reference added", data: { refId, name: "CMS_GS_paper1 (copy).pdf", ext: "pdf", kind: "pdf", sha256: scanFile.stored.sha256, storageKey: scanFile.stored.key, bytes: scanFile.bytes.length, pageCount: 28, uploadedAt: new Date().toISOString(), uploadedById: actorId, questions: [], key: [], textChars: 28, note: "scanned", scannedPages: 28 } } });
  const r = await requestLocalReferenceOcr({ jobId, refId, actorId });
  check("requested without any cost confirmation (₹0)", r.pages === 28);
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const cfg = job.config as { referenceOcr: { pages: number[] } };
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { config: { ...cfg, referenceOcr: { ...cfg.referenceOcr, pages: [14, 15] } } as unknown as Prisma.InputJsonValue } });
  const calls = await prisma.aiImportAiCall.count({ where: { jobId } });
  await runWorker(5 * 60_000);
  const read = (await prisma.aiImportEvent.findMany({ where: { jobId, type: "REFERENCE_READ" }, orderBy: { createdAt: "desc" }, take: 1 }))[0];
  const data = read?.data as { refId?: string; model?: string; questions?: { number: number | null }[] } | null;
  check("the worker read pages 14–15 with the local engine and recorded REFERENCE_READ", data?.refId === refId && data?.model === LOCAL_REFERENCE_OCR && (data?.questions?.length ?? 0) >= 6, { model: data?.model, n: data?.questions?.length });
  check("Q70 is among the questions read from the original page", (data?.questions ?? []).some((q) => q.number === 70));
  check("no AI call was made", (await prisma.aiImportAiCall.count({ where: { jobId } })) === calls);
  check("the job is back in review", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } })).status === AiImportJobStatus.NEEDS_REVIEW);
}

async function newImportBlockedBudget(examId: string, pypId: string, actorId: string) {
  section("11. A NEW import of the same files while paid AI is blocked by the budget (worker, no AI)");
  const paper = await vaultFile("cms2024p1-transcription.docx", "docx");
  const key = await vaultFile("cms2024p1-key.pdf", "pdf");
  const plan = { mode: "auto", tasks: Object.fromEntries(["extract", "verify", "classify", "key"].map((t) => [t, { task: t, model: "mock/never-called", fallbacks: [], reason: "test", candidates: [], price: { prompt: 0.000001, completion: 0.000002, image: 0, request: 0 }, maxInr: 0.5 }])) };
  const job = await prisma.aiImportJob.create({ data: { title: `CMS 2024 P I new ${RUN}`, examId, createdById: actorId, budgetInr: 8, status: AiImportJobStatus.QUEUED, expectedQuestions: 120, previousYearPaperId: pypId, config: { aiEnabled: true, verification: { independentAnswer: true }, modelPlan: plan } as unknown as Prisma.InputJsonValue } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.PAPER, originalName: "CMS_2024_Paper_I.docx", ext: "docx", declaredBytes: paper.bytes.length, bytes: paper.bytes.length, sha256: paper.stored.sha256, storageKey: paper.stored.key, status: AiImportFileStatus.ANALYZED, detected: { kind: "docx" }, pageCount: 1, uploadedById: actorId } });
  await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.ANSWER_KEY, paperFileId: file.id, originalName: "CMS_2024_Paper_I_Answer_Key.pdf", ext: "pdf", declaredBytes: key.bytes.length, bytes: key.bytes.length, sha256: key.stored.sha256, storageKey: key.stored.key, status: AiImportFileStatus.ANALYZED, detected: { kind: "pdf" }, pageCount: 1, uploadedById: actorId } });
  await runWorker(5 * 60_000);
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } });
  const ev = await prisma.aiImportEvent.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } });
  check("the job finished in review (not paused, not failed)", j.status === AiImportJobStatus.NEEDS_REVIEW, { status: j.status, err: j.errorMessage, pause: j.pauseReason });
  check("PAID_AI_BLOCKED logged with the month scope", ev.some((e) => e.type === "PAID_AI_BLOCKED" && /\(month\)/.test(e.message)), ev.map((e) => e.type));
  check("the key was read from its text layer (120 entries)", ev.some((e) => e.type === "KEY_READ" && /120 answer-key entries/.test(e.message)));
  check("no AI request was sent (0 calls, no reservation)", (await prisma.aiImportAiCall.count({ where: { jobId: job.id } })) === 0 && (await prisma.aiBudgetReservation.count({ where: { requestKey: { startsWith: `qi:${job.id}:` } } })) === 0);
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id } });
  const d = (n: number) => rows.find((r) => r.sourceNumber === n)!.data as unknown as ExtractedQuestion;
  check("120 questions; formatting applied at extraction with the text as read kept", rows.length === 120 && d(70).stem === Q70 && d(70).formatting?.by === "EXTRACTION" && /^Question: /.test(d(70).formatting?.original ?? ""));
  check("116 official answers; Q119 = D", rows.filter((r) => r.answerStatus === "OFFICIAL_MATCHED").length === 116 && rows.find((r) => r.sourceNumber === 119)!.finalAnswer.join() === "D");
  check("no AI answer anywhere", rows.every((r) => !r.aiAnswer.length));
  check("every Ready question passes every required check with a verified answer", rows.filter((r) => r.status === "READY").every((r) => checksAllowReady((r.data as unknown as ExtractedQuestion).checks) && answerVerified(r)));
  check("Q112 (table) stays for manual review", rows.find((r) => r.sourceNumber === 112)!.issueCodes.includes("STATEMENTS_MERGED"));
  return job;
}

async function publishingSafeguards(jobId: string) {
  section("12. Publishing safeguards (backend rules, independent of the Ready status)");
  const settingsOn = { ...(await getImporterSettings()), publish: { allowUnverifiedAnswers: true, requireTopic: false } };
  const row = await prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId, answerStatus: "OFFICIAL_MATCHED", subjectId: { not: null }, topicId: { not: null } }, include: { figures: true } });
  const variant = (over: Partial<typeof row>) => ({ ...row, issueCodes: [], approvedById: "admin", questionId: null, status: AiImportQuestionStatus.READY, ...over });
  check("AI-only answer (UNVERIFIED) is never importable or publishable — even with allowUnverifiedAnswers on", !!importBlocker(variant({ answerStatus: "UNVERIFIED", finalAnswer: ["B"] }), settingsOn) && !!publishBlocker(variant({ answerStatus: "UNVERIFIED", finalAnswer: ["B"] }), settingsOn));
  check("INDEPENDENTLY_VERIFIED (printed answer + AI agreeing) is not a verified answer", !!publishBlocker(variant({ answerStatus: "INDEPENDENTLY_VERIFIED", finalAnswer: ["B"] }), settingsOn));
  check("an unconfirmed answer printed in the paper is not importable", !!importBlocker(variant({ answerStatus: "UNVERIFIED", finalAnswer: ["B"], sourceAnswer: ["B"] }), settingsOn));
  check("the official key answer is importable and publishable", importBlocker(variant({}), settingsOn) === null && publishBlocker(variant({}), settingsOn) === null, [importBlocker(variant({}), settingsOn), publishBlocker(variant({}), settingsOn)]);
  check("an administrator-confirmed answer is importable", importBlocker(variant({ answerStatus: "UNVERIFIED", finalAnswer: ["C"], answerConfirmedById: "admin" }), settingsOn) === null);
  check("ANSWER_UNVERIFIED / TAXONOMY_CHECK_FAILED / VERIFY2_FAILED / STATEMENT_COUNT_MISMATCH block publishing", ["ANSWER_UNVERIFIED", "TAXONOMY_CHECK_FAILED", "VERIFY2_FAILED", "STATEMENT_COUNT_MISMATCH"].every((c) => ISSUE_DEFS[c]?.publishBlocking));
  check("AI_OPINION_DIFFERS is a warning only (neither blocking nor publish-blocking) when the official key is verified", !ISSUE_DEFS.AI_OPINION_DIFFERS.blocking && !ISSUE_DEFS.AI_OPINION_DIFFERS.publishBlocking);
  // Bulk publish eligibility: a same-text Verify 2 never qualifies.
  const fp = fingerprintOf(row);
  const d = row.data as unknown as ExtractedQuestion;
  const mk = (part: string, independence?: "SOURCE" | "SAME_TEXT") => ({ ...variant({}), data: { ...d, checks: { at: "", content: { status: "PASSED", required: true, detail: "" }, answer: { status: "PASSED", required: true, detail: "" }, taxonomy: { status: "PASSED", required: true, detail: "" }, independent: { status: "PASSED", required: true, detail: "" } }, paperVerify: { v1: { ...stampOf(fp), at: "", passed: true, problems: [], fixes: [] }, v2: { ...stampOf(fp), at: "", model: "m", status: "VERIFIED", fields: [], detail: "", part, ...(independence ? { independence } : {}) } } } as unknown as Prisma.JsonValue });
  const st = await getImporterSettings();
  check("bulk publish: Verify 2 that re-read the same Word text is NOT eligible", !eligibleForPublish(mk("x.docx part 3 of 15") as never, st, false));
  check("bulk publish: Verify 2 of the original pages can be eligible", eligibleForPublish(mk("page 4", "SOURCE") as never, { ...st, publish: { ...st.publish, requireTopic: false } }, false) === !importBlocker(variant({}), st, { ignoreApproval: true }));
}

async function main() {
  pureEdgeCases();
  await pureStatements();
  bankRegression();
  pureKey();
  pureChecks();
  pureBudget();
  await seedSettings();
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const { exam, ids, pyp } = await scratchExam();
  await budgetGateway(exam.id, admin.id);
  const prodJob = await productionReplay(exam.id, pyp.id, admin.id, ids);
  await referenceComparison(prodJob.id, admin.id);
  await scanCorrections(prodJob.id, admin.id);
  const newJob = await newImportBlockedBudget(exam.id, pyp.id, admin.id);
  await localReferenceWorker(prodJob.id, admin.id);
  await publishingSafeguards(newJob.id);
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
