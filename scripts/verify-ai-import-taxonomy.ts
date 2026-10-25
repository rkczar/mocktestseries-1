/**
 * AI Question Importer — exam-specific subject / topic / subtopic classification (2026-10-23).
 *
 *   A. Pure checks (no DB, no AI): the free local classifier against a synthetic CMS-like exam taxonomy — exam-specific
 *      subjects, topic / subtopic hierarchy, common medical question patterns, paper and section context, age words,
 *      commonly confused subjects (ambiguous → not forced), too little text (an extraction problem), another exam's ids
 *      rejected (evidence, memory and Verify 1), confirmed examples, Verify 1's taxonomy verdicts.
 *   B. Scratch DB + its OWN loopback OpenRouter mock (port 3535), synthetic exams only: an import classified by the free
 *      classifier (AI only for what it cannot settle), classifier failures / missing answers flagged as such (never as
 *      "no subject fits"), another exam's ids cleared, Verify 1 classification findings (no AI call), Verify 2's
 *      independent classification with cost confirmation (agreed / disagreement / needs review / verification failed),
 *      agreement with Verify 1, OCR findings kept apart from taxonomy, admin corrections with audit + exam-scoped
 *      confirmed examples, taxonomy change refresh, bulk-correction safety, Question Bank / published variants untouched.
 *
 * No real AI request is possible (network guard). Removes its jobs, questions, synthetic exams / taxonomy, memory rows
 * and restores Import Settings.
 *
 *   NODE_OPTIONS=--conditions=react-server OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3535 FX_TEST_BASE_URL=http://127.0.0.1:3535 \
 *     npx tsx scripts/verify-ai-import-taxonomy.ts <empty fixtures dir>
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { contentFingerprint, verifyState } from "@/lib/ai-import/verify-core";
import { requestVerify2, runVerify1, verify2Preview } from "@/lib/ai-import/paper-verify";
import { bulkSetTaxonomy, reclassifyQuestions, setTaxonomy } from "@/lib/ai-import/review";
import { refreshRoutes } from "@/lib/ai-import/routes";
import { buildTaxonomyIndex, classifyLocally, classifyPaper, textSufficient, verifyStoredTaxonomy, type LocalClassification } from "@/lib/ai-import/taxonomy-classify";
import { TAXONOMY_MEMORY_PREFIX, classifierContext, loadExamMemory, taxonomyFingerprint, validEntries } from "@/lib/ai-import/taxonomy-memory";
import { buildZip } from "@/lib/rich-import/zip-writer";
import { getExamTaxonomy, type ExamTaxonomySubject } from "@/lib/exam-taxonomy";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { ClassificationRecord, ExtractedQuestion } from "@/lib/ai-import/types";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const MOCK = process.env.OPENROUTER_TEST_BASE_URL ?? "";
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !/^http:\/\/127\.0\.0\.1:3535$/.test(MOCK)) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR (scratch) and OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3535 (this suite's own mock).");
  process.exit(2);
}
const FX = process.argv[2];
if (!FX) {
  console.error("usage: verify-ai-import-taxonomy.ts <fixtures dir>");
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

// ---- A synthetic CMS-like exam (pure) ------------------------------------------------------------------------

const st = (id: string, name: string, topicId: string) => ({ id, name, topicId });
const tp = (id: string, name: string, subjectId: string, subs: [string, string][] = []) => ({ id, name, subjectId, syllabusDescription: null, subTopics: subs.map(([i, n]) => st(i, n, id)) });
const PURE: ExamTaxonomySubject[] = [
  { id: "s-gm", name: "General Medicine", syllabusDescription: null, topics: [tp("t-cvs", "Cardiovascular Diseases", "s-gm", [["u-hs", "Heart Sounds"], ["u-valve", "Valvular Heart Disease"]]), tp("t-resp", "Respiratory Diseases", "s-gm"), tp("t-renal", "Renal Diseases", "s-gm"), tp("t-neuro", "Neurology", "s-gm"), tp("t-gi", "Gastrointestinal Diseases", "s-gm"), tp("t-poison", "Poisoning", "s-gm"), tp("t-endo", "Endocrinology", "s-gm")] },
  { id: "s-ped", name: "Pediatrics", syllabusDescription: null, topics: [tp("t-neo", "Neonatology", "s-ped"), tp("t-imm", "Immunization", "s-ped"), tp("t-gd", "Growth & Development", "s-ped"), tp("t-pgi", "Gastrointestinal Disorders", "s-ped")] },
  { id: "s-derm", name: "Dermatology", syllabusDescription: null, topics: [tp("t-pig", "Pigmentary Disorders", "s-derm"), tp("t-papsq", "Papulosquamous Disorders", "s-derm"), tp("t-lep", "Leprosy", "s-derm")] },
  { id: "s-psy", name: "Psychiatry", syllabusDescription: null, topics: [tp("t-mood", "Mood Disorders", "s-psy"), tp("t-schizo", "Schizophrenia", "s-psy")] },
  { id: "s-gk", name: "General Knowledge", syllabusDescription: null, topics: [] },
];
const OTHER: ExamTaxonomySubject[] = [{ id: "x-anat", name: "Anatomy", syllabusDescription: null, topics: [tp("x-ul", "Upper Limb", "x-anat")] }];
const Q = (stem: string, options: string[]) => ({ stem, options: options.map((t, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: t })) });
/** Medical question patterns with the subject › topic they belong to. */
const PATTERNS: [ReturnType<typeof Q>, string, string][] = [
  [Q("Which of the following heart sounds are best heard with the bell of the stethoscope?\nI. Opening snap\nII. Third heart sound", ["I only", "II only", "Both", "Neither"]), "s-gm", "t-cvs"],
  [Q("A 55 year old man with crushing chest pain has ST elevation on ECG. The most likely diagnosis is", ["Myocardial infarction", "Pericarditis", "Aortic dissection", "Pneumothorax"]), "s-gm", "t-cvs"],
  [Q("The first-line controller in persistent bronchial asthma with wheeze and cough is", ["Inhaled corticosteroid", "Oral theophylline", "Montelukast only", "Salbutamol only"]), "s-gm", "t-resp"],
  [Q("Massive proteinuria, hypoalbuminemia and edema in an adult define", ["Nephrotic syndrome", "Nephritic syndrome", "Renal tubular acidosis", "Acute kidney injury"]), "s-gm", "t-renal"],
  [Q("A 30 year old woman with recurrent unilateral throbbing headache with aura most likely has", ["Migraine", "Cluster headache", "Tension headache", "Trigeminal neuralgia"]), "s-gm", "t-neuro"],
  [Q("The antidote for organophosphate poisoning is", ["Atropine", "Naloxone", "Flumazenil", "Fomepizole"]), "s-gm", "t-poison"],
  [Q("A newborn with birth weight 1.8 kg develops jaundice on day one of life. The next step is", ["Serum bilirubin", "Discharge", "Phototherapy only", "Exchange transfusion"]), "s-ped", "t-neo"],
  [Q("A 9 month old child should receive which vaccine under the national immunization schedule?", ["Measles", "BCG", "Hepatitis B birth dose", "Typhoid"]), "s-ped", "t-imm"],
  [Q("At what age does a child normally walk alone and build a tower of three cubes (developmental milestone)?", ["15 months", "6 months", "9 months", "3 years"]), "s-ped", "t-gd"],
  [Q("Depigmented macules with leukotrichia and loss of melanocytes are seen in", ["Vitiligo", "Melasma", "Pityriasis versicolor", "Albinism"]), "s-derm", "t-pig"],
  [Q("Silvery scaling plaques on the extensor surfaces with Auspitz sign suggest", ["Psoriasis", "Lichen planus", "Eczema", "Tinea corporis"]), "s-derm", "t-papsq"],
  [Q("Thickened peripheral nerves with an anaesthetic hypopigmented patch suggest", ["Leprosy", "Vitiligo", "Tinea", "Pityriasis alba"]), "s-derm", "t-lep"],
  [Q("Lithium is the drug of choice for maintenance treatment of which mood disorder?", ["Bipolar disorder", "Schizophrenia", "Panic disorder", "Dementia"]), "s-psy", "t-mood"],
  [Q("Auditory hallucinations and fixed delusions of persecution for eight months in a young adult suggest", ["Schizophrenia", "Mania", "Delirium", "Depression"]), "s-psy", "t-schizo"],
];

// ---- DB fixtures -----------------------------------------------------------------------------------------------

const RUN = Date.now().toString(36);
const TAG = `tx${RUN}`;
const BR = `<w:br w:type="textWrapping"/>`;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  options: string[];
  answer: "a" | "b" | "c" | "d";
}
/**
 * The paper (CMS-like layout: Medicine block, then Dermatology / Psychiatry, then Pediatrics). Questions whose text
 * contains a topic's exact name are what the mock classifier (and Verify 2's mock model) can place. Q5 and Q6 are
 * deliberately generic (genuinely uncertain), Q12 has too little text (an extraction problem).
 */
const SRC: SrcQ[] = [
  { n: 1, stem: "In cardiovascular diseases, which of the following heart sounds are best heard with the bell of the stethoscope?\nI. Opening snap\nII. Third heart sound", options: ["I only", "II only", "Both I and II", "Neither"], answer: "b" },
  { n: 2, stem: "A 60 year old man with exertional angina, syncope and an ejection systolic murmur radiating to the carotids most likely has", options: ["Aortic stenosis", "Mitral stenosis", "Tricuspid regurgitation", "Pulmonary stenosis"], answer: "a" },
  { n: 3, stem: "Among respiratory diseases, the first-line controller for persistent bronchial asthma with nocturnal wheeze and cough is", options: ["Inhaled corticosteroid", "Oral theophylline", "Salbutamol only", "Antibiotics"], answer: "a" },
  { n: 4, stem: "Massive proteinuria, hypoalbuminemia, hyperlipidemia and generalized edema in an adult define which renal diseases syndrome?", options: ["Nephrotic syndrome", "Nephritic syndrome", "Renal tubular acidosis", "Acute kidney injury"], answer: "a" },
  { n: 5, stem: "Which of the following statements is correct about the given option?", options: ["Alpha only", "Beta only", "Alpha and beta", "Neither alpha nor beta"], answer: "c" },
  { n: 6, stem: "Which of the following is the most important first step in management?", options: ["Observation", "Reassurance", "Referral", "Follow up"], answer: "a" },
  { n: 7, stem: "Depigmented macules with leukotrichia and loss of melanocytes are typical of which of the pigmentary disorders?", options: ["Vitiligo", "Melasma", "Pityriasis versicolor", "Albinism"], answer: "a" },
  { n: 8, stem: "Silvery scaling plaques on the extensor surfaces with a positive Auspitz sign and Koebner phenomenon suggest", options: ["Psoriasis", "Lichen planus", "Eczema", "Tinea corporis"], answer: "a" },
  { n: 9, stem: "Lithium is the drug of choice for maintenance treatment of which of the mood disorders?", options: ["Bipolar affective disorder", "Schizophrenia", "Panic disorder", "Dementia"], answer: "a" },
  { n: 10, stem: "A newborn in neonatology care with birth weight 1.8 kg develops jaundice within 24 hours of birth. The next step is", options: ["Serum bilirubin estimation", "Discharge home", "Oral vitamins", "Wait and watch"], answer: "a" },
  { n: 11, stem: "A 9 month old child attends for immunization: which vaccine is due at this age under the national schedule?", options: ["Measles-rubella", "BCG", "Hepatitis B birth dose", "Typhoid conjugate"], answer: "a" },
  { n: 12, stem: "Which?", options: ["", "", "", ""], answer: "a" },
];
for (const q of SRC) q.stem = q.stem.replace(/^([^\n]*)/, `$1 (paper ${RUN})`);
function paperParagraphs(qs: SrcQ[]): string[] {
  const out = [p("Synthetic CMS-like paper — taxonomy regression.")];
  for (const q of qs) {
    out.push(p(`Q${q.n}. ${q.stem}`));
    q.options.forEach((o, i) => out.push(p(`(${"abcd"[i]}) ${o}`)));
    out.push(p(`Ans: (${q.answer})`));
  }
  return out;
}
const read = (q: SrcQ) => ({ number: q.n, type: "SINGLE_CORRECT", stem: q.stem, options: q.options.map((t, i) => ({ label: `(${"abcd"[i]})`, text: t })), printed_answer: [`(${q.answer})`], confidence: 0.95 });

// ---- Helpers ---------------------------------------------------------------------------------------------

const jobs: string[] = [];
async function upload(actor: string, jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId: null });
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
const byLabel = (qs: QRow[], label: string) => qs.find((q) => q.sourceLabel === label)!;
const eff = (q: QRow) => (q.editedData ?? q.data) as unknown as ExtractedQuestion;
const rec = (q: QRow) => (q.data as unknown as ExtractedQuestion).classification as ClassificationRecord | undefined;
const fp = (q: QRow) => contentFingerprint({ e: eff(q), finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures });
const vsOf = (q: QRow) => verifyState(q.data, fp(q));
const events = (jobId: string, type: string) => prisma.aiImportEvent.findMany({ where: { jobId, type }, orderBy: { createdAt: "asc" } });
const issue = (q: QRow, code: string) => ((q.issues as Record<string, string> | null) ?? {})[code] ?? "";
const refuse = async (fn: () => Promise<unknown>) => fn().then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));

/** A synthetic exam with its own canonical taxonomy (names tagged per run; nameKey is globally unique). */
async function makeExam(code: string, name: string, tax: ExamTaxonomySubject[]) {
  const exam = await prisma.exam.create({ data: { name, code, isActive: false } });
  const ids = new Map<string, string>();
  let order = 0;
  for (const s of tax) {
    const subj = await prisma.subject.create({ data: { name: `${s.name} ${TAG}`, nameKey: `${s.name} ${TAG}`.toLowerCase(), originExamId: exam.id } });
    ids.set(s.id, subj.id);
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: subj.id, displayOrder: order++ } });
    for (const t of s.topics) {
      const topic = await prisma.topic.create({ data: { subjectId: subj.id, name: t.name, nameKey: t.name.toLowerCase() } });
      ids.set(t.id, topic.id);
      await prisma.examTopic.create({ data: { examId: exam.id, topicId: topic.id, displayOrder: order++ } });
      for (const u of t.subTopics) {
        const sub = await prisma.subTopic.create({ data: { topicId: topic.id, name: u.name, nameKey: u.name.toLowerCase() } });
        ids.set(u.id, sub.id);
        await prisma.examSubTopic.create({ data: { examId: exam.id, subTopicId: sub.id, displayOrder: order++ } });
      }
    }
  }
  return { exam, ids };
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  // Question Bank + published AI variants before anything runs (they must be byte-identical afterwards).
  const bankSnapshot = async () => {
    const rows = await prisma.question.findMany({ where: { NOT: { code: { startsWith: `TX ${RUN} ` } } }, select: { id: true, status: true, updatedAt: true, subjectId: true, topicId: true, subTopicId: true, aiVariantType: true }, orderBy: { id: "asc" } });
    return { count: rows.length, variants: rows.filter((r) => r.aiVariantType && r.aiVariantType !== "CANONICAL" && r.status === "PUBLISHED").length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16) };
  };
  const bankBefore = await bankSnapshot();
  const created: { exams: string[]; subjects: string[]; questions: string[] } = { exams: [], subjects: [], questions: [] };
  let mockProc: ChildProcess | null = null;

  try {
    // ------------------------------------------------------------------ A
    section("A. Free local classifier (pure, no DB, no AI)");
    const evidence = [
      { topicId: "t-cvs", text: "Pansystolic murmur at the apex radiating to the axilla suggests mitral regurgitation" },
      { topicId: "t-resp", text: "Spirometry FEV1/FVC ratio below 0.7 after bronchodilator confirms COPD" },
      { topicId: "t-renal", text: "Red cell casts in urine with hypertension indicate glomerulonephritis" },
      { topicId: "t-neo", text: "Physiological jaundice of the newborn appears after 24 hours" },
      { topicId: "x-ul", text: "Wrist drop due to radial nerve injury in the spiral groove" },
    ];
    const index = buildTaxonomyIndex(PURE, evidence, null);
    check("evidence of a topic that is not in this exam (another exam's Upper Limb) is ignored", !index.evidenceCount.has("x-ul") && index.evidenceCount.get("t-cvs") === 1, [...index.evidenceCount]);
    const { results } = classifyPaper(index, PATTERNS.map(([q]) => q), { topicMin: 0.7 });
    const okSubjects = PATTERNS.filter(([, s], i) => results[i].subjectId === s).length;
    const okTopics = PATTERNS.filter(([, , t], i) => results[i].topicId === t).length;
    const wrongSubjects = PATTERNS.filter(([, s], i) => results[i].subjectId && results[i].subjectId !== s);
    check(`common medical question patterns: subject right for ≥ 12 of ${PATTERNS.length}, never a wrong subject`, okSubjects >= 12 && wrongSubjects.length === 0, PATTERNS.map(([q, s, t], i) => [q.stem.slice(0, 40), s, t, results[i].status, results[i].subjectId, results[i].topicId, Math.round(results[i].subjectConfidence * 100)]));
    check(`common medical question patterns: topic right for ≥ 10 of ${PATTERNS.length}, never a wrong topic`, okTopics >= 10 && PATTERNS.every(([, , t], i) => !results[i].topicId || results[i].topicId === t), PATTERNS.map(([, , t], i) => [t, results[i].topicId, Math.round(results[i].topicConfidence * 100)]));
    const all = PURE.flatMap((s) => [s.id, ...s.topics.flatMap((t) => [t.id, ...t.subTopics.map((u) => u.id)])]);
    check("every returned id belongs to this exam's taxonomy (subject → topic → subtopic hierarchy intact)", results.every((r) => (!r.subjectId || all.includes(r.subjectId)) && (!r.topicId || PURE.find((s) => s.id === r.subjectId)!.topics.some((t) => t.id === r.topicId)) && (!r.subTopicId || PURE.flatMap((s) => s.topics).find((t) => t.id === r.topicId)!.subTopics.some((u) => u.id === r.subTopicId))));
    const heart = classifyLocally(index, PATTERNS[0][0], { topicMin: 0.7 });
    check("a subtopic is chosen only when its words are in the question (Heart Sounds), and only under its topic", heart.topicId === "t-cvs" && heart.subTopicId === "u-hs", heart);
    check("no subtopic when none is clearly named (an optional subtopic is not forced)", results[1].topicId !== "t-cvs" || results[1].subTopicId === null, results[1]);
    check("each result explains itself: names, confidence and the matched words", /General Medicine › Cardiovascular Diseases/.test(heart.reason) && /subject \d+%/.test(heart.reason) && /matched/.test(heart.reason), heart.reason);
    // Ambiguous: GI disease without an age → General Medicine vs Pediatrics (commonly confused) → not forced.
    const diarrhoea = Q("Acute watery diarrhoea with some dehydration is best treated with oral rehydration solution and zinc for gastrointestinal disorders", ["ORS and zinc", "Antibiotics", "Antimotility drugs", "Intravenous fluids always"]);
    const amb = classifyLocally(index, diarrhoea, { topicMin: 0.7 });
    check("ambiguous question (fits two commonly confused subjects) → UNCERTAIN with the reason, nothing assigned", amb.status === "UNCERTAIN" && !amb.subjectId && /commonly confused|fit several subjects/.test(amb.reason), amb);
    const child = classifyLocally(index, { ...diarrhoea, stem: `A 2 year old child has ${diarrhoea.stem.toLowerCase()}` }, { topicMin: 0.7 });
    check("the same question about a 2 year old child → Pediatrics (age words settle the pair)", child.subjectId === "s-ped", child);
    const generic = classifyLocally(index, Q("Which of the following is the most important first step in management?", ["Observation", "Reassurance", "Referral", "Follow up"]), { topicMin: 0.7 });
    check("a question with no subject-specific words → UNCERTAIN (never filled in to complete the field)", !generic.subjectId && generic.status !== "CLASSIFIED", generic);
    const tiny = classifyLocally(index, Q("Which?", ["", "", "", ""]), {});
    check("too little text → INSUFFICIENT_TEXT (an extraction problem, not a taxonomy one)", tiny.status === "INSUFFICIENT_TEXT" && /text/.test(tiny.reason) && !textSufficient(Q("Which?", ["", "", "", ""])).ok, tiny);
    const single = classifyLocally(index, PATTERNS[9][0], { allowedSubjects: ["s-gm"], topicMin: 0.7 });
    check("a single-subject paper / printed heading limits the choice to that subject (no other subject returned)", single.subjectId === "s-gm" || single.subjectId === null, single);
    check("a heading subject of another exam → NO_TAXONOMY (not part of this exam), nothing assigned", classifyLocally(index, PATTERNS[0][0], { allowedSubjects: ["x-anat"] }).status === "NO_TAXONOMY");
    check("an exam without any taxonomy → NO_TAXONOMY with the missing-configuration reason", /no subjects configured/.test(classifyLocally(buildTaxonomyIndex([], [], null), PATTERNS[0][0]).reason));
    // Section context: a Pediatrics block after a Medicine block keeps its subject.
    const blocks = classifyPaper(index, [...PATTERNS.slice(0, 6).map(([q]) => q), ...PATTERNS.slice(6, 9).map(([q]) => q)], { topicMin: 0.7 });
    check("paper / section context: the Pediatrics block after a Medicine block stays Pediatrics", blocks.results.slice(6).every((r) => r.subjectId === "s-ped" || !r.subjectId) && blocks.results.slice(6).some((r) => r.subjectId === "s-ped") && blocks.prior.size > 0, blocks.results.map((r) => r.subjectId));
    // Memory: confirmed examples (this exam only), synonyms, foreign ids ignored.
    const memIndex = buildTaxonomyIndex(PURE, [], { synonyms: [{ term: "zebra stripes sign", subjectId: "s-derm", topicId: "t-pig" }, { term: "foreign", subjectId: "x-anat", topicId: "x-ul" }], confusions: [{ a: "s-gm", b: "x-anat", note: null }], corrections: [{ id: "c1", text: "Which enzyme deficiency causes the classic zebra bodies storage finding in this rare disorder?", subjectId: "s-gm", topicId: "t-endo", subTopicId: null }, { id: "c2", text: "Which nerve is injured in wrist drop after a fracture?", subjectId: "x-anat", topicId: "x-ul", subTopicId: null }] });
    const confirmed = classifyLocally(memIndex, Q("Which enzyme deficiency causes the classic zebra bodies storage finding in this rare disorder?", ["A", "B", "C", "D"]), {});
    check("a confirmed example of THIS exam gives its mapping (method: confirmed example)", confirmed.method === "confirmed example" && confirmed.subjectId === "s-gm" && confirmed.topicId === "t-endo", confirmed);
    const foreign = classifyLocally(memIndex, Q("Which nerve is injured in wrist drop after a fracture?", ["Radial", "Ulnar", "Median", "Axillary"]), {});
    check("a stored example / synonym / confusion pair with ANOTHER exam's ids is never used", foreign.method === "local terms" && foreign.subjectId !== "x-anat" && memIndex.corrections.length === 1 && memIndex.confusions.every((c) => c.a !== "x-anat" && c.b !== "x-anat"), [foreign, memIndex.corrections.length]);
    check("an administrator synonym is evidence for its topic", classifyLocally(memIndex, Q("The zebra stripes sign is seen in which condition of the skin?", ["Vitiligo", "Melasma", "Albinism", "Piebaldism"]), {}).topicId === "t-pig");
    // Verify 1 verdicts.
    const loc = (o: Partial<LocalClassification>): LocalClassification => ({ status: "CLASSIFIED", subjectId: "s-gm", topicId: "t-cvs", subTopicId: null, subjectConfidence: 0.9, topicConfidence: 0.9, method: "local terms", matched: ["murmur"], reason: "General Medicine › Cardiovascular Diseases", candidates: [], confusedWith: null, ...o });
    const v = (stored: Partial<Parameters<typeof verifyStoredTaxonomy>[0]>, l: LocalClassification | null) => verifyStoredTaxonomy({ subjectId: null, topicId: null, subTopicId: null, source: "AI (m)", ...stored }, l, PURE);
    check("Verify 1: stored = independent → AGREED", v({ subjectId: "s-gm", topicId: "t-cvs" }, loc({})).verification.status === "AGREED");
    const foreignStored = v({ subjectId: "x-anat", topicId: "x-ul" }, loc({}));
    check("Verify 1: a subject of ANOTHER exam → DISAGREEMENT, TAXONOMY_DISAGREES (not part of this exam)", foreignStored.verification.status === "DISAGREEMENT" && foreignStored.problems[0]?.code === "TAXONOMY_DISAGREES" && /not part of this exam/.test(foreignStored.problems[0].detail), foreignStored);
    check("Verify 1: a topic not under its subject / a subtopic not under its topic → DISAGREEMENT", v({ subjectId: "s-gm", topicId: "t-pig" }, loc({})).verification.status === "DISAGREEMENT" && v({ subjectId: "s-gm", topicId: "t-cvs", subTopicId: "u-x" }, loc({})).verification.status === "DISAGREEMENT");
    const wrongSubj = v({ subjectId: "s-derm", topicId: "t-pig" }, loc({ subjectConfidence: 0.92 }));
    check("Verify 1: a confident independent subject elsewhere → DISAGREEMENT with the reason (stored AI choice flagged)", wrongSubj.verification.status === "DISAGREEMENT" && wrongSubj.problems.length === 1 && /Dermatology vs General Medicine/.test(wrongSubj.verification.findings[0]), wrongSubj);
    const adminWrong = v({ subjectId: "s-derm", topicId: "t-pig", source: "admin" }, loc({ subjectConfidence: 0.92 }));
    check("Verify 1: an administrator's choice is shown as a disagreement but never flagged / overridden", adminWrong.verification.status === "DISAGREEMENT" && adminWrong.problems.length === 0 && /administrator's choice is kept/.test(adminWrong.verification.findings[0]), adminWrong);
    check("Verify 1: an administrator's choice the free check cannot confirm is NOT 'agreed' (admin ≠ verified)", v({ subjectId: "s-gm", topicId: "t-cvs", source: "admin" }, loc({ status: "UNCERTAIN", subjectId: null, topicId: null })).verification.status === "NEEDS_REVIEW");
    check("Verify 1: a weak independent disagreement → NEEDS_REVIEW, no flag (not decisive)", (() => { const r = v({ subjectId: "s-derm" }, loc({ subjectConfidence: 0.65 })); return r.verification.status === "NEEDS_REVIEW" && !r.problems.length; })());
    check("Verify 1: a stored subject far behind the free check's own choice → DISAGREEMENT even below 80% (granite: heart sounds → Biochemistry)", (() => { const r = v({ subjectId: "s-derm" }, loc({ subjectConfidence: 0.7, subjectScores: [{ subjectId: "s-gm", score: 10 }, { subjectId: "s-derm", score: 2 }] })); return r.verification.status === "DISAGREEMENT" && r.problems.length === 1 && /scores 20% of it/.test(r.verification.findings[0]); })());
    check("Verify 1: no subject stored → NEEDS_REVIEW with the free check's suggestion", /suggests General Medicine/.test(v({}, loc({})).verification.findings[0]));
    check("Verify 1: too little text → NOT_VERIFIED (extraction problem, not a taxonomy one)", (() => { const r = v({ subjectId: "s-gm" }, loc({ status: "INSUFFICIENT_TEXT", subjectId: null, reason: "not classified: the question text is empty" })); return r.verification.status === "NOT_VERIFIED" && /extraction problem/.test(r.verification.findings[0]); })());
    check("Verify 1: subject confirmed but no topic stored → NEEDS_REVIEW (topic suggested, never applied)", v({ subjectId: "s-gm" }, loc({})).verification.status === "NEEDS_REVIEW");
    check("taxonomy fingerprint changes when a topic is renamed / removed", taxonomyFingerprint(PURE) !== taxonomyFingerprint([{ ...PURE[0], topics: PURE[0].topics.slice(1) }, ...PURE.slice(1)]));
    const valid = validEntries({ examId: "e", version: 1, taxonomyFingerprint: "", synonyms: [{ id: "1", term: "x", subjectId: "s-gm", topicId: "t-cvs", byId: "a", at: "" }, { id: "2", term: "y", subjectId: "x-anat", topicId: "x-ul", byId: "a", at: "" }], confusions: [], corrections: [{ id: "3", text: "t", subjectId: "s-gm", topicId: "t-pig", subTopicId: null, jobId: "j", questionId: "q", byId: "a", at: "", source: "admin correction" }], lastRefresh: null, updatedAt: "" }, PURE);
    check("memory entries outside the exam's hierarchy (another exam's topic, a topic under another subject) are invalid", valid.synonyms.length === 1 && valid.corrections.length === 0, valid);

    // ------------------------------------------------------------------ setup
    section("B. Scratch import (synthetic exams, mocked AI only)");
    const A = await makeExam(`TAXA${RUN}`.toUpperCase().slice(0, 20), `Taxonomy CMS ${TAG}`, PURE);
    const B = await makeExam(`TAXB${RUN}`.toUpperCase().slice(0, 20), `Taxonomy Other ${TAG}`, OTHER);
    created.exams.push(A.exam.id, B.exam.id);
    created.subjects.push(...[...A.ids.entries(), ...B.ids.entries()].filter(([k]) => k.startsWith("s-") || k.startsWith("x-anat")).map(([, v]) => v));
    const idOf = (k: string) => A.ids.get(k)!;
    // Reviewed evidence (published, canonical) + an AI variant and a flagged question that must NOT count as evidence.
    let seq = 0;
    const mkQ = async (topicKey: string, text: string, extra: Record<string, unknown> = {}) => {
      const subjectKey = PURE.find((s) => s.topics.some((t) => t.id === topicKey))!.id;
      const q = await prisma.question.create({ data: { code: `TX ${RUN} ${++seq}`, examId: A.exam.id, subjectId: idOf(subjectKey), topicId: idOf(topicKey), text, status: "PUBLISHED", options: { create: ["One", "Two", "Three", "Four"].map((t, i) => ({ label: "ABCD"[i], text: t, order: i, isCorrect: i === 0 })) }, ...extra } });
      created.questions.push(q.id);
      return q;
    };
    const parent = await mkQ("t-cvs", "Pansystolic murmur at the apex radiating to the axilla suggests mitral regurgitation");
    await mkQ("t-resp", "Spirometry with FEV1/FVC below 0.7 after bronchodilator confirms chronic obstructive pulmonary disease");
    await mkQ("t-pig", "A variant about vitiligo wrongly filed under pigmentation", { aiVariantType: "AI_SIMILAR", parentQuestionId: parent.id, aiSlot: "AI01" });
    await mkQ("t-schizo", "A question whose topic is doubtful", { reviewRequired: true, reviewReason: 'Topic "Psychosis" not found for subject "Psychiatry" — needs mapping' });
    await mkQ("t-neo", "Physiological jaundice of the newborn appears after twenty four hours of birth", { reviewRequired: true, reviewReason: "Sub-topic not provided · Difficulty not provided, will default to MEDIUM" });
    const ctxA = await classifierContext(A.exam.id);
    check("classifier context: this exam's taxonomy only; published canonical questions as evidence (AI variant and a doubtful-topic flag excluded, a formatting-only flag kept)", ctxA.taxonomy.length === PURE.length && ctxA.evidenceQuestions === 3, [ctxA.taxonomy.length, ctxA.evidenceQuestions]);

    writeFileSync(path.join(FX, "tx-paper.docx"), docx(paperParagraphs(SRC)));
    const parts = [SRC.slice(0, 8), SRC.slice(8)];
    writeFileSync(path.join(FX, "tx-mock.json"), JSON.stringify({ pages: {}, keys: {}, text: parts.map((qs) => ({ match: qs[0].stem.slice(0, 50), questions: qs.map(read), checker: { questions: qs.map(read) } })) }));
    mockProc = spawn(process.execPath, ["scripts/mock-openrouter-vision.mjs", "3535", path.join(FX, "tx-mock.json")], { stdio: "ignore" });
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

    // ------------------------------------------------------------------ B1
    section("B1. Import: free classifier first, AI only for what it cannot settle");
    const j1 = await createJob({ actorId: actor, title: `Taxonomy ${TAG}`, examId: A.exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2025, paperCode: null, previousYearPaperId: null, expectedQuestions: SRC.length });
    jobs.push(j1);
    await upload(actor, j1, "tx-paper.docx");
    const before1 = await mockStats();
    const job1 = await runJob(actor, j1);
    const after1 = await mockStats();
    let qs = await questionsOf(j1);
    check(`DOCX read locally: ${SRC.length} questions, job waiting for review`, qs.length === SRC.length && job1.status === "NEEDS_REVIEW", [qs.length, job1.status, job1.errorMessage]);
    const expected: Record<string, [string, string]> = { "1": ["s-gm", "t-cvs"], "2": ["s-gm", "t-cvs"], "3": ["s-gm", "t-resp"], "4": ["s-gm", "t-renal"], "7": ["s-derm", "t-pig"], "8": ["s-derm", "t-papsq"], "9": ["s-psy", "t-mood"], "10": ["s-ped", "t-neo"], "11": ["s-ped", "t-imm"] };
    const right = Object.entries(expected).filter(([l, [s]]) => byLabel(qs, l).subjectId === idOf(s));
    check("exam-specific subjects: the medical questions get the right subject of THIS exam (database ids)", right.length >= 8 && Object.entries(expected).every(([l, [s]]) => !byLabel(qs, l).subjectId || byLabel(qs, l).subjectId === idOf(s)), Object.entries(expected).map(([l, [s, t]]) => [l, s, t, byLabel(qs, l).subjectId === idOf(s), byLabel(qs, l).topicId === idOf(t), byLabel(qs, l).taxonomySource]));
    const links = new Set((await prisma.examSubject.findMany({ where: { examId: A.exam.id } })).map((l) => l.subjectId));
    check("every stored subject / topic is linked to the selected exam (never another exam's)", qs.every((q) => !q.subjectId || links.has(q.subjectId)) && (await prisma.examTopic.count({ where: { examId: A.exam.id, topicId: { in: qs.map((q) => q.topicId).filter((x): x is string => !!x) } } })) === new Set(qs.map((q) => q.topicId).filter(Boolean)).size);
    const q1 = byLabel(qs, "1");
    check("topic + subtopic: Q1 → Cardiovascular Diseases › Heart Sounds (subtopic under its topic)", q1.topicId === idOf("t-cvs") && q1.subTopicId === idOf("u-hs"), [q1.topicId, q1.subTopicId, rec(q1)?.reason]);
    check("assigned by the free classifier (source, confidence, reason with matched words recorded)", q1.taxonomySource === "local classifier" && (q1.taxonomyConfidence ?? 0) >= 0.7 && rec(q1)?.kind === "ok" && /matched/.test(rec(q1)?.reason ?? ""), [q1.taxonomySource, q1.taxonomyConfidence, rec(q1)]);
    const localEv = (await events(j1, "LOCAL_CLASSIFY_RESULT")).at(-1);
    check("a LOCAL_CLASSIFY_RESULT event reports the free classification (counts, evidence)", !!localEv && /Free subject \/ topic classification/.test(localEv.message) && /3 reviewed Question Bank/.test(localEv.message), localEv?.message);
    const aiCalls = (after1.byTask?.classify ?? 0) - (before1.byTask?.classify ?? 0);
    const sentToAi = (((await events(j1, "CLASSIFY_RESULT")).at(-1)?.data ?? {}) as { questions?: number }).questions ?? 0;
    check("the AI classifier only got the questions the free one could not settle (fewer than all, one request)", aiCalls === 1 && sentToAi > 0 && sentToAi < SRC.length, [aiCalls, sentToAi]);
    const q5 = byLabel(qs, "5");
    const q6 = byLabel(qs, "6");
    check("genuinely uncertain questions (Q5, Q6) → Subject unknown with BOTH reasons (free check + AI), not forced", [q5, q6].every((q) => !q.subjectId && q.issueCodes.includes("SUBJECT_UNKNOWN") && rec(q)?.kind === "uncertain" && /No subject of this exam fits reliably/.test(issue(q, "SUBJECT_UNKNOWN")) && /AI classifier/.test(issue(q, "SUBJECT_UNKNOWN"))), [q5.issueCodes, issue(q5, "SUBJECT_UNKNOWN")]);
    check("an unknown subject is ONE flag (no extra 'Topic missing' on top)", !q5.issueCodes.includes("TOPIC_UNCERTAIN"), q5.issueCodes);
    const q12 = byLabel(qs, "12");
    check("too little text (Q12) → classified as an extraction problem, kept apart from taxonomy (OPTIONS_INCOMPLETE + text_incomplete)", rec(q12)?.kind === "text_incomplete" && /extraction problem/.test(issue(q12, "SUBJECT_UNKNOWN")) && q12.issueCodes.includes("OPTIONS_INCOMPLETE"), [q12.issueCodes, rec(q12)]);
    check("correct, complete questions with a confident topic carry no taxonomy flag", ["1", "3", "4"].every((l) => !byLabel(qs, l).issueCodes.some((c) => ["SUBJECT_UNKNOWN", "TOPIC_UNCERTAIN", "CLASSIFICATION_FAILED"].includes(c))), ["1", "3", "4"].map((l) => byLabel(qs, l).issueCodes));
    const memRow = await prisma.setting.findUnique({ where: { key: `${TAXONOMY_MEMORY_PREFIX}${A.exam.id}` } });
    check("AI / local predictions are never stored as knowledge (no memory row after an import)", !memRow);

    // ------------------------------------------------------------------ B2
    section("B2. Classifier failures and missing answers (engine failure ≠ 'no subject fits')");
    await mockConfig({ classifyKeep: 0 });
    await reclassifyQuestions([q5.id, q6.id], actor);
    await runWorker(300_000);
    qs = await questionsOf(j1);
    check("model answered for NO question → CLASSIFICATION_FAILED (engine failure), not SUBJECT_UNKNOWN", ["5", "6"].every((l) => byLabel(qs, l).issueCodes.includes("CLASSIFICATION_FAILED") && !byLabel(qs, l).issueCodes.includes("SUBJECT_UNKNOWN") && rec(byLabel(qs, l))?.kind === "engine_failure" && rec(byLabel(qs, l))?.ai?.status === "NO_RESULT"), ["5", "6"].map((l) => [byLabel(qs, l).issueCodes, rec(byLabel(qs, l))?.ai]));
    check("…the flag says why (no answer from the model) and that it is a failure, not a judgement", /returned no answer/.test(issue(byLabel(qs, "5"), "CLASSIFICATION_FAILED")) && /not a judgement/.test(issue(byLabel(qs, "5"), "CLASSIFICATION_FAILED")), issue(byLabel(qs, "5"), "CLASSIFICATION_FAILED"));
    const cr = (await events(j1, "CLASSIFY_RESULT")).at(-1);
    check("…and the CLASSIFY_RESULT event counts the missing answers", /got no answer from the model/.test(cr?.message ?? "") && ((cr?.data as { missing?: number })?.missing ?? 0) === 2, cr?.message);
    // Every classification request fails (the allowed fallback model too): the request failed — a failure, not a result.
    await mockConfig({ classifyKeep: null, failTask: { classify: [502, "mock: upstream error"] } });
    await reclassifyQuestions([q5.id], actor);
    await runWorker(300_000);
    qs = await questionsOf(j1);
    check("a failed classification request → CLASSIFICATION_FAILED (FAILED, with the error), never counted as a result", byLabel(qs, "5").issueCodes.includes("CLASSIFICATION_FAILED") && rec(byLabel(qs, "5"))?.ai?.status === "FAILED" && /request failed/.test(issue(byLabel(qs, "5"), "CLASSIFICATION_FAILED")), [byLabel(qs, "5").issueCodes, rec(byLabel(qs, "5"))?.ai]);
    await mockConfig({ failTask: {} });

    // ------------------------------------------------------------------ B3
    section("B3. Another exam's ids are rejected");
    const foreignSubject = B.ids.get("x-anat")!;
    const foreignTopic = B.ids.get("x-ul")!;
    check("setting a subject of ANOTHER exam is refused (nothing changed)", /not configured for this exam/.test(await refuse(() => setTaxonomy(byLabel(qs, "6").id, actor, foreignSubject, foreignTopic, null))));
    check("setting a topic under another subject is refused", /does not belong to the subject/.test(await refuse(() => setTaxonomy(byLabel(qs, "6").id, actor, idOf("s-gm"), idOf("t-pig"), null))));
    // As if a source column had named another exam's subject: kept by re-classification (not an AI choice), so the
    // next check must clear it.
    await prisma.aiImportQuestion.update({ where: { id: byLabel(qs, "6").id }, data: { subjectId: foreignSubject, topicId: foreignTopic, taxonomySource: "source column" } });
    await reclassifyQuestions([byLabel(qs, "6").id], actor);
    await runWorker(300_000);
    qs = await questionsOf(j1);
    const cleared = (await events(j1, "TAXONOMY_CLEARED")).at(-1);
    check("an id of another exam written into a question is never kept (cleared on the next check, event says why)", byLabel(qs, "6").subjectId !== foreignSubject && byLabel(qs, "6").topicId !== foreignTopic && /not part of this exam/.test(cleared?.message ?? ""), [byLabel(qs, "6").subjectId, cleared?.message]);

    // ------------------------------------------------------------------ B4
    section("B4. Verify 1 (free): classification findings, OCR kept apart");
    // Q7 (vitiligo) wrongly filed by an AI under General Medicine; Q8 wrongly set by an administrator.
    await prisma.aiImportQuestion.update({ where: { id: byLabel(qs, "7").id }, data: { subjectId: idOf("s-gm"), topicId: idOf("t-gi"), taxonomySource: "AI (mock)", taxonomyConfidence: 0.9 } });
    await setTaxonomy(byLabel(qs, "8").id, actor, idOf("s-gm"), idOf("t-renal"), null);
    const beforeV1 = await mockStats();
    const v1 = await runVerify1(j1, actor);
    const afterV1 = await mockStats();
    qs = await questionsOf(j1);
    check("Verify 1 made no AI request (free)", afterV1.chat === beforeV1.chat, [beforeV1.chat, afterV1.chat]);
    const v1c = (l: string) => vsOf(byLabel(qs, l)).pv?.v1?.classification;
    check("Verify 1 records a classification result per question (status, stored ids, independent choice, findings)", qs.every((q) => !!v1c(q.sourceLabel)?.status) && v1c("1")?.status === "AGREED" && v1c("1")?.stored.topicId === idOf("t-cvs"), qs.map((q) => [q.sourceLabel, v1c(q.sourceLabel)?.status]));
    check("Verify 1: Q7 (vitiligo filed under General Medicine by an AI) → DISAGREEMENT + TAXONOMY_DISAGREES with the reason", v1c("7")?.status === "DISAGREEMENT" && byLabel(qs, "7").issueCodes.includes("TAXONOMY_DISAGREES") && /Dermatology/.test(issue(byLabel(qs, "7"), "TAXONOMY_DISAGREES")), [v1c("7"), byLabel(qs, "7").issueCodes]);
    check("Verify 1: Q8 (administrator's choice) → disagreement SHOWN, not flagged, admin choice kept", v1c("8")?.status === "DISAGREEMENT" && !byLabel(qs, "8").issueCodes.includes("TAXONOMY_DISAGREES") && byLabel(qs, "8").subjectId === idOf("s-gm"), [v1c("8"), byLabel(qs, "8").issueCodes]);
    check("Verify 1: uncertain questions → NEEDS_REVIEW; too little text → NOT_VERIFIED", v1c("6")?.status === "NEEDS_REVIEW" && v1c("12")?.status === "NOT_VERIFIED", [v1c("6"), v1c("12")]);
    check("Verify 1 result counts the classification verdicts", (v1.classification?.AGREED ?? 0) >= 5 && (v1.classification?.DISAGREEMENT ?? 0) >= 2 && /subject \/ topic check \(free\)/.test((await events(j1, "VERIFY1_DONE")).at(-1)?.message ?? ""), v1.classification);
    check("OCR kept apart: a correctly read question with a taxonomy finding has no OCR / structure flag", !byLabel(qs, "7").issueCodes.some((c) => ["OPTIONS_INCOMPLETE", "EXTRACTION_UNCERTAIN", "UNREADABLE_TEXT", "QUESTION_TEXT_SUSPECT", "ANSWER_IN_OPTION", "STATEMENTS_MERGED"].includes(c)), byLabel(qs, "7").issueCodes);

    // ------------------------------------------------------------------ B5
    section("B5. Verify 2: independent classification with cost confirmation");
    const pv = await verify2Preview(j1, "mockvision/checker");
    check("Verify 2 preview shows the estimate and maximum incl. classification requests (nothing sent yet)", pv.maxInr !== null && pv.maxInr > 0 && pv.classifyBatches === Math.ceil(pv.questions / 10) && pv.classifyBatches >= 1 && pv.estimateInr !== null, pv);
    const beforeRefuse = await mockStats();
    const refused = await requestVerify2({ jobId: j1, actorId: actor, model: "mockvision/checker", confirmedMaxInr: null });
    const lower = await requestVerify2({ jobId: j1, actorId: actor, model: "mockvision/checker", confirmedMaxInr: Math.max(0, (pv.maxInr ?? 0) / 10) });
    await runWorker(30_000);
    check("Verify 2 without a confirmed maximum / below the maximum → not started, no AI request", !refused.started && !lower.started && (await mockStats()).chat === beforeRefuse.chat, [refused, lower]);
    await mockConfig({ classifyKeep: 8 });
    const r2 = await requestVerify2({ jobId: j1, actorId: actor, model: "mockvision/checker", confirmedMaxInr: pv.maxInr });
    await runWorker(300_000);
    await mockConfig({ classifyKeep: null });
    qs = await questionsOf(j1);
    const v2c = (l: string) => vsOf(byLabel(qs, l)).pv?.v2?.classification;
    check("Verify 2 started only after confirmation and classified independently (every question has a result)", r2.started && qs.every((q) => !!v2c(q.sourceLabel)), qs.map((q) => [q.sourceLabel, v2c(q.sourceLabel)?.status]));
    check("Verify 2: Q1 → AGREED, and agrees with Verify 1", v2c("1")?.status === "AGREED" && v2c("1")?.comparedWithV1 === "AGREES", v2c("1"));
    check("Verify 2: Q7 → DISAGREEMENT (Dermatology › Pigmentary Disorders found independently), same as Verify 1's choice", v2c("7")?.status === "DISAGREEMENT" && v2c("7")?.found?.subjectId === idOf("s-derm") && v2c("7")?.comparedWithV1 === "AGREES", v2c("7"));
    check("…its text read is still VERIFIED: a taxonomy disagreement never fails a correct reading", vsOf(byLabel(qs, "7")).pv?.v2?.status === "VERIFIED", vsOf(byLabel(qs, "7")).pv?.v2?.status);
    check("…and the disagreement becomes TAXONOMY_DISAGREES + SUBJECT_MISMATCH on the question", byLabel(qs, "7").issueCodes.includes("TAXONOMY_DISAGREES") && byLabel(qs, "7").issueCodes.includes("SUBJECT_MISMATCH"), byLabel(qs, "7").issueCodes);
    check("Verify 2: no subject stored + model unsure → NEEDS_REVIEW (never AGREED)", ["5", "6"].every((l) => v2c(l)?.status === "NEEDS_REVIEW" || v2c(l)?.status === "VERIFICATION_FAILED"), ["5", "6"].map((l) => v2c(l)));
    const missing = qs.filter((q) => v2c(q.sourceLabel)?.status === "VERIFICATION_FAILED");
    check("Verify 2: questions the model gave no answer for (it stopped after 8) → VERIFICATION_FAILED, never agreement", missing.length >= 2 && missing.every((q) => /returned no answer/.test(v2c(q.sourceLabel)?.findings[0] ?? "")), missing.map((q) => [q.sourceLabel, v2c(q.sourceLabel)]));
    check("Verify 2: too little text → NOT_VERIFIED (no request spent on it)", v2c("12")?.status === "NOT_VERIFIED", v2c("12"));
    const v2ev = (await events(j1, "VERIFY2_CLASSIFIED")).at(-1);
    check("Verify 2 reports the classification counts, failures named as never agreement", /verification failed \(never counted as agreement\)/.test(v2ev?.message ?? ""), v2ev?.message);

    // ------------------------------------------------------------------ B6
    section("B6. Admin corrections, audit, confirmed examples (exam-scoped)");
    const target = byLabel(qs, "7");
    const auditBefore = await prisma.auditLog.count({ where: { action: "AI_IMPORT_TAXONOMY_SET", entityId: target.id } });
    const set = await setTaxonomy(target.id, actor, idOf("s-derm"), idOf("t-pig"), null, { remember: true });
    qs = await questionsOf(j1);
    const t7 = byLabel(qs, "7");
    check("admin correction: ids updated, source admin, approval withdrawn (not verified by it)", t7.subjectId === idOf("s-derm") && t7.topicId === idOf("t-pig") && t7.taxonomySource === "admin" && !t7.approvedById && set.remembered, [t7.subjectId, t7.taxonomySource, set]);
    check("…its Verify 1 / Verify 2 results are out of date (ids are part of the fingerprint) — not 'verified'", vsOf(t7).v1 === "stale" && vsOf(t7).v2 === "stale", [vsOf(t7).v1, vsOf(t7).v2]);
    check("…audit log entry + TAXONOMY_SET event with from / to", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_TAXONOMY_SET", entityId: target.id } })) === auditBefore + 1 && /saved as an example/.test((await events(j1, "TAXONOMY_SET")).at(-1)?.message ?? ""));
    const memA = await loadExamMemory(A.exam.id);
    check("…saved as a confirmed example of THIS exam (ids, job, question, administrator, source)", memA?.corrections.length === 1 && memA.corrections[0].subjectId === idOf("s-derm") && memA.corrections[0].questionId === target.id && memA.corrections[0].byId === actor && memA.corrections[0].source === "admin correction" && !(await loadExamMemory(B.exam.id)), memA?.corrections);
    check("…an audit entry for the stored example", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_TAXONOMY_EXAMPLE_SAVED", entityId: A.exam.id } })) === 1);
    // A later paper of the same exam with the same question uses the example; another exam does not.
    writeFileSync(path.join(FX, "tx-paper2.docx"), docx(paperParagraphs([{ ...SRC[6], n: 1 }, { ...SRC[0], n: 2 }, { ...SRC[2], n: 3 }, { ...SRC[3], n: 4 }, { ...SRC[8], n: 5 }])));
    const j2 = await createJob({ actorId: actor, title: `Taxonomy reuse ${TAG}`, examId: A.exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2025, paperCode: null, previousYearPaperId: null, expectedQuestions: 5 });
    jobs.push(j2);
    await upload(actor, j2, "tx-paper2.docx");
    await runJob(actor, j2);
    const reuse = byLabel(await questionsOf(j2), "1");
    check("a later paper of the same exam: the confirmed example decides that question (source: confirmed example)", reuse.taxonomySource === "confirmed example" && reuse.subjectId === idOf("s-derm") && reuse.topicId === idOf("t-pig"), [reuse.taxonomySource, reuse.subjectId, rec(reuse)?.reason]);
    // Taxonomy change: unlink the topic → the stored example is dropped on the next refresh.
    await prisma.examTopic.updateMany({ where: { examId: A.exam.id, topicId: idOf("t-pig") }, data: { isActive: false } });
    const ctxAfter = await classifierContext(A.exam.id);
    const memAfter = await loadExamMemory(A.exam.id);
    check("taxonomy changed (topic unlinked) → affected reference entries dropped, new fingerprint, refresh recorded", ctxAfter.droppedOnRefresh === 1 && memAfter?.corrections.length === 0 && memAfter?.lastRefresh?.dropped === 1 && memAfter.taxonomyFingerprint === taxonomyFingerprint(await getExamTaxonomy(prisma, A.exam.id)), [ctxAfter.droppedOnRefresh, memAfter?.lastRefresh]);
    await prisma.examTopic.updateMany({ where: { examId: A.exam.id, topicId: idOf("t-pig") }, data: { isActive: true } });

    // ------------------------------------------------------------------ B7
    section("B7. Bulk correction safety");
    qs = await questionsOf(j1);
    const bulkIds = ["5", "6"].map((l) => byLabel(qs, l).id);
    check("bulk without confirmation → refused, nothing changed", /Confirm the bulk correction of the 2/.test(await refuse(() => bulkSetTaxonomy(bulkIds, actor, idOf("s-gm"), idOf("t-gi"), null, null))) && (await questionsOf(j1)).filter((q) => bulkIds.includes(q.id)).every((q) => q.taxonomySource !== "admin"));
    check("bulk with a confirmed count that differs from the selection → refused", /Confirm the bulk correction/.test(await refuse(() => bulkSetTaxonomy(bulkIds, actor, idOf("s-gm"), idOf("t-gi"), null, { count: 3 }))));
    check("bulk across two imports → refused", /one import at a time/.test(await refuse(() => bulkSetTaxonomy([bulkIds[0], reuse.id], actor, idOf("s-gm"), idOf("t-gi"), null, { count: 2 }))));
    check("bulk with another exam's subject → every question refused, nothing changed", (await bulkSetTaxonomy(bulkIds, actor, foreignSubject, null, null, { count: 2 })).updated === 0);
    const auditBulkBefore = await prisma.auditLog.count({ where: { action: "AI_IMPORT_TAXONOMY_BULK_SET" } });
    const bulk = await bulkSetTaxonomy(bulkIds, actor, idOf("s-gm"), idOf("t-gi"), null, { count: 2, remember: false });
    qs = await questionsOf(j1);
    check("confirmed bulk correction: both updated, audited per question, not approved, no example stored (remember off)", bulk.updated === 2 && bulk.remembered === 0 && (await prisma.auditLog.count({ where: { action: "AI_IMPORT_TAXONOMY_BULK_SET" } })) === auditBulkBefore + 2 && bulkIds.every((id) => { const q = qs.find((x) => x.id === id)!; return q.subjectId === idOf("s-gm") && q.taxonomySource === "admin" && !q.approvedById; }), bulk);

    // ------------------------------------------------------------------ B8
    section("B8. Paid-call safeguards, Question Bank and published variants");
    const off: ImporterSettings = { ...settings, aiEnabled: false };
    await saveImporterSettings(off, actor);
    const beforeOff = await mockStats();
    await reclassifyQuestions([byLabel(qs, "4").id], actor);
    await runWorker(300_000);
    check("Paid AI off: re-classification still works (free classifier) and sends no AI request", (await mockStats()).chat === beforeOff.chat && !!byLabel(await questionsOf(j1), "4").subjectId);
    const pvOff = await verify2Preview(j1, "mockvision/checker");
    check("Paid AI off: the Verify 2 preview says it cannot run", pvOff.problems.some((x) => /Paid AI is switched off/.test(x)), pvOff.problems);
    await saveImporterSettings(settings, actor);
    const bankAfter = await bankSnapshot();
    check("existing Question Bank questions and published AI variants unchanged (count + content hash)", bankAfter.count === bankBefore.count && bankAfter.variants === bankBefore.variants && bankAfter.hash === bankBefore.hash, [bankBefore, bankAfter]);
    check("nothing of this suite was stored in the Question Bank (no import approved / published)", (await prisma.aiImportQuestion.count({ where: { jobId: { in: jobs }, questionId: { not: null } } })) === 0);
    check("network guard: no request left this machine", blockedHosts.size === 0, [...blockedHosts]);
  } finally {
    for (const id of jobs) await prisma.aiImportJob.delete({ where: { id } }).catch(() => undefined);
    await prisma.question.deleteMany({ where: { id: { in: created.questions } } });
    await prisma.setting.deleteMany({ where: { key: { in: created.exams.map((e) => `${TAXONOMY_MEMORY_PREFIX}${e}`) } } });
    await prisma.subject.deleteMany({ where: { id: { in: created.subjects } } });
    await prisma.exam.deleteMany({ where: { id: { in: created.exams } } });
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    if (!routerWasEnabled) await setOpenRouterEnabled(false).catch(() => undefined);
    mockProc?.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
