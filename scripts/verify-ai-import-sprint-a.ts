/**
 * Importer Sprint A (owner approval 2026-11-06) — scratch database, scratch vault, NO AI request, no network.
 *
 *  1. Answer lines: a statement code after the label ("Correct Answer: (B) 1, 2 and 4") is never read as option labels.
 *  2. Searchable scans: the PDF's invisible OCR text layer is read (references) and cross-checked (paper pages).
 *  3. "Remember as a confirmed example" is off by default and only PROPOSES an example.
 *  4. Unsafe examples: legacy / proposed / quarantined examples are never used; quarantine keeps everything; re-activation
 *     only for an approved question with the same classification.
 *  5. No AI answer opinion where the official key decides; no AI_OPINION_DIFFERS flag once the key matched.
 *  6. Expected question count from printed totals (paper / key), never from the extraction; publishing gated.
 *
 * Original papers (AI_IMPORT_SA_FIXTURES): cms2024p2.docx, cms2024p2-key.pdf, cms2024p2-ocr-searchable.pdf,
 * cms2024p1.docx, cms2024p1-key.pdf, CMSE_2013_Paper_I/II_with_Answers.docx, cms 2025 1.docx, cms_2025_2_.docx,
 * CMS_GS_paper1.pdf. Truth: scripts/fixtures/ai-import-papers/truth.json (official keys transcribed from the key files,
 * printed index of the scans). cms2024p2-before.json: what release 9803eca stored (numbers and letters only).
 *
 *   DATABASE_URL=<scratch mts_sa_*> AI_IMPORT_VAULT_DIR=<scratch> STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch>
 *   AI_IMPORT_SA_FIXTURES=<dir> AI_IMPORT_DISABLE_KICK=1 NODE_OPTIONS=--conditions=react-server
 *   npx tsx scripts/verify-ai-import-sprint-a.ts
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportQuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";
import { putContent } from "@/lib/ai-import/vault";
import { readDocx } from "@/lib/ai-import/docx";
import { blockToQuestion, splitQuestions, takePrintedAnswer } from "@/lib/ai-import/local-parse";
import { parseKeyHeader, printedQuestionTotal } from "@/lib/ai-import/keys";
import { keyDecidesAnswer, runPostProcessing } from "@/lib/ai-import/post";
import { runVerify1 } from "@/lib/ai-import/paper-verify";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { IMPORTER_SETTING_KEY } from "@/lib/ai-import/config";
import { ocrTextLayer, pageLayout } from "@/lib/ai-import/pdf";
import { parsePdfPageLocal } from "@/lib/ai-import/pdf-local";
import { qualityReport, type QualityInput } from "@/lib/ai-import/quality";
import { jobQuality } from "@/lib/ai-import/summary";
import { addReference } from "@/lib/ai-import/reference";
import { acknowledgeSequence, approveQuestions, rejectQuestions, requestImport, setTaxonomy } from "@/lib/ai-import/review";
import { classifierContext, jobMemoryBrief, loadExamMemory, quarantineExamples, reactivateExample, TAXONOMY_MEMORY_PREFIX } from "@/lib/ai-import/taxonomy-memory";
import { runWorker } from "@/lib/ai-import/worker";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

const DB = process.env.DATABASE_URL ?? "";
if (!/mts_sa_/.test(DB) || /\/mocktestseries(\?|$)/.test(DB)) {
  console.error("Refusing to run: DATABASE_URL must be a disposable mts_sa_* scratch database.");
  process.exit(2);
}
const FX = process.env.AI_IMPORT_SA_FIXTURES ?? "";
if (!process.env.AI_IMPORT_VAULT_DIR || !FX || !existsSync(path.join(FX, "cms2024p2.docx"))) {
  console.error("Set AI_IMPORT_VAULT_DIR (scratch) and AI_IMPORT_SA_FIXTURES (the original papers).");
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
const metric = (name: string, value: unknown) => console.log(`  METRIC ${name}: ${JSON.stringify(value)}`);
const RUN = Date.now().toString(36);
const TRUTH = JSON.parse(readFileSync("scripts/fixtures/ai-import-papers/truth.json", "utf8")).papers as Record<string, { officialKey?: Record<string, string>; sourceMarkContradictsKey?: number[]; index?: Record<string, { page: number }> }>;
const BEFORE_P2 = JSON.parse(readFileSync("scripts/fixtures/ai-import-papers/cms2024p2-before.json", "utf8")).printedAnswer as Record<string, string[]>;
const KEY_P2 = TRUTH["cms-2024-p2"].officialKey!;
/** The three questions where the Word paper's printed answer really differs from the official key (checked by hand). */
const P2_GENUINE = [13, 46, 74];
const sorted = (a: string[]) => [...a].sort().join();

// ---------------------------------------------------------------------------------------------------------------------
async function answerLines() {
  section("1. Answer lines — statement codes are option text, never labels (pure + the six original Word papers)");
  const q = (answer: string, opts = ["1, 2 and 3", "1, 2 and 4", "1, 3 and 4", "2, 3 and 4"]) =>
    takePrintedAnswer(`Which are correct?\n1. a\n2. b\n3. c\n4. d\n(a) ${opts[0]}\n(b) ${opts[1]}\n(c) ${opts[2]}\n(d) ${opts[3]}\n${answer}`);
  const cases: [string, string[], string][] = [
    ["Correct Answer: (B) 1, 2 and 4", ["B"], "letter + statement code (the CMS 2024 P II line)"],
    ["Correct Answer: (C) 1, 3 and 4", ["C"], "letter + another code"],
    ["Correct Answer: (D) 2, 3 and 4", ["D"], "letter + code ending in 4"],
    ["Answer: B", ["B"], "letter alone"],
    ["Ans: (a) and (c)", ["A", "C"], "two letters (multiple-correct)"],
    ["Key: 2", ["B"], "a digit label alone"],
    ["Correct Answer: (b)", ["B"], "lower-case label in brackets"],
  ];
  for (const [line, want, why] of cases) {
    const r = q(line);
    check(`${why}: “${line}” → ${want.join(", ")}`, sorted(r.answer) === sorted(want), r.answer);
  }
  const wrongText = q("Correct Answer: (B) 1, 2, 4");
  check("negative: “(B) 1, 2, 4” does not match option B's text “1, 2 and 4” → no answer taken (never a wrong one)", wrongText.answer.length === 0 || sorted(wrongText.answer) === "B", wrongText.answer);
  const mixed = q("Correct Answer: (B) 1, 2 and 4");
  check("negative: no label set ever mixes a letter with digits", !mixed.answer.some((l) => !/^[A-D]$/.test(l)) && mixed.answer.length === 1, mixed.answer);
  const named = takePrintedAnswer("Raynaud's phenomenon is seen in\n(a) SLE\n(b) Systemic sclerosis\n(c) RA\n(d) Gout\n✓ Correct Answer: (b) Systemic sclerosis");
  check("an answer line with the option's own words still reads the label (“(b) Systemic sclerosis” → B)", sorted(named.answer) === "B", named.answer);

  const papers: [string, string, number | null][] = [
    ["cms2024p2.docx", "cms-2024-p2", 3],
    ["CMSE_2013_Paper_I_with_Answers.docx", "cms-2013-p1", 16],
    ["CMSE_2013_Paper_II_with_Answers.docx", "cms-2013-p2", 38],
    ["cms2024p1.docx", "cms-2024-p1", null],
    ["cms 2025 1.docx", "cms-2025-p1", null],
    ["cms_2025_2_.docx", "cms-2025-p2", null],
  ];
  for (const [file, id, genuine] of papers) {
    const doc = await readDocx(path.join(FX, file));
    const qs = splitQuestions(doc.lines).blocks.map((b) => blockToQuestion(b, 1, "DOCX").q);
    const key = TRUTH[id]?.officialKey;
    const printed = qs.filter((x) => x.printedAnswer.length);
    const multi = printed.filter((x) => x.printedAnswer.length > 1).length;
    const differs = key ? printed.filter((x) => x.printedAnswer.length !== 1 || x.printedAnswer[0] !== key[String(x.number)]).map((x) => x.number) : [];
    metric(`${id} reading`, { questions: qs.length, numbered: new Set(qs.map((x) => x.number)).size, fourOptions: qs.filter((x) => x.options.length === 4).length, printed: printed.length, multiLabel: multi, printedDiffersFromKey: key ? differs.length : "no key" });
    check(`${id}: 120 questions, 1–120 each once, 4 options each`, qs.length === 120 && new Set(qs.map((x) => x.number)).size === 120 && qs.every((x) => x.options.length === 4));
    check(`${id}: no printed answer with several labels (single-correct paper)`, multi === 0, multi);
    if (genuine !== null) {
      const expected = id === "cms-2024-p2" ? P2_GENUINE : TRUTH[id].sourceMarkContradictsKey!;
      check(`${id}: printed answer ≠ official key on exactly the ${genuine} genuinely different question(s)`, differs.length === genuine && sorted(differs.map(String)) === sorted(expected.map(String)), { differs });
    }
  }
  const before = Object.values(BEFORE_P2).filter((v) => v.length > 1).length;
  const beforeDiff = Object.entries(BEFORE_P2).filter(([n, v]) => v.length !== 1 || v[0] !== KEY_P2[n]).length;
  metric("cms-2024-p2 before (9803eca parser)", { multiLabel: before, printedDiffersFromKey: beforeDiff });
  check("baseline reproduced: 9803eca read 45 multi-label answers → 46 differences from the key (production showed 46 KEY_MISMATCH)", before === 45 && beforeDiff === 46, { before, beforeDiff });
}

// ---------------------------------------------------------------------------------------------------------------------
async function ocrLayers() {
  section("2. Searchable scans — the invisible OCR text layer (pure, original files)");
  const work = mkdtempSync(path.join(os.tmpdir(), "sa-layer-"));
  const ref = path.join(FX, "cms2024p2-ocr-searchable.pdf");
  const visible = await pageLayout(ref, 2, work);
  const hidden = await pageLayout(ref, 2, work, { hidden: true });
  check("baseline behaviour kept: without `hidden` the searchable page 2 has no text lines", visible.lines.length === 0, visible.lines.length);
  check("with `hidden` the OCR layer of page 2 is read (Q1 “Which of the following are risk factors for wound infection”)", hidden.lines.length > 20 && /risk factors for/i.test(hidden.lines.map((l) => l.text).join(" ")), hidden.lines.length);
  // Measured: question numbers the OCR layer shows, page by page, against the printed index of the original scan.
  const index = TRUTH["cms-2024-p2"].index!;
  const truthByPage = new Map<number, number[]>();
  for (const [n, v] of Object.entries(index)) truthByPage.set(v.page, [...(truthByPage.get(v.page) ?? []), Number(n)]);
  const state = { last: 0, sectionIdx: 1 };
  let found = 0;
  let right = 0;
  let layerPages = 0;
  const wrongPages: unknown[] = [];
  for (let p = 1; p <= 32; p++) {
    const l = await ocrTextLayer(ref, p, work, 0);
    if (!l) continue;
    layerPages++;
    const nums = parsePdfPageLocal({ lines: l.lines, images: [] }, p, state).questions.map((x) => x.number).filter((n): n is number => n !== null);
    const want = truthByPage.get(p) ?? [];
    found += nums.length;
    right += nums.filter((n) => want.includes(n)).length;
    if (nums.some((n) => !want.includes(n))) wrongPages.push({ p, nums, want });
  }
  const total = Object.keys(index).length;
  metric("OCR layer of the CMS 2024 P II searchable scan", { pagesWithLayer: layerPages, numbersFound: found, onTheRightPage: right, recall: +(right / total).toFixed(3), precision: found ? +(right / found).toFixed(3) : null, pagesWithWrongNumbers: wrongPages.length });
  const questionPages = truthByPage.size;
  check(`the OCR layer is read on at least 90% of the ${questionPages} pages that hold questions`, layerPages >= Math.ceil(questionPages * 0.9), { layerPages, questionPages });
  check("measured: OCR-layer question numbers are on the right page (precision ≥ 0.95)", found > 0 && right / found >= 0.95, wrongPages.slice(0, 5));
  const key = path.join(FX, "cms2024p2-key.pdf");
  check("negative: a normal text PDF (the key) has no OCR-layer read (visible text is used)", (await ocrTextLayer(key, 1, work, 500)) === null);
  const scan = path.join(FX, "CMS_GS_paper1.pdf");
  let anyLayer = false;
  for (let p = 1; p <= 4; p++) if (await ocrTextLayer(scan, p, work, 0)) anyLayer = true;
  check("negative: a pure image scan (CMS 2024 P I) has no OCR layer — nothing is invented", !anyLayer);
}

// ---------------------------------------------------------------------------------------------------------------------
async function scratchExam() {
  const exam = await prisma.exam.create({ data: { name: `SYNTHETIC CMS SA ${RUN}`, code: `SYNSA${RUN}`.slice(0, 20), isActive: true, durationMinutes: 120, totalQuestions: 120, negativeMarking: 0 } });
  const TAX: Record<string, string[]> = {
    "General Surgery": ["Wound Healing", "Oncology", "Vascular Surgery", "Trauma"],
    "Obstetrics & Gynaecology": ["Labour", "Gynaecological Oncology", "Antenatal Care"],
    "Preventive & Social Medicine": ["Epidemiology", "Immunization", "Nutrition"],
  };
  const ids = new Map<string, string>();
  for (const [i, [name, topics]] of Object.entries(TAX).entries()) {
    const s = await prisma.subject.create({ data: { name, nameKey: `${taxonomyNameKey(name)}-sa-${RUN}`, originExamId: exam.id, order: i } });
    ids.set(name, s.id);
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: s.id, displayOrder: i } });
    for (const [t, topic] of topics.entries()) {
      const row = await prisma.topic.create({ data: { subjectId: s.id, name: topic, nameKey: `${taxonomyNameKey(topic)}-sa-${RUN}`, order: t } });
      ids.set(`${name} › ${topic}`, row.id);
      await prisma.examTopic.create({ data: { examId: exam.id, topicId: row.id, displayOrder: t } });
    }
  }
  return { exam, ids };
}

async function vaultFile(name: string, ext: string) {
  const bytes = readFileSync(path.join(FX, name));
  return { bytes, stored: await putContent("files", bytes, ext) };
}

async function seedSettings() {
  // Paid AI off for the worker runs (no AI request anywhere in this suite).
  const value = { aiEnabled: false, budget: { monthlyInr: 1500, totalInr: 200 }, publish: { allowUnverifiedAnswers: false, requireTopic: false }, verification: { independentAnswer: true, secondReadBelow: 0.8, topicMinConfidence: 0.7, nearDuplicateAt: 0.85 }, models: { extract: null, verify: null, classify: null, key: null, extractFallbacks: [] } };
  await prisma.setting.upsert({ where: { key: IMPORTER_SETTING_KEY }, create: { key: IMPORTER_SETTING_KEY, value }, update: { value } });
}

async function p2Job(examId: string, actorId: string, expected: number | null) {
  const paper = await vaultFile("cms2024p2.docx", "docx");
  const key = await vaultFile("cms2024p2-key.pdf", "pdf");
  const job = await prisma.aiImportJob.create({ data: { title: `cMS 2024 2 ${RUN}`, examId, createdById: actorId, budgetInr: 0, status: AiImportJobStatus.QUEUED, expectedQuestions: expected, paperType: "FULL_PAPER", year: 2024 } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.PAPER, originalName: "cMS 2024 2 .docx", ext: "docx", declaredBytes: paper.bytes.length, bytes: paper.bytes.length, sha256: paper.stored.sha256, storageKey: paper.stored.key, status: AiImportFileStatus.ANALYZED, detected: { kind: "docx" }, pageCount: 1, uploadedById: actorId } });
  await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.ANSWER_KEY, paperFileId: file.id, originalName: "CMS_2024_Paper_II_Surgery_Gynae_PSM_Answer_Key.pdf", ext: "pdf", declaredBytes: key.bytes.length, bytes: key.bytes.length, sha256: key.stored.sha256, storageKey: key.stored.key, status: AiImportFileStatus.ANALYZED, detected: { kind: "pdf" }, pageCount: 1, uploadedById: actorId } });
  await runWorker(5 * 60_000);
  return prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } });
}

const ctxOf = async (jobId: string, over: Partial<Awaited<ReturnType<typeof getImporterSettings>>> = {}) => ({ job: await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } }), settings: { ...(await getImporterSettings()), ...over }, examName: "", subjectName: null, stillRunning: async () => true });

// ---------------------------------------------------------------------------------------------------------------------
async function productionReplay(examId: string, actorId: string) {
  section("3. CMS 2024 Paper II — a new import, then the production state replayed and Verify 1 (scratch DB, no AI)");
  const job = await p2Job(examId, actorId, 120);
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id } });
  const st = (s: string) => rows.filter((r) => r.answerStatus === s).length;
  metric("new import answer statuses", Object.fromEntries(["OFFICIAL_MATCHED", "KEY_MISMATCH", "AMBIGUOUS_MAPPING", "UNVERIFIED"].map((s) => [s, st(s)])));
  check("a NEW import: 120 questions in review", job.status === AiImportJobStatus.NEEDS_REVIEW && rows.length === 120, { status: job.status, n: rows.length });
  check("a NEW import: KEY_MISMATCH only on Q13, Q46, Q74 (printed ≠ key), 117 official answers", st("KEY_MISMATCH") === 3 && sorted(rows.filter((r) => r.answerStatus === "KEY_MISMATCH").map((r) => String(r.sourceNumber))) === sorted(P2_GENUINE.map(String)) && st("OFFICIAL_MATCHED") === 117, { mismatch: rows.filter((r) => r.answerStatus === "KEY_MISMATCH").map((r) => r.sourceNumber) });

  // Replay what release 9803eca stored (the misread printed answers) and an AI opinion on ten questions, as in production.
  for (const r of rows) {
    const d = r.data as unknown as ExtractedQuestion;
    await prisma.aiImportQuestion.update({ where: { id: r.id }, data: { data: { ...d, printedAnswer: BEFORE_P2[String(r.sourceNumber)] ?? d.printedAnswer } as unknown as Prisma.InputJsonValue } });
  }
  const opinionOn = [1, 2, 5, 11, 13, 20, 33, 60, 90, 118];
  for (const n of opinionOn) {
    const k = KEY_P2[String(n)];
    await prisma.aiImportQuestion.updateMany({ where: { jobId: job.id, sourceNumber: n }, data: { aiAnswer: [k === "A" ? "B" : "A"], aiAnswerModel: "google/gemma-3-4b-it", aiAnswerConfidence: 0.6 } });
  }
  await runPostProcessing(await ctxOf(job.id, { aiEnabled: false }));
  const replay = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id } });
  const mismatchBefore = replay.filter((r) => r.answerStatus === "KEY_MISMATCH").length;
  metric("replayed production state", { KEY_MISMATCH: mismatchBefore, AI_OPINION_DIFFERS: replay.filter((r) => r.issueCodes.includes("AI_OPINION_DIFFERS")).length });
  check("replay reproduces production: 46 KEY_MISMATCH", mismatchBefore === 46, mismatchBefore);
  const differsOn = replay.filter((r) => r.issueCodes.includes("AI_OPINION_DIFFERS")).map((r) => r.sourceNumber);
  check("item 5: AI_OPINION_DIFFERS is raised only where the key could NOT be applied (never on an OFFICIAL_MATCHED question)", replay.filter((r) => r.issueCodes.includes("AI_OPINION_DIFFERS")).every((r) => r.answerStatus !== "OFFICIAL_MATCHED"), differsOn);
  const finalBefore = new Map(replay.map((r) => [r.sourceNumber, sorted(r.finalAnswer)]));
  const officialBefore = new Map(replay.map((r) => [r.sourceNumber, sorted(r.officialAnswer)]));
  const versionsBefore = await prisma.aiImportQuestionVersion.count({ where: { jobId: job.id } });

  // Verify 1 (free): reads the printed answers again from the Word source.
  const v1 = await runVerify1(job.id, actorId);
  const after = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id } });
  const ev = await prisma.aiImportEvent.findMany({ where: { jobId: job.id, type: "PRINTED_ANSWER_REREAD" } });
  const mm = after.filter((r) => r.answerStatus === "KEY_MISMATCH").map((r) => r.sourceNumber!);
  metric("after Verify 1", { KEY_MISMATCH: mm.length, mismatch: mm, OFFICIAL_MATCHED: after.filter((r) => r.answerStatus === "OFFICIAL_MATCHED").length, AI_OPINION_DIFFERS: after.filter((r) => r.issueCodes.includes("AI_OPINION_DIFFERS")).map((r) => r.sourceNumber), ready: after.filter((r) => r.status === "READY").length, v1 });
  check("Verify 1 re-read 45 misread printed answers from the Word source (event logged); 43 now match the key", ev.length === 1 && /45 question/.test(ev[0].message), ev.map((e) => e.message));
  check("after Verify 1 only Q13, Q46, Q74 remain KEY_MISMATCH", sorted(mm.map(String)) === sorted(P2_GENUINE.map(String)), mm);
  check("every corrected question keeps its previous version (45 new EXTRACTION versions)", (await prisma.aiImportQuestionVersion.count({ where: { jobId: job.id } })) - versionsBefore >= 45);
  check("official answers (officialAnswer) unchanged by Verify 1", after.every((r) => sorted(r.officialAnswer) === officialBefore.get(r.sourceNumber) || officialBefore.get(r.sourceNumber) === ""), after.filter((r) => sorted(r.officialAnswer) !== officialBefore.get(r.sourceNumber)).map((r) => r.sourceNumber).slice(0, 10));
  const finalChanged = after.filter((r) => sorted(r.finalAnswer) !== finalBefore.get(r.sourceNumber));
  check("final answers change ONLY from empty to the official key value (the 43), never to anything else", finalChanged.length === 43 && finalChanged.every((r) => finalBefore.get(r.sourceNumber) === "" && sorted(r.finalAnswer) === KEY_P2[String(r.sourceNumber)]), finalChanged.map((r) => [r.sourceNumber, finalBefore.get(r.sourceNumber), r.finalAnswer]).slice(0, 8));
  check("item 5: after Verify 1 no OFFICIAL_MATCHED question carries AI_OPINION_DIFFERS; Q13 (key not applied) still does", after.filter((r) => r.issueCodes.includes("AI_OPINION_DIFFERS")).every((r) => r.answerStatus !== "OFFICIAL_MATCHED") && after.find((r) => r.sourceNumber === 13)!.issueCodes.includes("AI_OPINION_DIFFERS"));
  check("the AI opinion itself is kept for reference (aiAnswer not erased)", opinionOn.every((n) => after.find((r) => r.sourceNumber === n)!.aiAnswer.length === 1));
  check("nothing approved, imported or published", after.every((r) => !r.approvedById && !r.questionId && r.status !== AiImportQuestionStatus.PUBLISHED));
  check("no AI request was made", (await prisma.aiImportAiCall.count({ where: { jobId: job.id } })) === 0);
  // Negative: an approved question is never changed by the re-read; it is reported instead.
  const q2 = after.find((r) => r.sourceNumber === 2)!;
  const d2 = q2.data as unknown as ExtractedQuestion;
  await prisma.aiImportQuestion.update({ where: { id: q2.id }, data: { data: { ...d2, printedAnswer: ["C", "A", "D"] } as unknown as Prisma.InputJsonValue, approvedById: actorId, approvedAt: new Date() } });
  await runVerify1(job.id, actorId);
  const q2b = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q2.id } });
  check("negative: an APPROVED question's stored printed answer is not changed by Verify 1 (reported for review)", sorted((q2b.data as unknown as ExtractedQuestion).printedAnswer) === "A,C,D");
  await prisma.aiImportQuestion.update({ where: { id: q2.id }, data: { data: { ...d2 } as unknown as Prisma.InputJsonValue, approvedById: null, approvedAt: null } });
  return job;
}

// ---------------------------------------------------------------------------------------------------------------------
async function opinions(jobId: string) {
  section("5. AI answer opinions are not requested where the official key decides (pure + scratch DB)");
  check("key entry B for a 4-option question decides it", keyDecidesAnswer([{ rawValue: "B", wrongPaper: false }], ["A", "B", "C", "D"]));
  check("negative: no key entry → opinion still allowed", !keyDecidesAnswer([], ["A", "B", "C", "D"]));
  check("negative: a dropped entry (X) does not decide", !keyDecidesAnswer([{ rawValue: "X", wrongPaper: false }], ["A", "B", "C", "D"]));
  check("negative: two different values for one number do not decide", !keyDecidesAnswer([{ rawValue: "B", wrongPaper: false }, { rawValue: "C", wrongPaper: false }], ["A", "B", "C", "D"]));
  check("negative: a key printed for another paper does not decide", !keyDecidesAnswer([{ rawValue: "B", wrongPaper: true }], ["A", "B", "C", "D"]));
  check("negative: a value that is not an option (E on a 4-option question) does not decide", !keyDecidesAnswer([{ rawValue: "E", wrongPaper: false }], ["A", "B", "C", "D"]));
  // With paid AI ON and an opinion model configured, a post-processing pass over the 120 key-matched questions sends
  // nothing (any request would fail: no key, no network) and logs that the opinions were skipped.
  await prisma.aiImportQuestion.updateMany({ where: { jobId }, data: { aiAnswer: [], aiAnswerModel: null, aiAnswerConfidence: null } });
  const settings = await getImporterSettings();
  let threw: unknown = null;
  try {
    await runPostProcessing(await ctxOf(jobId, { aiEnabled: true, models: { ...settings.models, verify: "mock/never-called", classify: null }, verification: { ...settings.verification, independentAnswer: true } }));
  } catch (e) {
    threw = e instanceof Error ? e.message : e;
  }
  const skipped = await prisma.aiImportEvent.findFirst({ where: { jobId, type: "AI_OPINION_SKIPPED" }, orderBy: { createdAt: "desc" } });
  check("paid AI ON + opinion model: no request sent for key-decided questions (no error, 0 calls)", !threw && (await prisma.aiImportAiCall.count({ where: { jobId } })) === 0, threw);
  check("AI_OPINION_SKIPPED logged for the key-decided questions", !!skipped && /for 120 question/.test(skipped.message), skipped?.message);
}

// ---------------------------------------------------------------------------------------------------------------------
async function referenceRead(jobId: string, actorId: string) {
  section("2b. The searchable reference of CMS 2024 Paper II is read and compared (scratch DB, no AI)");
  const bytes = readFileSync(path.join(FX, "cms2024p2-ocr-searchable.pdf"));
  const ref = await addReference({ jobId, actorId, name: "CMS_2024_Paper_II_OCR_Searchable.pdf", bytes });
  metric("reference read", { questions: ref.questions.length, scannedPages: ref.scannedPages ?? 0, note: ref.note });
  check("before Sprint A: 0 questions, 32 pages ‘scanned’ → now ≥ 100 questions read from the OCR layer", ref.questions.length >= 100, ref.questions.length);
  check("the note says the pages were read from the PDF's OCR text layer and that its quality is not verified", /OCR text layer/.test(ref.note ?? "") && /not verified/.test(ref.note ?? ""), ref.note);
  const numbers = new Set(ref.questions.map((q) => q.number));
  metric("reference numbers 1–120 found", numbers.size);
  const numbered = [...numbers].filter((n): n is number => n !== null);
  metric("reference numbering", { numbered: numbered.length, unnumbered: ref.questions.filter((q) => q.number === null).length, outOfRange: numbered.filter((n) => n < 1 || n > 120) });
  check("the reference's numbered questions are within 1–120", numbered.every((n) => n >= 1 && n <= 120), numbered.filter((n) => n < 1 || n > 120));
}

// ---------------------------------------------------------------------------------------------------------------------
async function memory(examId: string, jobId: string, actorId: string, ids: Map<string, string>) {
  section("3–4. Classification memory — off by default, proposed → verified, quarantine, gated re-activation");
  const src = readFileSync("app/admin/(dashboard)/ai-importer/questions/[id]/question-review.tsx", "utf8");
  check("item 3: the review screen's “Remember” checkbox starts unchecked", /const \[rememberTax, setRememberTax\] = useState\(false\)/.test(src) && !/useState\(true\);\s*$/m.test(src.split("rememberTax")[0].slice(-40)));
  const bulk = readFileSync("app/admin/(dashboard)/ai-importer/exceptions/exceptions-table.tsx", "utf8");
  check("item 3: the bulk “Remember” checkbox starts unchecked", /const \[remember, setRemember\] = useState\(false\)/.test(bulk));

  // Legacy examples saved before Sprint A (no verifiedAt), as in production.
  const sub = ids.get("General Surgery")!;
  const top = ids.get("General Surgery › Wound Healing")!;
  const legacy = Array.from({ length: 5 }, (_, i) => ({ id: `legacy${i}${RUN}`, text: `keloid hypertrophic scar wound healing collagen remodelling case ${i}`, subjectId: sub, topicId: top, subTopicId: null, jobId: "deleted-job", questionId: `deleted-q${i}`, byId: actorId, at: "2026-10-24T10:00:00.000Z", source: "admin correction" }));
  await prisma.setting.upsert({ where: { key: `${TAXONOMY_MEMORY_PREFIX}${examId}` }, create: { key: `${TAXONOMY_MEMORY_PREFIX}${examId}`, value: { examId, version: 1, taxonomyFingerprint: "", synonyms: [], confusions: [], corrections: legacy, lastRefresh: null, updatedAt: new Date().toISOString() } }, update: {} });
  let cc = await classifierContext(examId);
  check("item 4: legacy examples (saved without approval) are NOT used by the classifier", cc.index.corrections.length === 0, cc.index.corrections.length);
  check("item 4: legacy examples are still stored (nothing deleted by loading)", ((await loadExamMemory(examId))?.corrections.length ?? 0) === 5);

  // Remember on a question → proposal only.
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: { orderIndex: "asc" } });
  const q1 = rows.find((r) => r.sourceNumber === 1)!;
  const q4 = rows.find((r) => r.sourceNumber === 4)!;
  await setTaxonomy(q1.id, actorId, sub, top, null, { remember: true });
  let mem = await loadExamMemory(examId);
  check("item 3: “Remember” stores a PROPOSED example — not an active one", mem?.proposedCorrections?.length === 1 && mem.corrections.length === 5 && mem.proposedCorrections[0].status === "PROPOSED");
  check("the proposal keeps its evidence (source number, pages, previous classification)", mem?.proposedCorrections?.[0].evidence?.sourceNumber === 1 && Array.isArray(mem.proposedCorrections[0].evidence?.pages));
  cc = await classifierContext(examId);
  check("item 4: a proposed example is NOT used by the classifier", cc.index.corrections.length === 0);
  await setTaxonomy(q4.id, actorId, ids.get("General Surgery")!, ids.get("General Surgery › Vascular Surgery")!, null, { remember: false });
  check("negative: Set without “Remember” stores nothing", ((await loadExamMemory(examId))?.proposedCorrections?.length ?? 0) === 1);

  // Approval of the question with the same classification → active.
  const ap = await approveQuestions([q1.id], actorId);
  mem = await loadExamMemory(examId);
  const active = mem?.corrections.filter((c) => !!c.verifiedAt) ?? [];
  check("approval with the same classification makes the example active (verifiedAt, verifiedById)", ap.approved === 1 && active.length === 1 && active[0].questionId === q1.id && active[0].verifiedById === actorId && (mem?.proposedCorrections?.length ?? 0) === 0, { ap, active: active.length });
  cc = await classifierContext(examId);
  check("item 4: only the verified example is used by the classifier (1 of 6 stored)", cc.index.corrections.length === 1, cc.index.corrections.length);

  // A proposal whose question is rejected is quarantined (kept), never used.
  const q6 = rows.find((r) => r.sourceNumber === 6)!;
  await setTaxonomy(q6.id, actorId, sub, ids.get("General Surgery › Oncology")!, null, { remember: true });
  await rejectQuestions([q6.id], actorId, "test rejection");
  mem = await loadExamMemory(examId);
  check("a rejected question's proposal is quarantined with the reason (not deleted, not used)", mem?.quarantinedCorrections?.length === 1 && /question rejected/.test(mem.quarantinedCorrections[0].reason) && !(mem.proposedCorrections ?? []).length);

  // A proposal changed after it was proposed stays proposed on approval.
  const q8 = rows.find((r) => r.sourceNumber === 8)!;
  await setTaxonomy(q8.id, actorId, sub, top, null, { remember: true });
  await prisma.aiImportQuestion.update({ where: { id: q8.id }, data: { topicId: ids.get("General Surgery › Trauma")! } });
  await approveQuestions([q8.id], actorId);
  mem = await loadExamMemory(examId);
  check("negative: a question approved with a DIFFERENT classification than proposed does not activate the example", (mem?.proposedCorrections ?? []).some((p) => p.questionId === q8.id) && !mem!.corrections.some((c) => c.questionId === q8.id));

  // Quarantine of every active example (the production operation): dry run first.
  const keyRow = `${TAXONOMY_MEMORY_PREFIX}${examId}`;
  const raw0 = JSON.stringify((await prisma.setting.findUniqueOrThrow({ where: { key: keyRow } })).value);
  const dry = await quarantineExamples(examId, actorId, "Sprint A approval 2: examples saved by a default-on checkbox", { dryRun: true });
  const raw1 = JSON.stringify((await prisma.setting.findUniqueOrThrow({ where: { key: keyRow } })).value);
  check("quarantine dry run reports 6 to move and writes nothing", dry.moved.length === 6 && raw0 === raw1, dry.moved.length);
  const real = await quarantineExamples(examId, actorId, "Sprint A approval 2: examples saved by a default-on checkbox");
  mem = await loadExamMemory(examId);
  const auditRow = await prisma.auditLog.findFirst({ where: { action: "AI_IMPORT_TAXONOMY_EXAMPLES_QUARANTINED", entityId: examId }, orderBy: { createdAt: "desc" } });
  check("quarantine: 0 active, 7 quarantined (6 moved + 1 earlier), the proposal untouched — nothing deleted", mem?.corrections.length === 0 && mem.quarantinedCorrections?.length === 7 && (mem.proposedCorrections?.length ?? 0) === 1, { a: mem?.corrections.length, q: mem?.quarantinedCorrections?.length });
  check("quarantined entries keep their full record (text, ids, job, question, admin, time) + reason, actor, time, batch", mem!.quarantinedCorrections!.filter((c) => c.batch === real.batch).every((c) => c.text.length > 10 && c.subjectId && c.questionId && c.byId && c.at && c.quarantinedAt && c.quarantinedById === actorId && c.reason.length > 10));
  check("the audit log and memory history record the batch with every id", !!auditRow && ((auditRow.metadata as { ids?: string[] }).ids?.length ?? 0) === 6 && (mem!.history ?? []).some((h) => h.action === "AI_IMPORT_TAXONOMY_EXAMPLES_QUARANTINED"));
  cc = await classifierContext(examId);
  check("item 4: after the quarantine the classifier uses no example", cc.index.corrections.length === 0);
  const brief = await jobMemoryBrief({ examId, title: "cMS 2024 2", previousYearPaperId: null }, "classify");
  check("item 4: no quarantined text reaches the AI memory brief", !mem!.quarantinedCorrections!.some((c) => brief.includes(c.text.slice(0, 30))));
  const stored = (await prisma.setting.findUniqueOrThrow({ where: { key: keyRow } })).value as { corrections: unknown[] };
  check("rollback-safe: the stored `corrections` list (what release 9803eca reads) is empty", Array.isArray(stored.corrections) && stored.corrections.length === 0);

  // Re-activation is gated, one by one.
  const legacyQ = mem!.quarantinedCorrections!.find((c) => c.questionId === "deleted-q0")!;
  let refused: string | null = null;
  try {
    await reactivateExample(examId, legacyQ.id, actorId);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  check("negative: an example whose question no longer exists cannot be re-activated", !!refused && /no longer exists/.test(refused), refused);
  const rejectedQ = mem!.quarantinedCorrections!.find((c) => c.questionId === q6.id)!;
  refused = null;
  try {
    await reactivateExample(examId, rejectedQ.id, actorId);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  check("negative: an example whose question is not approved cannot be re-activated", !!refused && /not approved/.test(refused), refused);
  const goodQ = mem!.quarantinedCorrections!.find((c) => c.questionId === q1.id)!;
  await reactivateExample(examId, goodQ.id, actorId);
  mem = await loadExamMemory(examId);
  check("an example whose question is approved with the same classification is re-activated (only that one)", mem!.corrections.length === 1 && mem!.corrections[0].questionId === q1.id && !!mem!.corrections[0].reactivatedAt && mem!.quarantinedCorrections!.length === 6);
  await prisma.aiImportQuestion.update({ where: { id: q1.id }, data: { approvedById: null, approvedAt: null } });
}

// ---------------------------------------------------------------------------------------------------------------------
async function expectedCount(examId: string, actorId: string) {
  section("6. Expected question count from printed totals; publishing gated on completeness");
  const doc = await readDocx(path.join(FX, "cms2024p2.docx"));
  check("printed total of the CMS 2024 P II Word paper: “Total Questions: 120” → 120", printedQuestionTotal(doc.lines.slice(0, 60).map((l) => l.text).join("\n")) === 120);
  check("printed total of a UPSC scan cover: “This Test Booklet contains 120 items (questions)” → 120", printedQuestionTotal("4. This Test Booklet contains 120 items (questions). Each item comprises four responses") === 120);
  check("“Total Number of Questions: 100” → 100", printedQuestionTotal("Time: 2 hours   Total Number of Questions: 100") === 100);
  check("negative: “Question 120” or “Maximum Marks: 250” is not a total", printedQuestionTotal("Question 120. Maximum Marks: 250") === null);
  check("the key header reads Total Questions 120 (key PDF)", parseKeyHeader("CMS-2024 — OFFICIAL ANSWER KEY\nPaper II (TWO) | Series A\nTotal Questions\n\n120")?.totalQuestions === 120);

  const base: QualityInput = { expected: 120, questions: [], pages: [], unmatchedKeyEntries: 0, failedKeyFiles: 0, verifierExtras: [], ack: null, processed: true };
  const qs = (n: number, skip: number[] = []) => Array.from({ length: n }, (_, i) => i + 1).filter((x) => !skip.includes(x)).map((x) => ({ fileId: "f", section: "", number: x, printedNumber: null, status: "EXTRACTED", approved: false, stored: false, verified: null, issueCodes: [], answerStatus: "OFFICIAL_MATCHED", importBlocker: null, rescanPending: false, page: 1 }));
  const r1 = qualityReport({ ...base, questions: qs(120), expectedSources: [{ source: "printed on the answer key", value: 120 }] });
  check("120 entered, 120 printed, 120 extracted → no conflict, publishing not blocked", r1.expectedConflict === null && r1.publishBlocker === null && r1.expectedFrom === "entered by an administrator", r1.publishBlocker);
  const r2 = qualityReport({ ...base, questions: qs(120, Array.from({ length: 62 }, (_, i) => 59 + i)), expectedSources: [{ source: "printed on the question paper", value: 120 }] });
  check("the 2022-style case: 120 expected / 58 extracted / 62 missing is stated and blocks publishing", /120 expected \/ 58 extracted \/ 62 missing/.test(r2.publishBlocker ?? ""), r2.publishBlocker);
  const r3 = qualityReport({ ...base, expected: 100, questions: qs(100), expectedSources: [{ source: "printed on the question paper", value: 120 }] });
  check("entered 100 but the paper prints 120 → conflict, blocks publishing (even though 100 of 100 were extracted)", !!r3.expectedConflict && r3.publishBlocker === r3.expectedConflict && r3.blockers.includes(r3.expectedConflict!), r3.publishBlocker);
  const r4 = qualityReport({ ...base, expected: null, questions: qs(120), expectedSources: [{ source: "printed on the answer key", value: 120 }] });
  check("nothing entered, the key prints 120 → expected 120 from the key (not from the extraction)", r4.expected === 120 && /answer key/.test(r4.expectedFrom ?? "") && r4.publishBlocker === null);
  const r5 = qualityReport({ ...base, expected: null, questions: qs(116) });
  check("negative: nothing entered and nothing printed → expected stays unknown (the 116 extracted are NOT used) and publishing is blocked", r5.expected === null && /not confirmed/.test(r5.publishBlocker ?? ""), r5);
  const r5b = qualityReport({ ...base, expected: null, questions: qs(116), ack: { byId: actorId, at: "", note: "no total printed; checked against the paper by hand", missing: [], expected: null, counted: 116 } });
  check("an unknown count explained with a reason (for exactly these 116) unblocks publishing; it lapses when the count changes", r5b.publishBlocker === null && qualityReport({ ...base, expected: null, questions: qs(115), ack: { byId: actorId, at: "", note: "x", missing: [], expected: null, counted: 116 } }).publishBlocker !== null);
  const r6 = qualityReport({ ...base, expected: null, questions: qs(120), expectedSources: [{ source: "paper", value: 120 }, { source: "key", value: 100 }] });
  check("printed totals that disagree → conflict, no expected count assumed", r6.expected === null && !!r6.expectedConflict);
  const r7 = qualityReport({ ...base, questions: qs(120), keyMaxNumber: 125 });
  check("the key numbers up to 125 with 120 expected → a warning (the key's highest number is not a printed total), not a blocker", !r7.expectedConflict && r7.warnings.some((w) => /up to 125/.test(w)));
  const missing = ["Q59", "Q60"];
  const r8 = qualityReport({ ...base, questions: qs(120, [59, 60]), ack: { byId: actorId, at: "", note: "withdrawn by the board", missing, expected: 120, counted: 118 } });
  check("an acknowledged difference (with a reason) no longer blocks publishing", r8.publishBlocker === null, r8.publishBlocker);
  const r9 = qualityReport({ ...base, questions: qs(120), pages: [{ status: "FAILED", kind: "SCANNED", attempts: 2, errorMessage: "x", fileId: "f", pageNumber: 3, outcome: "FAILED", outcomeReason: "x" }] });
  check("a page that was not read blocks publishing", /not read/.test(r9.publishBlocker ?? ""));
  const conflictText = r3.expectedConflict!;
  const r10 = qualityReport({ ...base, expected: 100, questions: qs(100), expectedSources: [{ source: "printed on the question paper", value: 120 }], ack: { byId: actorId, at: "", note: "cover total misread by OCR; the paper has 100", missing: [], expected: 100, counted: 100, conflict: conflictText } });
  check("an explained expected-count conflict (same wording, with a reason) no longer blocks publishing and stays as a warning", r10.publishBlocker === null && r10.warnings.some((w) => /conflict acknowledged/.test(w)), r10.publishBlocker);
  const r11 = qualityReport({ ...base, expected: 100, questions: qs(100), expectedSources: [{ source: "printed on the question paper", value: 125 }], ack: { byId: actorId, at: "", note: "old explanation", missing: [], expected: 100, counted: 100, conflict: conflictText } });
  check("negative: an explanation of a DIFFERENT conflict does not unblock a new one", r11.publishBlocker !== null);

  // Scratch DB: the CMS 2024 P II job with the expected count NOT entered — taken from the printed paper and key.
  const job = await p2Job(examId, actorId, null);
  let q = await jobQuality(job.id);
  metric("job without an entered count", { expected: q?.expected, from: q?.expectedFrom, sources: q?.expectedSources, publishBlocker: q?.publishBlocker });
  check("DB: no count entered → 120 from the Word paper's header AND the key's header", q?.expected === 120 && (q?.expectedSources.length ?? 0) === 2 && q!.expectedSources.every((s) => s.value === 120));
  // Remove two questions from the extraction → incomplete; publishing refused, Draft still allowed.
  const two = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id, sourceNumber: { in: [59, 60] } }, select: { id: true } });
  await prisma.aiImportQuestion.deleteMany({ where: { id: { in: two.map((t) => t.id) } } });
  q = await jobQuality(job.id);
  let refused: string | null = null;
  try {
    await requestImport(job.id, actorId, "PUBLISH_ALL", null);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  check("DB: publishing an incomplete paper is refused with “120 expected / 118 extracted / 2 missing”", !!refused && /120 expected \/ 118 extracted \/ 2 missing/.test(refused), refused);
  check("DB: the refusal is logged (PUBLISH_BLOCKED_INCOMPLETE) and the job did not start importing", (await prisma.aiImportEvent.count({ where: { jobId: job.id, type: "PUBLISH_BLOCKED_INCOMPLETE" } })) === 1 && (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } })).status !== AiImportJobStatus.IMPORTING);
  await requestImport(job.id, actorId, "DRAFT", null);
  check("DB: Import as Draft is still allowed", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } })).status === AiImportJobStatus.IMPORTING);
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.NEEDS_REVIEW, config: {} } });
  await acknowledgeSequence(job.id, actorId, "Q59 and Q60 removed for this test only");
  refused = null;
  try {
    await requestImport(job.id, actorId, "PUBLISH_ALL", null);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  check("DB: after the difference is acknowledged with a reason, publishing is no longer refused for completeness", refused === null || !/expected/.test(refused), refused);
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.CANCELLED } });
  // Entered count that the printed totals contradict.
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { expectedQuestions: 100, status: AiImportJobStatus.NEEDS_REVIEW, config: {} } });
  q = await jobQuality(job.id);
  check("DB: entered 100 while paper and key print 120 → conflict blocks publishing", !!q?.expectedConflict && q.publishBlocker === q.expectedConflict, q?.publishBlocker);
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.CANCELLED } });
}

async function main() {
  await answerLines();
  await ocrLayers();
  await seedSettings();
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const { exam, ids } = await scratchExam();
  const job = await productionReplay(exam.id, admin.id);
  await referenceRead(job.id, admin.id);
  await opinions(job.id);
  await memory(exam.id, job.id, admin.id, ids);
  await expectedCount(exam.id, admin.id);
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.CANCELLED } }).catch(() => null);
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
