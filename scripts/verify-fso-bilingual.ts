/**
 * Bilingual (Hindi + English) questions — server-side regression suite. Synthetic fixtures, disposable DB, scratch
 * storage, mock OpenRouter: never real AI, never production.
 *
 *   npx tsx scripts/fso-bilingual-fixtures.ts /tmp/fsobi
 *   node scripts/mock-openrouter-vision.mjs 3541 /tmp/fsobi/mock-vision.json &
 *   AI_IMPORT_DISABLE_KICK=1 OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3541 FX_TEST_BASE_URL=http://127.0.0.1:3541 \
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> AI_IMPORT_VAULT_DIR=<scratch> DATABASE_URL=<scratch mts_*> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-fso-bilingual.ts /tmp/fsobi [real-key-2019.txt real-key-2022.txt]
 *
 * The optional real key texts (pdftotext -layout of the two RPSC FSO keys) check the key parser against the real layouts.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiImportFileRole, AiImportPaperType, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { saveImporterSettings, getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker } from "@/lib/ai-import/adapter";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, setExpectedQuestions } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { approveQuestions, editQuestion, requestImport, revalidateQuestions, setAcademicReview, setAnswer, setFigure, setPracticeExclusion, setTaxonomy } from "@/lib/ai-import/review";
import { effective } from "@/lib/ai-import/post";
import { parseKeyText, keyLooksValid } from "@/lib/ai-import/keys";
import { pageSchema, toExtracted, EXTRACT_SYSTEM } from "@/lib/ai-import/prompts";
import { BILINGUAL_RULES, bilingualFindings, devanagariShare, mergeHindi, numbersIn, toHindi } from "@/lib/ai-import/bilingual";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { startPreviousYearPaperAttempt, saveAnswer, submitAttempt } from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { upsertOptions } from "@/lib/question-form-core";
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
const REAL_KEYS = process.argv.slice(3);
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
}

const pair = (en: Partial<ExtractedQuestion>, hi: ExtractedQuestion["hi"]): ExtractedQuestion =>
  ({ section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: "Example of Gel is", options: ["Smoke", "Fog", "Milk", "Butter"].map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "AI_VISION", ...en, hi }) as ExtractedQuestion;
const goodHi = { stem: "जैल का उदाहरण है", options: ["धुआँ", "कोहरा", "दूध", "मक्खन"].map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t })), confidence: 0.95, unreadable: [], sameOptionOrder: true, figuresDiffer: false };

function pureChecks() {
  section("A. Answer-key parser (real RPSC layouts + year-in-title regression)");
  const rowsK = Array.from({ length: 10 }, (_, k) => `${k + 1}   ${(k % 4) + 1}   ${k + 11}   ${k === 3 ? "*" : (k % 4) + 1}`).join("\n");
  const synthetic = `Food Safety Officer Comp. Exam - 2022\nExam Date : 27-06-2023\nQ. No.   RES   Q. No.   RES\n${rowsK}\n* Means deleted\n`;
  const sp = parseKeyText(synthetic);
  check("a year in the title is not read as an entry (no Q202)", !sp.some((p) => p.number > 20), sp.filter((p) => p.number > 20));
  check("2-column grid with `*` read completely and accepted", sp.length === 20 && keyLooksValid(sp) && sp.find((p) => p.number === 14)?.raw === "*", sp);
  check("existing formats still parse: '1. B  2. (c)', '1-A, 2-B'", parseKeyText("1. B  2. (c)").map((p) => p.raw).join() === "B,c" && parseKeyText("1-A, 2-B").map((p) => p.raw).join() === "A,B");
  for (const [i, file] of REAL_KEYS.entries()) {
    const text = readFileSync(file, "utf8");
    const deleted = i === 0 ? [71] : [16, 43, 50, 72, 106, 130];
    const pairs = parseKeyText(text);
    // Independent reading of the same grid: every "<number> <value>" pair on a row (whitespace-separated columns).
    const truth = new Map<number, string>();
    for (const line of text.split("\n")) {
      const cells = line.trim().split(/\s+/);
      if (!cells.every((c) => /^(\d{1,3}|\*)$/.test(c)) || cells.length % 2) continue;
      for (let k = 0; k < cells.length; k += 2) truth.set(Number(cells[k]), cells[k + 1]);
    }
    const nums = pairs.map((p) => p.number).sort((a, b) => a - b);
    const name = path.basename(file);
    check(`${name}: 150 entries, numbers 1–150 once each, key accepted`, pairs.length === 150 && nums.every((n, k) => n === k + 1) && keyLooksValid(pairs), { n: pairs.length, valid: keyLooksValid(pairs) });
    check(`${name}: every value equals the independent column reading (150/150)`, truth.size === 150 && pairs.every((p) => truth.get(p.number) === p.raw), [...truth].filter(([n, v]) => pairs.find((p) => p.number === n)?.raw !== v).slice(0, 5));
    check(`${name}: deleted (*) exactly Q${deleted.join(", Q")}`, JSON.stringify(pairs.filter((p) => p.raw === "*").map((p) => p.number).sort((a, b) => a - b)) === JSON.stringify(deleted));
    check(`${name}: every other value is an option number 1–4`, pairs.filter((p) => p.raw !== "*").every((p) => /^[1-4]$/.test(p.raw)));
  }

  section("B. Bilingual pair checks (pure)");
  check("good pair: no finding", bilingualFindings(pair({}, goodHi)).length === 0, bilingualFindings(pair({}, goodHi)));
  check("Hindi missing → BILINGUAL_HINDI_MISSING", bilingualFindings(pair({}, null))[0]?.code === "BILINGUAL_HINDI_MISSING");
  check("option count differs → BILINGUAL_MISMATCH", bilingualFindings(pair({}, { ...goodHi, options: goodHi.options.slice(0, 3) })).some((f) => f.code === "BILINGUAL_MISMATCH"));
  check("a number differs (0.66 vs 0.60) → BILINGUAL_MISMATCH", bilingualFindings(pair({ stem: "value 0.60" }, { ...goodHi, stem: "मान 0.66" })).some((f) => f.code === "BILINGUAL_MISMATCH" && /numbers differ/.test(f.detail)));
  check("Devanagari digits count as the same numbers (०.७५ = 0.75)", numbersIn("मान ०.७५").join() === "0.75" && bilingualFindings(pair({ stem: "value 0.75" }, { ...goodHi, stem: "मान ०.७५" })).length === 0);
  check("reader says option order differs → BILINGUAL_MISMATCH", bilingualFindings(pair({}, { ...goodHi, sameOptionOrder: false })).some((f) => f.code === "BILINGUAL_MISMATCH"));
  check("figure in one language only → BILINGUAL_MISMATCH", bilingualFindings(pair({}, { ...goodHi, figuresDiffer: true })).some((f) => f.code === "BILINGUAL_MISMATCH"));
  check("English side empty → BILINGUAL_MISMATCH", bilingualFindings(pair({ stem: "" }, goodHi)).some((f) => f.code === "BILINGUAL_MISMATCH"));
  check("low reader confidence → BILINGUAL_HINDI_UNCERTAIN", bilingualFindings(pair({}, { ...goodHi, confidence: 0.6 })).some((f) => f.code === "BILINGUAL_HINDI_UNCERTAIN"));
  check("OCR-garbage 'Hindi' (Latin letters) → BILINGUAL_HINDI_UNCERTAIN", devanagariShare("3π HRH Tor") === 0 && bilingualFindings(pair({}, { ...goodHi, stem: "3π HRH Tor Fe" })).some((f) => f.code === "BILINGUAL_HINDI_UNCERTAIN"));
  check("English terms inside real Hindi text are fine (विटामिन B2)", devanagariShare("किस विटामिन की कमी से B2") > 0.8);
  check("second read disagrees → BILINGUAL_HINDI_UNCERTAIN", bilingualFindings(pair({}, { ...goodHi, secondReadAgreement: 0.4 })).some((f) => f.code === "BILINGUAL_HINDI_UNCERTAIN"));
  check("admin-confirmed Hindi clears the reading doubts…", bilingualFindings(pair({}, { ...goodHi, confidence: 0.3, secondReadAgreement: 0.2, confirmedById: "x" })).length === 0);
  check("…but never the structural ones (option count)", bilingualFindings(pair({}, { ...goodHi, options: goodHi.options.slice(0, 3), confirmedById: "x" })).some((f) => f.code === "BILINGUAL_MISMATCH"));

  section("C. Reader output → extraction (labels, joins, English-only unchanged)");
  const out = pageSchema.parse({ questions: [{ number: 1, stem: "Example", options: [{ label: "(1)", text: "a" }, { label: "(2)", text: "b" }], confidence: 0.9, printed_answer: [], hi: { stem: "उदाहरण", options: [{ label: "(1)", text: "क" }, { label: "(2)", text: "ख" }], confidence: 0.9, same_option_order: true } }, { number: 2, stem: "English only", options: [{ label: "(1)", text: "a" }, { label: "(2)", text: "b" }], confidence: 0.9, printed_answer: [] }] });
  const ex = toExtracted(out, 1, "m");
  check("Hindi options get the canonical labels of the same English position (1)→A, (2)→B", ex[0].hi?.options.map((o) => `${o.label}:${o.text}`).join() === "A:क,B:ख", ex[0].hi);
  check("an English-only reading has no `hi` key at all (unchanged shape)", !("hi" in ex[1]));
  check("garbled `hi` from a reader is dropped, never thrown", pageSchema.parse({ questions: [{ number: 1, stem: "x", options: [], confidence: 1, printed_answer: [], hi: 42 }] }).questions[0].hi === null);
  const merged = mergeHindi(toHindi({ stem: "भाग 1", options: [], unreadable: [], confidence: 0.9, same_option_order: true }, []), toHindi({ stem: "भाग 2", options: [{ label: "(1)", text: "क" }], unreadable: [], confidence: 0.95, same_option_order: true }, ["A"]));
  check("a Hindi question across two pages is joined (stem + options)", merged?.stem === "भाग 1\nभाग 2" && merged.options.length === 1 && merged.confidence === 0.9, merged);
  check("extraction rules: bilingual pairing, never translate, ignore handwriting; English prompt unchanged", /Return each question number ONCE/.test(BILINGUAL_RULES) && /NEVER translate/.test(BILINGUAL_RULES) && /IGNORE HANDWRITING/.test(BILINGUAL_RULES) && !/Hindi/.test(EXTRACT_SYSTEM));
}

async function upload(actor: string, jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER, paperFileId: string | null = null) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  return { fileId, ...(await completeFile({ fileId, actorId: actor })) };
}

async function setSettings(patch: (s: ImporterSettings) => ImporterSettings, actor: string) {
  await saveImporterSettings(patch(normalizeImporterSettings(await getImporterSettings())), actor);
}

async function main() {
  pureChecks();
  if (!FX) throw new Error("fixture directory missing");
  const suffix = Date.now().toString(36);
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.create({ data: { name: `BI Exam ${suffix}`, code: `BI-${suffix}`, isActive: true, languageMode: "BILINGUAL" } });
  const enExam = await prisma.exam.create({ data: { name: `EN Exam ${suffix}`, code: `EN-${suffix}`, isActive: true } });
  check("a new exam defaults to ENGLISH (existing behaviour)", enExam.languageMode === "ENGLISH");
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: `BI Food Science ${suffix}` });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: `BI Microbiology ${suffix}` });
  const enSubject = await createFixtureSubject(prisma, { examId: enExam.id, name: `EN Subject ${suffix}` });

  section("D. Importer pipeline on a bilingual scanned paper (mock vision, ₹0)");
  await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
  check("OpenRouter (mock) connection test", (await testOpenRouterConnection()).ok);
  await setOpenRouterEnabled(true);
  await syncCatalog();
  await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
  const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
  await setSettings((s) => ({ ...s, aiEnabled: true, selection: { mode: "manual" }, importerModels: mockIds, models: { extract: "mockvision/reader", extractFallbacks: [], verify: "mockvision/checker", classify: "mocktext/classifier", key: null }, privacy: { dataCollection: "deny", zdr: false } }), actor);
  await realFetch(`${MOCK}/__mock/reset`, { method: "POST" });
  const jobId = await createJob({ actorId: actor, title: `BI paper ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2022, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  const paper = await upload(actor, jobId, "bilingual-paper.pdf");
  await upload(actor, jobId, "key-2022.pdf", AiImportFileRole.ANSWER_KEY, paper.fileId);
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  await setExpectedQuestions({ jobId, actorId: actor, expected: 7 });
  const j0 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  await confirmJob({ jobId, actorId: actor, examId: j0.examId, paperType: j0.paperType, subjectId: j0.subjectId, year: j0.year, paperCode: j0.paperCode, previousYearPaperId: j0.previousYearPaperId, confirmedMaxInr: CONFIRM_ANY });
  await runWorker(300_000);
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  check("job processed", job.status === "NEEDS_REVIEW", { s: job.status, e: job.errorMessage, p: job.pauseReason });
  const pages = await prisma.aiImportPage.findMany({ where: { jobId, fileId: paper.fileId }, orderBy: { pageNumber: "asc" } });
  check("both pages read by the vision model (outcome AI), local OCR not used", pages.length === 2 && pages.every((p) => p.outcome === "AI" && !p.ocrEngine), pages.map((p) => [p.outcome, p.ocrEngine, p.outcomeReason]));
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: { orderIndex: "asc" } });
  const byNo = (n: number) => qs.find((x) => effective(x).number === n)!;
  check("7 numbers → 7 questions (Hindi and English never stored as two rows)", qs.length === 7 && new Set(qs.map((x) => x.sourceKey)).size === 7, qs.map((x) => x.sourceKey));
  const q1 = byNo(1);
  check("Q1: English and Hindi kept, each as printed", effective(q1).stem === "Example of Gel is" && effective(q1).hi?.stem === "जैल का उदाहरण है" && effective(q1).hi?.options.map((o) => o.text).join() === "धुआँ,कोहरा,दूध,मक्खन");
  check("Q1: no bilingual issue (good pair, second read agrees)", !q1.issueCodes.some((c) => c.startsWith("BILINGUAL")) && effective(q1).hi?.secondReadAgreement === 1, { codes: q1.issueCodes, agr: effective(q1).hi?.secondReadAgreement });
  check("Q1: one diagram, attached to the one canonical question", q1.figures.length === 1 && q1.figures[0].owner === "STEM", q1.figures.map((f) => f.owner));
  check("Q2: Hindi missing → review (blocking)", byNo(2).issueCodes.includes("BILINGUAL_HINDI_MISSING"), byNo(2).issueCodes);
  check("Q3: Hindi 0.66 vs English 0.60 → mismatch (blocking)", byNo(3).issueCodes.includes("BILINGUAL_MISMATCH"), byNo(3).issueCodes);
  check("Q4: low Hindi confidence + second read disagrees → uncertain", byNo(4).issueCodes.includes("BILINGUAL_HINDI_UNCERTAIN") && (effective(byNo(4)).hi?.secondReadAgreement ?? 1) < 0.9, { codes: byNo(4).issueCodes, agr: effective(byNo(4)).hi?.secondReadAgreement });
  check("Q5: Latin-letter 'Hindi' (OCR failure mode) → uncertain", byNo(5).issueCodes.includes("BILINGUAL_HINDI_UNCERTAIN"), byNo(5).issueCodes);
  check("Q6: 3 Hindi options vs 4 English → mismatch", byNo(6).issueCodes.includes("BILINGUAL_MISMATCH"), byNo(6).issueCodes);
  const keys = await prisma.aiImportKeyEntry.findMany({ where: { jobId } });
  check("key read locally: 7 entries, no Q202 from the title year", keys.length === 7 && keys.every((k) => k.sourceNumber <= 7), keys.map((k) => [k.sourceNumber, k.rawValue]));
  check("Q1 answer = official key (2) → B", q1.answerStatus === "OFFICIAL_MATCHED" && q1.finalAnswer.join() === "B", [q1.answerStatus, q1.finalAnswer]);
  const q7 = byNo(7);
  check("Q7 deleted in key → WITHDRAWN, no answer, never importable", q7.answerStatus === "WITHDRAWN" && !q7.finalAnswer.length && !!importBlocker(q7, await getImporterSettings(), { ignoreApproval: true }), [q7.answerStatus, q7.finalAnswer]);
  let q7refused = "";
  await setAnswer(q7.id, actor, ["A"]).catch((e: Error) => (q7refused = e.message));
  const q7after = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q7.id }, include: { figures: true } });
  check("Q7 deleted in key: an administrator cannot set an answer on it", /deleted this question/.test(q7refused) && !q7after.finalAnswer.length, q7refused);
  check("Q7 deleted in key: the import gate names the deletion even if an answer, approval and subject were present", /deleted in the official answer key/.test(importBlocker({ ...q7after, finalAnswer: ["A"], answerConfirmedById: actor, approvedById: actor, subjectId: subject.id }, await getImporterSettings()) ?? ""));
  for (const n of [2, 3, 5, 6]) check(`Q${n}: import blocked until the pair is fixed`, /Hindi/.test(importBlocker(byNo(n), await getImporterSettings(), { ignoreApproval: true }) ?? ""), importBlocker(byNo(n), await getImporterSettings(), { ignoreApproval: true }));

  section("E. Review: Hindi correction / confirmation");
  let refused = "";
  await editQuestion(byNo(6).id, actor, { stem: effective(byNo(6)).stem, options: effective(byNo(6)).options, type: "SINGLE_CORRECT", contentFormat: "PLAIN", hi: { stem: "x", options: [{ text: "a" }] } }).catch((e: Error) => (refused = e.message));
  check("a Hindi edit with a different option count is refused", /same number of options/.test(refused), refused);
  const e4 = effective(byNo(4));
  await editQuestion(byNo(4).id, actor, { stem: e4.stem, options: e4.options, type: "SINGLE_CORRECT", contentFormat: "PLAIN", hi: { stem: e4.hi!.stem, options: e4.hi!.options.map((o) => ({ text: o.text })) } });
  await revalidateQuestions(jobId, [byNo(4).id]);
  const q4 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: byNo(4).id }, include: { figures: true } });
  check("confirming Q4's Hindi clears the doubt (recorded as an admin edit)", !q4.issueCodes.includes("BILINGUAL_HINDI_UNCERTAIN") && effective(q4).hi?.confirmedById === actor, q4.issueCodes);
  check("the confirmation is in the question's history", (await prisma.aiImportQuestionVersion.count({ where: { questionId: q4.id, kind: "ADMIN_EDIT" } })) === 1);
  check("the original extraction is never overwritten", (q4.data as unknown as ExtractedQuestion).hi?.confidence === 0.6);

  section("F. Import into the Question Bank: one question, both languages, one answer");
  for (const x of [q1, q4]) await setTaxonomy(x.id, actor, subject.id, topic.id);
  check("Q1's diagram placement waits for an administrator (never auto-trusted)", q1.issueCodes.includes("IMAGE_MAPPING_UNCERTAIN"), q1.issueCodes);
  for (const f of q1.figures) await setFigure(f.id, actor, "STEM", null);
  // Q4 is marked historical current affairs before import; Q1 is not (2026-11-11 practice exclusion).
  await setPracticeExclusion([q4.id], actor, true, "Historical current affairs (test)");
  const ap = await approveQuestions([q1.id, q4.id], actor);
  check("Q1 + Q4 approved", ap.approved === 2, ap.refused);
  await requestImport(jobId, actor, "DRAFT", [q1.id, q4.id]);
  await runWorker(300_000);
  const imported = await prisma.aiImportQuestion.findMany({ where: { id: { in: [q1.id, q4.id] } } });
  check("both imported", imported.every((x) => x.status === "IMPORTED" && !!x.questionId), imported.map((x) => [x.status, x.issues]));
  const bq1 = await prisma.question.findUniqueOrThrow({ where: { id: imported.find((x) => x.id === q1.id)!.questionId! }, include: { options: { orderBy: { order: "asc" } }, assets: true } });
  check("Question.text = English, Question.textHi = Hindi", bq1.text.includes("Example of Gel is") && bq1.textHi === "जैल का उदाहरण है", [bq1.text, bq1.textHi]);
  const bq4 = await prisma.question.findUniqueOrThrow({ where: { id: imported.find((x) => x.id === q4.id)!.questionId! } });
  check("practice exclusion carried on import: Q4 excluded with its reason, Q1 not", bq4.excludeFromPractice && bq4.excludeFromPracticeReason === "Historical current affairs (test)" && !bq1.excludeFromPractice, [bq4.excludeFromPractice, bq4.excludeFromPracticeReason, bq1.excludeFromPractice]);
  {
    const held = byNo(5);
    await setAcademicReview([held.id], actor, "UNMAPPED_PENDING_ACADEMIC_REVIEW", "test hold");
    const h = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: held.id }, include: { figures: true } });
    check("an import question under academic review is refused by the import gate (stays in staging, visible)", h.academicReview === "UNMAPPED_PENDING_ACADEMIC_REVIEW" && /taxonomy pending academic review/.test(importBlocker(h, await getImporterSettings(), { ignoreApproval: true }) ?? ""));
  }
  check("4 option rows, each with English + Hindi text, one correct (B)", bq1.options.length === 4 && bq1.options.map((o) => o.textHi).join() === "धुआँ,कोहरा,दूध,मक्खन" && bq1.options.filter((o) => o.isCorrect).map((o) => o.label).join() === "B", bq1.options);
  check("the diagram is stored once on the question (shared by both languages)", bq1.assets.filter((a) => a.role === "QUESTION").length === 1, bq1.assets.length);
  check("imported as DRAFT, never published by the import", bq1.status === "DRAFT");

  section("G. Question Bank edits never drop the Hindi");
  await upsertOptions(prisma, bq1.id, { optionA: "Smoke!", optionB: "Fog", optionC: "Milk", optionD: "Butter", optionAImageUrl: "", optionBImageUrl: "", optionCImageUrl: "", optionDImageUrl: "", correctOption: "B", questionType: "SINGLE_CORRECT" } as never);
  const after = await prisma.questionOption.findMany({ where: { questionId: bq1.id }, orderBy: { order: "asc" } });
  check("option edit keeps each option's Hindi text by label", after.map((o) => o.textHi).join() === "धुआँ,कोहरा,दूध,मक्खन" && after[0].text === "Smoke!", after.map((o) => [o.text, o.textHi]));

  section("H. Snapshot, player payload, answers (one Answer row whatever the language)");
  const pyq = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2022, title: `BI Comp Exam ${suffix}`, heldOn: new Date("2023-06-27") } });
  check("paper keeps its title year 2022 with the held-on date 27-06-2023", pyq.year === 2022 && pyq.heldOn?.toISOString().slice(0, 10) === "2023-06-27");
  const bq4id = imported.find((x) => x.id === q4.id)!.questionId!;
  await prisma.question.updateMany({ where: { id: { in: [bq1.id, bq4id] } }, data: { status: QuestionStatus.PUBLISHED, previousYearPaperId: pyq.id, reviewRequired: false } });
  const en = await prisma.question.create({ data: { examId: enExam.id, subjectId: enSubject.id, code: `EN-${suffix}-1`, text: "English only?", status: QuestionStatus.PUBLISHED, options: { create: ["a", "b", "c", "d"].map((t, i) => ({ label: "ABCD"[i], text: t, isCorrect: i === 0, order: i })) } } });
  const enPaper = await prisma.previousYearPaper.create({ data: { examId: enExam.id, year: 2024, title: `EN PYQ ${suffix}` } });
  await prisma.question.update({ where: { id: en.id }, data: { previousYearPaperId: enPaper.id } });
  const student = await prisma.student.create({ data: { studentId: `BI-${suffix}`, name: "BI Student", email: `bi-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  const started = await startPreviousYearPaperAttempt(student.id, pyq.id);
  const attempt = await prisma.testAttempt.findUniqueOrThrow({ where: { id: started.id }, include: { questions: { include: { answer: true }, orderBy: { order: "asc" } } } });
  const snap = attempt.questions.map((t) => t.questionSnapshot as { text: string; hi?: { text: string; options: { label: string; text: string }[] }; correctLabel: string });
  check("bilingual snapshot carries both versions, one correctLabel", snap.length === 2 && snap.every((s) => !!s.hi?.text && !!s.correctLabel), snap.map((s) => Object.keys(s)));
  const player = toPlayerQuestions(attempt.questions, { instantMode: false });
  const p1 = player.find((p) => p.text.includes("Example of Gel"))!;
  check("player payload: Hindi text + options by label", p1.hi?.text === "जैल का उदाहरण है" && p1.hi.options.B === "कोहरा", p1.hi);
  check("player payload never carries the answer (no reveal) in either language", player.every((p) => p.reveal === null) && !JSON.stringify(player).includes("correctLabel"));
  const target = attempt.questions.find((t) => t.questionId === bq1.id)!;
  await saveAnswer(attempt.id, student.id, bq1.id, "B", true, 1);
  await saveAnswer(attempt.id, student.id, bq1.id, "B", true, 2);
  const answers = await prisma.answer.findMany({ where: { attemptQuestionId: target.id } });
  check("one Answer row per attempt-question; mark-for-review stored", answers.length === 1 && answers[0].selectedOptionLabel === "B" && answers[0].status === "ANSWERED_AND_MARKED", answers);
  const done = await submitAttempt(attempt.id, student.id);
  const scored = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  check("result: the correct label scores in whichever language it was chosen", (scored.correctCount ?? 0) === 1, { done, scored: [scored.correctCount, scored.score] });

  const enStart = await startPreviousYearPaperAttempt(student.id, enPaper.id);
  const enAttempt = await prisma.testAttempt.findUniqueOrThrow({ where: { id: enStart.id }, include: { questions: { include: { answer: true } } } });
  const enSnap = enAttempt.questions[0].questionSnapshot as Record<string, unknown>;
  check("English-only exam: snapshot has exactly the v1 keys (unchanged)", JSON.stringify(Object.keys(enSnap).sort()) === JSON.stringify(["code", "correctLabel", "difficulty", "imageUrl", "options", "text"]), Object.keys(enSnap));
  check("English-only exam: player payload has no `hi` key", !("hi" in toPlayerQuestions(enAttempt.questions, { instantMode: false })[0]));

  section("I. Rich (formula) Hindi rendering");
  const rich = toPlayerQuestions([{ questionId: "r", questionSnapshot: { v: 2, contentFormat: "RICH_V1", code: "r", text: "Value of $A_{w}$", difficulty: "MEDIUM", imageUrl: null, correctLabel: "A", options: [{ label: "A", text: "$x^{2}$", imageUrl: null }, { label: "B", text: "b", imageUrl: null }], assets: [], hi: { text: "$A_{w}$ का मान", options: [{ label: "A", text: "$x^{2}$ हिंदी" }, { label: "B", text: "ख" }] } }, answer: null }], { instantMode: false })[0];
  check("Hindi formulas are rendered like the English ones (KaTeX HTML)", !!rich.hi?.rich && /katex/.test(JSON.stringify(rich.hi.rich.textHtml)) && /katex/.test(JSON.stringify(rich.hi.rich.optionHtml.A)), rich.hi);

  section("J. Safety");
  check("no request left the machine (only the loopback mock)", blockedHosts.size === 0, [...blockedHosts]);
  const calls = await prisma.aiImportAiCall.findMany({ where: { jobId } });
  check("every AI call of the job went to mock models", calls.length > 0 && calls.every((c) => c.model.startsWith("mock")), calls.map((c) => c.model));

  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
