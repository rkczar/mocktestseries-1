/**
 * AI Question Importer — universal import + full-paper verification (2026-10-22).
 *
 *   A. Pure checks (no DB, no AI): printed answers after the options / "Correct answer is …" / run into option D /
 *      written as the option's text / with an explanation (and text that must NOT be taken), an answer left inside
 *      an extracted option, reference comparison, content fingerprints.
 *   B. DOCX end to end (local reading, no AI for extraction): answers printed after options, multiple-correct,
 *      formula, a missing question, official key, reference paper (wording / answer conflicts, a question only in
 *      the reference, suggested answers), invalid taxonomy ids cleared, an answer injected into option D moved out
 *      by Verify 1 with history, stale results after an edit, bulk subject / topic correction, Verify 2 on the
 *      document text (cost preview, confirmation, price-change refusal, source-settled differences, a printed-answer
 *      disagreement, an independent topic disagreement, a question found only by the second read), eligibility,
 *      Import & Publish Eligible (only verified questions), Import Approved as Draft.
 *   C. Scanned PDF (mocked vision): question spanning two pages, two figures, a number read twice, a missing
 *      question, crop aspect-ratio check, Verify 2 per page with ONE recorded fallback to a cheaper model after an
 *      unusable answer, a disagreement the scan cannot settle.
 *   D. Paid AI off: Verify 2 refused, nothing sent.
 *
 * Scratch DB + scratch storage + its OWN loopback OpenRouter mock (port 3533) — no real AI request is possible
 * (network guard). Removes its jobs and the questions it stored; restores Import Settings.
 *
 *   NODE_OPTIONS=--conditions=react-server OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3533 FX_TEST_BASE_URL=http://127.0.0.1:3533 \
 *     npx tsx scripts/verify-ai-import-universal.ts <empty fixtures dir>
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { mergedAnswerIn, splitOptions, takePrintedAnswer } from "@/lib/ai-import/local-parse";
import { addReference, compareWithReference, listReferences, referenceOnly, unlinkReference } from "@/lib/ai-import/reference";
import { contentFingerprint, verifyState } from "@/lib/ai-import/verify-core";
import { importAndPublishEligible, paperSummary, requestVerify2, runVerify1, verify2Preview } from "@/lib/ai-import/paper-verify";
import { approveQuestions, requestImport, setTaxonomy } from "@/lib/ai-import/review";
import { refreshRoutes } from "@/lib/ai-import/routes";
import { buildZip } from "@/lib/rich-import/zip-writer";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const MOCK = process.env.OPENROUTER_TEST_BASE_URL ?? "";
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !/^http:\/\/127\.0\.0\.1:3533$/.test(MOCK)) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR (scratch) and OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3533 (this suite's own mock).");
  process.exit(2);
}
const FX = process.argv[2];
if (!FX) {
  console.error("usage: verify-ai-import-universal.ts <fixtures dir>");
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
}

// ---- Fixtures --------------------------------------------------------------------------------------------

const p = (inner: string) => `<w:p>${inner}</w:p>`;
const r = (t: string, vert?: string) => `<w:r>${vert ? `<w:rPr><w:vertAlign w:val="${vert}"/></w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
function docx(paragraphs: string[]): Buffer {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs.join("")}</w:body></w:document>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(ct) },
    { name: "word/document.xml", data: Buffer.from(documentXml) },
  ]);
}

const PAPER = [
  p(r("Instructions: answer every question.")),
  p(r("Q1. Which epithelium lines the urinary bladder?")),
  p(r("(a) Simple squamous")),
  p(r("(b) Transitional")),
  p(r("(c) Stratified squamous")),
  p(r("(d) Columnar")),
  p(r("Ans: (b)")),
  p(r("Explanation: Transitional epithelium stretches as the bladder fills.")),
  p(r("Q2. Which bone forms the point of the elbow?")),
  p(r("(a) Radius")),
  p(r("(b) Humerus")),
  p(r("(c) Olecranon of ulna")),
  p(r("(d) Scapula Correct answer is (c)")),
  p(r("Q3. One or more options may be correct. Which of these are carpal bones?")),
  p(r("(a) Scaphoid (b) Lunate (c) Talus (d) Hamate")),
  p(r("Answer: A, B, D")),
  p(r("Q4. A nerve impulse travels 3 × 10") + r("-3", "superscript") + r(" km in 1 s. Its speed in m/s is")),
  p(r("(a) 3 (b) 30 (c) 0.3 (d) 300")),
  p(r("Correct answer: (a)")),
  p(r("Q6. Which nerve supplies the deltoid muscle of the upper limb?")),
  p(r("(a) Radial nerve")),
  p(r("(b) Axillary nerve")),
  p(r("(c) Ulnar nerve")),
  p(r("(d) Median nerve")),
  p(r("Correct answer: Axillary nerve")),
];
const REFERENCE = [
  p(r("Q1. Which epithelium lines the urinary bladder?")),
  p(r("(a) Simple squamous (b) Transitional (c) Stratified squamous (d) Columnar")),
  p(r("Ans: (b)")),
  p(r("Q2. Which bony landmark forms the tip of the elbow joint?")),
  p(r("(a) Radius (b) Humerus (c) Olecranon of ulna (d) Scapula")),
  p(r("Ans: (c)")),
  p(r("Q3. One or more options may be correct. Which of these are carpal bones?")),
  p(r("(a) Scaphoid (b) Lunate (c) Talus (d) Hamate")),
  p(r("Ans: A, B")),
  p(r("Q4. A nerve impulse travels 3 × 10") + r("-3", "superscript") + r(" km in 1 s. Its speed in m/s is")),
  p(r("(a) 3 (b) 30 (c) 0.3 (d) 300")),
  p(r("Q5. Which muscle abducts the arm beyond fifteen degrees?")),
  p(r("(a) Supraspinatus (b) Teres minor (c) Deltoid (d) Subscapularis")),
  p(r("Ans: (c)")),
  p(r("Q6. Which nerve supplies the deltoid muscle of the upper limb?")),
  p(r("(a) Radial nerve (b) Axillary nerve (c) Ulnar nerve (d) Median nerve")),
  p(r("Ans: (b)")),
];

/** Same palette as the vision mock (marker square in the top-right corner). */
const PALETTE: [number, number, number][] = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170]];
const W = 1240;
const H = 1754;
const box = (x: number, y: number, w: number, h: number) => ({ x: Math.round((x / W) * 1000), y: Math.round((y / H) * 1000), w: Math.round((w / W) * 1000), h: Math.round((h / H) * 1000) });
const opts = (a: string[]) => a.map((t, i) => ({ label: `(${i + 1})`, text: t }));
async function scanPage(doc: PDFDocument, marker: number, body: string) {
  const c = PALETTE[marker];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fafaf7"/><rect x="${W - 80}" y="0" width="80" height="80" fill="rgb(${c.join(",")})"/>${body}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const page = doc.addPage([595, 842]);
  page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
}
const t = (x: number, y: number, s: string) => `<text x="${x}" y="${y}" font-size="26" font-family="DejaVu Sans">${s}</text>`;
const fig = (x: number, y: number, w: number, h: number, fill: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/><circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 3}" fill="#444"/>`;
const FA = { x: 120, y: 160, w: 360, h: 200 };
const FB = { x: 620, y: 160, w: 360, h: 200 };

async function buildFixtures() {
  writeFileSync(path.join(FX, "uni-paper.docx"), docx(PAPER));
  writeFileSync(path.join(FX, "uni-reference.docx"), docx(REFERENCE));
  writeFileSync(path.join(FX, "uni-key.csv"), 'Q,Answer\n1,B\n2,C\n3,"A,B,D"\n4,A\n6,B\n');
  const doc = await PDFDocument.create();
  await scanPage(doc, 1, [t(80, 130, "1. Compare figure P with figure Q."), fig(FA.x, FA.y, FA.w, FA.h, "#dde"), fig(FB.x, FB.y, FB.w, FB.h, "#ede"), t(80, 410, "(1) P is larger (2) Q is larger (3) Equal (4) Cannot say"), t(80, 1600, "2. The chamber that pumps blood to the lungs is"), t(80, 1660, "(1) Right ventricle (2) Left ventricle")].join(""));
  await scanPage(doc, 2, [t(80, 130, "(3) Right atrium (4) Left atrium"), t(80, 260, "3. Which vessel carries oxygenated blood from the lungs?"), t(80, 320, "(1) Pulmonary artery (2) Pulmonary vein (3) Aorta (4) Vena cava"), t(80, 460, "3. Which valve guards the left atrioventricular opening?"), t(80, 520, "(1) Tricuspid (2) Mitral (3) Aortic (4) Pulmonary")].join(""));
  writeFileSync(path.join(FX, "uni-scan.pdf"), await doc.save());
  const p1 = [
    { number: 1, type: "SINGLE_CORRECT", stem: "Compare figure P with figure Q.", options: opts(["P is larger", "Q is larger", "Equal", "Cannot say"]), region: box(60, 95, 1120, 335), figures: [{ box: box(FA.x, FA.y, FA.w, FA.h), owner: "STEM", description: "P" }, { box: box(FB.x, FB.y, FB.w, FB.h), owner: "STEM", description: "Q" }], printed_answer: [], confidence: 0.95 },
    { number: 2, type: "SINGLE_CORRECT", stem: "The chamber that pumps blood to the lungs is", options: opts(["Right ventricle", "Left ventricle"]), region: box(60, 1570, 1120, 120), figures: [], confidence: 0.9, continues_on_next_page: true },
  ];
  const p2 = [
    { number: 2, type: "SINGLE_CORRECT", stem: "", options: [{ label: "(3)", text: "Right atrium" }, { label: "(4)", text: "Left atrium" }], region: box(60, 100, 1120, 60), figures: [], confidence: 0.9, continued_from_previous_page: true },
    { number: 3, type: "SINGLE_CORRECT", stem: "Which vessel carries oxygenated blood from the lungs?", options: opts(["Pulmonary artery", "Pulmonary vein", "Aorta", "Vena cava"]), region: box(60, 230, 1120, 110), figures: [], confidence: 0.95 },
    { number: 3, type: "SINGLE_CORRECT", stem: "Which valve guards the left atrioventricular opening?", options: opts(["Tricuspid", "Mitral", "Aortic", "Pulmonary"]), region: box(60, 430, 1120, 110), figures: [], confidence: 0.95 },
  ];
  // The independent model reads page 2's Q3 option (3) differently: a scan has no text layer to settle it.
  const p2checker = p2.map((q, i) => (i === 1 ? { ...q, options: opts(["Pulmonary artery", "Pulmonary vein", "Arch of aorta", "Vena cava"]) } : q));
  const docText = {
    match: "urinary bladder",
    questions: [],
    checker: {
      questions: [
        { number: 1, type: "SINGLE_CORRECT", stem: "Which epithelium lines the urinary bladder?", options: [{ label: "(a)", text: "Simple squamous" }, { label: "(b)", text: "Transitional" }, { label: "(c)", text: "Stratified squamous" }, { label: "(d)", text: "Columnar" }], printed_answer: ["(b)"], confidence: 0.95 },
        { number: 2, type: "SINGLE_CORRECT", stem: "Which bony part makes up the point of the elbow joint?", options: [{ label: "(a)", text: "Radius" }, { label: "(b)", text: "Humerus" }, { label: "(c)", text: "Olecranon of ulna" }, { label: "(d)", text: "Scapula" }], printed_answer: ["(c)"], confidence: 0.95 },
        { number: 3, type: "MULTIPLE_CORRECT", stem: "One or more options may be correct. Which of these are carpal bones?", options: [{ label: "(a)", text: "Scaphoid" }, { label: "(b)", text: "Lunate" }, { label: "(c)", text: "Talus" }, { label: "(d)", text: "Hamate" }], printed_answer: ["(a)", "(b)"], confidence: 0.95 },
        { number: 4, type: "SINGLE_CORRECT", stem: "A nerve impulse travels 3 × 10$^{3}$ km in 1 s. Its speed in m/s is", rich: true, options: [{ label: "(a)", text: "3" }, { label: "(b)", text: "30" }, { label: "(c)", text: "0.3" }, { label: "(d)", text: "300" }], printed_answer: ["(a)"], confidence: 0.95 },
        { number: 5, type: "SINGLE_CORRECT", stem: "Which muscle abducts the arm beyond fifteen degrees?", options: [{ label: "(a)", text: "Supraspinatus" }, { label: "(b)", text: "Teres minor" }, { label: "(c)", text: "Deltoid" }, { label: "(d)", text: "Subscapularis" }], printed_answer: [], confidence: 0.9 },
        { number: 6, type: "SINGLE_CORRECT", stem: "Which nerve supplies the deltoid muscle of the upper limb?", options: [{ label: "(a)", text: "Radial nerve" }, { label: "(b)", text: "Axillary nerve" }, { label: "(c)", text: "Ulnar nerve" }, { label: "(d)", text: "Median nerve" }], printed_answer: ["(b)"], confidence: 0.95 },
      ],
    },
  };
  writeFileSync(path.join(FX, "uni-mock.json"), JSON.stringify({ pages: { "1": { questions: p1 }, "2": { questions: p2, checker: { questions: p2checker } } }, keys: {}, text: [docText] }));
}

// ---- Helpers ---------------------------------------------------------------------------------------------

const TAG = `uni-${Date.now().toString(36)}`;
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
const mockStats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()) as { chat: number; byModel: Record<string, number>; byTask: Record<string, number> };
const mockConfig = (c: Record<string, unknown>) => fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) });
const questionsOf = (jobId: string) => prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: { orderIndex: "asc" } });
type QRow = Awaited<ReturnType<typeof questionsOf>>[number];
const byLabel = (qs: QRow[], label: string) => qs.find((q) => q.sourceLabel === label);
const data = (q: QRow | undefined) => q?.data as unknown as ExtractedQuestion | undefined;
const eff = (q: QRow | undefined) => (q?.editedData ?? q?.data) as unknown as ExtractedQuestion | undefined;
const fp = (q: QRow) => contentFingerprint({ e: eff(q)!, finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures });
const vs = (q: QRow | undefined) => (q ? verifyState(q.data, fp(q)) : null);
const events = (jobId: string, type: string) => prisma.aiImportEvent.findMany({ where: { jobId, type }, orderBy: { createdAt: "asc" } });

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const tax = await getExamTaxonomy(prisma, exam.id);
  const anatomy = tax.find((s) => s.name === "Anatomy")!;
  const topic = async (name: string) => tax.flatMap((s) => s.topics).find((x) => x.name === name)!.id;
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  const questionsBefore = await prisma.question.count();
  const stored: string[] = [];
  let mockProc: ChildProcess | null = null;

  try {
    // ------------------------------------------------------------------ A
    section("A. Pure checks (no DB, no AI)");
    const ans = (s: string) => takePrintedAnswer(s);
    const a1 = ans("Which organelle makes ATP?\n(a) Nucleus\n(b) Mitochondria\n(c) Golgi\n(d) Lysosome\nAns: (b)\nExplanation: ATP synthase is in the inner membrane.");
    check("answer printed on its own line after the options → B, removed, explanation kept separately", a1.answer.join() === "B" && !/Ans/.test(a1.text) && a1.explanation === "ATP synthase is in the inner membrane." && splitOptions(a1.text).options[3].text === "Lysosome", a1);
    const a2 = ans("Which organelle makes ATP?\n(a) Nucleus\n(b) Mitochondria\n(c) Golgi\n(d) Lysosome Correct answer is (b)");
    check("“Correct answer is (b)” run into option D → B, option D is just “Lysosome”", a2.answer.join() === "B" && splitOptions(a2.text).options[3].text === "Lysosome", [a2, splitOptions(a2.text).options]);
    const a3 = ans("Q text\n(1) 10\n(2) 20\n(3) 30\n(4) 40\nThe correct answer is (3)\nSolution: 3 x 10 = 30");
    check("“The correct answer is (3)” with numbered options → C; solution kept as explanation", a3.answer.join() === "C" && a3.explanation === "3 x 10 = 30");
    const a4 = ans("Which organelle makes ATP?\n(a) Nucleus\n(b) Mitochondria\n(c) Golgi\n(d) Lysosome\nCorrect answer: Mitochondria");
    check("answer written as the option's text → matched to B (and said so)", a4.answer.join() === "B" && /matched to option B/.test(a4.note ?? ""), a4);
    check("multiple-correct “Answer: A, C” → A,C", ans("Select all.\n(A) a1 (B) b1 (C) c1 (D) d1 Answer: A, C").answer.join() === "A,C");
    check("NOT taken: “Answer the following …” instruction, “None … is the correct answer” option, “Vitamin key A”, “The answer is 5” option", [
      "Answer the following. Which is largest?\n(a) 1 (b) 2 (c) 3 (d) None of these is the correct answer",
      "Which?\n(a) Vitamin key A (b) x (c) y (d) z",
      "Which?\n(a) p (b) q (c) r (d) The answer is 5",
    ].every((s) => ans(s).answer.length === 0 && ans(s).text === s));
    check("an answer text that matches no option is left in place (never guessed)", ans("Which?\n(a) p (b) q (c) r (d) s\nCorrect answer: Mitochondria").answer.length === 0);
    const merged = mergedAnswerIn({ stem: "Which organelle?", options: [{ label: "A", printed: "(a)", text: "Nucleus" }, { label: "B", printed: "(b)", text: "Mitochondria" }, { label: "C", printed: "(c)", text: "Golgi" }, { label: "D", printed: "(d)", text: "Lysosome Ans: B" }] });
    check("answer left inside an extracted option D → found, option cleaned, answer B", merged?.labels.join() === "B" && merged.options[3].text === "Lysosome" && merged.where === "option D", merged);
    check("clean extracted question → nothing found", mergedAnswerIn({ stem: "Which organelle?", options: ["Nucleus", "Mitochondria", "Golgi", "Lysosome"].map((x, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: x })) }) === null);
    const q = (n: number, stem: string, o: string[], extra: Partial<ExtractedQuestion> = {}): ExtractedQuestion => ({ section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem, options: o.map((x, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: x })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "DOCX", ...extra });
    const ref = { questions: [{ section: "", number: 1, stem: "Which epithelium lines the urinary bladder?", options: ["Simple squamous", "Transitional", "Stratified squamous", "Columnar"], answer: ["B"], pages: [1] }, { section: "", number: 7, stem: "Which bone forms the point of the elbow?", options: ["Radius", "Humerus", "Olecranon of ulna", "Scapula"], answer: ["C"], pages: [1] }], key: [{ number: 3, section: "", raw: "D" }] };
    const c1 = compareWithReference(q(1, "Which epithelium lines the urinary bladder?", ["Simple squamous", "Transitional", "Stratified squamous", "Columnar"]), ["B"], ref);
    check("reference: same question, same answer → matched, no conflict", c1.matched === "Q1" && !c1.conflicts.length, c1);
    const c2 = compareWithReference(q(2, "Which bone forms the point of the elbow?", ["Radius", "Humerus", "Olecranon of ulna", "Scapula"]), ["A"], ref);
    check("reference: found by text under another number → numbering conflict + answer conflict", c2.matched === "Q7" && c2.conflicts.some((x) => /numbers this question Q7/.test(x)) && c2.conflicts.some((x) => /answer C/.test(x)), c2);
    const c3 = compareWithReference(q(3, "Unrelated question text here?", ["w", "x", "y", "z"]), [], ref);
    check("reference answer-key entry for a question without an answer → suggestion only (never applied)", c3.suggestedAnswer.join() === "D" && !c3.conflicts.length, c3);
    check("reference questions with no counterpart are listed (possible missing)", referenceOnly(ref, [q(1, "Which epithelium lines the urinary bladder?", ["a", "b", "c", "d"])]).join() === "Q7");
    const base = q(1, "Stem", ["a", "b", "c", "d"]);
    const fpA = contentFingerprint({ e: base, finalAnswer: ["B"], subjectId: "s", topicId: "t", subTopicId: null, figures: [] });
    check("fingerprint: same content → same; an option, the answer or the topic changed → different", fpA === contentFingerprint({ e: { ...base, notes: ["x"], confidence: 0.1 }, finalAnswer: ["B"], subjectId: "s", topicId: "t", subTopicId: null, figures: [] }) && fpA !== contentFingerprint({ e: q(1, "Stem", ["a", "b", "c", "e"]), finalAnswer: ["B"], subjectId: "s", topicId: "t", subTopicId: null, figures: [] }) && fpA !== contentFingerprint({ e: base, finalAnswer: ["C"], subjectId: "s", topicId: "t", subTopicId: null, figures: [] }) && fpA !== contentFingerprint({ e: base, finalAnswer: ["B"], subjectId: "s", topicId: "u", subTopicId: null, figures: [] }));
    check("verification state: a result with another fingerprint is stale", verifyState({ paperVerify: { v1: { fingerprint: "old", passed: true, problems: [], fixes: [], at: "" } } }, fpA).v1 === "stale" && verifyState({ paperVerify: { v1: { fingerprint: fpA, passed: true, problems: [], fixes: [], at: "" } } }, fpA).v1 === "passed");

    // ------------------------------------------------------------------ setup
    await buildFixtures();
    mockProc = spawn(process.execPath, ["scripts/mock-openrouter-vision.mjs", "3533", path.join(FX, "uni-mock.json")], { stdio: "ignore" });
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
      aiEnabled: false,
      privacy: { dataCollection: "deny", zdr: false },
      selection: { mode: "manual" },
      importerModels,
      verification: { ...savedSettings.verification, independentAnswer: false },
      budget: { ...savedSettings.budget, maxRequestInr: 1, keyReserveUsd: 5, retryTransient: false, allowPricierFallback: false },
      limits: { ...savedSettings.limits, concurrency: 1 },
      models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null },
    };
    await saveImporterSettings(settings, actor);
    await refreshRoutes(importerModels);

    // ------------------------------------------------------------------ B
    section("B. DOCX: answers after options, reference paper, Verify 1, Verify 2, eligible publishing");
    const jB = await createJob({ actorId: actor, title: `Universal DOCX ${TAG}`, examId: exam.id, paperType: AiImportPaperType.SINGLE_SUBJECT, subjectId: anatomy.id, year: 2024, paperCode: null, previousYearPaperId: null, expectedQuestions: 6 });
    jobs.push(jB);
    const paperB = await upload(actor, jB, "uni-paper.docx");
    await upload(actor, jB, "uni-key.csv", AiImportFileRole.ANSWER_KEY, paperB);
    const jobB = await runJob(actor, jB);
    let qs = await questionsOf(jB);
    check("DOCX processed locally (Paid AI off) and waiting for review", jobB.status === "NEEDS_REVIEW" && (await mockStats()).chat === 0, [jobB.status, jobB.errorMessage]);
    check("five questions read: Q1, Q2, Q3, Q4, Q6 (Q5 is not in the paper)", qs.map((x) => x.sourceLabel).join() === "1,2,3,4,6", qs.map((x) => x.sourceLabel));
    const d = (l: string) => data(byLabel(qs, l))!;
    check("Q1: answer printed after the options → B; explanation kept; no option contains the answer", d("1").printedAnswer.join() === "B" && d("1").hints?.explanation === "Transitional epithelium stretches as the bladder fills." && d("1").options.every((o) => !/Ans|Explanation/.test(o.text)), d("1"));
    check("Q2: “Correct answer is (c)” run into option D → C, option D is “Scapula”", d("2").printedAnswer.join() === "C" && d("2").options[3].text === "Scapula", d("2").options);
    check("Q3: multiple-correct, answer A,B,D after the options", d("3").type === "MULTIPLE_CORRECT" && d("3").printedAnswer.join() === "A,B,D", [d("3").type, d("3").printedAnswer]);
    check("Q4: superscript kept as a formula ($^{-3}$), answer A", /\^\{-3\}/.test(d("4").stem) && d("4").contentFormat === "RICH_V1" && d("4").printedAnswer.join() === "A", d("4").stem);
    check("Q6: answer written as text “Axillary nerve” → B", d("6").printedAnswer.join() === "B");
    check("official key matched by number (Q3 A,B,D multiple-correct)", byLabel(qs, "1")!.answerStatus === "OFFICIAL_MATCHED" && byLabel(qs, "3")!.finalAnswer.join() === "A,B,D" && byLabel(qs, "3")!.answerStatus === "OFFICIAL_MATCHED", qs.map((x) => [x.sourceLabel, x.answerStatus, x.finalAnswer, x.issueCodes]));

    // Taxonomy: valid topics set in bulk; Q4 gets an id from ANOTHER subject (must never be kept); Q6 an AI topic.
    const headNeck = await topic("Head & Neck");
    const upperLimb = await topic("Upper Limb");
    const renal = await topic("Renal Physiology");
    for (const l of ["1", "2", "3", "4"]) await setTaxonomy(byLabel(qs, l)!.id, actor, anatomy.id, l === "1" ? await topic("Histology") : upperLimb, null);
    await prisma.aiImportQuestion.update({ where: { id: byLabel(qs, "4")!.id }, data: { topicId: renal, subTopicId: "cmnotasubtopicxxxxxxxxxx1", taxonomySource: "AI (mock)", taxonomyConfidence: 0.9 } });
    await prisma.aiImportQuestion.update({ where: { id: byLabel(qs, "6")!.id }, data: { topicId: headNeck, taxonomySource: "AI (mocktext/classifier)", taxonomyConfidence: 0.9 } });
    // A reader that left the answer inside option D (simulated on Q6's stored extraction).
    const q6row = byLabel(qs, "6")!;
    await prisma.aiImportQuestion.update({ where: { id: q6row.id }, data: { data: { ...d("6"), options: d("6").options.map((o) => (o.label === "D" ? { ...o, text: "Median nerve Ans: B" } : o)) } as never } });
    // Reference paper.
    const refB = await addReference({ jobId: jB, actorId: actor, name: "uni-reference.docx", bytes: readFileSync(path.join(FX, "uni-reference.docx")) });
    check("reference paper stored and read locally: 6 questions, original kept in the vault", refB.questions.length === 6 && !!refB.storageKey && (await listReferences(jB)).length === 1 && (await mockStats()).chat === 0, [refB.questions.length, refB.note]);

    const v1 = await runVerify1(jB, actor);
    qs = await questionsOf(jB);
    check("Verify 1 ran over the whole paper without AI (no request sent)", v1.questions === 5 && (await mockStats()).chat === 0, v1);
    check("Verify 1 reports the missing Q5 and that the reference has a Q5 the source lacks", v1.missing.includes("Q5") && v1.referenceOnly.some((x) => x.startsWith("Q5")), v1);
    const q6 = byLabel(qs, "6")!;
    const versions6 = await prisma.aiImportQuestionVersion.findMany({ where: { questionId: q6.id } });
    check("Q6: answer moved out of option D (source evidence: the document's own text), previous version kept", d("6").options[3].text === "Median nerve" && vs(q6)?.pv?.v1?.fixes.some((f) => f.field === "option D" && /document/.test(f.evidence)) === true && versions6.some((v) => v.kind === "EXTRACTION" && /Verify 1/.test(v.note ?? "")) && v1.corrected === 1, [d("6").options[3], vs(q6)?.pv?.v1?.fixes, versions6.map((v) => v.note)]);
    const q4 = byLabel(qs, "4")!;
    check("Q4: topic from another subject and an unknown subtopic are cleared, never saved (reported)", q4.topicId === null && q4.subTopicId === null && q4.issueCodes.includes("TOPIC_UNCERTAIN") && (await events(jB, "TAXONOMY_CLEARED")).some((e) => /topic belongs to another subject/.test(e.message) && /subtopic is not part of this exam/.test(e.message)), [q4.topicId, q4.subTopicId, q4.issueCodes]);
    const q2 = byLabel(qs, "2")!;
    const q3 = byLabel(qs, "3")!;
    check("Q2: reference wording differs → REFERENCE_CONFLICT (question text not changed)", q2.issueCodes.includes("REFERENCE_CONFLICT") && /question text differs/.test((q2.issues as Record<string, string>).REFERENCE_CONFLICT ?? "") && d("2").stem === "Which bone forms the point of the elbow?", [q2.issueCodes, q2.issues]);
    check("Q3: reference answer A,B vs official A,B,D → REFERENCE_CONFLICT, official answer kept", q3.issueCodes.includes("REFERENCE_CONFLICT") && /answer A, B/.test((q3.issues as Record<string, string>).REFERENCE_CONFLICT ?? "") && q3.finalAnswer.join() === "A,B,D", [q3.issues, q3.finalAnswer]);
    const q1 = byLabel(qs, "1")!;
    check("Q1: Verify 1 passed (official key, valid topic, no flag); Q2/Q3/Q4 have findings", vs(q1)?.v1 === "passed" && ["2", "3", "4"].every((l) => vs(byLabel(qs, l))?.v1 === "problems"), qs.map((x) => [x.sourceLabel, vs(x)?.v1, x.issueCodes]));
    // Bulk correction of Q4's topic → its Verify 1 result is out of date until it runs again.
    await setTaxonomy(q4.id, actor, anatomy.id, upperLimb, null);
    qs = await questionsOf(jB);
    check("after correcting Q4's topic its Verify 1 result is out of date (never trusted silently)", vs(byLabel(qs, "4"))?.v1 === "stale");
    await runVerify1(jB, actor);
    qs = await questionsOf(jB);
    check("Verify 1 again: Q4 passes", vs(byLabel(qs, "4"))?.v1 === "passed", byLabel(qs, "4")!.issueCodes);
    const sum0 = await paperSummary(jB);
    // Q6 (stored Head & Neck, text about the upper limb) is caught by Verify 1's free subject / topic check since 2026-10-23.
    check("nothing is eligible to publish before Verify 2", sum0!.eligible.length === 0 && sum0!.v1.passed >= 2, sum0);
    check("Verify 1's subject / topic check flags Q6's topic (Head & Neck vs Upper Limb), without any AI call", vs(byLabel(qs, "6"))?.pv?.v1?.classification?.status === "DISAGREEMENT" && byLabel(qs, "6")!.issueCodes.includes("TAXONOMY_DISAGREES"), [vs(byLabel(qs, "6"))?.pv?.v1?.classification, byLabel(qs, "6")!.issueCodes]);

    // Verify 2 — paid AI on now; the price is shown and confirmed first.
    await saveImporterSettings({ ...settings, aiEnabled: true }, actor);
    const before = await mockStats();
    const pv = await verify2Preview(jB, null);
    check("Verify 2 preview: a suitable model chosen automatically, cost estimate + maximum shown, nothing sent", !!pv.model && pv.estimateInr !== null && pv.maxInr !== null && pv.maxInr >= pv.estimateInr && pv.textParts === 1 && pv.pages === 0 && (await mockStats()).chat === before.chat, pv);
    check("…models that extracted the job are excluded from the choice", pv.candidates.filter((c) => c.eligible).every((c) => !pv.usedModels.includes(c.id)), [pv.usedModels, pv.candidates.map((c) => [c.id, c.eligible])]);
    const r0 = await requestVerify2({ jobId: jB, actorId: actor, model: "mockvision/checker", confirmedMaxInr: null });
    const r1 = !r0.started ? await requestVerify2({ jobId: jB, actorId: actor, model: "mockvision/checker", confirmedMaxInr: r0.preview.maxInr! - 0.01 }) : r0;
    check("without a confirmation, or with a maximum below the current price → not started, the price is shown again", !r0.started && !r1.started && /price changed/i.test(!r1.started ? r1.reason : "") && (await mockStats()).chat === before.chat, [r0, r1]);
    const r2 = await requestVerify2({ jobId: jB, actorId: actor, model: "mockvision/checker", confirmedMaxInr: !r0.started ? r0.preview.maxInr : null });
    check("confirmed at the shown maximum → queued; the job's confirmed maximum covers it", r2.started && (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } })).budgetInr >= (r2.started ? r2.maxInr : 0), r2);
    await runWorker(300_000);
    const jobB2 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } });
    qs = await questionsOf(jB);
    const stats2 = await mockStats();
    const v2state = (jobB2.config as { verify2?: { status: string; model: string; maxInr: number } }).verify2;
    check("Verify 2 finished: job back in review, state DONE", ["NEEDS_REVIEW", "COMPLETED_WITH_ISSUES", "COMPLETED"].includes(jobB2.status) && v2state?.status === "DONE", [jobB2.status, v2state]);
    check("Verify 2 sent only to the confirmed model (1 document read + 1 classification), actual spend within the maximum", (stats2.byModel["mockvision/checker"] ?? 0) - (before.byModel["mockvision/checker"] ?? 0) === 2 && !stats2.byModel["mockvision/reader"] && jobB2.spentInr > 0 && jobB2.spentInr <= jobB2.budgetInr + 1e-9, [stats2.byModel, jobB2.spentInr, jobB2.budgetInr]);
    const v = (l: string) => vs(byLabel(qs, l))!;
    check("Q1 verified by the independent model (model recorded)", v("1").v2 === "verified" && v("1").pv?.v2?.model === "mockvision/checker", v("1").pv?.v2);
    check("Q2: wording differs between the reads, but the source text holds the stored wording → verified, reason recorded", v("2").v2 === "verified" && /source text/.test(v("2").pv?.v2?.resolvedBySource ?? ""), v("2").pv?.v2);
    check("Q4: exponent differs in the second read; the document text confirms 10^{-3} → verified (formula unchanged)", v("4").v2 === "verified" && !!v("4").pv?.v2?.resolvedBySource && /\^\{-3\}/.test(d("4").stem), v("4").pv?.v2);
    check("Q3: printed answer A,B vs A,B,D cannot be settled by the source → VERIFY2_DISAGREES (blocked)", v("3").v2 === "disagree" && byLabel(qs, "3")!.issueCodes.includes("VERIFY2_DISAGREES") && /printed answer/.test(v("3").pv?.v2?.detail ?? ""), [v("3").pv?.v2, byLabel(qs, "3")!.issueCodes]);
    // The subject / topic check is kept apart from the text read (a correct reading is not failed by a taxonomy finding).
    check("Q6: independent classification says Upper Limb, stored Head & Neck → topic DISAGREEMENT flagged (text read still verified, agrees with Verify 1)", v("6").v2 === "verified" && v("6").pv?.v2?.classification?.status === "DISAGREEMENT" && /topic Head & Neck vs Upper Limb/.test(v("6").pv?.v2?.classification?.findings[0] ?? "") && v("6").pv?.v2?.classification?.comparedWithV1 === "AGREES" && byLabel(qs, "6")!.issueCodes.includes("TAXONOMY_DISAGREES"), [v("6").pv?.v2, byLabel(qs, "6")!.issueCodes]);
    check("the question found only by the second read (Q5) is reported, never added", (await events(jB, "VERIFY_EXTRA")).some((e) => /Q5/.test(e.message)) && !byLabel(qs, "5"));
    const doneEv = (await events(jB, "VERIFY2_DONE"))[0];
    check("VERIFY2_DONE logs model, counts and actual vs estimated / maximum cost", !!doneEv && /mockvision\/checker/.test(doneEv.message) && /Actual cost ₹/.test(doneEv.message) && /maximum ₹/.test(doneEv.message), doneEv?.message);
    const sum1 = await paperSummary(jB);
    const eligibleLabels = qs.filter((x) => sum1!.eligible.includes(x.id)).map((x) => x.sourceLabel).sort();
    check("eligible to publish without individual review: exactly Q1 and Q4 (both verifications, every check clean)", eligibleLabels.join() === "1,4", [eligibleLabels, qs.map((x) => [x.sourceLabel, vs(x)?.v1, vs(x)?.v2, x.status, x.issueCodes])]);
    check("paper summary: totals, verified, unresolved disagreements, cost estimate vs actual", sum1!.total === 5 && sum1!.verified === 2 && sum1!.unresolved >= 2 && sum1!.classificationIssues >= 1 && sum1!.missing.includes("Q5") && sum1!.cost.verify2?.actualInr === Math.round(jobB2.spentInr * 100) / 100, sum1);
    // Approval safeguards: Q3 (disagreement) is never approved by the eligible action.
    const pub = await importAndPublishEligible(jB, actor);
    check("Import & Publish Eligible: approves and sends only Q1 and Q4", pub.requested === 2 && pub.approved === 2, pub);
    await runWorker(300_000);
    qs = await questionsOf(jB);
    for (const x of qs) if (x.questionId) stored.push(x.questionId);
    check("Q1 and Q4 published; Q2, Q3, Q6 not approved and not stored", ["1", "4"].every((l) => byLabel(qs, l)!.status === "PUBLISHED") && ["2", "3", "6"].every((l) => !byLabel(qs, l)!.questionId && !byLabel(qs, l)!.approvedById), qs.map((x) => [x.sourceLabel, x.status, !!x.approvedById]));
    // An administrator checks Q6's disagreement and approves it → Import Approved Questions as Draft.
    const ap = await approveQuestions([byLabel(qs, "6")!.id], actor);
    check("an administrator may approve a disagreement after checking it (recorded)", ap.approved === 1, ap);
    await requestImport(jB, actor, "DRAFT", null);
    await runWorker(300_000);
    qs = await questionsOf(jB);
    for (const x of qs) if (x.questionId && !stored.includes(x.questionId)) stored.push(x.questionId);
    check("Import Approved as Draft: Q6 stored as Draft; Q2 / Q3 still blocked", byLabel(qs, "6")!.status === "IMPORTED" && !byLabel(qs, "2")!.questionId && !byLabel(qs, "3")!.questionId, qs.map((x) => [x.sourceLabel, x.status]));
    const created = await prisma.question.findMany({ where: { id: { in: stored } }, select: { status: true, explanation: true, id: true } });
    check("stored questions: 2 published + 1 draft; Q1 keeps the printed explanation", created.length === 3 && created.filter((x) => x.status === "PUBLISHED").length === 2 && created.some((x) => /Transitional epithelium stretches/.test(x.explanation ?? "")), created);
    await unlinkReference(jB, refB.refId, actor);
    check("unlinking the reference keeps its file and history", (await listReferences(jB)).length === 0 && (await events(jB, "REFERENCE_ADDED")).length === 1);

    // ------------------------------------------------------------------ C
    section("C. Scanned PDF: cross-page question, figures, number read twice, crop check, Verify 2 with fallback");
    await saveImporterSettings({ ...settings, aiEnabled: true }, actor);
    const jC = await createJob({ actorId: actor, title: `Universal scan ${TAG}`, examId: exam.id, paperType: AiImportPaperType.SINGLE_SUBJECT, subjectId: anatomy.id, year: 2024, paperCode: null, previousYearPaperId: null, expectedQuestions: 4 });
    jobs.push(jC);
    await upload(actor, jC, "uni-scan.pdf");
    const jobC = await runJob(actor, jC);
    let qc = await questionsOf(jC);
    check("scan processed by the page reader", jobC.status === "NEEDS_REVIEW" && qc.length === 4, [jobC.status, jobC.pauseReason, qc.map((x) => x.sourceLabel)]);
    const c2q = byLabel(qc, "2")!;
    check("Q2 spans pages 1–2: joined into one question with four options", c2q.pages.join() === "1,2" && data(c2q)!.options.length === 4, [c2q.pages, data(c2q)?.options]);
    const c1q = byLabel(qc, "1")!;
    check("Q1: two figures cropped from the scan with their page and box", c1q.figures.length === 2 && c1q.figures.every((f) => f.source === "CROP" && f.pageNumber === 1 && !!f.box));
    // Damage one crop's recorded size (aspect ratio no longer matches its box) → Verify 1 must not trust it.
    const bad = c1q.figures[0];
    await prisma.aiImportFigure.update({ where: { id: bad.id }, data: { width: bad.width * 3 } });
    const v1c = await runVerify1(jC, actor);
    qc = await questionsOf(jC);
    const badAfter = byLabel(qc, "1")!.figures.find((f) => f.id === bad.id)!;
    check("Verify 1: a crop that does not keep its box's aspect ratio → UNCERTAIN with the reason, question blocked", badAfter.mappingStatus === "UNCERTAIN" && /aspect ratio/.test((badAfter.box as { reason?: string }).reason ?? "") && byLabel(qc, "1")!.issueCodes.includes("IMAGE_MAPPING_UNCERTAIN"), [badAfter.mappingStatus, badAfter.box]);
    check("Verify 1: number read twice and missing Q4 reported", v1c.duplicateNumbers.some((x) => /Q3/.test(x)) && v1c.missing.includes("Q4"), v1c);
    // Verify 2 with the checker model; its answer for page 1 is unusable → one recorded fallback to a cheaper suitable
    // model (targeted at page 1: pages are read in parallel since importer-reliability-2, so "first" is not page 1).
    await mockConfig({ scriptMarker: { "mockvision/checker": { "1": ["malformed"] } } });
    const pc = await verify2Preview(jC, "mockvision/checker");
    check("Verify 2 preview (scan): 2 page images, priced", pc.pages === 2 && pc.maxInr !== null && pc.model === "mockvision/checker", pc);
    const rc = await requestVerify2({ jobId: jC, actorId: actor, model: "mockvision/checker", confirmedMaxInr: pc.maxInr });
    check("…confirmed and queued", rc.started, rc);
    await runWorker(300_000);
    qc = await questionsOf(jC);
    const sw = await events(jC, "MODEL_SWITCHED");
    check("unusable answer → ONE recorded fallback to mockvision/mid (cheaper), with the reason", sw.length === 1 && /mockvision\/mid/.test(sw[0].message) && /Verify 2/.test(sw[0].message), sw.map((e) => e.message));
    const w = (l: string) => vs(byLabel(qc, l))!;
    check("page 1 verified by the fallback model (recorded per question), incl. the question spanning pages", w("1").pv?.v2?.model === "mockvision/mid" && w("2").v2 === "verified", [w("1").pv?.v2, w("2").pv?.v2]);
    check("page 2: the independent read differs on Q3 option C; a scan cannot settle it → disagreement, blocked", w("3").v2 === "disagree" && /option C/.test(w("3").pv?.v2?.detail ?? "") && byLabel(qc, "3")!.issueCodes.includes("VERIFY2_DISAGREES"), w("3").pv?.v2);
    const sumC = await paperSummary(jC);
    check("summary (scan): duplicates, missing, figure issues and unresolved disagreements counted; nothing eligible with open flags", sumC!.duplicates.some((x) => /Q3/.test(x)) && sumC!.missing.includes("Q4") && sumC!.figureIssues >= 1 && sumC!.unresolved >= 1 && !sumC!.eligible.includes(byLabel(qc, "1")!.id), sumC);

    // ------------------------------------------------------------------ D
    section("D. Paid AI off: Verify 2 refused, nothing sent");
    await saveImporterSettings({ ...settings, aiEnabled: false }, actor);
    const s0 = await mockStats();
    const pd = await verify2Preview(jC, null);
    let refused = "";
    try {
      await requestVerify2({ jobId: jC, actorId: actor, model: "mockvision/mid", confirmedMaxInr: 100 });
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    check("preview says Paid AI is off; start is refused; no AI request", !pd.aiEnabled && pd.problems.some((x) => /switched off/.test(x)) && /switched off/.test(refused) && (await mockStats()).chat === s0.chat, [pd.problems, refused]);

    check("the Question Bank only gained the 3 questions this suite stored (removed again below)", (await prisma.question.count()) === questionsBefore + 3);
  } catch (e) {
    fail++;
    console.error(e);
  } finally {
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    await setOpenRouterEnabled(routerWasEnabled).catch(() => undefined);
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
