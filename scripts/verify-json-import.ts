/**
 * JSON question import (docs/JSON-IMPORT.md) on the ONE Bulk Import pipeline.
 *
 * Against a DISPOSABLE database (a production copy: real RUHS MO / NEET UG
 * taxonomy) and DISPOSABLE storage + staging directories:
 *   A. parser: every example, every accepted shape, every structural refusal
 *   B. format parity: a JSON file yields the same BulkImportRow as the CSV /
 *      rich XLSX carrying the same questions (so every later stage is shared)
 *   C. Standard JSON end to end: stage → validate → import (DRAFT) → history →
 *      re-import duplicates (SKIP) → rollback
 *   D. Rich JSON: formulas / chemistry, MSQ, Match the Following, review flag
 *   E. JSON package ZIP: questions.json + images → bundle → process → import,
 *      assets stored; missing image, unsafe ZIPs, missing / double manifest
 *   F. row validation shared with CSV: invalid label, unsupported type,
 *      cross-exam reference, existing question code
 *
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> DATABASE_URL=<scratch> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-json-import.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { BulkImportStatus, ImportBundleStatus, ImportRowSeverity, QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildTaxonomyLookups, detectImportFileFormat, mergeRowData, parseImportFile, parseJsonText, runExamContextFor, type BulkImportRow, type ImportParseMode } from "@/lib/bulk-import";
import { executeBulkImport, recomputeRunCounts } from "@/lib/bulk-import-execute";
import { completeBundle, createBundle, processBundleSlice, putChunk, readBundleJsonManifest, CHUNK_BYTES } from "@/lib/rich-import/bundle";
import { buildZip } from "@/lib/rich-import/zip-writer";
import { loadRichContext, referencedFilenames, resolveImportRow } from "@/lib/rich-import/validate";
import { isContentAddressedKey, mediaStorage } from "@/lib/media-storage";
import { executeImportRollback } from "@/lib/import-rollback";
import { jsonPackageZip, richTemplateZip } from "@/lib/rich-import/template";
import { JSON_IMPORT_LIMITS, JSON_IMPORT_SCHEMA, JsonImportError, parseJsonQuestions } from "@/lib/json-import";
import { JSON_IMPORT_EXAMPLES, jsonImportExampleText, type JsonImportExampleId } from "@/lib/json-import-examples";
import { hostileZips, toXlsx, type FixtureRow } from "./rich-import-fixtures";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
for (const v of ["STORAGE_DIR", "IMPORT_STAGING_DIR"]) {
  if (!process.env[v] || process.env[v]!.startsWith("/var/www/mocktestseries-shared") || process.env[v]!.startsWith("/var/lib/mocktestseries")) {
    console.error(`Set ${v} to a disposable directory.`);
    process.exit(2);
  }
}

let failuresCount = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  if (!passed) failuresCount++;
}
const section = (s: string) => console.log(`\n${s}`);

/** The problems a document is refused with ([] = accepted). */
function problemsOf(doc: unknown, mode: ImportParseMode = "LEGACY"): string[] {
  try {
    parseJsonQuestions(typeof doc === "string" ? doc : JSON.stringify(doc), mode);
    return [];
  } catch (e) {
    if (e instanceof JsonImportError) return e.problems;
    throw e;
  }
}
const q1 = (over: Record<string, unknown> = {}) => ({ subject: "Anatomy", question: "Q?", options: ["a", "b", "c", "d"], correct: "A", ...over });
const one = (over: Record<string, unknown> = {}, mode: ImportParseMode = "LEGACY") => problemsOf({ questions: [q1(over)] }, mode);

/** Example document with every code made unique to this run. */
function exampleWith(id: JsonImportExampleId, suffix: string, edit?: (d: { questions: Record<string, unknown>[] } & Record<string, unknown>) => void): string {
  const d = JSON.parse(jsonImportExampleText(id)) as { questions: Record<string, unknown>[] } & Record<string, unknown>;
  for (const q of d.questions) {
    if (typeof q.code === "string") q.code = `${q.code}-${suffix}`;
    // Same text = duplicate (existing rule), so every run's text is its own.
    if (typeof q.question === "string") q.question = `${q.question} [${suffix}]`;
    else if (q.question && typeof q.question === "object") (q.question as { text: string }).text += ` [${suffix}]`;
  }
  edit?.(d);
  return JSON.stringify(d);
}

const fileOf = (name: string, data: string | Buffer) => new File([typeof data === "string" ? data : new Uint8Array(data)], name);

async function uploadBundle(actorId: string, zip: Buffer, name = "package.zip") {
  const b = await createBundle({ actorId, filename: name, declaredBytes: zip.length });
  for (let i = 0; i * CHUNK_BYTES < zip.length; i++) await putChunk({ bundleId: b.id, actorId, index: i, bytes: zip.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  return completeBundle({ bundleId: b.id, actorId });
}

/** Mirrors the upload route: rows → run + staged rows (format from the file name, or JSON for a package). */
async function stage(o: { actorId: string; examId: string; filename: string; rows: BulkImportRow[]; mode: ImportParseMode; bundleId?: string | null; strategy?: "SKIP" | "REPLACE" | "ADD_AS_NEW" }) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.bulkImportRun.create({
      data: {
        adminUserId: o.actorId, filename: o.filename, format: detectImportFileFormat(o.filename) === "JSON" || o.bundleId ? "JSON" : "CSV", examId: o.examId, totalRows: o.rows.length,
        duplicateStrategy: o.strategy ?? "SKIP", status: BulkImportStatus.UPLOADED,
        ...(o.mode === "RICH" ? { importMode: "RICH" as const, bundleId: o.bundleId ?? null } : {}),
      },
    });
    await tx.bulkImportRow.createMany({ data: o.rows.map((r) => ({ runId: run.id, rowNumber: r.rowNumber, rawData: r as unknown as Prisma.InputJsonValue, severity: ImportRowSeverity.ERROR })) });
    return run;
  });
}

async function validateRun(runId: string) {
  const run = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: runId } });
  const rows = await prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, orderBy: { rowNumber: "asc" } });
  const lookups = await buildTaxonomyLookups(prisma);
  const ctx = await loadRichContext(runId);
  const rx = runExamContextFor(lookups.exams, run);
  const out: { rowNumber: number; severity: string; errors: string[]; warnings: string[] }[] = [];
  for (const row of rows) {
    const merged = mergeRowData(row.rawData, row.editedData) as BulkImportRow;
    const r = await resolveImportRow(prisma, lookups, merged, undefined, rx, ctx);
    await prisma.bulkImportRow.update({
      where: { id: row.id },
      data: { severity: r.severity, errors: r.errors, warnings: r.warnings, reviewRequired: r.reviewRequired, ...(ctx ? { infos: r.infos ?? [] } : {}) },
    });
    out.push({ rowNumber: row.rowNumber, severity: r.severity, errors: r.errors, warnings: r.warnings });
  }
  await prisma.bulkImportRun.update({ where: { id: runId }, data: { status: BulkImportStatus.READY } });
  await recomputeRunCounts(runId);
  return out;
}

async function processAll(runId: string, actorId: string) {
  const run = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: runId } });
  for (let steps = 0; ; steps++) {
    const r = await processBundleSlice({ bundleId: run.bundleId!, actorId, wanted: await referencedFilenames(runId), sliceMs: 5_000 });
    if (r.done || steps > 200) return r;
  }
}

/** Imported questions with the file's code (kept on the import row; Question.code is allocated by the platform). */
async function questionsOf(runId: string) {
  const rows = await prisma.bulkImportRow.findMany({ where: { runId, questionId: { not: null } }, select: { questionId: true, rawData: true }, orderBy: { rowNumber: "asc" } });
  const qs = await prisma.question.findMany({ where: { importBatchId: runId }, include: { options: { orderBy: { label: "asc" } }, assets: true } });
  return rows.flatMap((r) => {
    const q = qs.find((x) => x.id === r.questionId);
    return q ? [{ ...q, fileCode: (r.rawData as { questionCode?: string }).questionCode ?? null }] : [];
  });
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  const neet = await prisma.exam.findFirstOrThrow({ where: { code: "NEETUG" }, select: { id: true, name: true } });
  const ruhs = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true, name: true } });
  const suffix = Date.now().toString(36).toUpperCase();
  const cleanup = { runs: [] as string[], bundles: [] as string[] };
  const questionsBefore = await prisma.question.count();

  // ------------------------------------------------------------------ A
  section("A. parser");
  for (const id of Object.keys(JSON_IMPORT_EXAMPLES) as JsonImportExampleId[]) {
    const onDisk = readFileSync(path.join(process.cwd(), "docs", "json-import-examples", `${id}.json`), "utf8");
    check(`docs/json-import-examples/${id}.json matches lib/json-import-examples.ts`, onDisk === jsonImportExampleText(id));
    check(`example ${id} parses in Rich mode`, problemsOf(jsonImportExampleText(id), "RICH").length === 0, problemsOf(jsonImportExampleText(id), "RICH"));
  }
  check("ruhs-mo example also parses in Standard mode", problemsOf(jsonImportExampleText("ruhs-mo")).length === 0);
  for (const id of ["neet-ug-rich", "with-images", "multiple-correct", "match-the-following"] as const) {
    const p = problemsOf(jsonImportExampleText(id));
    check(`${id} in Standard mode → refused, asks for Rich mode`, p.length > 0 && p.every((m) => /Rich content mode/.test(m)), p);
  }

  {
    const rows = parseJsonQuestions(jsonImportExampleText("ruhs-mo"));
    check("array options → A–D", rows[0].optionA === "Adrenaline" && rows[0].optionD === "Chlorpheniramine" && rows[0].correctAnswer === "A");
    check("object options {A:…} → A–D", rows[1].optionB === "60–100" && rows[1].correctAnswer === "B" && rows[1].difficulty === "EASY");
    check("nested options with correct:true → correct label", rows[2].optionC === "Femur" && rows[2].correctAnswer === "C");
    check("defaults apply (difficulty MEDIUM) and status is DRAFT", rows[0].difficulty === "MEDIUM" && rows.every((r) => r.status === "DRAFT"));
    check("rowNumber = position in questions[]", rows.map((r) => r.rowNumber).join(",") === "1,2,3");
    check("no rich keys in Standard rows", rows.every((r) => r.contentFormat === undefined && r.questionType === undefined && r.listI === undefined));
    check("bare array of questions accepted", problemsOf([q1(), q1({ question: "Q2?" })]).length === 0);
    check("BOM accepted", problemsOf(`\uFEFF${JSON.stringify({ questions: [q1()] })}`).length === 0);
    check("numbers for year / questionNumber", parseJsonQuestions(JSON.stringify({ questions: [q1({ year: 2025, questionNumber: 7 })] }))[0].examYear === "2025");
  }
  {
    const msq = parseJsonQuestions(jsonImportExampleText("multiple-correct"), "RICH");
    check("MSQ: correct array → A,B,D; type from defaults", msq[0].correctAnswer === "A,B,D" && msq[0].questionType === "MULTIPLE_CORRECT");
    check("MSQ: correct:true flags → A,C", msq[1].correctAnswer === "A,C");
    const mtf = parseJsonQuestions(jsonImportExampleText("match-the-following"), "RICH")[0];
    check("MTF: lists → List I / List II cells", mtf.listI === "A. \\ce{CH4}\nB. \\ce{C2H4}\nC. \\ce{C2H2}\nD. \\ce{C6H6}" && mtf.listII?.startsWith("I. Benzene\nII. Methane") === true, mtf);
    const img = parseJsonQuestions(jsonImportExampleText("with-images"), "RICH");
    check("images → cell grammar with alt", img[0].questionImageFilename === "SAMPLE-004-Q1.png :: Battery with two 3 ohm resistors in series" && img[0].explanationImages === "SAMPLE-004-EXP1.png :: R equals R1 plus R2");
    check("option images, empty option text", img[1].optionCImageFilename === "SAMPLE-005-C.png :: A triangle" && img[1].optionC === "");
    check("two question images, decorative explanation image", img[2].questionImageFilename === "SAMPLE-004-Q1.png :: Circuit before | SAMPLE-006-Q2.png :: Circuit after" && img[2].explanationImages === "SAMPLE-004-EXP1.png :: decorative");
    const rich = parseJsonQuestions(jsonImportExampleText("neet-ug-rich"), "RICH");
    check("KaTeX + mhchem kept verbatim", rich[0].optionA === "$\\sqrt{2as}$" && rich[1].questionText.includes("\\ce{N2 + 3H2 <=> 2NH3}") && rich[0].contentFormat === "RICH_V1");
    check("review → Review Required flag + reason", rich[2].reviewFlag === "TRUE" && rich[2].reviewReason === "Answer key to be confirmed by the subject expert");
  }

  const refusals: [string, string[], RegExp][] = [
    ["invalid JSON", problemsOf("{ questions: [ }"), /not valid JSON/],
    ["empty questions", problemsOf({ questions: [] }), /no questions/],
    ["wrong schema", problemsOf({ schema: "other/v9", questions: [q1()] }), /Unsupported schema/],
    ["unknown top-level field", problemsOf({ questions: [q1()], extra: 1 }), /Unknown top-level field "extra"/],
    ["defaults with a per-question field", problemsOf({ defaults: { code: "X" }, questions: [q1()] }), /cannot set "code"/],
    ["unknown question field (typo)", one({ explaination: "x" }), /Question 1 › explaination: unknown field/],
    ["missing options", one({ options: undefined }), /options: is required/],
    ["three options", one({ options: ["a", "b", "c"] }), /exactly 4/],
    ["five options", one({ options: { A: "1", B: "2", C: "3", D: "4", E: "5" } }), /exactly 4|not one of A, B, C, D/],
    ["option label E", one({ options: [{ label: "A", text: "1" }, { label: "B", text: "2" }, { label: "C", text: "3" }, { label: "E", text: "4" }] }), /"E" is not one of A, B, C, D/],
    ["missing correct", one({ correct: undefined }), /correct: is required/],
    ["correct as a number", one({ correct: 2 }), /correct: must be a label/],
    ["correct disagrees with correct:true", one({ options: [{ label: "A", text: "1", correct: true }, { label: "B", text: "2" }, { label: "C", text: "3" }, { label: "D", text: "4" }], correct: "B" }), /disagrees/],
    ["question as an array", one({ question: ["x"] }), /question: must be a string/],
    ["status PUBLISHED", one({ status: "PUBLISHED" }), /always saved as DRAFT/],
    ["image without file", one({ question: { text: "x", images: [{ alt: "y" }] } }, "RICH"), /needs a "file"/],
    ["image file with reserved |", one({ question: { text: "x", images: [{ file: "a|b.png" }] } }, "RICH"), /reserved character/],
    ["alt text 'decorative'", one({ question: { text: "x", images: [{ file: "a.png", alt: "Decorative" }] } }, "RICH"), /decorative": true/],
    ["match list entry without key", one({ type: "MTF", matchLists: { listI: [{ text: "x" }], listII: [] } }, "RICH"), /needs a "key"/],
    ["images in Standard mode", one({ question: { text: "x", images: ["a.png"] } }), /Rich content mode/],
    ["MSQ type in Standard mode", one({ type: "MULTIPLE_CORRECT" }), /Rich content mode/],
    ["duplicate code in one Standard file", problemsOf({ questions: [q1({ code: "DUP-1" }), q1({ code: "DUP-1", question: "Other?" })] }), /Question 2 › code: "DUP-1" is already used by question 1/],
    ["too deeply nested", problemsOf({ questions: [q1({ question: { text: JSON.parse("[".repeat(20) + "]".repeat(20)) } })] }), /nested too deeply/],
    ["more than the question limit", problemsOf({ questions: Array.from({ length: JSON_IMPORT_LIMITS.maxQuestions + 1 }, () => q1()) }), /max 2000/],
    ["larger than 10 MB", problemsOf(JSON.stringify({ questions: [q1({ explanation: "x".repeat(JSON_IMPORT_LIMITS.maxBytes) })] })), /larger than 10 MB/],
  ];
  for (const [name, p, re] of refusals) check(`refused: ${name}`, p.length > 0 && p.some((m) => re.test(m)), p);
  {
    const p = problemsOf({ questions: [q1({ correct: undefined }), q1({ options: ["a"] }), q1({ bogus: 1 })] });
    check("every problem of the file is listed, numbered per question", p.length >= 3 && p.some((m) => m.startsWith("Question 1 ›")) && p.some((m) => m.startsWith("Question 2 ›")) && p.some((m) => m.startsWith("Question 3 ›")), p);
    check("parseJsonText: broken file → 0 rows + the problems (route shows them)", (() => { const r = parseJsonText("[1]"); return r.rows.length === 0 && /Question 1 › \(question\): must be an object/.test(r.errors[0]); })());
    check("duplicate code in a Rich file is left to the per-row validator", problemsOf({ questions: [q1({ code: "DUP-1" }), q1({ code: "DUP-1", question: "Other?" })] }, "RICH").length === 0);
  }

  // ------------------------------------------------------------------ B
  section("B. format parity with CSV / XLSX");
  {
    const json = parseJsonQuestions(jsonImportExampleText("ruhs-mo"));
    const csvRows = (JSON_IMPORT_EXAMPLES["ruhs-mo"].doc.questions as readonly Record<string, unknown>[]).map((q, i) => ({
      "Question Code": q.code, Subject: q.subject, "Question Text": q.question,
      "Option A": json[i].optionA, "Option B": json[i].optionB, "Option C": json[i].optionC, "Option D": json[i].optionD,
      "Correct Answer": json[i].correctAnswer, Explanation: q.explanation, Difficulty: json[i].difficulty, Status: "DRAFT",
    }));
    const csv = await parseImportFile(fileOf("same.csv", Papa.unparse(csvRows)), "LEGACY");
    const keys = ["questionCode", "subject", "questionText", "optionA", "optionB", "optionC", "optionD", "correctAnswer", "explanation", "difficulty", "status"] as const;
    const diff = csv.rows.flatMap((r, i) => keys.filter((k) => (r[k] ?? "") !== (json[i][k] ?? "")).map((k) => `${i + 1}.${k}: csv=${r[k]} json=${json[i][k]}`));
    check("Standard: JSON rows ≡ CSV rows for the same questions", csv.rows.length === 3 && diff.length === 0, diff);
    const viaFile = await parseImportFile(fileOf("ruhs.json", jsonImportExampleText("ruhs-mo")), "LEGACY");
    check("parseImportFile routes .json to the JSON parser", viaFile.rows.length === 3 && viaFile.errors.length === 0 && detectImportFileFormat("X.JSON") === "JSON");
    check("detectImportFileFormat unchanged for CSV / XLS / XLSX / DOCX", ["a.csv", "a.xls", "a.xlsx", "a.docx", "a.txt"].map(detectImportFileFormat).join(",") === "CSV,XLS,XLSX,DOCX,");
  }
  {
    const json = parseJsonQuestions(jsonImportExampleText("with-images"), "RICH").concat(parseJsonQuestions(jsonImportExampleText("match-the-following"), "RICH"));
    const fx: FixtureRow[] = json.map((r) => ({
      Code: r.questionCode, Subject: r.subject, "Question Type": r.questionType ?? "", "Content Format": r.contentFormat ?? "", "Question Text": r.questionText,
      "Question Images": r.questionImageFilename ?? "", "Option A": r.optionA, "Option A Image": r.optionAImageFilename ?? "", "Option B": r.optionB, "Option B Image": r.optionBImageFilename ?? "",
      "Option C": r.optionC, "Option C Image": r.optionCImageFilename ?? "", "Option D": r.optionD, "Option D Image": r.optionDImageFilename ?? "", Correct: r.correctAnswer,
      Explanation: r.explanation ?? "", "Explanation Images": r.explanationImages ?? "", Difficulty: r.difficulty, Status: "DRAFT", "List I": r.listI ?? "", "List II": r.listII ?? "",
    }));
    const xlsx = await parseImportFile(fileOf("same.xlsx", toXlsx(fx)), "RICH");
    const keys = ["questionCode", "questionText", "optionA", "optionC", "correctAnswer", "questionImageFilename", "optionCImageFilename", "explanationImages", "questionType", "contentFormat", "listI", "listII"] as const;
    const diff = xlsx.rows.flatMap((r, i) => keys.filter((k) => (r[k] ?? "") !== (json[i][k] ?? "")).map((k) => `${i + 1}.${k}: xlsx=${JSON.stringify(r[k])} json=${JSON.stringify(json[i][k])}`));
    check("Rich: JSON rows ≡ rich XLSX rows (images, lists, type, format)", xlsx.rows.length === 4 && diff.length === 0, diff);
  }

  // ------------------------------------------------------------------ C
  section("C. Standard JSON end to end (RUHS MO)");
  {
    const src = exampleWith("ruhs-mo", suffix);
    const { rows } = parseJsonText(src, "LEGACY");
    const run = await stage({ actorId: admin.id, examId: ruhs.id, filename: "ruhs-mo.json", rows, mode: "LEGACY" });
    cleanup.runs.push(run.id);
    const v = await validateRun(run.id);
    check("3 rows staged and valid (no ERROR)", v.length === 3 && v.every((r) => r.errors.length === 0), v);
    const res = await executeBulkImport({ runId: run.id, adminUserId: admin.id, acknowledgeWarnings: true });
    check("3 questions created", res.successCount === 3 && res.failedCount === 0, res);
    const qs = await questionsOf(run.id);
    check("all DRAFT, exam = RUHS MO, file code kept on the import row", qs.length === 3 && qs.every((q) => q.status === QuestionStatus.DRAFT && q.examId === ruhs.id) && qs[0].fileCode === `RUHS-JSON-001-${suffix}`, qs.map((q) => [q.code, q.fileCode, q.status]));
    check("one correct option each, matches the file", qs.map((q) => q.options.find((o) => o.isCorrect)?.label).join("") === "ABC");
    // Standard mode stores no explanation, for CSV / XLSX too (pre-existing; Rich mode does) — pinned so a change is deliberate.
    check("Standard mode: explanation not stored (same as CSV)", qs.every((q) => q.explanation === null), qs.map((q) => q.explanation));
    const hist = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: run.id } });
    check("import history: run format JSON, filename, counts", hist.format === "JSON" && hist.filename === "ruhs-mo.json" && hist.successCount === 3, { format: hist.format, s: hist.successCount });

    const run2 = await stage({ actorId: admin.id, examId: ruhs.id, filename: "ruhs-mo-again.json", rows: parseJsonText(src, "LEGACY").rows, mode: "LEGACY" });
    cleanup.runs.push(run2.id);
    const v2 = await validateRun(run2.id);
    check("re-import: every row flagged as a duplicate (Same Question Code)", v2.every((r) => r.warnings.some((w) => /duplicate/i.test(w))), v2.map((r) => r.warnings));
    const r2 = await executeBulkImport({ runId: run2.id, adminUserId: admin.id, acknowledgeWarnings: true });
    check("SKIP strategy: 0 created, 3 skipped", r2.successCount === 0 && r2.skippedCount === 3, r2);

    const rb = await executeImportRollback({ runId: run.id, actorId: admin.id, mode: "AUTO" });
    check("rollback: the 3 unused DRAFT questions are deleted", rb.deleted.length === 3 && (await prisma.question.count({ where: { importBatchId: run.id } })) === 0, { d: rb.deleted.length, a: rb.archived.length, p: rb.protected.length });
  }

  // ------------------------------------------------------------------ D
  section("D. Rich JSON (NEET UG): formulas, MSQ, Match the Following");
  {
    const rows = [
      ...parseJsonText(exampleWith("neet-ug-rich", suffix), "RICH").rows,
      ...parseJsonText(exampleWith("multiple-correct", suffix), "RICH").rows,
      ...parseJsonText(exampleWith("match-the-following", suffix), "RICH").rows,
    ].map((r, i) => ({ ...r, rowNumber: i + 1 }));
    const run = await stage({ actorId: admin.id, examId: neet.id, filename: "neet-rich.json", rows, mode: "RICH" });
    cleanup.runs.push(run.id);
    const v = await validateRun(run.id);
    check("6 rows, no ERROR", v.length === 6 && v.every((r) => r.errors.length === 0), v.filter((r) => r.errors.length));
    const res = await executeBulkImport({ runId: run.id, adminUserId: admin.id, acknowledgeWarnings: true });
    check("6 questions created", res.successCount === 6 && res.failedCount === 0, res);
    const qs = await questionsOf(run.id);
    const by = (code: string) => qs.find((q) => q.fileCode === `${code}-${suffix}`)!;
    check("NEET imports are DRAFT, never PUBLISHED", qs.length === 6 && qs.every((q) => q.status === QuestionStatus.DRAFT));
    check("RICH_V1 + LaTeX / mhchem stored verbatim", by("NEET-JSON-001").contentFormat === "RICH_V1" && by("NEET-JSON-001").options[0].text === "$\\sqrt{2as}$" && by("NEET-JSON-002").text.includes("\\ce{N2 + 3H2 <=> 2NH3}"));
    check("review flag + reason → reviewRequired, NEEDS_REVIEW", by("NEET-JSON-003").reviewRequired && /subject expert/.test(by("NEET-JSON-003").reviewReason ?? "") && by("NEET-JSON-003").editorialStage === "NEEDS_REVIEW");
    check("MSQ stored as MULTIPLE_CORRECT with A,B,D correct", by("MSQ-JSON-001").questionType === "MULTIPLE_CORRECT" && by("MSQ-JSON-001").options.filter((o) => o.isCorrect).map((o) => o.label).join("") === "ABD");
    check("MSQ from correct:true flags → A,C", by("MSQ-JSON-002").options.filter((o) => o.isCorrect).map((o) => o.label).join("") === "AC");
    const mtf = by("MTF-JSON-001");
    const spec = mtf.matchSpec as { listI: { key: string; text: string }[]; listII: { key: string; text: string }[] } | null;
    check("MTF stored with List I / List II", mtf.questionType === "MATCH_THE_FOLLOWING" && spec?.listI.length === 4 && spec.listII[1].text === "Methane", spec);
    check("subject mapping (PHYSICS / Chemistry / Botany) resolved", new Set(qs.map((q) => q.subjectId)).size === 3);
  }

  // ------------------------------------------------------------------ E
  section("E. JSON package ZIP (questions.json + images)");
  {
    const doc = exampleWith("with-images", suffix);
    const tpl = await jsonPackageZip();
    const bundleTpl = await uploadBundle(admin.id, tpl, "json-package-example.zip");
    cleanup.bundles.push(bundleTpl.id);
    check("downloadable package example is accepted as a bundle", bundleTpl.status === ImportBundleStatus.UPLOADED, bundleTpl.errorMessage);
    check("package example's questions.json = with-images example", (await readBundleJsonManifest(bundleTpl.id)) === jsonImportExampleText("with-images"));

    // Same images, codes unique to this run, manifest in a folder.
    const images = (await richTemplateZipEntries()).filter((e) => !e.name.endsWith(".json"));
    const pkg = buildZip([{ name: "paper/questions.json", data: Buffer.from(doc) }, ...images]);
    const bundle = await uploadBundle(admin.id, pkg);
    cleanup.bundles.push(bundle.id);
    const { rows, errors } = parseJsonText(await readBundleJsonManifest(bundle.id), "RICH");
    check("questions.json read from a sub-folder of the package", rows.length === 3 && errors.length === 0, errors);
    const run = await stage({ actorId: admin.id, examId: neet.id, filename: "package.zip", rows, mode: "RICH", bundleId: bundle.id });
    cleanup.runs.push(run.id);
    const before = await validateRun(run.id);
    check("before processing: image rows wait for processing", before.some((r) => r.errors.some((e) => /not been processed yet/.test(e))), before.map((r) => r.errors));
    const proc = await processAll(run.id, admin.id);
    check("all 7 referenced images processed", proc.ready === 7 && proc.invalid === 0, proc);
    const v = await validateRun(run.id);
    check("after processing: no ERROR, questions.json not reported as an unused image", v.every((r) => r.errors.length === 0) && !JSON.stringify(v).includes("questions.json"), v);
    const res = await executeBulkImport({ runId: run.id, adminUserId: admin.id, acknowledgeWarnings: true });
    check("3 questions created", res.successCount === 3, res);
    const qs = await questionsOf(run.id);
    const by = (code: string) => qs.find((q) => q.fileCode === `${code}-${suffix}`)!;
    check("question + explanation images stored as assets with alt", by("IMG-JSON-001").assets.filter((a) => a.role === "QUESTION").length === 1 && /3 ohm/.test(by("IMG-JSON-001").assets.find((a) => a.role === "QUESTION")!.alt) && by("IMG-JSON-001").assets.some((a) => a.role === "EXPLANATION"));
    check("A–D option images", by("IMG-JSON-002").assets.filter((a) => a.role === "OPTION").map((a) => a.optionLabel).sort().join("") === "ABCD");
    check("two question images + decorative explanation image (empty alt)", by("IMG-JSON-003").assets.filter((a) => a.role === "QUESTION").length === 2 && by("IMG-JSON-003").assets.some((a) => a.role === "EXPLANATION" && a.alt === ""));
    const assets = qs.flatMap((q) => q.assets);
    check("asset keys content-addressed and on disk; no base64", (await Promise.all(assets.map(async (a) => isContentAddressedKey(a.storageKey) && (await mediaStorage().exists(a.storageKey))))).every(Boolean) && qs.every((q) => !/data:image|base64/.test(q.text)));
    check("all DRAFT", qs.every((q) => q.status === QuestionStatus.DRAFT));

    // Missing image asset → per-row ERROR from the existing validator.
    const miss = buildZip([{ name: "questions.json", data: Buffer.from(exampleWith("with-images", `${suffix}M`)) }, ...images.filter((e) => !e.name.endsWith("SAMPLE-005-C.png"))]);
    const mb = await uploadBundle(admin.id, miss);
    cleanup.bundles.push(mb.id);
    const mrun = await stage({ actorId: admin.id, examId: neet.id, filename: "missing.zip", rows: parseJsonText(await readBundleJsonManifest(mb.id), "RICH").rows, mode: "RICH", bundleId: mb.id });
    cleanup.runs.push(mrun.id);
    await processAll(mrun.id, admin.id);
    const mv = await validateRun(mrun.id);
    check("missing image → ERROR on that row only", mv[1].errors.some((e) => /SAMPLE-005-C\.png/.test(e)) && mv[0].errors.length === 0 && mv[2].errors.length === 0, mv.map((r) => r.errors));

    // Manifest rules.
    const noManifest = await uploadBundle(admin.id, buildZip(images));
    cleanup.bundles.push(noManifest.id);
    check("package without questions.json → refused", /has no questions\.json/.test(await readBundleJsonManifest(noManifest.id).then(() => "", (e) => String(e))));
    const two = await uploadBundle(admin.id, buildZip([{ name: "a/questions.json", data: Buffer.from(doc) }, { name: "b/questions.json", data: Buffer.from(doc) }, ...images]));
    cleanup.bundles.push(two.id);
    check("package with two questions.json → refused", /2 files named questions\.json/.test(await readBundleJsonManifest(two.id).then(() => "", (e) => String(e))));
    const broken = await uploadBundle(admin.id, buildZip([{ name: "questions.json", data: Buffer.from("{ not json") }, ...images]));
    cleanup.bundles.push(broken.id);
    check("package with invalid questions.json → JSON problems, no rows", parseJsonText(await readBundleJsonManifest(broken.id), "RICH").rows.length === 0);

    // Unsafe ZIPs: the image bundle's checks apply to a package unchanged.
    const hostile = await hostileZips();
    for (const name of ["traversal", "absolute", "symlink", "executable", "nested", "bomb", "encrypted", "duplicate"]) {
      const b = await uploadBundle(admin.id, hostile[name], `${name}.zip`);
      cleanup.bundles.push(b.id);
      check(`unsafe package refused: ${name}`, b.status === ImportBundleStatus.FAILED, { status: b.status, err: b.errorMessage });
    }
    const evil = buildZip([{ name: "../questions.json", data: Buffer.from(doc) }, ...images]);
    const eb = await uploadBundle(admin.id, evil, "evil.zip");
    cleanup.bundles.push(eb.id);
    check("unsafe package refused: questions.json with ../ path", eb.status === ImportBundleStatus.FAILED, eb.errorMessage);
  }

  // ------------------------------------------------------------------ F
  section("F. row validation shared with CSV");
  {
    const doc = {
      schema: JSON_IMPORT_SCHEMA,
      questions: [
        { code: `F-LBL-${suffix}`, subject: "Chemistry", question: "Invalid label?", options: ["1", "2", "3", "4"], correct: "E" },
        { code: `F-TYPE-${suffix}`, type: "ESSAY", subject: "Chemistry", question: "Unsupported type?", options: ["1", "2", "3", "4"], correct: "A" },
        { code: `F-EXAM-${suffix}`, exam: ruhs.name, subject: "Chemistry", question: `Cross exam ${suffix}?`, options: ["1", "2", "3", "4"], correct: "A" },
        { code: `F-MSQ1-${suffix}`, subject: "Chemistry", question: "Two answers on a single-correct?", options: ["1", "2", "3", "4"], correct: ["A", "B"] },
        { code: `F-SUBJ-${suffix}`, subject: "No Such Subject Zz", question: "Unknown subject?", options: ["1", "2", "3", "4"], correct: "A" },
      ],
    };
    const { rows, errors } = parseJsonText(JSON.stringify(doc), "RICH");
    check("structurally valid → staged (content rules are the validators')", rows.length === 5 && errors.length === 0, errors);
    const run = await stage({ actorId: admin.id, examId: neet.id, filename: "rules.json", rows, mode: "RICH" });
    cleanup.runs.push(run.id);
    const v = await validateRun(run.id);
    check("invalid answer label E → ERROR", v[0].errors.some((e) => /correct|answer/i.test(e)), v[0]);
    check("unsupported question type → ERROR", v[1].errors.some((e) => /type/i.test(e)), v[1]);
    check("cross-exam reference → ERROR in Rich mode (existing rule)", v[2].errors.some((e) => /scoped to/.test(e) && e.includes(neet.name)), v[2]);
    check("two answers on single-correct → ERROR", v[3].errors.length > 0, v[3]);
    check("unknown subject → ERROR", v[4].errors.some((e) => /subject/i.test(e)), v[4]);

    {
      const cx = parseJsonText(JSON.stringify({ questions: [{ exam: ruhs.name, subject: "Chemistry", question: `Cross exam std ${suffix}?`, options: ["1", "2", "3", "4"], correct: "A" }] }), "LEGACY").rows;
      const crun = await stage({ actorId: admin.id, examId: neet.id, filename: "cross.json", rows: cx, mode: "LEGACY" });
      cleanup.runs.push(crun.id);
      const cv = await validateRun(crun.id);
      check("cross-exam reference → WARNING in Standard mode, scoped to the selected exam (as CSV)", cv[0].errors.length === 0 && cv[0].warnings.some((w) => /scoped to/.test(w) && w.includes(neet.name)), cv[0]);
    }

    // An existing code in the bank → the existing duplicate rule (Standard mode).
    const existing = await prisma.question.findFirst({ where: { examId: ruhs.id }, select: { code: true } });
    if (existing) {
      const dup = parseJsonText(JSON.stringify({ questions: [{ code: existing.code, subject: "Anatomy", question: `Dup code ${suffix}`, options: ["1", "2", "3", "4"], correct: "A" }] }), "LEGACY").rows;
      const drun = await stage({ actorId: admin.id, examId: ruhs.id, filename: "dup.json", rows: dup, mode: "LEGACY" });
      cleanup.runs.push(drun.id);
      const dv = await validateRun(drun.id);
      check("existing question code → duplicate (unchanged rule)", dv[0].warnings.some((w) => /duplicate/i.test(w)), dv[0]);
      const dr = await executeBulkImport({ runId: drun.id, adminUserId: admin.id, acknowledgeWarnings: true });
      check("SKIP: the bank question is not touched", dr.successCount === 0 && dr.skippedCount === 1, dr);
    }
  }

  // ------------------------------------------------------------------ cleanup
  section("cleanup");
  for (const id of cleanup.runs) {
    await prisma.question.deleteMany({ where: { importBatchId: id } }).catch(() => undefined);
    await prisma.bulkImportRun.delete({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanup.bundles) await prisma.importBundle.delete({ where: { id } }).catch(() => undefined);
  check("question count back to the starting value", (await prisma.question.count()) === questionsBefore, { before: questionsBefore, after: await prisma.question.count() });

  console.log(`\n${failuresCount === 0 ? "ALL PASS" : `${failuresCount} FAILED`}`);
  await prisma.$disconnect();
  process.exit(failuresCount === 0 ? 0 : 1);
}

/** The sample images of the official template (same files the package example uses). */
async function richTemplateZipEntries(): Promise<{ name: string; data: Buffer }[]> {
  const { readZipDirectory, readZipEntry } = await import("@/lib/rich-import/zip");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const p = path.join(mkdtempSync(path.join(os.tmpdir(), "json-import-")), "tpl.zip");
  writeFileSync(p, await richTemplateZip());
  const entries = (await readZipDirectory(p)).filter((e) => e.kind === "IMAGE");
  return Promise.all(entries.map(async (e) => ({ name: e.name, data: await readZipEntry(p, e) })));
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
