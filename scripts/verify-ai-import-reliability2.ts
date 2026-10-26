/**
 * AI Question Importer — importer-reliability-2 (2026-10-26 audit of the CMS Paper II job: 40 of 120 "Verified").
 *
 *   A. Pure: "✓ / ✔ / ☑ / √ / ■" answer lines, "■ SECTION:" headings (never an explanation), statement-code questions,
 *      printed-tick annotations, heading → subject resolution (names, aliases, one unique subject), separate content /
 *      answer / taxonomy / figure fingerprints, verification states of old and new results, reference rules (cover
 *      pages, text-first matching, no answers from a booklet), "not compared after a new reading", reasoning budget,
 *      model families, output schemas.
 *   B. A synthetic 30-question DOCX in the production layout (three "■ SECTION:" headings, "✓ Correct Answer: (b) …"
 *      lines) on the scratch DB:
 *      B1 import: no tick in any option, sections → subjects (one by name, one by an administrator-confirmed alias that
 *         is validated first), no heading stored as an explanation; versioned, audited memory.
 *      B2 Verify 1 on questions made to look like the OLD reading: printed ticks removed with source evidence (history
 *         kept, approved / edited questions untouched), headings restored, older Verify 2 results rebuilt only when
 *         provably unchanged (incl. an edit that removed only a tick), others stay out of date, statement-code type and
 *         printed-tick disagreements re-assessed.
 *      B3 a subject / topic change keeps the content verification; a content edit makes it out of date.
 *      B4 re-classification keeps administrator, approved, agreed and printed-section decisions.
 *      B5 list actions: Approve from a row refuses unresolved conflicts; Publish only when eligible (server re-check),
 *         then imported and published.
 *      B6 "Confirm text-only, no image needed": clears the pointer flag for this content only; refused with a failed image.
 *      B7 reference reading: cover page dropped, booklet "answers" ignored, matched by wording, "not compared" until
 *         Verify 1 runs again.
 *      B8 Verify 2 on the mock: parts read 3 at a time, JSON Schema sent to a structured-output route, statement-code
 *         type agreed, exhausted / thinking models ranked last, model families, no paid call outside the mock.
 *
 * Scratch DB + scratch storage + its OWN loopback OpenRouter mock (port 3536) — no real AI request is possible (network
 * guard). Removes its jobs, the questions it stored and its taxonomy memory; restores Import Settings.
 *
 *   NODE_OPTIONS=--conditions=react-server OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3536 FX_TEST_BASE_URL=http://127.0.0.1:3536 \
 *     npx tsx scripts/verify-ai-import-reliability2.ts <empty fixtures dir>
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AiImportFileRole, AiImportPaperType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { blockToQuestion, explanationIsHeading, isSectionHeading, headingName, splitQuestions, statementCodeQuestion, stripAnnotationTail, takePrintedAnswer } from "@/lib/ai-import/local-parse";
import { headingKey, resolveHeadingSubject } from "@/lib/ai-import/section-subject";
import { contentFingerprint, fingerprintParts, fingerprintsOf, verifyState } from "@/lib/ai-import/verify-core";
import { eligibleForPublish, fingerprintOf, paperSummary, publishEligibleQuestion, requestVerify2, runVerify1, verify2Preview } from "@/lib/ai-import/paper-verify";
import { approveQuestions, confirmTextOnly, editQuestion, reclassifyQuestions, revalidateQuestions, setTaxonomy } from "@/lib/ai-import/review";
import { compareWithReference, isInstructionText, listReferences, type ReferencePaper } from "@/lib/ai-import/reference";
import { referenceStatus } from "@/lib/ai-import/reference-status";
import { TAXONOMY_MEMORY_PREFIX, addFormatRule, addHeadingAlias, loadExamMemory, removeMemoryEntry } from "@/lib/ai-import/taxonomy-memory";
import { textOnlyConfirmed } from "@/lib/ai-import/post";
import { exhaustedModels, modelFamily, preferReliable, reasoningBudget } from "@/lib/ai-import/ai";
import { OUTPUT_SCHEMAS } from "@/lib/ai-import/output-schemas";
import { refreshRoutes } from "@/lib/ai-import/routes";
import { buildZip } from "@/lib/rich-import/zip-writer";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { ExtractedQuestion, PaperVerification } from "@/lib/ai-import/types";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const MOCK = process.env.OPENROUTER_TEST_BASE_URL ?? "";
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !/^http:\/\/127\.0\.0\.1:3536$/.test(MOCK)) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR (scratch) and OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3536 (this suite's own mock).");
  process.exit(2);
}
const FX = process.argv[2];
if (!FX) {
  console.error("usage: verify-ai-import-reliability2.ts <fixtures dir>");
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
async function errorOf(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// ---- Fixture: the 2026-10-26 production layout -----------------------------------------------------------

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const BR = `<w:br w:type="textWrapping"/>`;
const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t.split("\n").map(esc).join(`</w:t>${BR}<w:t xml:space="preserve">`)}</w:t></w:r></w:p>`;
function docx(paragraphs: string[]): Buffer {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}</w:body></w:document>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(ct) },
    { name: "word/document.xml", data: Buffer.from(documentXml) },
  ]);
}

const RUN = Date.now().toString(36);
const SECTIONS = ["■ SECTION: ANATOMY", "■ SECTION: PHYSIOLOGY & BODY FUNCTION", "■ SECTION: BIOCHEMISTRY"];
const TOPICS = [
  ["upper limb", "lower limb", "head and neck", "neuroanatomy", "histology"],
  ["cardiovascular system", "renal physiology", "respiratory system", "special senses", "cardiovascular system"],
  ["enzymes", "nutrition", "enzymes", "nutrition", "enzymes"],
];
const CODE_OPTS = ["I, II and III", "I, II and IV", "I, III and IV", "II, III and IV"];
interface SrcQ {
  n: number;
  stem: string;
  options: string[];
  answer: number;
  mark: string;
}
const MARKS = ["✓ Correct Answer:", "✔ Correct Answer:", "☑ Answer:", "√ Ans:", "■ Correct Answer:"];
const SRC: SrcQ[] = Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  const sec = Math.floor(i / 10);
  const topic = TOPICS[sec][i % 5];
  const code = n === 2 || n === 12;
  const stem = code
    ? `Which of the following statements about the ${topic} are correct? (set ${RUN} q${n})\nI. Statement one of the ${topic}\nII. Statement two of the ${topic}\nIII. Statement three of the ${topic}\nIV. Statement four of the ${topic}\nSelect the answer using the code given below:`
    : n === 6
      ? `Identify the structure of the lower limb in the X-ray shown below. (set ${RUN} q${n})`
      : `Question ${n} about the ${topic}: which item is characteristic of the ${topic}? (set ${RUN} q${n})`;
  const options = code ? CODE_OPTS : [`Alpha ${topic} ${n}`, `Beta ${topic} ${n}`, `Gamma ${topic} ${n}`, `Delta ${topic} ${n}`];
  return { n, stem, options, answer: n % 4, mark: MARKS[n % MARKS.length] };
});
const L = "abcd";
function paperParagraphs(): string[] {
  const out = [p("COMBINED SYNTHETIC EXAMINATION - 2025"), p("PAPER-II (SERIES A) — QUESTIONS WITH OFFICIAL ANSWERS")];
  for (const q of SRC) {
    if ((q.n - 1) % 10 === 0) out.push(p(SECTIONS[(q.n - 1) / 10]));
    out.push(p(`Q${q.n}. ${q.stem}`));
    q.options.forEach((o, i) => out.push(p(`(${L[i]}) ${o}`)));
    out.push(p(`${q.mark} (${L[q.answer]}) ${q.options[q.answer]}`));
  }
  return out;
}
const read = (q: SrcQ) => ({ number: q.n, type: q.n === 2 || q.n === 12 ? "MULTIPLE_CORRECT" : "SINGLE_CORRECT", stem: q.stem, options: q.options.map((t, i) => ({ label: `(${L[i]})`, text: t })), printed_answer: [`(${L[q.answer]})`], confidence: 0.95 });

// ---- Helpers ------------------------------------------------------------------------------------------------

const TAG = `r2-${RUN}`;
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
const mockStats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()) as { chat: number; byModel: Record<string, number>; responseFormat: (string | null)[]; maxInflight: number; reasoning: unknown[] };
const mockConfig = (c: Record<string, unknown>) => fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) });
const questionsOf = (jobId: string) => prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: { orderIndex: "asc" } });
type QRow = Awaited<ReturnType<typeof questionsOf>>[number];
const byN = (qs: QRow[], n: number) => qs.find((q) => q.sourceLabel === String(n))!;
const eff = (q: QRow) => (q.editedData ?? q.data) as unknown as ExtractedQuestion;
const dataOf = (q: QRow) => q.data as unknown as ExtractedQuestion;
const vsOf = (q: QRow) => verifyState(q.data, fingerprintOf(q));
const events = (jobId: string, type: string) => prisma.aiImportEvent.findMany({ where: { jobId, type }, orderBy: { createdAt: "asc" } });
async function setData(id: string, d: ExtractedQuestion, extra: Prisma.AiImportQuestionUpdateInput = {}) {
  await prisma.aiImportQuestion.update({ where: { id }, data: { data: d as unknown as Prisma.InputJsonValue, ...extra } });
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const tax = await getExamTaxonomy(prisma, exam.id);
  const subj = (name: string) => tax.find((s) => s.name === name)!;
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  const memoryKey = `${TAXONOMY_MEMORY_PREFIX}${exam.id}`;
  const memoryBefore = await prisma.setting.findUnique({ where: { key: memoryKey } });
  await prisma.setting.deleteMany({ where: { key: memoryKey } });
  const stored: string[] = [];
  let mockProc: ChildProcess | null = null;

  try {
    // ------------------------------------------------------------------ A
    section("A. Pure checks (no DB, no AI)");
    writeFileSync(path.join(FX, "r2-paper.docx"), docx(paperParagraphs()));
    writeFileSync(path.join(FX, "r2-key.csv"), `Q,Answer\n${SRC.map((q) => `${q.n},${L[q.answer].toUpperCase()}`).join("\n")}\n`);
    writeFileSync(path.join(FX, "r2-mock.json"), JSON.stringify({ pages: {}, keys: {}, text: [{ match: `(set ${RUN}`, questions: SRC.map(read) }] }));
    for (const mark of ["✓", "✔", "☑", "√", "■"]) {
      const t = takePrintedAnswer(`Q\n(a) p\n(b) q\n(c) r\n(d) Takayasu disease\n${mark} Correct Answer: (b) q`);
      check(`“${mark} Correct Answer: (b) q” is the answer line — B, and no “${mark}” left in option D`, t.answer.join() === "B" && !/[✓✔☑√■]/.test(t.text) && t.text.endsWith("(d) Takayasu disease"), t);
    }
    check("“■ SECTION: GYNAECOLOGY & OBSTETRICS” is a heading named “GYNAECOLOGY & OBSTETRICS”", isSectionHeading("■ SECTION: GYNAECOLOGY & OBSTETRICS") && headingName("■ SECTION: GYNAECOLOGY & OBSTETRICS") === "GYNAECOLOGY & OBSTETRICS");
    check("answer / key / list lines are never headings", !isSectionHeading("■ CORRECT ANSWER KEY") && !isSectionHeading("LIST I") && isSectionHeading("PHYSIOLOGY"));
    const tail = splitQuestions(["Q1. Stem one?", "(a) w", "(b) x", "(c) y", "(d) z", "✓ Correct Answer: (b) x", "■ SECTION: PREVENTIVE & SOCIAL MEDICINE", "Q2. Stem two?", "(a) w", "(b) x", "(c) y", "(d) z", "✓ Correct Answer: (a) w"].map((text) => ({ text }))).blocks;
    const t1 = blockToQuestion(tail[0], 1, "DOCX").q;
    const t2 = blockToQuestion(tail[1], 1, "DOCX").q;
    check("a heading after the answer line is never Q1's explanation; Q2 carries it as its section", tail.length === 2 && !t1.hints?.explanation && t2.hints?.subject === "PREVENTIVE & SOCIAL MEDICINE", [t1.hints, t2.hints]);
    check("explanationIsHeading: a heading line is not an explanation, text is", explanationIsHeading("■ SECTION: SURGERY") && !explanationIsHeading("The femur is the longest bone."));
    check("stripAnnotationTail removes only a lone trailing mark line", stripAnnotationTail("Takayasu disease\n✓") === "Takayasu disease" && stripAnnotationTail("A ✓ in the text") === "A ✓ in the text");
    const codeQ = { stem: "Which statements are correct?\nI. a\nII. b\nIII. c\nIV. d\nSelect the answer using the code given below:", options: CODE_OPTS.map((t, i) => ({ label: "ABCD"[i], printed: `(${L[i]})`, text: t })) };
    check("statement-code question recognised (options are statement combinations)", statementCodeQuestion(codeQ) && !statementCodeQuestion({ ...codeQ, options: codeQ.options.map((o, i) => ({ ...o, text: `Free text ${i}` })) }));
    const subjects = [
      { id: "s1", name: "General Surgery" },
      { id: "s2", name: "Obstetrics & Gynaecology" },
      { id: "s3", name: "Community Medicine / PSM" },
      { id: "s4", name: "General Medicine" },
    ];
    check("heading → subject: SURGERY = General Surgery (one subject holds the word)", resolveHeadingSubject("■ SECTION: SURGERY", subjects)?.subjectId === "s1");
    check("heading → subject: GYNAECOLOGY & OBSTETRICS = Obstetrics & Gynaecology (same words)", resolveHeadingSubject("GYNAECOLOGY & OBSTETRICS", subjects)?.via === "name");
    check("heading → subject: PREVENTIVE & SOCIAL MEDICINE unresolved without an alias (never guessed), resolved with one", resolveHeadingSubject("PREVENTIVE & SOCIAL MEDICINE", subjects) === null && resolveHeadingSubject("PREVENTIVE & SOCIAL MEDICINE", subjects, [{ heading: headingKey("PREVENTIVE & SOCIAL MEDICINE"), subjectId: "s3" }])?.via === "alias");
    check("heading → subject: MEDICINE is ambiguous (two subjects) → unresolved", resolveHeadingSubject("MEDICINE", subjects) === null);
    const base: ExtractedQuestion = { section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: "Stem", options: CODE_OPTS.map((t, i) => ({ label: "ABCD"[i], printed: L[i], text: t })), printedAnswer: ["B"], contentFormat: "PLAIN", confidence: 0.9, unreadable: [], figures: [], method: "DOCX" };
    const fpIn = { e: base, finalAnswer: ["B"], subjectId: "s1", topicId: "t1", subTopicId: null, figures: [] };
    const a1 = fingerprintParts(fpIn);
    const a2 = fingerprintParts({ ...fpIn, subjectId: "s2", topicId: null });
    const a3 = fingerprintParts({ ...fpIn, e: { ...base, options: base.options.map((o, i) => (i === 3 ? { ...o, text: `${o.text}\n✓` } : o)) } });
    check("fingerprints: a subject / topic change changes ONLY the taxonomy part", a1.content === a2.content && a1.answer === a2.answer && a1.figures === a2.figures && a1.taxonomy !== a2.taxonomy);
    check("fingerprints: a lone printed tick on option D is not content", a1.content === a3.content);
    check("fingerprints: a changed answer changes the answer part only", fingerprintParts({ ...fpIn, finalAnswer: ["C"] }).answer !== a1.answer && fingerprintParts({ ...fpIn, finalAnswer: ["C"] }).content === a1.content);
    const fpNow = fingerprintsOf({ ...fpIn, subjectId: "s2", topicId: null });
    const newResult = { paperVerify: { v2: { fingerprint: "x", parts: a1, status: "VERIFIED", model: "m", at: "", fields: [], detail: "" } } };
    check("state: a result with parts stays VERIFIED after a subject / topic change", verifyState(newResult, fpNow).v2 === "verified");
    check("state: a result with parts is out of date after a content change", verifyState(newResult, fingerprintsOf({ ...fpIn, e: { ...base, stem: "Other" } })).v2 === "stale");
    const legacyResult = { paperVerify: { v2: { fingerprint: contentFingerprint(fpIn), status: "VERIFIED", model: "m", at: "", fields: [], detail: "" } } };
    check("state: an OLD result (combined fingerprint only) is out of date after a subject change until rebuilt", verifyState(legacyResult, fpNow).v2 === "stale" && verifyState(legacyResult, fingerprintsOf(fpIn)).v2 === "verified");
    check("reference: cover / instruction text is not a question", isInstructionText("DO NOT OPEN THIS TEST BOOKLET UNTIL YOU ARE TOLD TO DO SO. Time Allowed: Two Hours. Maximum Marks: 250", ["T.B.C.", "Serial No. 1060945"]) && !isInstructionText("Vibration white finger refers to:", ["Buerger's disease"]));
    const ocrRef: Pick<ReferencePaper, "questions" | "key"> = { key: [], questions: [{ section: "", number: 7, stem: "Vibration white finger refers to:", options: ["Buerger's disease", "Raynaud's syndrome", "Acrocyanosis", "Takayasu disease"], answer: ["A"], pages: [2], confidence: 0.95 }] };
    const vq: ExtractedQuestion = { ...base, number: 1, stem: "Vibration white finger refers to:", options: ["Buerger's disease", "Raynaud's syndrome", "Acrocyanosis", "Takayasu disease\n✓"].map((t, i) => ({ label: "ABCD"[i], printed: L[i], text: t })) };
    const cmp = compareWithReference(vq, ["B"], ocrRef);
    check("reference: matched by wording although the OCR numbered it Q7; no order / answer / tick conflict; no suggested answer", cmp.matched === "Q7" && cmp.conflicts.length === 0 && cmp.suggestedAnswer.length === 0, cmp);
    const keyRef = compareWithReference(vq, ["B"], { questions: [], key: [{ number: 1, section: "", raw: "C" }] });
    check("reference: an ANSWER KEY entry is still compared (and reported when it differs)", keyRef.conflicts.some((c) => /answer key gives answer C/.test(c)), keyRef);
    check("reference status: read again after the last Verify 1 → not compared, with the reason", /read again/.test(referenceStatus({ questions: 3, key: 0, scannedPages: 2, readAfterVerify: true }, 0).reason ?? ""));
    check("reasoning budget: a quarter of the output limit, at most 2,000 tokens", reasoningBudget(8000) === 2000 && reasoningBudget(2500) === 625 && reasoningBudget(600) === 256);
    check("model families: gemma 4B / 12B are one family, deepseek another", modelFamily("google/gemma-3-4b-it") === modelFamily("google/gemma-3-12b-it") && modelFamily("google/gemma-4-26b-a4b-it") === "google/gemma" && modelFamily("deepseek/deepseek-v4-flash") !== modelFamily("google/gemma-3-4b-it"));
    check("output schemas: extraction and classification shapes", (OUTPUT_SCHEMAS.extract.required as string[]).includes("questions") && (OUTPUT_SCHEMAS.classify.required as string[]).includes("results"));

    // ------------------------------------------------------------------ setup
    mockProc = spawn(process.execPath, ["scripts/mock-openrouter-vision.mjs", "3536", path.join(FX, "r2-mock.json")], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${MOCK}/__mock/stats`).then((x) => x.ok).catch(() => false)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig({ structModels: true, reasonModels: true });
    await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
    await testOpenRouterConnection();
    await setOpenRouterEnabled(true);
    await syncCatalog();
    const importerModels = ["mockvision/reader", "mockstruct/reader", "mockvision/mid", "mockreason/think"];
    const settings: ImporterSettings = {
      ...savedSettings,
      aiEnabled: true,
      privacy: { dataCollection: "deny", zdr: false },
      selection: { mode: "manual" },
      importerModels,
      verification: { ...savedSettings.verification, independentAnswer: false, topicMinConfidence: 0.7 },
      limits: { ...savedSettings.limits, concurrency: 1 },
      models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null },
    };
    await saveImporterSettings(settings, actor);
    await refreshRoutes(importerModels);

    // ------------------------------------------------------------------ B1
    section("B1. Import of the production layout: ticks, sections, explanations, memory");
    const badAlias = await errorOf(() => addHeadingAlias(exam.id, actor, "ANATOMY", subj("Physiology").id));
    check("alias validation: a heading that already names another subject cannot be mapped elsewhere", !!badAlias && /already names Anatomy/.test(badAlias.message), badAlias?.message);
    const foreign = await errorOf(() => addHeadingAlias(exam.id, actor, "PHYSIOLOGY & BODY FUNCTION", "not-a-subject-of-this-exam"));
    check("alias validation: only the exam's own subjects", !!foreign && /subject of this exam/.test(foreign.message));
    const jB = await createJob({ actorId: actor, title: `Reliability 2 ${TAG}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2025, paperCode: null, previousYearPaperId: null, expectedQuestions: 30 });
    jobs.push(jB);
    const paperId = await upload(actor, jB, "r2-paper.docx");
    await upload(actor, jB, "r2-key.csv", AiImportFileRole.ANSWER_KEY, paperId);
    const jobB = await runJob(actor, jB);
    let qs = await questionsOf(jB);
    check("DOCX read locally: 30 questions, waiting for review, no AI request", jobB.status === "NEEDS_REVIEW" && qs.length === 30 && (await mockStats()).chat === 0, [jobB.status, jobB.errorMessage, qs.length]);
    check("no tick / mark left in any option or question text", qs.every((q) => !eff(q).options.some((o) => /[✓✔☑√■]/.test(o.text)) && !/[✓✔☑√■]/.test(eff(q).stem)), qs.filter((q) => eff(q).options.some((o) => /[✓✔☑√■]/.test(o.text))).map((q) => q.sourceLabel));
    check("every answer read from its marked answer line and matched with the key", qs.every((q) => q.finalAnswer.join() === "ABCD"[SRC[Number(q.sourceLabel) - 1].answer] && q.answerStatus === "OFFICIAL_MATCHED"), qs.map((q) => [q.sourceLabel, q.finalAnswer, q.answerStatus]));
    check("no section heading stored as an explanation (Q10, Q20)", qs.every((q) => !eff(q).hints?.explanation), qs.filter((q) => eff(q).hints?.explanation).map((q) => [q.sourceLabel, eff(q).hints?.explanation]));
    check("sections: Q1–10 Anatomy and Q21–30 Biochemistry from the printed headings", qs.filter((q) => Number(q.sourceLabel) <= 10).every((q) => q.subjectId === subj("Anatomy").id && q.taxonomySource !== "admin") && qs.filter((q) => Number(q.sourceLabel) > 20).every((q) => q.subjectId === subj("Biochemistry").id), qs.map((q) => [q.sourceLabel, q.subjectId, q.taxonomySource]));
    check("“PHYSIOLOGY & BODY FUNCTION” has no alias yet: not guessed by section (left to the classifier)", qs.filter((q) => Number(q.sourceLabel) > 10 && Number(q.sourceLabel) <= 20).every((q) => q.taxonomySource !== "printed section"), qs.filter((q) => Number(q.sourceLabel) > 10 && Number(q.sourceLabel) <= 20).map((q) => q.taxonomySource));
    await addHeadingAlias(exam.id, actor, "PHYSIOLOGY & BODY FUNCTION", subj("Physiology").id, "checked against the exam's subjects");
    await addFormatRule(exam.id, actor, "STATEMENT_CODE_SINGLE");
    const dup = await errorOf(() => addHeadingAlias(exam.id, actor, "Physiology & Body Function", subj("Physiology").id));
    check("an alias is stored once (same heading key)", !!dup && /already mapped/.test(dup.message));
    let mem = await loadExamMemory(exam.id);
    check("memory: alias + rule recorded with administrator, time and version; history and audit log kept", mem?.headingAliases?.length === 1 && mem.headingAliases[0].byId === actor && mem.formatRules?.[0]?.rule === "STATEMENT_CODE_SINGLE" && (mem.history ?? []).some((h) => h.action === "AI_IMPORT_TAXONOMY_HEADING_ALIAS_ADDED") && mem.version >= 2 && (await prisma.auditLog.count({ where: { entityId: exam.id, action: "AI_IMPORT_TAXONOMY_HEADING_ALIAS_ADDED" } })) >= 1, mem);

    // ------------------------------------------------------------------ B2
    section("B2. Verify 1 on questions in the OLD reading's shape: annotations, headings, older Verify 2 results");
    // Make questions look like the earlier reader's output and give them older (combined-fingerprint) Verify 2 results.
    const withTick = (d: ExtractedQuestion): ExtractedQuestion => ({ ...d, options: d.options.map((o, i) => (i === 3 ? { ...o, text: `${o.text}\n✓` } : o)) });
    const oldSubject = subj("Biochemistry").id;
    const legacyV2 = (q: QRow, d: ExtractedQuestion, status: "VERIFIED" | "DISAGREE", extra: Partial<NonNullable<PaperVerification["v2"]>> = {}, finalAnswer = q.finalAnswer) => ({
      fingerprint: contentFingerprint({ e: d, finalAnswer, subjectId: oldSubject, topicId: null, subTopicId: null, figures: q.figures }),
      at: new Date(Date.now() - 3600_000).toISOString(),
      model: "mockvision/mid",
      status,
      fields: [],
      detail: "older result",
      classification: { status: "AGREED" as const, stored: { subjectId: oldSubject, topicId: null, subTopicId: null }, found: { subjectId: oldSubject, topicId: null, subTopicId: null }, confidence: 0.9, method: "mockvision/mid", findings: [], comparedWithV1: "NO_V1" as const },
      ...extra,
    });
    for (const n of [1, 2, 3, 4, 5, 8, 9, 10]) {
      const q = byN(qs, n);
      const old = withTick(dataOf(q));
      const hints = n === 10 ? { explanation: "■ SECTION: PHYSIOLOGY & BODY FUNCTION" } : undefined;
      const d: ExtractedQuestion = { ...old, hints };
      const v2 =
        n === 2
          ? legacyV2(q, d, "DISAGREE", { fields: ["type"], detail: "type single_correct vs multiple_correct" })
          : n === 3
            ? legacyV2(q, d, "DISAGREE", { fields: ["option D"], detail: "option D differs", second: { options: eff(q).options.map((o) => o.text) } })
            : n === 4
              ? legacyV2(q, d, "VERIFIED", {}, ["A", "B"])
              : legacyV2(q, d, "VERIFIED");
      await setData(q.id, { ...d, paperVerify: { v2 } }, n === 5 ? { editedData: { ...dataOf(q), hints } as unknown as Prisma.InputJsonValue } : n === 8 ? { approvedById: actor, approvedAt: new Date(), reviewedById: actor, reviewedAt: new Date() } : {});
    }
    const v1 = await runVerify1(jB, actor);
    qs = await questionsOf(jB);
    check("older results: 7 rebuilt (Q1–3, Q5, Q8–10 — Q5 via an edit that only removed the tick), Q4 out of date (answer changed), 2 disagreements re-assessed", v1.verify2Upgrade?.rebuilt === 7 && v1.verify2Upgrade.viaEdit === 1 && v1.verify2Upgrade.stale === 1 && v1.verify2Upgrade.reassessed === 2, v1.verify2Upgrade);
    const q1 = byN(qs, 1);
    check("Q1: tick removed from option D with source evidence, previous version kept", !/✓/.test(dataOf(q1).options[3].text) && (await prisma.aiImportQuestionVersion.count({ where: { questionId: q1.id, kind: "EXTRACTION" } })) >= 1 && (vsOf(q1).pv?.v1?.fixes ?? []).some((f) => f.field === "option D" && /answer line/.test(f.evidence)), [dataOf(q1).options[3], vsOf(q1).pv?.v1?.fixes]);
    check("Q1: its Verify 2 result is still VERIFIED (only the subject and a printed tick differed)", vsOf(q1).v2 === "verified" && !!vsOf(q1).pv?.v2?.parts && /reproduced/.test(vsOf(q1).pv?.v2?.rebuilt?.proof ?? ""), vsOf(q1).pv?.v2);
    check("Q2: statement-code type disagreement re-assessed to VERIFIED (key gives one code option), rule recorded", vsOf(byN(qs, 2)).v2 === "verified" && /statement-code/.test(vsOf(byN(qs, 2)).pv?.v2?.reassessed?.rule ?? ""), vsOf(byN(qs, 2)).pv?.v2);
    check("Q3: option D differing only by the printed tick re-assessed to VERIFIED", vsOf(byN(qs, 3)).v2 === "verified" && /printed tick/.test(vsOf(byN(qs, 3)).pv?.v2?.reassessed?.rule ?? ""), vsOf(byN(qs, 3)).pv?.v2);
    check("Q4: answer changed since the read → stays out of date (Verify 2 must read it again)", vsOf(byN(qs, 4)).v2 === "stale", vsOf(byN(qs, 4)).pv?.v2);
    check("Q5: edited question (tick removed by hand) rebuilt from the original extraction; the edit is untouched", vsOf(byN(qs, 5)).v2 === "verified" && !!byN(qs, 5).editedData && /original extraction/.test(vsOf(byN(qs, 5)).pv?.v2?.rebuilt?.proof ?? ""), vsOf(byN(qs, 5)).pv?.v2);
    check("Q8 (approved): never changed automatically — tick kept, approval kept", /✓/.test(dataOf(byN(qs, 8)).options[3].text) && !!byN(qs, 8).approvedById, [dataOf(byN(qs, 8)).options[3], byN(qs, 8).approvedById]);
    check("Q10: heading removed from the explanation and restored as its section (with history)", !dataOf(byN(qs, 10)).hints?.explanation && dataOf(byN(qs, 10)).hints?.subject === "ANATOMY" && (vsOf(byN(qs, 10)).pv?.v1?.fixes ?? []).some((f) => f.field === "explanation"), [dataOf(byN(qs, 10)).hints, vsOf(byN(qs, 10)).pv?.v1?.fixes]);
    check("Q11–20: Physiology (the confirmed heading alias limits them to it)", qs.filter((q) => Number(q.sourceLabel) > 10 && Number(q.sourceLabel) <= 20).every((q) => q.subjectId === subj("Physiology").id), qs.filter((q) => Number(q.sourceLabel) > 10 && Number(q.sourceLabel) <= 20).map((q) => [q.sourceLabel, q.subjectId, q.taxonomySource]));
    const upgraded = await events(jB, "VERIFY2_RESULTS_UPGRADED");
    check("the upgrade is logged with its counts (no AI request)", upgraded.length === 1 && /7 kept/.test(upgraded[0].message) && (await mockStats()).chat === 0, upgraded.map((e) => e.message));

    // ------------------------------------------------------------------ B3
    section("B3. A subject / topic change keeps the content verification; a content edit does not");
    await setTaxonomy(q1.id, actor, subj("Anatomy").id, tax.find((s) => s.name === "Anatomy")!.topics[1].id);
    await revalidateQuestions(jB, [q1.id]);
    let q1b = (await questionsOf(jB)).find((q) => q.id === q1.id)!;
    check("after a topic change Q1's Verify 2 is still VERIFIED (only its taxonomy check is out of date)", vsOf(q1b).v2 === "verified", vsOf(q1b));
    const e1 = eff(q1b);
    await editQuestion(q1.id, actor, { stem: `${e1.stem} (edited)`, options: e1.options.map((o) => ({ label: o.label, text: o.text })), type: e1.type, contentFormat: e1.contentFormat });
    await revalidateQuestions(jB, [q1.id]);
    q1b = (await questionsOf(jB)).find((q) => q.id === q1.id)!;
    check("after a wording edit Q1's Verify 1 and Verify 2 are out of date", vsOf(q1b).v2 === "stale" && vsOf(q1b).v1 === "stale", vsOf(q1b));

    // ------------------------------------------------------------------ B4
    section("B4. Re-classification keeps settled decisions");
    qs = await questionsOf(jB);
    const qAgreed = byN(qs, 21);
    const pvA = dataOf(qAgreed).paperVerify ?? {};
    await setData(qAgreed.id, { ...dataOf(qAgreed), paperVerify: { ...pvA, v2: { ...(pvA.v2 ?? { fingerprint: "", at: "", model: "m", status: "VERIFIED", fields: [], detail: "" }), classification: { status: "AGREED", stored: { subjectId: qAgreed.subjectId, topicId: qAgreed.topicId, subTopicId: qAgreed.subTopicId }, found: null, confidence: 0.9, method: "m", findings: [], comparedWithV1: "NO_V1" } } } });
    if (!qAgreed.topicId) await prisma.aiImportQuestion.update({ where: { id: qAgreed.id }, data: { topicId: tax.find((s) => s.name === "Biochemistry")!.topics[0].id } });
    const qAdmin = byN(qs, 22);
    await setTaxonomy(qAdmin.id, actor, subj("Biochemistry").id, tax.find((s) => s.name === "Biochemistry")!.topics[1].id);
    const qApproved = byN(qs, 23);
    await prisma.aiImportQuestion.update({ where: { id: qApproved.id }, data: { approvedById: actor, approvedAt: new Date() } });
    const qSection = byN(qs, 24);
    // Q24: its subject / topic check did not agree (needs review) — the only question here a re-classification may touch.
    const pvS = dataOf(qSection).paperVerify ?? {};
    await setData(qSection.id, { ...dataOf(qSection), paperVerify: { ...pvS, v1: pvS.v1 ? { ...pvS.v1, classification: pvS.v1.classification ? { ...pvS.v1.classification, status: "NEEDS_REVIEW" } : null } : undefined, v2: pvS.v2 ? { ...pvS.v2, classification: null } : undefined } });
    const before = await prisma.aiImportQuestion.findMany({ where: { id: { in: [qAgreed.id, qAdmin.id, qApproved.id, qSection.id] } }, select: { id: true, subjectId: true, topicId: true, approvedById: true } });
    const queued = await reclassifyQuestions([qAgreed.id, qAdmin.id, qApproved.id, qSection.id], actor);
    const mid = await prisma.aiImportQuestion.findMany({ where: { id: { in: [qAgreed.id, qAdmin.id, qApproved.id, qSection.id] } }, select: { id: true, subjectId: true, topicId: true, approvedById: true } });
    const same = (id: string) => JSON.stringify(before.find((x) => x.id === id)) === JSON.stringify(mid.find((x) => x.id === id));
    check("only the printed-section question is queued; agreed / administrator / approved untouched", queued === 1 && same(qAgreed.id) && same(qAdmin.id) && same(qApproved.id), { queued, before, mid });
    check("the printed-section subject is kept while its topic is classified again", mid.find((x) => x.id === qSection.id)?.subjectId === subj("Biochemistry").id);
    await runWorker(120_000);
    const settled = await errorOf(() => reclassifyQuestions([qAgreed.id, qAdmin.id, qApproved.id], actor));
    check("re-classifying only settled questions is refused with the reason", !!settled && /settled/.test(settled.message), settled?.message);
    check("after the run the section question still has its printed-section subject", (await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: qSection.id } })).subjectId === subj("Biochemistry").id);

    // ------------------------------------------------------------------ B5
    section("B5. Approve / Publish from a list row");
    // An administrator files Q25 (Biochemistry section) under Anatomy: kept, flagged, never approved from the list.
    qs = await questionsOf(jB);
    await setTaxonomy(byN(qs, 25).id, actor, subj("Anatomy").id, tax.find((s) => s.name === "Anatomy")!.topics[0].id);
    await revalidateQuestions(jB, [byN(qs, 25).id]);
    qs = await questionsOf(jB);
    check("an administrator's subject that differs from the printed section is kept and flagged", byN(qs, 25).subjectId === subj("Anatomy").id && byN(qs, 25).issueCodes.includes("SECTION_SUBJECT_DIFFERS"), byN(qs, 25).issueCodes);
    const listRefused = await approveQuestions([byN(qs, 25).id], actor, { from: "list" });
    check("Approve from the row refuses it (decided on the question's page)", listRefused.approved === 0 && /subject differs from the printed section/i.test(listRefused.refused[0]?.reason ?? ""), listRefused);
    await setData(byN(qs, 26).id, { ...dataOf(byN(qs, 26)), paperVerify: { ...(dataOf(byN(qs, 26)).paperVerify ?? {}), v2: { fingerprint: "x", parts: fingerprintOf(byN(qs, 26)).parts, at: "", model: "m", status: "DISAGREE", fields: ["question text"], detail: "differs" } } });
    await runVerify1(jB, actor);
    qs = await questionsOf(jB);
    const disagreeRefused = await approveQuestions([byN(qs, 26).id], actor, { from: "list" });
    check("Approve from the row refuses a Verify 2 disagreement", disagreeRefused.approved === 0 && /verify 2/i.test(disagreeRefused.refused[0]?.reason ?? ""), [byN(qs, 26).issueCodes, disagreeRefused]);
    const notEligible = await errorOf(() => publishEligibleQuestion(byN(qs, 4).id, actor));
    check("Publish of a question that is not eligible is refused on the server with the reason", !!notEligible && /not eligible to publish: Verify 2/.test(notEligible.message), notEligible?.message);
    const eligibleNow = qs.filter((q) => eligibleForPublish(q, settings, false));
    const target = eligibleNow.find((q) => !q.approvedById) ?? eligibleNow[0];
    check("at least one rebuilt question is eligible now (Verify 1 passed + Verify 2 agreed, no open flag)", !!target, qs.map((q) => [q.sourceLabel, vsOf(q).v1, vsOf(q).v2, q.status, q.issueCodes.join("+")]));
    if (target) {
      const r = await publishEligibleQuestion(target.id, actor);
      await runWorker(120_000);
      const after = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: target.id } });
      if (after.questionId) stored.push(after.questionId);
      const bank = after.questionId ? await prisma.question.findUnique({ where: { id: after.questionId }, select: { status: true } }) : null;
      check("Publish from the row: approved by the action, imported and published", r.requested && !!after.approvedById && after.status === "PUBLISHED" && bank?.status === "PUBLISHED", [r, after.status, bank]);
    }

    // ------------------------------------------------------------------ B6
    section("B6. Confirm text-only, no image needed");
    qs = await questionsOf(jB);
    const q6 = byN(qs, 6);
    check("Q6 (“the X-ray shown below”, DOCX without images) carries the figure-pointer flag", q6.issueCodes.includes("IMAGE_REFERENCE_UNCERTAIN"), q6.issueCodes);
    await confirmTextOnly(q6.id, actor, true);
    let q6b = (await questionsOf(jB)).find((q) => q.id === q6.id)!;
    check("confirmed as text-only: the flag is cleared, the decision recorded (who, when)", !q6b.issueCodes.includes("IMAGE_REFERENCE_UNCERTAIN") && dataOf(q6b).imageDecision?.byId === actor && (await events(jB, "TEXT_ONLY_CONFIRMED")).length === 1, [q6b.issueCodes, dataOf(q6b).imageDecision]);
    const e6 = eff(q6b);
    await editQuestion(q6.id, actor, { stem: `${e6.stem} Look at the figure shown here.`, options: e6.options.map((o) => ({ label: o.label, text: o.text })), type: e6.type, contentFormat: e6.contentFormat });
    await revalidateQuestions(jB, [q6.id]);
    q6b = (await questionsOf(jB)).find((q) => q.id === q6.id)!;
    // (An edit also marks the question reviewed, which already settles this reviewable flag; the decision itself lapses.)
    check("a later wording change lapses the text-only decision (it no longer matches the content)", !textOnlyConfirmed(q6b, eff(q6b)) && !!dataOf(q6b).imageDecision, dataOf(q6b).imageDecision);
    const q7 = byN(qs, 7);
    await prisma.aiImportFigure.create({ data: { jobId: jB, fileId: paperId, pageNumber: 1, questionId: q7.id, owner: "STEM", source: "EMBEDDED", originalKey: "files/xx/missing.png", originalSha256: "0".repeat(64), originalMime: "image/png", width: 10, height: 10, bytes: 1, mappingStatus: "MISSING" } });
    const refusedImg = await errorOf(() => confirmTextOnly(q7.id, actor, true));
    check("refused when an embedded image failed to extract (that image must be restored)", !!refusedImg && /failed to extract/.test(refusedImg.message), refusedImg?.message);

    // ------------------------------------------------------------------ B7
    section("B7. A scanned reference read by OCR: cover page, booklet answers, not compared until Verify 1");
    const refId = `ref${RUN}`;
    const past = new Date(Date.now() - 60_000).toISOString();
    await prisma.aiImportEvent.create({ data: { jobId: jB, type: "REFERENCE_ADDED", message: "Reference added (suite)", data: { refId, name: "Scanned booklet.pdf", ext: "pdf", kind: "pdf", sha256: "0".repeat(64), storageKey: "files/xx/none.pdf", bytes: 1, pageCount: 2, uploadedAt: past, uploadedById: actor, questions: [], key: [], textChars: 0, note: "2 of 2 page(s) have no text layer", scannedPages: 2 } } });
    await runVerify1(jB, actor);
    const s3 = SRC[2];
    await prisma.aiImportEvent.create({ data: { jobId: jB, type: "REFERENCE_READ", message: "read (suite)", data: { refId, model: "mockvision/mid", at: new Date(Date.now() + 1000).toISOString(), pagesRead: [1, 2], failedPages: [], questions: [{ section: "", number: 1, stem: "DO NOT OPEN THIS TEST BOOKLET UNTIL YOU ARE TOLD TO DO SO. Time Allowed: Two Hours. Maximum Marks: 250", options: ["T.B.C.", "Serial No. 1", "Roll Number", "OMR"], answer: ["A"], pages: [1], confidence: 0.95 }, { section: "", number: 1, stem: s3.stem, options: s3.options, answer: ["A"], pages: [2], confidence: 0.95 }] } } });
    const refs = await listReferences(jB);
    const ref = refs.find((r) => r.refId === refId)!;
    check("the cover page is not a reference question; no booklet “answer” is kept", ref.questions.length === 1 && ref.questions.every((q) => !q.answer.length) && ref.skippedInstructions === 1, ref.questions);
    let sum = await paperSummary(jB);
    check("read after the last Verify 1 → the reference shows NOT compared (with the reason)", sum?.references.find((r) => r.refId === refId)?.status.state !== "compared" && /read again/.test(sum?.references.find((r) => r.refId === refId)?.status.reason ?? ""), sum?.references);
    await new Promise((r) => setTimeout(r, 1200));
    await runVerify1(jB, actor);
    sum = await paperSummary(jB);
    qs = await questionsOf(jB);
    const r3 = vsOf(byN(qs, 3)).pv?.v1?.references?.find((x) => x.refId === refId);
    check("after Verify 1: compared; Q3 matched by its wording although the OCR numbered it Q1; no conflict, no answer taken", sum?.references.find((r) => r.refId === refId)?.status.state === "compared" && r3?.matched === "Q1" && r3.conflicts.length === 0 && !byN(qs, 3).issueCodes.includes("REFERENCE_CONFLICT"), [sum?.references, r3]);

    // ------------------------------------------------------------------ B8
    section("B8. Verify 2 on the mock: parallel parts, structured output, reliable models");
    // Every question needs a new read (the older results are dropped for this run).
    for (const q of await questionsOf(jB)) {
      const d = dataOf(q);
      if (q.status === "PUBLISHED" || !d.paperVerify) continue;
      const { v2: _v2, ...restPv } = d.paperVerify;
      void _v2;
      await setData(q.id, { ...d, paperVerify: { ...restPv, passes: [] } });
    }
    // Reliability ranking: a thinking model and one that used up its output limit twice recently are ranked last.
    await prisma.aiImportAiCall.createMany({ data: [1, 2].map((i) => ({ jobId: jB, task: "verify", requestId: `r2-${RUN}-${i}`, model: "mockvision/mid", ok: false, costStatus: "none", errorSummary: "Model output failure: the model used its whole output limit of 8000 tokens (reasoning) and returned no answer — cut off at the token limit." })) });
    const ranked = await preferReliable([{ id: "mockvision/mid", eligible: true }, { id: "mockreason/think", eligible: true }, { id: "mockstruct/reader", eligible: true }]);
    check("reliable model first: exhausted (twice) and thinking models ranked after a non-thinking one", ranked[0].id === "mockstruct/reader" && ranked[ranked.length - 1].id === "mockvision/mid", ranked.map((r) => r.id));
    check("exhausted models of this job are known (≥ 2 output-limit failures)", (await exhaustedModels(jB)).has("mockvision/mid"));
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await mockConfig({ structModels: true, reasonModels: true, chatDelayMs: 900 });
    const pv = await verify2Preview(jB, null);
    check("Verify 2 preview picks the reliable non-thinking model and prices it before anything is sent", pv.model === "mockstruct/reader" && pv.maxInr !== null && (await mockStats()).chat === 0, [pv.model, pv.maxInr, pv.problems]);
    check("Verify 2 reads the document in ≥ 4 parts here (so 3 can run at once)", pv.textParts >= 4, pv.textParts);
    const req = await requestVerify2({ jobId: jB, actorId: actor, model: "mockstruct/reader", confirmedMaxInr: pv.maxInr });
    check("Verify 2 starts only with the confirmed maximum", req.started === true, req);
    await runWorker(300_000);
    const st = await mockStats();
    check("parts read 3 at a time (never more)", st.maxInflight === 3, st.maxInflight);
    check("the structured-output route was sent a JSON Schema", st.responseFormat.filter(Boolean).length > 0 && st.responseFormat.every((x) => x === null || x === "json_schema"), st.responseFormat);
    qs = await questionsOf(jB);
    const open = qs.filter((q) => q.status !== "PUBLISHED");
    check("every open question has a current Verify 2 result; the statement-code questions (read as multiple-correct) agree", open.every((q) => vsOf(q).v2 !== "none" && vsOf(q).v2 !== "stale") && vsOf(byN(qs, 12)).v2 === "verified", open.map((q) => [q.sourceLabel, vsOf(q).v2, vsOf(q).pv?.v2?.detail?.slice(0, 80)]));
    const done = (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } })).config as { verify2?: { status: string; counts?: Record<string, number> } };
    check("Verify 2 finished with a result for every part (none failed)", done.verify2?.status === "DONE" && (done.verify2?.counts?.failedUnits ?? 0) === 0, done.verify2);
    check("no request left the machine (network guard)", blockedHosts.size === 0, [...blockedHosts]);

    // Memory entries can be removed (audited).
    mem = await loadExamMemory(exam.id);
    await removeMemoryEntry(exam.id, actor, "headingAlias", mem!.headingAliases![0].id);
    mem = await loadExamMemory(exam.id);
    check("a heading alias can be removed (history keeps it)", !mem?.headingAliases?.length && (mem?.history ?? []).some((h) => h.action === "AI_IMPORT_TAXONOMY_MEMORY_REMOVED"));
  } finally {
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    await setOpenRouterEnabled(routerWasEnabled).catch(() => undefined);
    for (const id of stored) await prisma.question.delete({ where: { id } }).catch(() => undefined);
    for (const id of jobs) await prisma.aiImportJob.delete({ where: { id } }).catch(() => undefined);
    await prisma.setting.deleteMany({ where: { key: memoryKey } }).catch(() => undefined);
    if (memoryBefore) await prisma.setting.create({ data: { key: memoryKey, value: memoryBefore.value as Prisma.InputJsonValue } }).catch(() => undefined);
    mockProc?.kill();
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
