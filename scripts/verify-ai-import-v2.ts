/**
 * AI Question Importer 2.0 — server-side suite for paper mapping, approval-gated storage, manual
 * correction history, re-scan with preserved corrections, two-agent verification, images, sequence /
 * quality gate and cost guards. Synthetic fixtures, disposable DB, scratch storage, loopback mock
 * OpenRouter only (never real AI, never production). Same environment as scripts/verify-ai-import.ts:
 *
 *   npx tsx scripts/ai-import-fixtures.ts /tmp/aifx
 *   node scripts/mock-openrouter-vision.mjs 3501 /tmp/aifx/mock-vision.json &
 *   AI_IMPORT_DISABLE_KICK=1 OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3501 FX_TEST_BASE_URL=http://127.0.0.1:3501 \
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> AI_IMPORT_VAULT_DIR=<scratch> DATABASE_URL=<scratch> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-import-v2.ts /tmp/aifx
 *
 * Everything it creates (papers, a second exam, a sub-topic, jobs, questions, runs) is removed at the end.
 */
import "dotenv/config";
import { readFileSync, utimesSync, existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { saveImporterSettings, getImporterSettings } from "@/lib/ai-import/settings";
import { addFile, changeJobPaper, completeFile, confirmJob, createJob, expectedCount, putChunk, requestAnalysis, setExpectedQuestions } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import {
  applyRescan,
  approveAllClean,
  approveQuestions,
  attachUploadedFigure,
  discardRescan,
  editQuestion,
  markImageMissing,
  rejectQuestions,
  requestImport,
  rescanQuestions,
  revalidateQuestions,
  setAnswer,
  setFigure,
  setTaxonomy,
  unapproveQuestions,
} from "@/lib/ai-import/review";
import { jobQuality, settleJobStatus } from "@/lib/ai-import/summary";
import { jobMapping } from "@/lib/ai-import/job-view";
import { missingNumbers, qualityReport, type QualityInput, type QualityQuestion } from "@/lib/ai-import/quality";
import { compareVersions, mergeChoice } from "@/lib/ai-import/versions";
import { effective } from "@/lib/ai-import/post";
import { findCandidates } from "@/lib/ai-import/storage";
import { exists as vaultExists, vaultPath } from "@/lib/ai-import/vault";
import { estimateJobCost } from "@/lib/ai-import/estimate";
import { planOf } from "@/lib/ai-import/select";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR and IMPORT_STAGING_DIR to scratch directories.");
  process.exit(2);
}
const FX = process.argv[2];
const MOCK = process.env.OPENROUTER_TEST_BASE_URL!;

// Every HTTP request of this process must go to the loopback mock (no real AI provider, ever).
const requestHosts = new Set<string>();
const blockedHosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
  requestHosts.add(host);
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
async function expectError(name: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
    check(name, false, "no error");
  } catch (e) {
    check(name, re.test(e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : String(e));
  }
}

const created = { jobs: [] as string[], questions: [] as string[], runs: [] as string[], papers: [] as string[], exams: [] as string[], subTopics: [] as string[] };
const restore: { importer: import("@prisma/client").Prisma.InputJsonValue | null; openrouter: import("@prisma/client").Prisma.InputJsonValue | null } = { importer: null, openrouter: null };

async function upload(actor: string, jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER, paperFileId: string | null = null) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  await completeFile({ fileId, actorId: actor });
  return fileId;
}

async function setSettings(patch: (s: ImporterSettings) => ImporterSettings, actor: string) {
  await saveImporterSettings(patch(normalizeImporterSettings(await getImporterSettings())), actor);
}

async function q(jobId: string, label: string) {
  return prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId, sourceLabel: label }, include: { figures: true } });
}

async function stored(jobId: string) {
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId, questionId: { not: null } } });
  for (const r of rows) if (!created.questions.includes(r.questionId!)) created.questions.push(r.questionId!);
  for (const r of rows) if (r.bulkImportRunId && !created.runs.includes(r.bulkImportRunId)) created.runs.push(r.bulkImportRunId);
  return rows;
}

function qq(p: Partial<QualityQuestion>): QualityQuestion {
  return { fileId: "f", section: "", number: 1, status: "READY", approved: false, stored: false, verified: null, issueCodes: [], answerStatus: "OFFICIAL_MATCHED", importBlocker: null, rescanPending: false, ...p };
}
const qin = (p: Partial<QualityInput>): QualityInput => ({ expected: null, questions: [], pages: [], unmatchedKeyEntries: 0, failedKeyFiles: 0, verifierExtras: [], ack: null, processed: true, ...p });

async function main() {
  const actor = (await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } })).id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true, year: true } });
  const anatomy = await prisma.subject.findFirstOrThrow({ where: { name: "Anatomy" }, select: { id: true } });
  const headNeck = await prisma.topic.findFirstOrThrow({ where: { name: "Head & Neck", subjectId: anatomy.id }, select: { id: true } });
  restore.importer = ((await prisma.setting.findUnique({ where: { key: "ai.importer" } }))?.value ?? null) as never;
  restore.openrouter = ((await prisma.setting.findUnique({ where: { key: "api.openrouter" } }))?.value ?? null) as never;
  await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
  const tag = Date.now().toString(36);

  // Synthetic records owned by this suite.
  const paper24 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: `V2 FX RUHS MO 2024 Official Paper ${tag}`, paperCode: `SETA${tag}` } });
  created.papers.push(paper24.id);
  const paper23 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2023, title: `V2 FX RUHS MO 2023 Official Paper ${tag}` } });
  created.papers.push(paper23.id);
  const exam2 = await prisma.exam.create({ data: { name: `V2 FX Other Exam ${tag}`, code: `V2FX${tag}`.toUpperCase().slice(0, 20), year: 2026 } as never });
  created.exams.push(exam2.id);
  const paperOther = await prisma.previousYearPaper.create({ data: { examId: exam2.id, year: 2024, title: `V2 FX Other Exam 2024 ${tag}` } });
  created.papers.push(paperOther.id);
  const subName = `V2 FX Cranial nerves ${tag}`;
  const sub = await prisma.subTopic.create({ data: { name: subName, nameKey: taxonomyNameKey(subName), topicId: headNeck.id } });
  created.subTopics.push(sub.id);
  await prisma.examSubTopic.create({ data: { examId: exam.id, subTopicId: sub.id } as never });

  // ------------------------------------------------------------------ 1
  section("1. Exam and Previous Year Paper mapping (selection kept, never guessed)");
  // Single-subject papers (the synthetic papers have no subject headings and AI classification is off at first).
  const base = { actorId: actor, title: "V2 FX mapped", examId: exam.id, paperType: AiImportPaperType.SINGLE_SUBJECT, subjectId: anatomy.id, budgetInr: 8 };
  const j1 = await createJob({ ...base, year: null, paperCode: null, previousYearPaperId: paper24.id, expectedQuestions: 10 });
  created.jobs.push(j1);
  let row = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j1 } });
  check("job keeps the selected paper", row.previousYearPaperId === paper24.id);
  check("the paper's year and code are taken from the paper (not the exam)", row.year === 2024 && row.paperCode === paper24.paperCode, { year: row.year, code: row.paperCode, examYear: exam.year });
  check("expected question count stored", row.expectedQuestions === 10);
  const m1 = await jobMapping(j1);
  check("mapping view shows exam, paper title, year and code", !!m1 && m1.paper?.title === paper24.title && m1.year === 2024 && m1.paperCode === paper24.paperCode && m1.examName.length > 0, m1);
  await expectError("a typed year that differs from the paper's is refused", () => createJob({ ...base, year: 2023, paperCode: null, previousYearPaperId: paper24.id }), /does not match the selected paper/);
  await expectError("a typed code that differs from the paper's is refused", () => createJob({ ...base, year: null, paperCode: "SET-Z", previousYearPaperId: paper24.id }), /paper code "SET-Z" does not match/);
  await expectError("a paper of another exam is refused", () => createJob({ ...base, year: null, paperCode: null, previousYearPaperId: paperOther.id }), /does not belong to the selected exam/);
  await expectError("a missing paper record is refused (never created or guessed)", () => createJob({ ...base, year: null, paperCode: null, previousYearPaperId: "cmvdoesnotexist000000000" }), /no longer exists/);
  check("no paper record was created by the importer", (await prisma.previousYearPaper.count({ where: { examId: exam.id, title: { contains: "V2 FX" } } })) === 2);
  check("expected count: 0, 1001 and text are refused; blank is null", ["0", "1001", "abc"].every((v) => { try { expectedCount(v); return false; } catch { return true; } }) && expectedCount("") === null && expectedCount("100") === 100);

  // Analysis, then an explicit paper change before confirmation (logged with both values).
  await upload(actor, j1, "digital-clean.pdf");
  await upload(actor, j1, "key-digital.pdf", AiImportFileRole.ANSWER_KEY);
  await requestAnalysis(j1, actor);
  await runWorker(60_000);
  await changeJobPaper({ jobId: j1, actorId: actor, previousYearPaperId: null });
  row = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j1 } });
  check("paper removed explicitly (Question Bank only)", row.previousYearPaperId === null);
  await changeJobPaper({ jobId: j1, actorId: actor, previousYearPaperId: paper24.id });
  row = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j1 } });
  const changes = await prisma.aiImportEvent.findMany({ where: { jobId: j1, type: "PAPER_CHANGED" }, orderBy: { createdAt: "asc" } });
  check("paper selected again; both changes logged with from/to", row.previousYearPaperId === paper24.id && row.year === 2024 && changes.length === 2 && (changes[1].data as { to: { previousYearPaperId: string } }).to.previousYearPaperId === paper24.id, changes.map((c) => c.data));
  check("a paper change is audited", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_PAPER_CHANGED", entityId: j1 } })) === 2);
  await expectError("the one-page flow refuses to start without a confirmed count", () => confirmJob({ jobId: j1, actorId: actor, examId: exam.id, paperType: row.paperType, subjectId: anatomy.id, year: row.year, paperCode: row.paperCode, previousYearPaperId: row.previousYearPaperId, budgetInr: 8, expectedQuestions: null, requireExpected: true }), /expected number of questions/);
  await confirmJob({ jobId: j1, actorId: actor, examId: exam.id, paperType: row.paperType, subjectId: anatomy.id, year: row.year, paperCode: row.paperCode, previousYearPaperId: row.previousYearPaperId, budgetInr: 8, expectedQuestions: 10, requireExpected: true });
  await runWorker(300_000);
  row = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j1 } });
  check("the paper stays selected through processing", row.status === "NEEDS_REVIEW" && row.previousYearPaperId === paper24.id && row.year === 2024, { s: row.status, p: row.previousYearPaperId });
  check("nothing is stored before approval", (await prisma.aiImportQuestion.count({ where: { jobId: j1, questionId: { not: null } } })) === 0);

  // ------------------------------------------------------------------ 2
  section("2. Manual correction: validation, history, approval withdrawn");
  const q1 = await q(j1, "1");
  const q4 = await q(j1, "4");
  await expectError("an empty question text is refused", () => editQuestion(q4.id, actor, { stem: " ", options: effective(q4).options, type: "SINGLE_CORRECT", contentFormat: "PLAIN" }), /cannot be empty/);
  await expectError("a number already used in the paper is refused", () => editQuestion(q4.id, actor, { stem: effective(q4).stem, options: effective(q4).options, type: "SINGLE_CORRECT", contentFormat: "PLAIN", number: 1 }), /already exists in this paper/);
  await expectError("a source page outside the file is refused", () => editQuestion(q4.id, actor, { stem: effective(q4).stem, options: effective(q4).options, type: "SINGLE_CORRECT", contentFormat: "PLAIN", pages: [99] }), /Source pages must be between/);
  await expectError("all problems are reported together", () => editQuestion(q4.id, actor, { stem: "", options: effective(q4).options, type: "SINGLE_CORRECT", contentFormat: "PLAIN", number: 1, pages: [99] }), /cannot be empty.*already exists.*Source pages/);
  await expectError("an unchanged question is not saved as an edit", () => editQuestion(q4.id, actor, { stem: effective(q4).stem, options: effective(q4).options.map((o) => ({ label: o.label, text: o.text })), type: effective(q4).type, contentFormat: effective(q4).contentFormat }), /Nothing changed/);
  const apr0 = await approveQuestions([q4.id], actor);
  const before4 = effective(q4);
  await editQuestion(q4.id, actor, { stem: `${before4.stem} (corrected)`, options: before4.options, type: before4.type, contentFormat: before4.contentFormat, explanation: "Synthetic explanation." });
  const q4b = await q(j1, "4");
  const v4 = await prisma.aiImportQuestionVersion.findMany({ where: { questionId: q4.id, kind: "ADMIN_EDIT" } });
  check("edit kept beside the original extraction", (q4b.data as unknown as ExtractedQuestion).stem === before4.stem && effective(q4b).stem.endsWith("(corrected)"));
  check("edit recorded with the fields changed and the admin", v4.length === 1 && v4[0].actorId === actor && JSON.stringify(v4[0].changes).includes("Question text") && JSON.stringify(v4[0].changes).includes("Explanation"), v4.map((v) => v.changes));
  check("an edit withdraws an earlier approval", apr0.approved === 1 && !q4b.approvedById, { apr0, codes: q4.issueCodes, status: q4.status });
  check("explanation saved with the question", effective(q4b).hints?.explanation === "Synthetic explanation.");
  check("edit audited", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_QUESTION_EDITED", entityId: q4.id } })) === 1);

  // ------------------------------------------------------------------ 3
  section("3. Approval → stored in the existing Question Bank (exam, paper, taxonomy, idempotent)");
  await expectError("a sub-topic of another topic is refused", () => setTaxonomy(q1.id, actor, anatomy.id, null, sub.id), /sub-topic does not belong/);
  await setTaxonomy(q1.id, actor, anatomy.id, headNeck.id, sub.id);
  check("sub-topic saved from the exam's own taxonomy", (await q(j1, "1")).subTopicId === sub.id);
  // An administrator settles the topic of every question (AI classification is off for this paper).
  for (const x of await prisma.aiImportQuestion.findMany({ where: { jobId: j1, status: { not: "REJECTED" } }, select: { id: true, sourceLabel: true } })) if (x.sourceLabel !== "1") await setTaxonomy(x.id, actor, anatomy.id, headNeck.id);
  await revalidateQuestions(j1, (await prisma.aiImportQuestion.findMany({ where: { jobId: j1 }, select: { id: true } })).map((x) => x.id));
  const clean = await approveAllClean(j1, actor);
  check("approve-all approves only questions without any flag", clean.approved > 0 && (await prisma.aiImportQuestion.count({ where: { jobId: j1, approvedById: { not: null }, issueCodes: { isEmpty: false } } })) === 0, clean);
  const all = await prisma.aiImportQuestion.findMany({ where: { jobId: j1 }, select: { id: true, sourceLabel: true } });
  const apr = await approveQuestions(all.map((x) => x.id), actor);
  check("structural problems are refused with a reason (never hidden by approval)", apr.refused.length > 0 && apr.refused.every((r) => r.reason.length > 2), apr.refused);
  const approvedIds = (await prisma.aiImportQuestion.findMany({ where: { jobId: j1, approvedById: { not: null } }, select: { id: true } })).map((x) => x.id);
  const unap = await unapproveQuestions([approvedIds[0]], actor);
  check("approval can be withdrawn", unap === 1 && !(await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: approvedIds[0] } })).approvedById);
  await approveQuestions([approvedIds[0]], actor);
  const qBefore = await prisma.question.count();
  await requestImport(j1, actor, "DRAFT", null);
  await runWorker(300_000);
  const st = await stored(j1);
  check("exactly the approved questions are stored", st.length > 0 && st.length <= approvedIds.length && (await prisma.question.count()) - qBefore === st.length, { stored: st.length, approved: approvedIds.length });
  const saved = await prisma.question.findMany({ where: { id: { in: st.map((x) => x.questionId!) } }, include: { options: true } });
  check("stored as DRAFT in the canonical Question model with options and a correct answer", saved.every((x) => x.status === "DRAFT" && x.options.length === 4 && x.options.some((o) => o.isCorrect)));
  check("stored under the selected exam (never another exam)", saved.every((x) => x.examId === exam.id));
  check("stored with the selected Previous Year Paper, its year and source PYQ", saved.every((x) => x.previousYearPaperId === paper24.id && x.examYear === 2024 && x.source === "PYQ"), saved.map((x) => [x.previousYearPaperId, x.examYear, x.source]));
  const s1 = saved.find((x) => x.id === st.find((y) => y.sourceLabel === "1")?.questionId);
  check("subject, topic and sub-topic stored", !!s1 && s1.subjectId === anatomy.id && s1.topicId === headNeck.id && s1.subTopicId === sub.id, s1 && [s1.subjectId, s1.topicId, s1.subTopicId]);
  check("explanation stored with the edited question", saved.find((x) => x.id === st.find((y) => y.sourceLabel === "4")?.questionId)?.explanation === "Synthetic explanation." || !st.some((y) => y.sourceLabel === "4"));
  check("Question Bank filters find them: exam + paper", (await prisma.question.count({ where: { examId: exam.id, previousYearPaperId: paper24.id } })) === st.length);
  check("Question Bank filters find them: import batch", (await prisma.question.count({ where: { importBatchId: { in: [...new Set(st.map((x) => x.bulkImportRunId!))] } } })) === st.length);
  check("nothing attached to the other exam", (await prisma.question.count({ where: { examId: exam2.id } })) === 0);
  await expectError("a stored question cannot be approved or edited again in the importer", () => approveQuestions([st[0].id], actor), /already in the Question Bank/);
  const runsBefore = await prisma.bulkImportRun.count();
  const qMid = await prisma.question.count();
  await requestImport(j1, actor, "DRAFT", null);
  await runWorker(120_000);
  check("repeating the store creates no duplicate questions or runs", (await prisma.question.count()) === qMid && (await prisma.bulkImportRun.count()) === runsBefore);
  await expectError("the paper cannot be changed once questions are stored", () => changeJobPaper({ jobId: j1, actorId: actor, previousYearPaperId: null }), /already in the Question Bank/);

  // ------------------------------------------------------------------ 4
  section("4. Sequence and the final quality gate");
  let qr = (await jobQuality(j1))!;
  check("quality counts come from stored facts", qr.expected === 10 && qr.extracted === 10 && qr.stored === st.length && qr.pages.total === 2, qr);
  check("not complete while unapproved / blocked questions remain", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j1 } })).status === "NEEDS_REVIEW" && qr.state !== "COMPLETED");
  const leftovers = await prisma.aiImportQuestion.findMany({ where: { jobId: j1, questionId: null }, select: { id: true } });
  await rejectQuestions(leftovers.map((x) => x.id), actor, "synthetic: not stored");
  qr = (await jobQuality(j1))!;
  check("a rejected question was still found: no missing number, no count difference", qr.missing.length === 0 && qr.countDifference === 0 && qr.rejected === leftovers.length, { d: qr.countDifference, m: qr.missing });
  await setExpectedQuestions({ jobId: j1, actorId: actor, expected: 12 });
  await settleJobStatus(j1);
  qr = (await jobQuality(j1))!;
  check("questions beyond the last one found are reported missing (never renumbered)", JSON.stringify(qr.missing) === JSON.stringify(["Q11", "Q12"]) && qr.countDifference === 2 && qr.state === "NEEDS_CORRECTION", { d: qr.countDifference, m: qr.missing, s: qr.state });
  check("…and the job is not Completed", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j1 } })).status === "NEEDS_REVIEW");
  await setExpectedQuestions({ jobId: j1, actorId: actor, expected: 10 });
  await settleJobStatus(j1);
  check("counts match and every question decided → Completed with Warnings (rejected / unsupported remain visible)", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j1 } })).status === "COMPLETED_WITH_ISSUES" && (await jobQuality(j1))!.state === "COMPLETED_WITH_WARNINGS", (await jobQuality(j1))!.blockers);

  // ------------------------------------------------------------------ 5
  section("5. Pure quality / sequence rules");
  check("sections restart numbering without false gaps", missingNumbers([qq({ number: 1 }), qq({ number: 2 }), qq({ section: "S2", number: 1 }), qq({ section: "S2", number: 2 })], 4).length === 0);
  check("a gap inside a section is reported with its section", JSON.stringify(missingNumbers([qq({ number: 1 }), qq({ number: 3 }), qq({ section: "S2", number: 2 })], null)) === JSON.stringify(["Q2", "S2 Q1"]));
  check("a single continuous paper is checked up to the expected count", JSON.stringify(missingNumbers([qq({ number: 1 }), qq({ number: 2 })], 4)) === JSON.stringify(["Q3", "Q4"]));
  const okQs = [1, 2, 3].map((n) => qq({ number: n, stored: true, approved: true }));
  check("all stored, counts match → Completed", qualityReport(qin({ expected: 3, questions: okQs })).state === "COMPLETED");
  check("no expected count → Needs Correction", qualityReport(qin({ expected: null, questions: okQs })).state === "NEEDS_CORRECTION");
  const ack = { byId: "a", at: "x", note: "Q4 withdrawn by the board", missing: ["Q4"], expected: 4, counted: 3 };
  check("acknowledged difference → Completed with Warnings", qualityReport(qin({ expected: 4, questions: okQs, ack })).state === "COMPLETED_WITH_WARNINGS");
  check("acknowledgement lapses when the facts change", qualityReport(qin({ expected: 5, questions: okQs, ack })).state === "NEEDS_CORRECTION");
  check("failed page → Needs Correction", qualityReport(qin({ expected: 3, questions: okQs, pages: [{ status: "FAILED", kind: "SCANNED", attempts: 2, errorMessage: "x" }] })).state === "NEEDS_CORRECTION");
  const rq = qualityReport(qin({ expected: 3, questions: okQs, pages: [{ status: "PENDING", kind: "SCANNED", attempts: 1, errorMessage: "429" }, { status: "PENDING", kind: "TEXT", attempts: 0, errorMessage: null }] }));
  check("page states: retrying vs pending are told apart", rq.pages.retrying === 1 && rq.pages.pending === 1);
  check("importable but unapproved → Ready for Approval; flagged → Ready for Review", qualityReport(qin({ expected: 1, questions: [qq({})] })).state === "READY_FOR_APPROVAL" && qualityReport(qin({ expected: 1, questions: [qq({ issueCodes: ["TOPIC_UNCERTAIN"] })] })).state === "READY_FOR_REVIEW");
  const flaggedOnly = qualityReport(qin({ expected: 2, questions: [qq({ number: 1, issueCodes: ["TOPIC_UNCERTAIN"] }), qq({ number: 2, status: "NEEDS_CORRECTION", issueCodes: ["TOPIC_UNCERTAIN"] })] }));
  const oneClean = qualityReport(qin({ expected: 2, questions: [qq({ number: 1 }), qq({ number: 2, issueCodes: ["TOPIC_UNCERTAIN"] })] }));
  check("'Approve all without flags' is offered only for unflagged questions", flaggedOnly.awaitingApproval === 2 && flaggedOnly.awaitingCleanApproval === 0 && oneClean.awaitingCleanApproval === 1, { flaggedOnly: [flaggedOnly.awaitingApproval, flaggedOnly.awaitingCleanApproval], oneClean: oneClean.awaitingCleanApproval });
  check("approved but not stored → Approved (ready to add)", qualityReport(qin({ expected: 1, questions: [qq({ approved: true })] })).state === "APPROVED");
  check("a waiting re-scan result blocks completion", qualityReport(qin({ expected: 1, questions: [qq({ stored: true, rescanPending: true })] })).state === "NEEDS_CORRECTION");
  check("verification counts: agree / disagree / none", (() => { const r = qualityReport(qin({ expected: 3, questions: [qq({ number: 1, verified: true }), qq({ number: 2, verified: false }), qq({ number: 3 })] })); return r.verified === 1 && r.verifyDisagreed === 1 && r.unverified === 1; })());
  check("unmatched answer-key entries are reported", qualityReport(qin({ expected: 3, questions: okQs, unmatchedKeyEntries: 2 })).warnings.some((w) => /matched no question/.test(w)));
  const cur: ExtractedQuestion = { section: "", number: 5, label: "5", pages: [1], type: "SINGLE_CORRECT", stem: "Edited stem", options: ["A", "B", "C", "D"].map((l) => ({ label: l, printed: l, text: `cur ${l}` })), printedAnswer: ["A"], contentFormat: "PLAIN", confidence: 1, unreadable: [], figures: [], method: "AI_VISION+ADMIN" };
  const nxt: ExtractedQuestion = { ...cur, stem: "Rescan stem", options: cur.options.map((o) => (o.label === "B" ? { ...o, text: "new B" } : o)), printedAnswer: ["B"], method: "AI_VISION" };
  const diff = compareVersions(cur, [], nxt, []);
  check("comparison marks exactly the differing fields", diff.filter((d) => !d.same).map((d) => d.field).join() === "stem,option:B,printedAnswer", diff.filter((d) => !d.same));
  const merged = mergeChoice(cur, nxt, new Set(["option:B"] as const));
  check("merge takes only the chosen fields (the manual stem is kept)", merged.stem === "Edited stem" && merged.options.find((o) => o.label === "B")?.text === "new B" && merged.printedAnswer.join() === "A");

  // ------------------------------------------------------------------ 6
  section("6. Two agents: independent verification (mock), re-scan from the original, corrections preserved");
  await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
  await prisma.setting.update({ where: { key: "api.openrouter" }, data: { value: { ...((await prisma.setting.findUniqueOrThrow({ where: { key: "api.openrouter" } })).value as object), lastTest: null } } });
  check("OpenRouter (mock) connection test", (await testOpenRouterConnection()).ok);
  await setOpenRouterEnabled(true);
  await syncCatalog();
  const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
  await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
  await setSettings((s) => ({ ...s, aiEnabled: true, selection: { mode: "manual" }, importerModels: mockIds, models: { extract: "mockvision/reader", extractFallbacks: [], verify: "mockvision/checker", classify: "mocktext/classifier", key: null }, privacy: { dataCollection: "deny", zdr: false } }), actor);
  const budgetBefore = (await getImporterSettings()).budget;
  const j2 = await createJob({ ...base, title: "V2 FX scanned", year: null, paperCode: null, previousYearPaperId: paper23.id, expectedQuestions: 3 });
  created.jobs.push(j2);
  await upload(actor, j2, "scanned.pdf");
  await requestAnalysis(j2, actor);
  await runWorker(60_000);
  const an = (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j2 } })).analysis as unknown as JobAnalysis;
  const settingsNow = await getImporterSettings();
  const planNow = an.estimate.plan;
  const facts = an.files.filter((f) => f.role === "PAPER" && f.facts).map((f) => f.facts!);
  const estRisk = await estimateJobCost({ paperFacts: facts, keyFacts: [], settings: settingsNow, plan: planNow, verifyMode: "risk" });
  const estAll = await estimateJobCost({ paperFacts: facts, keyFacts: [], settings: settingsNow, plan: planNow, verifyMode: "all" });
  check("verify-every-page is priced in the estimate (never hidden)", estAll.lines.some((l) => /every page/.test(l.label)) && (estAll.maxInr ?? 0) >= (estRisk.maxInr ?? 0), { all: estAll.maxInr, risk: estRisk.maxInr });
  const j2row = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j2 } });
  await expectError("a budget below the estimate refuses to start (no silent increase)", () => confirmJob({ jobId: j2, actorId: actor, examId: exam.id, paperType: j2row.paperType, subjectId: anatomy.id, year: j2row.year, paperCode: j2row.paperCode, previousYearPaperId: j2row.previousYearPaperId, budgetInr: 0.0001, expectedQuestions: 3, requireExpected: true, verifyMode: "all" }), /Nothing was started/);
  check("the job budget was not raised by the refusal", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j2 } })).budgetInr === 8);
  await confirmJob({ jobId: j2, actorId: actor, examId: exam.id, paperType: j2row.paperType, subjectId: anatomy.id, year: j2row.year, paperCode: j2row.paperCode, previousYearPaperId: j2row.previousYearPaperId, budgetInr: 8, expectedQuestions: 3, requireExpected: true, verifyMode: "all" });
  await runWorker(300_000);
  let j2now = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j2 } });
  check("AI job processed with verification of every page", j2now.status === "NEEDS_REVIEW" && (j2now.config as { verifyMode?: string }).verifyMode === "all", { s: j2now.status, e: j2now.errorMessage });
  const s1q = await q(j2, "1");
  const s3q = await q(j2, "3");
  const ver1 = (s1q.data as unknown as ExtractedQuestion).verification;
  const ver3 = (s3q.data as unknown as ExtractedQuestion).verification;
  check("agent B agrees on Q1 (evidence kept with its model)", ver1?.agree === true && ver1.model === "mockvision/checker", ver1);
  check("agent B disagrees on Q3: field named, flagged for review", ver3?.agree === false && ver3.fields.includes("option D") && s3q.issueCodes.includes("VERIFY_DISAGREES"), { ver3, codes: s3q.issueCodes });
  qr = (await jobQuality(j2))!;
  check("quality: verified 2, disagreed 1 — agreement is evidence, not a claim of 100%", qr.verified === 2 && qr.verifyDisagreed === 1, { v: qr.verified, d: qr.verifyDisagreed });
  const stats = (await (await fetch(`${MOCK}/__mock/stats`)).json()) as { byModel: Record<string, number> };
  check("both agents were called independently (reader + checker)", (stats.byModel["mockvision/reader"] ?? 0) >= 1 && (stats.byModel["mockvision/checker"] ?? 0) >= 1, stats.byModel);

  // Images: complete crops at their aspect ratio, kept in the vault.
  const fig1 = s1q.figures[0];
  check("figure extracted with its own dimensions (aspect ratio of its box)", !!fig1 && fig1.width > 0 && fig1.height > 0 && Math.abs(fig1.width / fig1.height - (420 + 0.024 * 1240) / (260 + 0.024 * 1754)) < 0.25, fig1 && [fig1.width, fig1.height]);

  // Manual correction on Q1, a bad (tampered) extraction on Q2, then a re-scan of both.
  const e1 = effective(s1q);
  await editQuestion(s1q.id, actor, { stem: `${e1.stem} [manually corrected]`, options: e1.options, type: e1.type, contentFormat: e1.contentFormat });
  const s2q = await q(j2, "2");
  const bad = { ...(s2q.data as unknown as ExtractedQuestion), stem: "Garbled extraction of question two" };
  await prisma.aiImportQuestion.update({ where: { id: s2q.id }, data: { data: bad as never } });
  const s3before = JSON.stringify((await q(j2, "3")).data);
  // Re-scan refused when the original is gone (simulated), nothing changed.
  const paperFile = await prisma.aiImportFile.findFirstOrThrow({ where: { jobId: j2, role: "PAPER" } });
  await prisma.aiImportFile.update({ where: { id: paperFile.id }, data: { status: "PURGED" } });
  await expectError("re-scan refused when the original file was removed — explained, nothing queued", () => rescanQuestions([s1q.id], "question", actor), /no longer stored/);
  await prisma.aiImportFile.update({ where: { id: paperFile.id }, data: { status: paperFile.status } });
  check("…and the job was not queued", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j2 } })).status === "NEEDS_REVIEW");
  await setSettings((s) => ({ ...s, aiEnabled: false }), actor);
  await expectError("re-scan refused when paid AI is off — explained", () => rescanQuestions([s1q.id], "question", actor), /paid AI is switched off/);
  await setSettings((s) => ({ ...s, aiEnabled: true }), actor);
  const r = await rescanQuestions([s1q.id, s2q.id], "question", actor);
  check("re-scan queued for the source page of both questions", r.pages === 1 && r.questions === 2 && (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j2 } })).status === "QUEUED", r);
  await runWorker(300_000);
  j2now = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j2 } });
  const s1r = await q(j2, "1");
  const s2r = await q(j2, "2");
  const s3r = await q(j2, "3");
  check("manual correction NOT overwritten by the re-scan", effective(s1r).stem.endsWith("[manually corrected]"));
  const pend = await prisma.aiImportQuestionVersion.findFirst({ where: { questionId: s1q.id, kind: "RESCAN", status: "PENDING" } });
  check("the re-scan result waits as a version to compare", !!pend && (pend.data as unknown as ExtractedQuestion).stem === e1.stem, pend?.data);
  check("…and blocks approval until decided", s1r.issueCodes.includes("RESCAN_PENDING") && (await approveQuestions([s1q.id], actor)).refused.some((x) => /re-scan result is waiting/.test(x.reason)));
  check("an untouched question is replaced by the re-scan", (s2r.data as unknown as ExtractedQuestion).stem === "Special Senses: Which layer is labelled X?", (s2r.data as unknown as ExtractedQuestion).stem);
  const v2 = await prisma.aiImportQuestionVersion.findMany({ where: { questionId: s2q.id }, orderBy: { createdAt: "asc" } });
  check("…with its previous extraction kept in its history", v2.some((v) => v.kind === "EXTRACTION" && (v.data as unknown as ExtractedQuestion).stem === "Garbled extraction of question two") && v2.some((v) => v.kind === "RESCAN" && v.status === "AUTO_APPLIED"), v2.map((v) => [v.kind, v.status]));
  check("a question outside the re-scan scope is untouched", JSON.stringify(s3r.data) === s3before && !(await prisma.aiImportQuestionVersion.count({ where: { questionId: s3q.id, kind: "RESCAN" } })));
  const done = await prisma.aiImportEvent.findFirst({ where: { jobId: j2, type: "RESCAN_DONE" } });
  check("the re-scan attempt and its outcome are recorded", !!done && /1 replaced/.test(done.message) && /1 waiting for your choice/.test(done.message), done?.message);
  check("the re-scan read the original page again (one more reader call, no extra checker call needed)", ((await (await fetch(`${MOCK}/__mock/stats`)).json()) as { byModel: Record<string, number> }).byModel["mockvision/reader"] > (stats.byModel["mockvision/reader"] ?? 0));
  const cmp = compareVersions(effective(s1r), [], pend!.data as unknown as ExtractedQuestion, []);
  check("comparison shows the stem as different (manual vs re-scan)", cmp.some((c) => c.field === "stem" && !c.same));
  await applyRescan(pend!.id, actor, ["option:A"]);
  const s1a = await q(j2, "1");
  check("choosing fields keeps the manual stem", effective(s1a).stem.endsWith("[manually corrected]") && (await prisma.aiImportQuestionVersion.findUniqueOrThrow({ where: { id: pend!.id } })).status === "APPLIED");
  await expectError("a decided re-scan result cannot be applied twice", () => applyRescan(pend!.id, actor, ["stem"]), /already decided/);
  // A second re-scan, discarded this time.
  await rescanQuestions([s1q.id], "question", actor);
  await runWorker(300_000);
  const pend2 = await prisma.aiImportQuestionVersion.findFirstOrThrow({ where: { questionId: s1q.id, kind: "RESCAN", status: "PENDING" } });
  await discardRescan(pend2.id, actor);
  await revalidateQuestions(j2, [s1q.id]);
  check("discarding keeps the question and clears the waiting flag", !(await q(j2, "1")).issueCodes.includes("RESCAN_PENDING") && effective(await q(j2, "1")).stem.endsWith("[manually corrected]"));

  // Images: replace with an uploaded original, mark missing, storage keeps every referenced original.
  const s1f = (await q(j2, "1")).figures[0];
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 220, b: 240 } } }).png().toBuffer();
  await expectError("an undecodable upload is refused", () => attachUploadedFigure({ questionId: s1q.id, actorId: actor, bytes: Buffer.from("not an image"), mime: "image/png", owner: "STEM", optionLabel: null, replaceFigureId: s1f.id }), /could not be decoded|could not be read/);
  await expectError("an unsupported type is refused", () => attachUploadedFigure({ questionId: s1q.id, actorId: actor, bytes: png, mime: "image/gif", owner: "STEM", optionLabel: null, replaceFigureId: s1f.id }), /PNG, JPEG or WebP/);
  await attachUploadedFigure({ questionId: s1q.id, actorId: actor, bytes: png, mime: "image/png", owner: "STEM", optionLabel: null, replaceFigureId: s1f.id });
  const s1u = await q(j2, "1");
  const old = await prisma.aiImportFigure.findUniqueOrThrow({ where: { id: s1f.id } });
  check("replacement stored at its full size, placement confirmed", s1u.figures.length === 1 && s1u.figures[0].source === "ADMIN_UPLOAD" && s1u.figures[0].width === 300 && s1u.figures[0].height === 200 && !!s1u.figures[0].confirmedById, s1u.figures.map((f) => [f.source, f.width, f.height]));
  check("the replaced original is detached, never deleted", old.questionId === null && old.mappingStatus === "REPLACED" && (await vaultExists(old.originalKey)));
  check("the change is in the question's history with the figures before it", (await prisma.aiImportQuestionVersion.count({ where: { questionId: s1q.id, kind: "ADMIN_EDIT", figures: { not: undefined } } })) >= 1);
  // Old orphan originals are cleanup candidates, but originals kept by versions or rows never are.
  for (const k of [old.originalKey, ...(await prisma.aiImportQuestionVersion.findMany({ where: { jobId: j2 } })).flatMap((v) => ((v.figures as { originalKey?: string }[] | null) ?? []).map((f) => f.originalKey ?? ""))].filter(Boolean)) {
    const p = vaultPath(k);
    if (existsSync(p)) utimesSync(p, new Date(Date.now() - 3 * 86_400_000), new Date(Date.now() - 3 * 86_400_000));
  }
  const cands = await findCandidates(new Date());
  const versionKeys = new Set((await prisma.aiImportQuestionVersion.findMany({ where: { jobId: j2 } })).flatMap((v) => ((v.figures as { originalKey?: string }[] | null) ?? []).map((f) => f.originalKey ?? "")).filter(Boolean));
  check("storage cleanup never offers originals kept by figures or question versions", !cands.some((c) => c.category === "ORPHAN_FIGURES" && (c.key === old.originalKey || versionKeys.has(c.key))), cands.filter((c) => c.category === "ORPHAN_FIGURES").map((c) => c.key));
  await markImageMissing(s3q.id, actor, "OPTION", "D", "Option D diagram not captured");
  await revalidateQuestions(j2, [s3q.id]);
  const s3m = await q(j2, "3");
  check("an image marked missing blocks approval", s3m.issueCodes.includes("IMAGE_MISSING") && (await approveQuestions([s3q.id], actor)).refused.length === 1);

  // Store Q1 and Q2 and check the images in the Question Bank.
  await setAnswer(s1q.id, actor, ["A"]);
  await setAnswer(s2r.id, actor, ["B"]);
  for (const f of (await q(j2, "2")).figures) await setFigure(f.id, actor, "STEM", null);
  for (const id of [s1q.id, s2r.id]) await setTaxonomy(id, actor, anatomy.id, headNeck.id);
  const ap2 = await approveQuestions([s1q.id, s2r.id], actor);
  check("Q1 and Q2 approved after their decisions", ap2.approved === 2, ap2.refused);
  await requestImport(j2, actor, "DRAFT", null);
  await runWorker(300_000);
  const st2 = await stored(j2);
  const a1 = await prisma.questionAsset.findMany({ where: { questionId: st2.find((x) => x.sourceLabel === "1")?.questionId ?? "" } });
  check("the uploaded image is the question image in the Question Bank, full size, aspect kept", a1.length === 1 && a1[0].role === "QUESTION" && a1[0].width === 300 && a1[0].height === 200, { assets: a1.map((a) => [a.role, a.width, a.height]), q1: await prisma.aiImportQuestion.findUnique({ where: { id: s1q.id }, select: { status: true, issueCodes: true, issues: true, approvedById: true, questionId: true, sourceLabel: true } }) });
  const s2saved = await prisma.question.findUnique({ where: { id: st2.find((x) => x.sourceLabel === "2")?.questionId ?? "" } });
  check("stored with the job's paper and exam (scanned import)", s2saved?.previousYearPaperId === paper23.id && s2saved?.examYear === 2023 && s2saved?.examId === exam.id);
  check("the same question number cannot be stored twice in one paper (Bulk Import protects paper numbering)", (await prisma.question.count({ where: { previousYearPaperId: paper24.id } })) === st.length);
  check("importer budgets / limits unchanged by the suite's jobs", JSON.stringify((await getImporterSettings()).budget) === JSON.stringify(budgetBefore));
  check("the plan frozen at confirmation was used (no other model chosen)", planOf(j2now.config)?.tasks.extract.model === "mockvision/reader");
  await settleJobStatus(j2);
}

async function cleanup() {
  const qids = [...new Set(created.questions)];
  await prisma.questionAsset.deleteMany({ where: { questionId: { in: qids } } });
  await prisma.questionOption.deleteMany({ where: { questionId: { in: qids } } });
  await prisma.question.deleteMany({ where: { id: { in: qids } } });
  const runs = [...new Set(created.runs)];
  const bundles = (await prisma.bulkImportRun.findMany({ where: { id: { in: runs } }, select: { bundleId: true } })).map((r) => r.bundleId).filter((x): x is string => !!x);
  await prisma.bulkImportRow.deleteMany({ where: { runId: { in: runs } } });
  await prisma.bulkImportRun.deleteMany({ where: { id: { in: runs } } });
  await prisma.importBundle.deleteMany({ where: { id: { in: bundles } } });
  await prisma.aiImportJob.deleteMany({ where: { id: { in: created.jobs } } });
  await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
  await prisma.examSubTopic.deleteMany({ where: { subTopicId: { in: created.subTopics } } });
  await prisma.subTopic.deleteMany({ where: { id: { in: created.subTopics } } });
  await prisma.previousYearPaper.deleteMany({ where: { id: { in: created.papers } } });
  await prisma.exam.deleteMany({ where: { id: { in: created.exams } } });
  await prisma.setting.deleteMany({ where: { key: "ai.importer.routes" } });
  if (restore.openrouter) await prisma.setting.upsert({ where: { key: "api.openrouter" }, create: { key: "api.openrouter", value: restore.openrouter }, update: { value: restore.openrouter } });
  else await prisma.setting.deleteMany({ where: { key: "api.openrouter" } });
  if (restore.importer) await prisma.setting.upsert({ where: { key: "ai.importer" }, create: { key: "ai.importer", value: restore.importer }, update: { value: restore.importer } });
  else await prisma.setting.deleteMany({ where: { key: "ai.importer" } });
}

main()
  .catch((e) => {
    fail++;
    console.error(e);
  })
  .finally(async () => {
    if (process.env.KEEP !== "1") await cleanup().catch((e) => console.error("cleanup failed", e));
    check(`network guard: every request went to the loopback mock (hosts: ${[...requestHosts].join(", ") || "none"})`, blockedHosts.size === 0, [...blockedHosts]);
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
