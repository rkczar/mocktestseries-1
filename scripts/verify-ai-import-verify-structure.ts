/**
 * AI Question Importer — Verify 1 / Verify 2, question structure and exam taxonomy (2026-10-23).
 *
 *   A. Pure checks (no DB, no AI): Word line breaks with attributes (<w:br w:type="textWrapping"/>), numbered
 *      statements (Roman / Arabic) with four combination options, "► Official Answer: Option (c) — III and IV" after
 *      the options, an explanation printed beneath the answer, an answer left inside option D, statements run
 *      together, Verify 2 text parts, classification guards (shifted answers, invalid / out-of-hierarchy codes, low
 *      confidence, no fitting subject), verification states (failed / unavailable never "Passed"), Verify 2
 *      outcome, format-profile rules and deviations.
 *   B. A synthetic 20-question DOCX in the layout of the 2026-10-23 production paper (mocked AI only): structure on
 *      import, classification with shifted answers / no match / bulk re-classification, Verify 1 restoring a legacy
 *      question (statements run together + official answer inside option D) from the Word source with history, a
 *      text reference with differences + a scanned reference that is NOT compared, Verify 2 in parts with cost
 *      confirmation, one failed part (cut off → refused fallback), retry of only that part, a disagreement, a
 *      question not found, an independent subject mismatch, consistent counters, timeout / empty answer /
 *      unavailable model (never agreement), publishing blocks, actual spend, format profile save / apply / disable.
 *
 * Scratch DB + scratch storage + its OWN loopback OpenRouter mock (port 3534) — no real AI request is possible
 * (network guard). Removes its jobs, the questions it stored and its format profiles; restores Import Settings.
 *
 *   NODE_OPTIONS=--conditions=react-server OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3534 FX_TEST_BASE_URL=http://127.0.0.1:3534 \
 *     npx tsx scripts/verify-ai-import-verify-structure.ts <empty fixtures dir>
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { AiImportFileRole, AiImportPaperType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { blockToQuestion, mergedAnswerIn, mergedStatements, splitQuestions, statementsOf, takePrintedAnswer } from "@/lib/ai-import/local-parse";
import { readDocx } from "@/lib/ai-import/docx";
import { addReference } from "@/lib/ai-import/reference";
import { contentFingerprint, v2Display, verifyState } from "@/lib/ai-import/verify-core";
import { importAndPublishEligible, paperSummary, requestVerify2, runVerify1, verify2Outcome, verify2Preview, verify2TextParts } from "@/lib/ai-import/paper-verify";
import { approveQuestions, reclassifyQuestions, setTaxonomy } from "@/lib/ai-import/review";
import { referenceStatus } from "@/lib/ai-import/reference-status";
import { decideClassification, echoMatches, taxonomyCodes } from "@/lib/ai-import/taxonomy-check";
import { FORMAT_PROFILES_KEY, deriveRules, listFormatProfiles, profileDeviations, saveProfileFromJob, updateFormatProfile } from "@/lib/ai-import/format-profile";
import { refreshRoutes } from "@/lib/ai-import/routes";
import { buildZip } from "@/lib/rich-import/zip-writer";
import { getExamTaxonomy, type ExamTaxonomySubject } from "@/lib/exam-taxonomy";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const MOCK = process.env.OPENROUTER_TEST_BASE_URL ?? "";
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !/^http:\/\/127\.0\.0\.1:3534$/.test(MOCK)) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR (scratch) and OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3534 (this suite's own mock).");
  process.exit(2);
}
const FX = process.argv[2];
if (!FX) {
  console.error("usage: verify-ai-import-verify-structure.ts <fixtures dir>");
  process.exit(2);
}
mkdirSync(FX, { recursive: true });

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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ""}`);
}

// ---- Fixtures: the 2026-10-23 production layout (Word line breaks with attributes, "► Official Answer") ----------

const BR = `<w:br w:type="textWrapping"/>`;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** One paragraph; "\n" inside the text becomes an attributed line break, as the production file has it. */
const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t.split("\n").map(esc).join(`</w:t>${BR}<w:t xml:space="preserve">`)}</w:t></w:r></w:p>`;
function docx(paragraphs: string[]): Buffer {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs.join("")}</w:body></w:document>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(ct) },
    { name: "word/document.xml", data: Buffer.from(documentXml) },
  ]);
}

interface SrcQ {
  n: number;
  stem: string;
  code?: string;
  options: string[];
  answer: "a" | "b" | "c" | "d";
  explanation?: string;
  /** An unlabelled explanation paragraph printed beneath the answer. */
  plainExplanation?: string;
}
const HEART = "Which of the following heart sounds of the cardiovascular system are best heard with the bell of the stethoscope?\nI. Opening snap\nII. Systolic click\nIII. Third heart sound\nIV. Mid diastolic murmur";
const SIMPLE: [string, string[], "a" | "b" | "c" | "d"][] = [
  ["Which nerve of the upper limb supplies the deltoid muscle?", ["Radial nerve", "Axillary nerve", "Ulnar nerve", "Median nerve"], "b"],
  ["Which bone of the lower limb is the longest in the body?", ["Tibia", "Fibula", "Femur", "Patella"], "c"],
  ["Which enzymes digest starch in the mouth?", ["Pepsin", "Salivary amylase", "Lipase", "Trypsin"], "b"],
  ["Which vitamin deficiency in nutrition causes scurvy?", ["Vitamin A", "Vitamin B12", "Vitamin C", "Vitamin D"], "c"],
  ["Which muscle is the main driver of the respiratory system during quiet breathing?", ["Diaphragm", "Trapezius", "Deltoid", "Biceps"], "a"],
  ["Which cells of the special senses detect colour vision?", ["Rods", "Cones", "Bipolar cells", "Ganglion cells"], "b"],
  ["Which epithelium seen in histology lines the urinary bladder?", ["Simple squamous", "Transitional", "Columnar", "Cuboidal"], "b"],
  ["Which lobe in neuroanatomy contains the primary visual cortex?", ["Frontal", "Parietal", "Temporal", "Occipital"], "d"],
  ["Which artery of the head & neck is palpated at the temple?", ["Facial", "Superficial temporal", "Lingual", "Occipital"], "b"],
  ["Which hormone of renal physiology increases water reabsorption?", ["Insulin", "Glucagon", "Vasopressin", "Thyroxine"], "c"],
  ["Which valve of the cardiovascular system lies between the left atrium and left ventricle?", ["Tricuspid", "Mitral", "Aortic", "Pulmonary"], "b"],
  ["Which nerve of the lower limb causes foot drop when injured?", ["Femoral", "Obturator", "Common peroneal", "Tibial"], "c"],
  ["Which enzymes are inhibited by aspirin?", ["Cyclooxygenase", "Lipoxygenase", "Kinase", "Phosphatase"], "a"],
  ["Which mineral in nutrition prevents goitre?", ["Iron", "Iodine", "Calcium", "Zinc"], "b"],
  ["Which bone of the upper limb articulates with the scapula?", ["Radius", "Ulna", "Humerus", "Clavicle"], "c"],
  ["Which part of the respiratory system is the site of gas exchange?", ["Trachea", "Bronchi", "Alveoli", "Larynx"], "c"],
  ["Which number is the smallest prime greater than ten?", ["Eleven", "Twelve", "Thirteen", "Fifteen"], "a"],
  ["Which gland of the head & neck secretes thyroxine?", ["Parotid", "Thyroid", "Pituitary", "Thymus"], "b"],
];
const SRC: SrcQ[] = [
  { n: 1, stem: HEART, code: "Select the correct answer using the code given below:", options: ["I and IV", "II and III only", "III and IV", "I, II and III"], answer: "c" },
  { n: 2, stem: "Consider the following statements about renal physiology:\n1. The loop of Henle concentrates urine\n2. Renin is secreted by the juxtaglomerular cells\n3. The proximal tubule secretes all of the filtered glucose", code: "Which of the statements given above are correct?", options: ["1 only", "1 and 2 only", "2 and 3 only", "1, 2 and 3"], answer: "b", explanation: "Glucose is reabsorbed, not secreted, in the proximal tubule." },
  ...SIMPLE.map(([stem, options, answer], i): SrcQ => ({ n: i + 3, stem, options, answer, ...(i === 4 ? { plainExplanation: "The diaphragm does most of the work of quiet breathing." } : {}) })),
];
/** Every run's paper is its own (a run tag on each question's first line), so no earlier run's stored questions are duplicates of it. */
const RUN = Date.now().toString(36);
for (const q of SRC) q.stem = q.stem.replace(/^([^\n]*)/, `$1 (set ${RUN})`);
const answerLine = (q: SrcQ) => `► Official Answer: Option (${q.answer}) — ${q.options["abcd".indexOf(q.answer)]}`;
function paperParagraphs(qs: SrcQ[], misspell = false): string[] {
  const out = [p("UPSC-style synthetic paper — Official Keys are provided immediately below each question.")];
  for (const q of qs) {
    out.push(p(`Q${q.n}. ${misspell ? q.stem.replace("stethoscope", "stethescope") : q.stem}`));
    if (q.code) out.push(p(q.code));
    q.options.forEach((o, i) => out.push(p(`(${"abcd"[i]}) ${o}`)));
    if (!(misspell && q.n === 4)) out.push(p(answerLine(q)));
    if (q.explanation) out.push(p(`Explanation: ${q.explanation}`));
    if (q.plainExplanation) out.push(p(q.plainExplanation));
  }
  return out;
}
/** What an independent reader returns for a question (labels as printed). */
const read = (q: SrcQ, patch: Partial<{ stem: string; options: string[] }> = {}) => ({ number: q.n, type: "SINGLE_CORRECT", stem: patch.stem ?? `${q.stem}${q.code ? `\n${q.code}` : ""}`, options: (patch.options ?? q.options).map((t, i) => ({ label: `(${"abcd"[i]})`, text: t })), printed_answer: [`(${q.answer})`], confidence: 0.95 });

async function buildFixtures() {
  writeFileSync(path.join(FX, "vs-paper.docx"), docx(paperParagraphs(SRC)));
  writeFileSync(path.join(FX, "vs-paper2.docx"), docx(paperParagraphs(SRC.slice(0, 6), true)));
  writeFileSync(path.join(FX, "vs-key.csv"), `Q,Answer\n${SRC.map((q) => `${q.n},${q.answer.toUpperCase()}`).join("\n")}\n`);
  // Text reference: Q3 worded differently, Q4 with another answer.
  const refQs = SRC.map((q) => (q.n === 3 ? { ...q, stem: "Which nerve of the arm supplies the deltoid?" } : q.n === 4 ? { ...q, answer: "a" as const } : q));
  writeFileSync(path.join(FX, "vs-reference.docx"), docx(paperParagraphs(refQs)));
  // Scanned reference: a page image only (no text layer).
  const doc = await PDFDocument.create();
  const png = await sharp({ create: { width: 600, height: 840, channels: 3, background: { r: 250, g: 250, b: 245 } } }).png().toBuffer();
  const page = doc.addPage([595, 842]);
  page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
  writeFileSync(path.join(FX, "vs-scanned-reference.pdf"), await doc.save());
  // Verify 2 (checker): parts are Q1–8, Q9–16, Q17–20. Q10 printed answer read differently (the source cannot settle
  // it), Q11 option C read differently (the Word text settles it), Q12 not found.
  const part = (from: number, to: number) =>
    SRC.filter((q) => q.n >= from && q.n <= to && q.n !== 12).map((q) => (q.n === 11 ? read(q, { options: [q.options[0], q.options[1], "Something else entirely", q.options[3]] }) : q.n === 10 ? { ...read(q), printed_answer: ["(a)"] } : read(q)));
  const text = [
    { match: "heart sounds of the cardiovascular", questions: [], checker: { questions: part(1, 8) }, byModel: { "mockvision/mid": { questions: part(1, 8) }, "mockvision/reader": { questions: part(1, 8) } } },
    { match: SRC[8].stem.slice(0, 40), questions: [], checker: { questions: part(9, 16) }, byModel: { "mockvision/mid": { questions: part(9, 16) }, "mockvision/reader": { questions: part(9, 16) } } },
    { match: SRC[16].stem.slice(0, 40), questions: [], checker: { questions: part(17, 20) }, byModel: { "mockvision/mid": { questions: part(17, 20) }, "mockvision/reader": { questions: part(17, 20) } } },
  ];
  writeFileSync(path.join(FX, "vs-mock.json"), JSON.stringify({ pages: {}, keys: {}, text }));
}

// ---- Helpers ---------------------------------------------------------------------------------------------

const TAG = `vs-${Date.now().toString(36)}`;
const jobs: string[] = [];
async function upload(actor: string, jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER, paperFileId: string | null = null) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  await completeFile({ fileId, actorId: actor });
  return fileId;
}
async function runJob(actor: string, jobId: string) {
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const max = (j.estimate as { maxInr: number | null } | null)?.maxInr ?? null;
  await confirmJob({ jobId, actorId: actor, examId: j.examId, paperType: j.paperType, subjectId: j.subjectId, year: j.year, paperCode: j.paperCode, previousYearPaperId: j.previousYearPaperId, confirmedMaxInr: max });
  await runWorker(300_000);
  return prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
}
const mockStats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()) as { chat: number; byModel: Record<string, number>; byTask: Record<string, number>; attempts: Record<string, number> };
const mockConfig = (c: Record<string, unknown>) => fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) });
const questionsOf = (jobId: string) => prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: { orderIndex: "asc" } });
type QRow = Awaited<ReturnType<typeof questionsOf>>[number];
const byLabel = (qs: QRow[], label: string) => qs.find((q) => q.sourceLabel === label)!;
const eff = (q: QRow) => (q.editedData ?? q.data) as unknown as ExtractedQuestion;
const fp = (q: QRow) => contentFingerprint({ e: eff(q), finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures });
const vs = (q: QRow) => verifyState(q.data, fp(q));
const events = (jobId: string, type: string) => prisma.aiImportEvent.findMany({ where: { jobId, type }, orderBy: { createdAt: "asc" } });
const v2Of = (q: QRow) => (q.data as unknown as ExtractedQuestion).paperVerify?.v2;
async function verify2(jobId: string, actor: string, model: string) {
  const pv = await verify2Preview(jobId, model);
  const r = await requestVerify2({ jobId, actorId: actor, model, confirmedMaxInr: pv.maxInr });
  await runWorker(300_000);
  return { pv, r, job: await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } }) };
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const tax = await getExamTaxonomy(prisma, exam.id);
  const subjectOf = (name: string) => tax.find((s) => s.name === name)!;
  const topicId = (name: string) => tax.flatMap((s) => s.topics).find((x) => x.name === name)!.id;
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  const profilesBefore = await prisma.setting.findUnique({ where: { key: FORMAT_PROFILES_KEY } });
  // Profiles left by an earlier kept run would apply to this run's papers: set aside, restored in `finally`.
  await prisma.setting.deleteMany({ where: { key: FORMAT_PROFILES_KEY } });
  const questionsBefore = await prisma.question.count();
  const taxonomyCounts = async () => [await prisma.subject.count(), await prisma.topic.count(), await prisma.subTopic.count(), await prisma.examSubject.count(), await prisma.examTopic.count(), await prisma.examSubTopic.count()].join("/");
  const taxonomyBefore = await taxonomyCounts();
  const stored: string[] = [];
  let mockProc: ChildProcess | null = null;

  try {
    // ------------------------------------------------------------------ A
    section("A. Pure checks (no DB, no AI)");
    await buildFixtures();
    const doc = await readDocx(path.join(FX, "vs-paper.docx"));
    check("Word line breaks with attributes (<w:br w:type=\"textWrapping\"/>) become separate lines", doc.lines.some((l) => l.text === "I. Opening snap") && doc.lines.some((l) => l.text === "IV. Mid diastolic murmur") && !doc.lines.some((l) => /snapII/.test(l.text)), doc.lines.slice(0, 8));
    const blocks = splitQuestions(doc.lines).blocks;
    check("20 questions found; numbered statements 1–3 under Q2 stay in Q2 (not read as Q3)", blocks.length === 20 && blocks.map((b) => b.number).join() === Array.from({ length: 20 }, (_, i) => i + 1).join(), blocks.map((b) => b.number));
    const q1 = blockToQuestion(blocks[0], 1, "DOCX").q;
    check("Q1: four Roman statements on their own lines, then the instruction", statementsOf(q1.stem).map((s) => s.key).join() === "I,II,III,IV" && q1.stem.endsWith("Select the correct answer using the code given below:"), q1.stem);
    check("Q1: four combination options, option D is just “I, II and III” (official answer NOT appended)", q1.options.map((o) => o.text).join("|") === "I and IV|II and III only|III and IV|I, II and III", q1.options);
    check("Q1: “► Official Answer: Option (c) — III and IV” read as answer C, kept separately as printed", q1.printedAnswer.join() === "C" && q1.printedAnswerRaw === "► Official Answer: Option (c) — III and IV", [q1.printedAnswer, q1.printedAnswerRaw]);
    const q2 = blockToQuestion(blocks[1], 1, "DOCX").q;
    check("Q2: Arabic statements 1–3 kept in the stem, answer B, labelled explanation separate", statementsOf(q2.stem).length === 3 && q2.printedAnswer.join() === "B" && q2.hints?.explanation === SRC[1].explanation && q2.options[3].text === "1, 2 and 3", [q2.stem, q2.options, q2.hints]);
    const q7 = blockToQuestion(blocks[6], 1, "DOCX").q;
    check("Q7: an unlabelled explanation printed beneath the answer is the explanation, not option text", q7.options[3].text === "Biceps" && q7.hints?.explanation === SRC[6].plainExplanation && q7.printedAnswer.join() === "A", [q7.options, q7.hints]);
    const restart = splitQuestions(["Q5. Consider the following statements:", "1. Alpha", "2. Beta", "Which are correct?", "(a) 1 only", "(b) 2 only", "(c) Both", "(d) Neither", "Q6. Next?", "(a) w", "(b) x", "(c) y", "(d) z"].map((text) => ({ text }))).blocks;
    check("a statement “1.” inside Q5 does not open a new section (numbering restart)", restart.length === 2 && restart.every((b) => b.section === "") && statementsOf(blockToQuestion(restart[0], 1, "DOCX").q.stem).length === 2, restart.map((b) => [b.section, b.number]));
    const legacy = { stem: "Which of the following heart sounds are best heard with the bell of stethoscope?I. Opening snapII. Systolic clickIII. Third heart soundIV. Mid diastolic murmur\nSelect the correct answer using the code given below:", options: [{ label: "A", printed: "(a)", text: "I and IV" }, { label: "B", printed: "(b)", text: "II and III only" }, { label: "C", printed: "(c)", text: "III and IV" }, { label: "D", printed: "(d)", text: "I, II and III\n► Official Answer: Option (c) — III and IV" }] };
    const m = mergedAnswerIn(legacy);
    check("production question as stored: the official answer inside option D is found, option D cleaned, answer C", m?.where === "option D" && m.options[3].text === "I, II and III" && m.labels.join() === "C", m);
    check("production question as stored: statements run together are detected (I, II, III, IV)", mergedStatements(legacy.stem)?.join() === "I,II,III,IV" && mergedStatements(q1.stem) === null, mergedStatements(legacy.stem));
    const a = takePrintedAnswer("Q\n(a) p\n(b) q\n(c) r\n(d) s\nAns: (b)\nExplanation: because.");
    check("answer + labelled explanation beneath the options → B, explanation separate, option D clean", a.answer.join() === "B" && a.explanation === "because." && !/Ans/.test(a.text), a);
    check("an answer marker inside the question text (before the options) is content, never taken", takePrintedAnswer("Answer the following: which is the official answer key format?\n(a) p\n(b) q\n(c) r\n(d) s").answer.length === 0);
    const parts = verify2TextParts(doc.lines.map((l) => l.text));
    check("Verify 2 text parts: at most 8 questions each, every question in exactly one part, each part starts at a question", parts.length === 3 && parts.every((x) => x.keys.length <= 8) && parts.flatMap((x) => x.keys).length === 20 && new Set(parts.flatMap((x) => x.keys)).size === 20 && parts.slice(1).every((x) => /^Q\d+\./.test(x.text)) && parts[0].text.startsWith("UPSC-style"), parts.map((x) => [x.keys.length, x.text.slice(0, 30)]));

    // Classification guards.
    const T: ExamTaxonomySubject[] = [
      { id: "s-med", name: "General Medicine", syllabusDescription: null, topics: [{ id: "t-cvs", name: "Cardiovascular Diseases", subjectId: "s-med", syllabusDescription: null, subTopics: [{ id: "u-aus", name: "Auscultation", topicId: "t-cvs" }] }] },
      { id: "s-derm", name: "Dermatology", syllabusDescription: null, topics: [{ id: "t-pig", name: "Pigmentary Disorders", subjectId: "s-derm", syllabusDescription: null, subTopics: [] }] },
    ];
    const codes = taxonomyCodes(T);
    check("taxonomy codes: subjects, topics and subtopics of the exam only, mapped back to database ids", codes.subject("S1") === "s-med" && codes.topic("t1") === "t-cvs" && codes.subTopic("U1") === "u-aus" && codes.subject("S9") === null && /SUBTOPIC U1 = Auscultation/.test(codes.list));
    const heart = { stem: legacy.stem, options: legacy.options };
    const ok = decideClassification({ subject: "S1", topic: "T1", subtopic: "U1", confidence: 0.9, about: ["heart sounds", "stethoscope"], reason: "auscultation" }, heart, codes, T, "m");
    check("a result whose key words are in the question → subject, topic and subtopic used, with an explanation", ok.subject === "s-med" && ok.topic === "t-cvs" && ok.subTopic === "u-aus" && !ok.rejected && /General Medicine › Cardiovascular Diseases › Auscultation/.test(ok.explanation) && /90%/.test(ok.explanation), ok);
    const shifted = decideClassification({ subject: "S2", topic: "T2", subtopic: null, confidence: 0.95, about: ["vitiligo", "melanocytes"] }, heart, codes, T, "m");
    check("a shifted answer (key words of another question: vitiligo) → NOT used: heart sounds never become Dermatology", shifted.subject === null && /belongs to another question/.test(shifted.rejected ?? ""), shifted);
    check("no key words returned → not used (cannot be tied to the question)", decideClassification({ subject: "S1", topic: "T1", subtopic: null, confidence: 0.9 }, heart, codes, T, "m").subject === null);
    check("a subject code not on this exam's list → not used, reported", /not in this exam's list/.test(decideClassification({ subject: "S7", topic: null, subtopic: null, confidence: 0.9, about: ["heart sounds"] }, heart, codes, T, "m").rejected ?? ""));
    const wrongTopic = decideClassification({ subject: "S1", topic: "T2", subtopic: null, confidence: 0.9, about: "heart sounds" }, heart, codes, T, "m");
    check("a topic of ANOTHER subject → subject kept, topic not used (reported)", wrongTopic.subject === "s-med" && wrongTopic.topic === null && /not under General Medicine/.test(wrongTopic.rejected ?? ""), wrongTopic);
    const wrongSub = decideClassification({ subject: "S1", topic: "T1", subtopic: "U9", confidence: 0.9, about: "heart sounds" }, heart, codes, T, "m");
    check("an invalid subtopic code → topic kept, subtopic not used", wrongSub.topic === "t-cvs" && wrongSub.subTopic === null && /subtopic code/.test(wrongSub.rejected ?? ""), wrongSub);
    check("confidence below 60% → unresolved (no subject just to fill the field)", decideClassification({ subject: "S2", topic: null, subtopic: null, confidence: 0.3, about: "heart sounds" }, heart, codes, T, "m").subject === null);
    check("no subject fits (null) → unresolved", /no subject of this exam fits/.test(decideClassification({ subject: null, topic: null, subtopic: null, confidence: 0.2, about: "heart sounds" }, heart, codes, T, "m").rejected ?? ""));
    check("key-word echo tolerates plural / case (“Heart Sound”, “murmurs”), rejects unrelated words", echoMatches(["Heart Sound", "murmurs"], heart) && !echoMatches(["pigmentation"], heart));

    // Reference status words.
    check("reference status: scanned → stored, no text, NOT compared (needs OCR / vision, cost shown first)", referenceStatus({ questions: 0, key: 0, scannedPages: 32 }, 0).state === "not compared" && /OCR \/ vision/.test(referenceStatus({ questions: 0, key: 0, scannedPages: 32 }, 0).reason ?? ""));
    check("reference status: text read, Verify 1 not run → text extracted (not compared yet)", referenceStatus({ questions: 20, key: 0, scannedPages: 0 }, 0).state === "text extracted");
    check("reference status: compared by Verify 1 → compared", referenceStatus({ questions: 20, key: 5, scannedPages: 0 }, 20).state === "compared");

    // Verification states and outcome.
    const fpx = "f";
    const st = (status: string) => verifyState({ paperVerify: { v2: { fingerprint: fpx, status, model: "m", at: "", fields: [], detail: "" } } }, fpx).v2;
    check("Verify 2 states: FAILED → failed, UNAVAILABLE → unavailable, NOT_FOUND → not_found (none of them verified)", st("FAILED") === "failed" && st("UNAVAILABLE") === "unavailable" && st("NOT_FOUND") === "not_found" && st("VERIFIED") === "verified");
    check("display: no result is Failed / Unavailable, Pending / Running while Verify 2 is queued / running — never Passed", v2Display("failed", null) === "Failed" && v2Display("unavailable", { status: "DONE" }) === "Unavailable" && v2Display("none", { status: "QUEUED" }) === "Pending" && v2Display("failed", { status: "RUNNING" }) === "Running" && v2Display("verified", { status: "RUNNING" }) === "Passed" && v2Display("none", null) === "Not run");
    check("Verify 2 outcome: no result at all → NO_RESULT; some failed parts → PARTIAL; all answered → COMPLETE", verify2Outcome({ FAILED: 120, attempted: 120, units: 1, failedUnits: 1 }) === "NO_RESULT" && verify2Outcome({ VERIFIED: 10, FAILED: 8, attempted: 18, failedUnits: 1 }) === "PARTIAL" && verify2Outcome({ VERIFIED: 9, DISAGREE: 1, attempted: 10, failedUnits: 0 }) === "COMPLETE");

    // Format profile rules.
    const verifiedQs = blocks.slice(0, 10).map((b) => blockToQuestion(b, 1, "DOCX").q);
    const rules = deriveRules(verifiedQs);
    check("format profile rules from verified questions: “(a)” labels, answers beneath each question, “► Official Answer: Option”", rules.optionLabels === "(a)" && rules.answerPlacement === "below-question" && rules.answerLinePrefix === "► Official Answer: Option", rules);
    const dev = profileDeviations({ ...rules, ocrErrors: [{ wrong: "stethescope", right: "stethoscope" }] }, { ...q1, stem: q1.stem.replace("stethoscope", "stethescope"), options: [...q1.options.slice(0, 3), { ...q1.options[3], text: "I, II and III ► Official Answer: Option (c)" }], printedAnswerRaw: undefined }, false);
    check("profile deviations: answer line inside option D, no answer beneath the question, a known reading error", dev.some((x) => /option D contains this format's answer line/.test(x)) && dev.some((x) => /none was found here/.test(x)) && dev.some((x) => /stethescope/.test(x)), dev);
    check("a clean question has no deviation", profileDeviations(rules, q1, false).length === 0, profileDeviations(rules, q1, false));

    // ------------------------------------------------------------------ setup
    mockProc = spawn(process.execPath, ["scripts/mock-openrouter-vision.mjs", "3534", path.join(FX, "vs-mock.json")], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${MOCK}/__mock/stats`).then((x) => x.ok).catch(() => false)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
    await testOpenRouterConnection();
    await setOpenRouterEnabled(true);
    await syncCatalog();
    const importerModels = ["mockvision/reader", "mockvision/checker", "mockvision/mid", "mocktext/classifier"];
    const settings: ImporterSettings = {
      ...savedSettings,
      aiEnabled: true,
      privacy: { dataCollection: "deny", zdr: false },
      selection: { mode: "manual" },
      importerModels,
      verification: { ...savedSettings.verification, independentAnswer: false, topicMinConfidence: 0.7 },
      budget: { ...savedSettings.budget, maxRequestInr: 1, keyReserveUsd: 5, retryTransient: false, allowPricierFallback: false },
      limits: { ...savedSettings.limits, concurrency: 1 },
      models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: "mocktext/classifier", key: null },
    };
    await saveImporterSettings(settings, actor);
    await refreshRoutes(importerModels);

    // ------------------------------------------------------------------ B
    section("B1. Import: structure on import, classification guards");
    // The classifier answers shifted by one question (as a small model did on 2026-10-23).
    await mockConfig({ classifyShift: true });
    const jB = await createJob({ actorId: actor, title: `Verify structure ${TAG}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2025, paperCode: null, previousYearPaperId: null, expectedQuestions: 20 });
    jobs.push(jB);
    const paperB = await upload(actor, jB, "vs-paper.docx");
    await upload(actor, jB, "vs-key.csv", AiImportFileRole.ANSWER_KEY, paperB);
    const jobB = await runJob(actor, jB);
    let qs = await questionsOf(jB);
    check("DOCX read locally: 20 questions, job waiting for review", jobB.status === "NEEDS_REVIEW" && qs.length === 20, [jobB.status, jobB.errorMessage, qs.length]);
    const d1 = eff(byLabel(qs, "1"));
    check("Q1 stored with its statements on separate lines, clean options, answer C — no ANSWER_IN_OPTION / STATEMENTS_MERGED", statementsOf(d1.stem).length === 4 && d1.options[3].text === "I, II and III" && byLabel(qs, "1").finalAnswer.join() === "C" && !byLabel(qs, "1").issueCodes.some((c) => c === "ANSWER_IN_OPTION" || c === "STATEMENTS_MERGED"), [d1.stem, d1.options, byLabel(qs, "1").issueCodes]);
    check("no option of any question contains an answer line", qs.every((q) => eff(q).options.every((o) => !/Official Answer/.test(o.text))));
    const shiftEv = (await events(jB, "CLASSIFY_RESULT")).at(-1);
    // Since 2026-10-23 the free local classifier decides first; the (shifted) AI classifier only gets what it cannot settle.
    check("shifted classifier answers are NOT used: no subject / topic comes from the AI, the heart-sounds question is never filed under another subject", qs.every((q) => !q.taxonomySource?.startsWith("AI")) && byLabel(qs, "1").subjectId !== subjectOf("Biochemistry").id, [qs.map((q) => [q.sourceLabel, q.subjectId, q.taxonomySource]), shiftEv?.message]);
    check("each question without a subject says why (its own reason, never the bare generic message)", qs.filter((q) => !q.subjectId).every((q) => { const t = ((q.issues as Record<string, string>) ?? {}); const why = t.SUBJECT_UNKNOWN ?? t.CLASSIFICATION_FAILED ?? ""; return why.length > 60 && !/^No subject of this exam could be determined\. Set it/.test(why); }), qs.filter((q) => !q.subjectId).map((q) => q.issues));
    await mockConfig({ classifyShift: false });
    // Bulk re-classification with the same restrictions.
    const n = await reclassifyQuestions(qs.map((q) => q.id), actor);
    await runWorker(300_000);
    qs = await questionsOf(jB);
    const heartQ = byLabel(qs, "1");
    check("bulk re-classification queued all 20 and assigned exam subjects / topics by meaning", n === 20 && heartQ.subjectId === subjectOf("Physiology").id && heartQ.topicId === topicId("Cardiovascular System") && byLabel(qs, "3").topicId === topicId("Upper Limb"), [n, heartQ.subjectId, heartQ.topicId]);
    const prime = byLabel(qs, "19");
    check("a question with no suitable taxonomy match stays unresolved (no unrelated subject filled in)", !prime.subjectId && prime.issueCodes.includes("SUBJECT_UNKNOWN"), [prime.subjectId, prime.issueCodes]);
    const evidence = await prisma.aiImportCheck.findFirst({ where: { questionId: heartQ.id, name: { in: ["Classification evidence", "Local classification"] } }, orderBy: { createdAt: "desc" } });
    check("the classification is explained: subject › topic, confidence, the words / key words that decided it", /Physiology › Cardiovascular System/.test(evidence?.detail ?? "") && /\d+%/.test(evidence?.detail ?? "") && /matched|key words/.test(evidence?.detail ?? ""), evidence?.detail);
    // Manual / bulk subject-topic setting: this exam's records only.
    const otherExam = await prisma.exam.findFirst({ where: { id: { not: exam.id }, examSubjects: { some: {} } }, select: { id: true } });
    const foreignTopic = otherExam ? await prisma.topic.findFirst({ where: { examLinks: { some: { examId: otherExam.id } }, NOT: { examLinks: { some: { examId: exam.id } } } }, select: { id: true, subjectId: true } }) : null;
    const refuse = async (fn: () => Promise<unknown>) => fn().then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));
    check("setting a topic of ANOTHER subject is refused", /does not belong to the subject/.test(await refuse(() => setTaxonomy(byLabel(qs, "3").id, actor, subjectOf("Physiology").id, topicId("Upper Limb"), null))));
    check("setting a subject / topic that is not linked to this exam is refused", !foreignTopic || /not configured for this exam|does not belong/.test(await refuse(() => setTaxonomy(byLabel(qs, "3").id, actor, foreignTopic.subjectId, foreignTopic.id, null))), foreignTopic);

    // Invalid codes from the classifier: never stored.
    await mockConfig({ script: { "mocktext/classifier": ["badcodes"] } });
    await reclassifyQuestions([byLabel(qs, "4").id], actor);
    await runWorker(120_000);
    qs = await questionsOf(jB);
    const q4links = new Set((await prisma.examSubject.findMany({ where: { examId: exam.id } })).map((l) => l.subjectId));
    const badEv = (await events(jB, "CLASSIFY_RESULT")).at(-1);
    check("invalid subject / topic codes from the classifier are never stored (only this exam's ids; counted as invalid when the AI was asked)", (!byLabel(qs, "4").subjectId || q4links.has(byLabel(qs, "4").subjectId!)) && !byLabel(qs, "4").taxonomySource?.startsWith("AI") && (((byLabel(qs, "4").data as unknown as ExtractedQuestion).classification?.ai?.status ?? "") !== "REJECTED" || /not on the list/.test(badEv?.message ?? "")), [byLabel(qs, "4").subjectId, byLabel(qs, "4").taxonomySource, badEv?.message]);
    await reclassifyQuestions([byLabel(qs, "4").id], actor);
    await runWorker(120_000);
    qs = await questionsOf(jB);

    check("the importer created no subject, topic or subtopic (and no exam link) — classification, re-classification, invalid codes", (await taxonomyCounts()) === taxonomyBefore, [taxonomyBefore, await taxonomyCounts()]);

    section("B2. Verify 1: legacy question restored from the Word source, references");
    // Simulate a question stored by the old reader (exactly the production record): statements run together and the
    // official answer inside option D; and an earlier wrong AI subject on Q9 (Dermatology-style mismatch).
    const old = byLabel(qs, "1");
    const oldData = old.data as unknown as ExtractedQuestion;
    await prisma.aiImportQuestion.update({ where: { id: old.id }, data: { data: { ...oldData, stem: oldData.stem.replace(/\n(?=I{1,3}\.|IV\.)/g, ""), options: oldData.options.map((o) => (o.label === "D" ? { ...o, text: `${o.text}\n${answerLine(SRC[0])}` } : o)), printedAnswer: [], printedAnswerRaw: undefined } as unknown as Prisma.InputJsonValue } });
    const q9 = byLabel(qs, "9");
    await prisma.aiImportQuestion.update({ where: { id: q9.id }, data: { subjectId: subjectOf("Biochemistry").id, topicId: topicId("Nutrition"), taxonomySource: "AI (old classifier)", taxonomyConfidence: 0.9 } });
    await addReference({ jobId: jB, actorId: actor, name: "Clean copy.docx", bytes: readFileSync(path.join(FX, "vs-reference.docx")) });
    await addReference({ jobId: jB, actorId: actor, name: "Scanned copy.pdf", bytes: readFileSync(path.join(FX, "vs-scanned-reference.pdf")) });
    const scannedEv = (await events(jB, "REFERENCE_ADDED")).at(-1);
    check("scanned reference: stored, and the event says it will NOT be compared (needs OCR / vision)", /will NOT be compared/.test(scannedEv?.message ?? "") && /OCR \/ vision/.test(scannedEv?.message ?? ""), scannedEv?.message);
    const v1 = await runVerify1(jB, actor);
    qs = await questionsOf(jB);
    const fixed = byLabel(qs, "1");
    const fd = eff(fixed);
    check("Verify 1 moved the official answer out of option D (source evidence) and restored the statement line breaks", fd.options[3].text === "I, II and III" && statementsOf(fd.stem).length === 4 && fd.printedAnswer.join() === "C" && v1.whitespaceRestored >= 1 && v1.corrected >= 1, [fd.stem, fd.options[3], v1]);
    const versions = await prisma.aiImportQuestionVersion.findMany({ where: { questionId: fixed.id }, orderBy: { createdAt: "asc" } });
    check("the original extraction is kept in the history (two versions: before the answer move, before the line breaks)", versions.length >= 2 && versions.some((v) => /line breaks/.test(v.note ?? "")) && versions.some((v) => /printed answer/.test(v.note ?? "")), versions.map((v) => v.note));
    check("Verify 1 result of Q1: passed after the corrections", vs(fixed).v1 === "passed", [vs(fixed).v1, vs(fixed).pv?.v1?.problems, fixed.issueCodes, fixed.issues, fixed.status]);
    const ref3 = vs(byLabel(qs, "3")).pv?.v1?.references ?? [];
    check("text reference: Q3 wording difference shown with its similarity, the scanned reference recorded as NOT compared", ref3.some((x) => x.name === "Clean copy.docx" && x.compared && x.matched === "Q3" && x.similarity !== null && x.similarity < 0.9 && x.conflicts.length > 0) && ref3.some((x) => x.name === "Scanned copy.pdf" && !x.compared && /not compared/.test(x.note ?? "")), ref3);
    check("text reference: Q4 answer difference is a reference conflict (source not replaced)", byLabel(qs, "4").issueCodes.includes("REFERENCE_CONFLICT") && eff(byLabel(qs, "4")).options[0].text === SRC[3].options[0], byLabel(qs, "4").issueCodes);
    check("Verify 1 result names the reference that was not compared", v1.referencesCompared === 1 && v1.referencesNotCompared.join() === "Scanned copy.pdf" && /NOT compared/.test((await events(jB, "VERIFY1_DONE")).at(-1)?.message ?? ""), [v1, (await events(jB, "VERIFY1_DONE")).at(-1)?.message]);
    let sum = (await paperSummary(jB))!;
    check("summary: reference states — clean copy “compared”, scanned copy “not compared” (stored, no text)", sum.references.find((r) => r.name === "Clean copy.docx")?.status.state === "compared" && sum.references.find((r) => r.name === "Scanned copy.pdf")?.status.state === "not compared" && sum.references.find((r) => r.name === "Scanned copy.pdf")?.status.extracted === null, sum.references.map((r) => r.status));
    check("summary: each reference identifiable — clean copy compared, scanned copy NOT compared (1 page)", sum.references.length === 2 && sum.references.find((r) => r.name === "Clean copy.docx")?.compared === true && sum.references.find((r) => r.name === "Scanned copy.pdf")?.compared === false && sum.references.find((r) => r.name === "Scanned copy.pdf")?.scannedPages === 1, sum.references);

    section("B3. Verify 2: cost confirmation, parts, a failed part, retry, disagreement, subject mismatch");
    const s0 = await mockStats();
    const pv = await verify2Preview(jB, "mockvision/checker");
    check("preview: 3 document parts + classification, estimate ≤ maximum, nothing sent", pv.textParts === 3 && pv.pages === 0 && pv.estimateInr !== null && pv.maxInr !== null && pv.estimateInr <= pv.maxInr && (await mockStats()).chat === s0.chat, pv);
    check("preview states the scanned reference's required OCR / vision and its estimated cost (not sent)", pv.referenceOcr.length === 1 && pv.referenceOcr[0].pages === 1 && pv.referenceOcr[0].maxInr !== null && /OCR \/ vision/.test(pv.referenceOcr[0].processing), pv.referenceOcr);
    const r0 = await requestVerify2({ jobId: jB, actorId: actor, model: "mockvision/checker", confirmedMaxInr: null });
    const r1 = await requestVerify2({ jobId: jB, actorId: actor, model: "mockvision/checker", confirmedMaxInr: pv.maxInr! - 0.01 });
    check("no confirmation / a lower confirmation → not started, nothing sent", !r0.started && !r1.started && (await mockStats()).chat === s0.chat, [r0, r1]);
    const spentBefore = (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } })).spentInr;
    // Part 1: the checker's answer is cut off, the one fallback (mid) refuses — that part has no result.
    await mockConfig({ script: { "mockvision/checker": ["length"], "mockvision/mid": ["refusal"] } });
    const r2 = await requestVerify2({ jobId: jB, actorId: actor, model: "mockvision/checker", confirmedMaxInr: pv.maxInr });
    await runWorker(300_000);
    let jobV = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } });
    let st2 = (jobV.config as { verify2?: { status: string; outcome?: string; counts?: Record<string, number> } }).verify2!;
    qs = await questionsOf(jB);
    const part1 = qs.filter((q) => Number(q.sourceLabel) <= 8);
    check("started after confirmation; finished with gaps (PARTIAL): part 1 failed, parts 2–3 answered", r2.started && st2.status === "DONE" && st2.outcome === "PARTIAL" && st2.counts?.failedUnits === 1 && st2.counts?.units === 3, st2);
    check("part 1's 8 questions: FAILED with the reason (cut off + refusal), never agreement", part1.every((q) => vs(q).v2 === "failed" && !!v2Of(q)?.error?.message && /part 1 of 3/.test(v2Of(q)?.part ?? "")), part1.map((q) => [q.sourceLabel, vs(q).v2, v2Of(q)?.error?.message?.slice(0, 80)]));
    check("Q10: printed answer read differently (the source cannot settle it) → disagreement with the field named", vs(byLabel(qs, "10")).v2 === "disagree" && v2Of(byLabel(qs, "10"))!.fields.some((x) => /answer/.test(x)) && byLabel(qs, "10").issueCodes.includes("VERIFY2_DISAGREES"), [vs(byLabel(qs, "10")).v2, v2Of(byLabel(qs, "10"))?.fields]);
    check("Q11: option C read differently, but the Word text contains the stored wording → agrees, settled by the source (shown)", vs(byLabel(qs, "11")).v2 === "verified" && v2Of(byLabel(qs, "11"))!.fields.includes("option C") && !!v2Of(byLabel(qs, "11"))!.resolvedBySource, v2Of(byLabel(qs, "11")));
    check("Q12: not found by the second read → its own state (a disagreement to decide), not agreement", vs(byLabel(qs, "12")).v2 === "not_found" && byLabel(qs, "12").issueCodes.includes("VERIFY2_DISAGREES"));
    // The subject / topic check is its own result (v2.classification); the text read keeps its own verdict.
    check("Q9: the independent classification files it under Anatomy, not the stored Biochemistry → DISAGREEMENT + Subject mismatch", v2Of(byLabel(qs, "9"))?.classification?.status === "DISAGREEMENT" && v2Of(byLabel(qs, "9"))?.classification?.found?.subjectId === subjectOf("Anatomy").id && byLabel(qs, "9").issueCodes.includes("SUBJECT_MISMATCH") && byLabel(qs, "9").issueCodes.includes("TAXONOMY_DISAGREES"), [v2Of(byLabel(qs, "9")), byLabel(qs, "9").issueCodes]);
    sum = (await paperSummary(jB))!;
    const b2 = sum.v2;
    check("counters add up: Verify 1 and Verify 2 buckets each sum to the questions processed", sum.v1.passed + sum.v1.problems + sum.v1.stale + sum.v1.none === sum.total && b2.verified + b2.disagree + b2.not_found + b2.failed + b2.unavailable + b2.stale + b2.none === sum.total && b2.failed === 8, [sum.total, sum.v1, b2]);
    check("summary run: attempted / results / no result / failed parts match the stored results, with the first reason", sum.verify2Run?.outcome === "PARTIAL" && sum.verify2Run.attempted === 20 && sum.verify2Run.noResult === 8 && sum.verify2Run.results === 12 && sum.verify2Run.failedParts === 1 && !!sum.verify2Run.firstError, sum.verify2Run);
    check("subject / topic counters distinguish a subject mismatch from a missing subject / topic", sum.classification.subjectMismatch >= 1 && sum.classification.subjectUnknown >= 1, sum.classification);
    check("failed questions are not eligible to publish; disagreements neither", !sum.eligible.some((id) => part1.some((q) => q.id === id)) && !sum.eligible.includes(byLabel(qs, "10").id) && !sum.eligible.includes(byLabel(qs, "12").id), sum.eligible.length);
    const doneEv = (await events(jB, "VERIFY2_DONE")).at(-1);
    check("event: finished with gaps, 12 of 20 with a result, retry only the failed parts", /finished with gaps/.test(doneEv?.message ?? "") && /12 of 20/.test(doneEv?.message ?? "") && /retry only those parts/.test(doneEv?.message ?? ""), doneEv?.message);
    // Retry: only part 1 is priced and sent again.
    const beforeRetry = await mockStats();
    const pvR = await verify2Preview(jB, "mockvision/checker");
    check("retry preview: only the failed part is read again (1 document part)", pvR.textParts === 1, pvR.textParts);
    await requestVerify2({ jobId: jB, actorId: actor, model: "mockvision/checker", confirmedMaxInr: pvR.maxInr });
    await runWorker(300_000);
    const afterRetry = await mockStats();
    qs = await questionsOf(jB);
    check("retry sent exactly one document read (no duplicate charges / results for parts 2–3) and part 1 now agrees", (afterRetry.byTask.extract ?? 0) - (beforeRetry.byTask.extract ?? 0) === 1 && qs.filter((q) => Number(q.sourceLabel) <= 8).every((q) => vs(q).v2 === "verified" || (q.sourceLabel === "9")), [afterRetry.byTask, beforeRetry.byTask, qs.filter((q) => Number(q.sourceLabel) <= 8).map((q) => vs(q).v2)]);
    jobV = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } });
    st2 = (jobV.config as { verify2?: { status: string; outcome?: string; counts?: Record<string, number> } }).verify2!;
    sum = (await paperSummary(jB))!;
    check("actual spend recorded: the job's spend grew, stayed within the confirmed maximum, Verify 2 actual shown", jobV.spentInr > spentBefore && jobV.spentInr <= jobV.budgetInr + 1e-9 && (sum.cost.verify2?.actualInr ?? 0) > 0, [jobV.spentInr, spentBefore, jobV.budgetInr, sum.cost.verify2]);

    section("B4. Verify 2 failures with another model: timeout, empty answer, unavailable — never agreement");
    // A second import of the same paper (its own Verify 2 state), so each failure mode is seen on every question.
    const jF = await createJob({ actorId: actor, title: `Verify failures ${TAG}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2025, paperCode: null, previousYearPaperId: null, expectedQuestions: 20 });
    jobs.push(jF);
    await upload(actor, jF, "vs-paper.docx");
    await runJob(actor, jF);
    await runVerify1(jF, actor);
    await mockConfig({ script: {}, failTask: { extract: [408, "Request Timeout"] } });
    let f = await verify2(jF, actor, "mockvision/mid");
    let fqs = await questionsOf(jF);
    let fst = (f.job.config as { verify2?: { outcome?: string } }).verify2!;
    check("timeout: every question FAILED with the provider's message; outcome NO_RESULT; nothing verified", fqs.every((q) => vs(q).v2 === "failed" && /OpenRouter failed/.test(v2Of(q)?.error?.message ?? "")) && fst.outcome === "NO_RESULT" && (await paperSummary(jF))!.verified === 0, [fst, fqs.map((q) => v2Of(q)?.error?.message?.slice(0, 60)).slice(0, 2)]);
    check("timeout: the event says Verify 2 produced NO independent result", (await events(jF, "VERIFY2_NO_RESULT")).length === 1 && /none counts as verified/.test((await events(jF, "VERIFY2_NO_RESULT"))[0].message));
    // Every allowed fallback answers empty too (since 2026-10-25 a slightly pricier one, mockvision/checker, is allowed).
    await mockConfig({ failTask: {}, script: { "mockvision/mid": ["empty", "empty", "empty"], "mockvision/reader": ["empty", "empty", "empty"], "mockvision/checker": ["empty", "empty", "empty"] } });
    f = await verify2(jF, actor, "mockvision/mid");
    fqs = await questionsOf(jF);
    check("empty answers (and an empty fallback): FAILED with “empty” reason, never agreement", fqs.every((q) => vs(q).v2 === "failed" && /empty|no answer/i.test(v2Of(q)?.error?.message ?? "")), fqs.map((q) => v2Of(q)?.error?.message?.slice(0, 80)).slice(0, 2));
    await mockConfig({ script: {}, noEndpoint: ["mockvision/mid", "mockvision/reader", "mockvision/checker"] });
    f = await verify2(jF, actor, "mockvision/mid");
    fqs = await questionsOf(jF);
    fst = (f.job.config as { verify2?: { outcome?: string } }).verify2!;
    const fsum = (await paperSummary(jF))!;
    check("unavailable model / route: UNAVAILABLE (with the reason), outcome NO_RESULT, counted as unavailable", fqs.every((q) => vs(q).v2 === "unavailable" && !!v2Of(q)?.error?.message) && fst.outcome === "NO_RESULT" && fsum.v2.unavailable === 20 && fsum.v2.verified === 0, [fst, fsum.v2, fqs.map((q) => v2Of(q)?.error).slice(0, 1)]);
    check("display: these questions show Unavailable, not Passed", fqs.every((q) => v2Display(vs(q).v2, { status: "DONE" }) === "Unavailable"));
    await mockConfig({ noEndpoint: [] });

    section("B5. Publishing blocks and bulk actions");
    qs = await questionsOf(jB);
    const appr = await approveQuestions([byLabel(qs, "10").id, byLabel(qs, "9").id, byLabel(qs, "3").id], actor);
    check("bulk approve refuses unresolved disagreements (Verify 2 / subject mismatch) — decided one by one", appr.refused.some((x) => x.label === "10" && /decide it on its own/.test(x.reason)) && appr.refused.some((x) => x.label === "9"), appr);
    sum = (await paperSummary(jB))!;
    const elig = sum.eligible.length;
    if (!elig) console.log("  (debug) not eligible:", JSON.stringify(qs.slice(0, 8).map((q) => [q.sourceLabel, q.status, q.issueCodes, vs(q).v1, vs(q).v2, q.approvedById ? "approved" : ""])));
    const pubBefore = await prisma.question.count();
    const pub = await importAndPublishEligible(jB, actor);
    await runWorker(300_000);
    qs = await questionsOf(jB);
    const storedNow = qs.filter((q) => q.questionId).map((q) => q.questionId!);
    stored.push(...storedNow);
    check("Import & Publish Eligible: only questions with Verify 1 passed + Verify 2 agreed were stored", elig > 0 && pub.requested === elig && storedNow.length === elig && (await prisma.question.count()) === pubBefore + elig && qs.filter((q) => q.questionId).every((q) => sum.eligible.includes(q.id)), [pub, elig, storedNow.length]);
    check("unresolved questions stayed out of the Question Bank (Q10 disagreement, Q12 not found, Q9 subject mismatch, Q19 no subject)", ["10", "12", "9", "19"].every((l) => !byLabel(qs, l).questionId), ["10", "12", "9", "19"].map((l) => byLabel(qs, l).questionId));

    section("B6. Format profile: learned from verified questions, applied to the next paper, disabled");
    const prof = await saveProfileFromJob({ jobId: jB, actorId: actor, name: "Synthetic UPSC DOCX" });
    check("profile saved from verified questions only: “(a)”, answers beneath, “► Official Answer: Option”", prof.version === 1 && prof.rules.answerLinePrefix === "► Official Answer: Option" && prof.rules.answerPlacement === "below-question" && prof.evidence.verifiedQuestions >= 5, prof);
    await updateFormatProfile({ id: prof.id, actorId: actor, rules: { ocrErrors: [{ wrong: "stethescope", right: "stethoscope" }] } });
    const jP = await createJob({ actorId: actor, title: `Profile check ${TAG}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2025, paperCode: null, previousYearPaperId: null, expectedQuestions: 6 });
    jobs.push(jP);
    await upload(actor, jP, "vs-paper2.docx");
    await runJob(actor, jP);
    await runVerify1(jP, actor);
    let pq = await questionsOf(jP);
    check("next paper of the same exam / format checked against the profile: Q1 known reading error, Q4 answer line missing", byLabel(pq, "1").issueCodes.includes("FORMAT_DEVIATION") && /stethescope/.test(((byLabel(pq, "1").issues as Record<string, string>) ?? {}).FORMAT_DEVIATION ?? "") && byLabel(pq, "4").issueCodes.includes("FORMAT_DEVIATION") && (await events(jP, "FORMAT_PROFILE_APPLIED")).length === 1, pq.map((q) => [q.sourceLabel, q.issueCodes]));
    check("the profile changed nothing in the questions (Q1 text still as printed)", /stethescope/.test(eff(byLabel(pq, "1")).stem));
    const dis = await updateFormatProfile({ id: prof.id, actorId: actor, enabled: false });
    await runVerify1(jP, actor);
    pq = await questionsOf(jP);
    check("Master Admin disabled it (new version, history kept) → no longer applied", !dis.enabled && dis.version === 3 && dis.history.length === 2 && pq.every((q) => !q.issueCodes.includes("FORMAT_DEVIATION")), [dis.enabled, dis.version, dis.history.length]);
    check("profiles list shows it", (await listFormatProfiles()).some((x) => x.id === prof.id && !x.enabled));
  } catch (e) {
    fail++;
    console.error(e);
  } finally {
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    await setOpenRouterEnabled(routerWasEnabled).catch(() => undefined);
    // KEEP=1 (scratch browser check): the jobs, stored questions and profiles stay; their ids are written for a later cleanup.
    if (process.env.KEEP === "1") {
      writeFileSync(path.join(FX, "kept.json"), JSON.stringify({ jobs, stored, profilesBefore: profilesBefore?.value ?? null }));
      console.log(`KEEP=1: kept ${jobs.length} job(s) and ${stored.length} stored question(s) (ids in ${path.join(FX, "kept.json")})`);
      mockProc?.kill();
      await prisma.$disconnect();
      return;
    }
    if (profilesBefore) await prisma.setting.upsert({ where: { key: FORMAT_PROFILES_KEY }, update: { value: profilesBefore.value as Prisma.InputJsonValue }, create: { key: FORMAT_PROFILES_KEY, value: profilesBefore.value as Prisma.InputJsonValue } }).catch(() => undefined);
    else await prisma.setting.deleteMany({ where: { key: FORMAT_PROFILES_KEY } }).catch(() => undefined);
    if (stored.length) {
      const runs = (await prisma.aiImportQuestion.findMany({ where: { questionId: { in: stored } }, select: { bulkImportRunId: true } })).map((x) => x.bulkImportRunId).filter((x): x is string => !!x);
      await prisma.question.deleteMany({ where: { id: { in: stored } } }).catch((e) => console.error("cleanup questions:", e instanceof Error ? e.message.slice(0, 200) : e));
      await prisma.bulkImportRun.deleteMany({ where: { id: { in: [...new Set(runs)] } } }).catch(() => undefined);
    }
    if (jobs.length) {
      await prisma.aiBudgetReservation.deleteMany({ where: { OR: jobs.map((id) => ({ requestKey: { startsWith: `qi:${id}:` } })) } }).catch(() => undefined);
      await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs } } }).catch(() => undefined);
    }
    mockProc?.kill();
  }
  check("cleanup: the Question Bank is back to its starting size", (await prisma.question.count()) === questionsBefore, [await prisma.question.count(), questionsBefore]);
  check("network guard: every request of this run went to the loopback mock", blockedHosts.size === 0, [...blockedHosts]);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("SOME CHECKS FAILED");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

void main();
