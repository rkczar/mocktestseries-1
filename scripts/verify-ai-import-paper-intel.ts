/**
 * Source re-read, key matching and paper memory of the AI Question Importer — database suite (disposable scratch DB,
 * scratch vault, no AI, no network). Uses the ORIGINAL papers that failed:
 *
 *   - CMS 2013 Paper I (Word): the import is reproduced exactly as production made it, by running the importer's reader
 *     of release 85dac10 (taken from git) on the original file — 18 questions, a false section "S2", options lost —
 *     plus a 15-entry partial key reading. Then: dry run (nothing written), refused stale apply, question-level apply
 *     (PENDING results, missing questions added, non-questions rejected), field-by-field decision with history kept,
 *     the complete official key (transcribed from the key file) matched through Verify 1, and mark/key conflicts flagged.
 *   - AI-read scanned paper (CMS 2024 layout): two key sources (a question page's "key" + the real key file), a page
 *     whose numbers are out of sequence and a cover-page instruction item.
 *   - CMS 2025 Paper II (Word) with admin-approved questions: paper memory learned, learned again (no duplicates),
 *     confirmed, applied by Verify 1 as a check, rejected.
 *
 *   AI_IMPORT_PAPER_FIXTURES=<originals> DATABASE_URL=<scratch> AI_IMPORT_VAULT_DIR=<scratch> STORAGE_DIR=<scratch> \
 *   IMPORT_STAGING_DIR=<scratch> AI_IMPORT_DISABLE_KICK=1 NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/verify-ai-import-paper-intel.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportQuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";
import { putContent } from "@/lib/ai-import/vault";
import { readDocx } from "@/lib/ai-import/docx";
import { docxQuestions } from "@/lib/ai-import/process";
import { applySourceReread, sourceRereadPreview } from "@/lib/ai-import/source-reread";
import { applyRescan } from "@/lib/ai-import/review";
import { runPostProcessing } from "@/lib/ai-import/post";
import { runVerify1 } from "@/lib/ai-import/paper-verify";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { learnPaperMemory } from "@/lib/ai-import/paper-learn";
import { decidePaperRule, examPaperRules } from "@/lib/ai-import/taxonomy-memory";
import { sourceKeyOf, type ExtractedQuestion } from "@/lib/ai-import/types";

if (!/mts_paperintel|_scratch|paperverify/.test(process.env.DATABASE_URL ?? "") || /mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must be a disposable scratch database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.AI_IMPORT_PAPER_FIXTURES) {
  console.error("Set AI_IMPORT_VAULT_DIR (scratch) and AI_IMPORT_PAPER_FIXTURES (the original papers).");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
}
async function refused(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e instanceof Error ? e.message : String(e));
  }
}

const truth = JSON.parse(readFileSync("scripts/fixtures/ai-import-papers/truth.json", "utf8")).papers as Record<string, { file: string; officialKey?: Record<string, string>; sourceMarks?: Record<string, string | null>; sourceMarkContradictsKey?: number[] }>;
const FX = process.env.AI_IMPORT_PAPER_FIXTURES!;
const RUN = Date.now().toString(36);

async function syntheticExam() {
  const exam = await prisma.exam.create({ data: { name: `SYNTHETIC CMS ${RUN}`, code: `SYNCMS${RUN}`.slice(0, 20), isActive: true, durationMinutes: 120, totalQuestions: 120, negativeMarking: 0 } });
  const TAX: Record<string, string[]> = {
    "General Medicine": ["Cardiology", "Respiratory Medicine", "Nephrology", "Infectious Diseases", "Gastroenterology"],
    Pediatrics: ["Neonatology", "Growth and Development"],
    "General Surgery": ["Gastrointestinal Surgery", "Trauma"],
    "Obstetrics & Gynaecology": ["Obstetrics", "Gynaecology"],
    "Community Medicine / PSM": ["Epidemiology", "National Health Programmes"],
  };
  const ids = new Map<string, string>();
  for (const [i, [name, topics]] of Object.entries(TAX).entries()) {
    const s = await prisma.subject.create({ data: { name: `${name}`, nameKey: `${taxonomyNameKey(name)}-${RUN}`, originExamId: exam.id, order: i } });
    ids.set(name, s.id);
    await prisma.examSubject.create({ data: { examId: exam.id, subjectId: s.id, displayOrder: i } });
    for (const [t, topic] of topics.entries()) {
      const row = await prisma.topic.create({ data: { subjectId: s.id, name: topic, nameKey: `${taxonomyNameKey(topic)}-${RUN}`, order: t } });
      await prisma.examTopic.create({ data: { examId: exam.id, topicId: row.id, displayOrder: t } });
    }
  }
  const p1 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2013, title: "UPSC CMS PAPER 1" } });
  const p2 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2025, title: "UPSC CMS PAPER 2" } });
  return { exam, ids, p1, p2 };
}

async function jobWithPaper(input: { examId: string; actorId: string; title: string; pyp: string; file: string; ext: string; kind: string; status?: AiImportJobStatus }) {
  const bytes = readFileSync(path.join(FX, input.file));
  const stored = await putContent("files", bytes, input.ext);
  const job = await prisma.aiImportJob.create({ data: { title: `${input.title} ${RUN}`, examId: input.examId, createdById: input.actorId, budgetInr: 0, status: input.status ?? AiImportJobStatus.NEEDS_REVIEW, expectedQuestions: 120, previousYearPaperId: input.pyp } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, role: AiImportFileRole.PAPER, originalName: input.file, ext: input.ext, declaredBytes: bytes.length, bytes: bytes.length, sha256: stored.sha256, storageKey: stored.key, status: AiImportFileStatus.PROCESSED, detected: { kind: input.kind }, pageCount: 1, uploadedById: input.actorId } });
  return { job, file };
}

async function keyFile(jobId: string, paperFileId: string, actorId: string, name: string) {
  // As the importer records an image / scanned key: no text layer, so only AI vision can read it.
  return prisma.aiImportFile.create({ data: { jobId, role: AiImportFileRole.ANSWER_KEY, paperFileId, originalName: name, ext: "pdf", declaredBytes: 1, bytes: 1, status: AiImportFileStatus.PROCESSED, detected: { kind: "pdf", facts: { textPages: 0, pages: 1 } }, pageCount: 1, uploadedById: actorId } });
}

const questionRow = (jobId: string, fileId: string, q: ExtractedQuestion, i: number, extra: Partial<Prisma.AiImportQuestionUncheckedCreateInput> = {}): Prisma.AiImportQuestionUncheckedCreateInput => ({ jobId, fileId, sourceKey: sourceKeyOf(q), sourceNumber: q.number, sourceLabel: q.label, pages: q.pages, orderIndex: i, status: AiImportQuestionStatus.EXTRACTED, data: q as unknown as Prisma.InputJsonValue, questionType: q.type, optionCount: q.options.length, contentFormat: q.contentFormat, confidence: q.confidence, sourceAnswer: q.printedAnswer, ...extra });
const ctxOf = async (jobId: string) => ({ job: await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } }), settings: { ...(await getImporterSettings()), aiEnabled: false }, examName: "", subjectName: null, stillRunning: async () => true });

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const { exam, ids, p1, p2 } = await syntheticExam();
  const qbBefore = await prisma.question.count();

  // ---------------------------------------------------------------------------------------------------------------
  section("CMS 2013 Paper I — the production import reproduced with the release 85dac10 reader");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "old-reader-"));
  writeFileSync(path.join(tmp, "local-parse.ts"), execFileSync("git", ["show", "85dac10:lib/ai-import/local-parse.ts"]));
  const old = (await import(pathToFileURL(path.join(tmp, "local-parse.ts")).href)) as typeof import("@/lib/ai-import/local-parse");
  const doc = await readDocx(path.join(FX, truth["cms-2013-p1"].file));
  const oldQs = old.splitQuestions(doc.lines).blocks.map((b) => old.blockToQuestion(b, 1, "DOCX").q);
  check("release 85dac10 reads 18 questions with a false section S2 (as in production)", oldQs.length === 18 && oldQs.filter((q) => q.section === "S2").length === 4, oldQs.map((q) => `${q.section}${q.number}`));
  const { job: j1, file: f1 } = await jobWithPaper({ examId: exam.id, actorId: admin.id, title: "CMSE 2013 Paper I", pyp: p1.id, file: truth["cms-2013-p1"].file, ext: "docx", kind: "docx" });
  for (const [i, q] of oldQs.entries()) await prisma.aiImportQuestion.create({ data: questionRow(j1.id, f1.id, q, i, { status: AiImportQuestionStatus.NEEDS_CORRECTION }) });
  const k1 = await keyFile(j1.id, f1.id, admin.id, "paper-1-answer-key.pdf");
  // The partial AI reading production stored: 15 entries of a 120-cell grid.
  await prisma.aiImportKeyEntry.createMany({ data: Array.from({ length: 15 }, (_, i) => ({ jobId: j1.id, keyFileId: k1.id, paperFileId: f1.id, sourceNumber: i + 1, rawValue: "ABCD"[i % 4], status: "UNMATCHED" })) });
  const before = new Map((await prisma.aiImportQuestion.findMany({ where: { jobId: j1.id } })).map((q) => [q.id, JSON.stringify(q.data)]));

  const pv = await sourceRereadPreview(j1.id);
  check("dry run: 120 questions in the source, 18 stored", pv.totals.source === 120 && pv.totals.stored === 18, pv.totals);
  check("dry run: 106 missing questions, 4 stored lines that are not questions (S2#1–4)", pv.totals.new === 106 && pv.totals.notInSource === 4 && pv.files[0].items.filter((x) => x.action === "NOT_IN_SOURCE").every((x) => x.key.startsWith("S2#")), pv.totals);
  check("dry run: every stored Q1–Q14 differs from the source (lost options / wrong printed answers)", pv.totals.changed === 14, pv.totals);
  const q1 = pv.files[0].items.find((x) => x.key === "#1")!;
  check("dry run: Q1 shows the printed answer D → C and option D restored", q1.fields.some((f) => f.field === "printedAnswer" && f.current === "D" && f.next === "C") && q1.fields.some((f) => f.field === "option:D" && f.next === "chromium"), q1.fields);
  check("dry run: the 15-entry key reading is incomplete → no key corrections, a note says so", pv.key.complete === false && pv.totals.keyCorrections === 0 && pv.notes.some((n) => /incomplete/.test(n)), { key: pv.key, notes: pv.notes });
  check("dry run: AI cost ₹0 (Word source read locally)", pv.costInr === 0);
  check("dry run: nothing was written (questions, versions, events)", JSON.stringify([...before.values()]) === JSON.stringify((await prisma.aiImportQuestion.findMany({ where: { jobId: j1.id } })).map((q) => JSON.stringify(q.data))) && (await prisma.aiImportQuestionVersion.count({ where: { jobId: j1.id } })) === 0 && (await prisma.aiImportEvent.count({ where: { jobId: j1.id } })) === 0);
  check("apply with a stale preview is refused", await refused(() => applySourceReread({ jobId: j1.id, actorId: admin.id, hash: "0".repeat(32), choice: { pending: ["#1"], add: [], reject: [] } }), /changed since this preview/));
  const changed = pv.files[0].items.filter((x) => x.action === "CHANGED").map((x) => x.key);
  const added = pv.files[0].items.filter((x) => x.action === "NEW").map((x) => x.key);
  const notIn = pv.files[0].items.filter((x) => x.action === "NOT_IN_SOURCE").map((x) => x.questionId!);
  const r = await applySourceReread({ jobId: j1.id, actorId: admin.id, hash: pv.hash, choice: { pending: changed, add: added, reject: notIn } });
  check("apply: 14 pending results, 106 questions added, 4 rejected", r.pending === 14 && r.added === 106 && r.rejected === 4, r);
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId: j1.id }, include: { versions: true } });
  const kept = rows.filter((q) => before.has(q.id) && !notIn.includes(q.id));
  check("apply: the 14 existing questions are NOT overwritten (stored extraction unchanged)", kept.length === 14 && kept.every((q) => JSON.stringify(q.data) === before.get(q.id) && !q.editedData));
  check("apply: each of them has one PENDING source re-read result", kept.every((q) => q.versions.filter((v) => v.kind === "RESCAN" && v.status === "PENDING" && v.model === "source re-read (local, no AI)").length === 1));
  check("apply: the 4 non-questions are REJECTED with a reason (reversible)", rows.filter((q) => notIn.includes(q.id)).every((q) => q.status === AiImportQuestionStatus.REJECTED && /Not in the source/.test(q.rejectedReason ?? "")));
  const live = rows.filter((q) => q.status !== AiImportQuestionStatus.REJECTED);
  check("apply: 120 live questions numbered 1–120, one each", live.length === 120 && [...new Set(live.map((q) => q.sourceNumber))].length === 120);
  check("apply: nothing approved, imported or published; Question Bank untouched", rows.every((q) => !q.approvedById && !q.questionId) && (await prisma.question.count()) === qbBefore);
  check("apply: added questions carry the source's printed answer as UNVERIFIED (no official key)", rows.filter((q) => !before.has(q.id) && q.sourceNumber !== 108).every((q) => q.answerStatus === "UNVERIFIED" || q.answerStatus === "AMBIGUOUS_MAPPING"), [...new Set(rows.filter((q) => !before.has(q.id)).map((q) => q.answerStatus))]);
  check("apply: the partial key reading (15 of 120) is not used — Q15 gets no official answer from it", rows.find((q) => q.sourceNumber === 15)!.answerStatus !== "OFFICIAL_MATCHED" && !rows.find((q) => q.sourceNumber === 15)!.officialAnswer.length, rows.find((q) => q.sourceNumber === 15));
  check("apply: an event and an audit-log entry record it", (await prisma.aiImportEvent.count({ where: { jobId: j1.id, type: "SOURCE_REREAD_APPLIED" } })) === 1 && (await prisma.auditLog.count({ where: { entityId: j1.id, action: "AI_IMPORT_SOURCE_REREAD" } })) === 1);

  const q1row = rows.find((q) => q.sourceKey === "#1")!;
  const v = q1row.versions.find((x) => x.status === "PENDING")!;
  await applyRescan(v.id, admin.id, ["printedAnswer", "option:C", "option:D"]);
  const q1after = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q1row.id }, include: { versions: true } });
  const eff = q1after.editedData as unknown as ExtractedQuestion;
  check("field-by-field decision: Q1 takes the answer C and option D from the re-read", eff.printedAnswer.join() === "C" && eff.options.find((o) => o.label === "D")?.text === "chromium", eff);
  check("history: the original extraction stays in `data`, the previous version is kept (ADMIN_EDIT)", JSON.stringify(q1after.data) === before.get(q1row.id) && q1after.versions.some((x) => x.kind === "ADMIN_EDIT") && q1after.versions.some((x) => x.kind === "RESCAN" && x.status === "APPLIED"));
  const pv2 = await sourceRereadPreview(j1.id);
  check("a second dry run sees the waiting results and the new questions (nothing re-added)", pv2.totals.new === 0 && pv2.totals.pendingExists === 13 && pv2.hash !== pv.hash, pv2.totals);

  // The complete official key (transcribed from the key file) replaces the partial reading; Verify 1 (free) matches it.
  await prisma.aiImportKeyEntry.deleteMany({ where: { keyFileId: k1.id } });
  await prisma.aiImportKeyEntry.createMany({ data: Object.entries(truth["cms-2013-p1"].officialKey!).map(([n, val]) => ({ jobId: j1.id, keyFileId: k1.id, paperFileId: f1.id, sourceNumber: Number(n), rawValue: val })) });
  const pv3 = await sourceRereadPreview(j1.id);
  check("dry run with the complete key: key complete, marks contradicting the key listed (16)", pv3.key.complete && pv3.totals.markConflicts === truth["cms-2013-p1"].sourceMarkContradictsKey!.length, { key: pv3.key, conflicts: pv3.totals.markConflicts });
  await runVerify1(j1.id, admin.id);
  const vrows = await prisma.aiImportQuestion.findMany({ where: { jobId: j1.id, status: { not: AiImportQuestionStatus.REJECTED } } });
  const contradict = new Set(truth["cms-2013-p1"].sourceMarkContradictsKey!);
  const added2 = vrows.filter((q) => !before.has(q.id));
  check("Verify 1: added questions whose printed mark equals the key → OFFICIAL_MATCHED", added2.filter((q) => !contradict.has(q.sourceNumber!) && q.sourceNumber !== 108).every((q) => q.answerStatus === "OFFICIAL_MATCHED"), added2.filter((q) => !contradict.has(q.sourceNumber!) && q.sourceNumber !== 108 && q.answerStatus !== "OFFICIAL_MATCHED").map((q) => [q.sourceNumber, q.answerStatus, q.issueCodes]));
  check("Verify 1: a printed mark that contradicts the key → KEY_MISMATCH + ANSWER_MISMATCH, no answer chosen", added2.filter((q) => contradict.has(q.sourceNumber!)).every((q) => q.answerStatus === "KEY_MISMATCH" && q.issueCodes.includes("ANSWER_MISMATCH") && !q.finalAnswer.length), added2.filter((q) => contradict.has(q.sourceNumber!)).map((q) => [q.sourceNumber, q.answerStatus]));
  check("Verify 1: Q108 (dropped in the key) → WITHDRAWN", vrows.find((q) => q.sourceNumber === 108)?.answerStatus === "WITHDRAWN");
  check("no question is verified by extraction alone (no Verify 2 result anywhere)", vrows.every((q) => !(q.data as unknown as ExtractedQuestion).paperVerify?.v2));
  check("Verify 1 never approves or publishes", vrows.every((q) => !q.approvedById && !q.questionId) && (await prisma.question.count()) === qbBefore);

  // ---------------------------------------------------------------------------------------------------------------
  section("AI-read scanned paper — key sources, number sequence, instruction items");
  const { job: j2, file: f2 } = await jobWithPaper({ examId: exam.id, actorId: admin.id, title: "CMS 2024 Paper I (scanned layout)", pyp: p1.id, file: "CMS_GS_paper1.pdf", ext: "pdf", kind: "pdf" });
  const mk = (n: number | null, page: number, stem: string, options = 4): ExtractedQuestion => ({ section: "", number: n, label: String(n ?? "?"), pages: [page], type: "SINGLE_CORRECT", stem, options: Array.from({ length: options }, (_, i) => ({ label: "ABCD"[i], printed: `(${"abcd"[i]})`, text: `option ${i + 1}` })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.9, unreadable: [], figures: [], method: "AI_VISION", notes: [] });
  const scanned = [mk(1, 1, "This Test Booklet contains 120 items (questions). Mark each response on the Answer Sheet.", 1), mk(5, 2, "Which are major Jones criteria?"), mk(6, 2, "A 70-year-old man with dyspnoea"), mk(9, 3, "Which scoring system assesses stroke risk?"), mk(10, 3, "Consider the following criteria: pleural fluid"), mk(11, 4, "Lofgren syndrome statements"), mk(12, 4, "Diagnosis of pulmonary tuberculosis")];
  for (const [i, q] of scanned.entries()) await prisma.aiImportQuestion.create({ data: questionRow(j2.id, f2.id, q, i) });
  // A "key" read from question page 3 (a table of the questions themselves), then the real key file restarting at 1.
  await prisma.aiImportKeyEntry.createMany({ data: [11, 12].map((n) => ({ jobId: j2.id, keyFileId: f2.id, paperFileId: f2.id, sourceNumber: n, rawValue: "(d)", page: 3 })) });
  const k2 = await keyFile(j2.id, f2.id, admin.id, "Screenshot_key.jpg");
  const key24 = truth["cms-2024-p1"].officialKey!;
  await prisma.aiImportKeyEntry.createMany({ data: Object.entries(key24).map(([n, val]) => ({ jobId: j2.id, keyFileId: k2.id, paperFileId: f2.id, sourceNumber: Number(n), rawValue: val })) });
  await runPostProcessing(await ctxOf(j2.id));
  const s2 = new Map((await prisma.aiImportQuestion.findMany({ where: { jobId: j2.id } })).map((q) => [q.sourceKey, q]));
  check("the real key file is matched even though another source starts earlier (no false key section)", s2.get("#5")!.answerStatus === "WITHDRAWN" && s2.get("#6")!.answerStatus === "OFFICIAL_MATCHED" && s2.get("#6")!.officialAnswer.join() === key24["6"], ["#5", "#6"].map((k) => [k, s2.get(k)!.answerStatus, s2.get(k)!.officialAnswer]));
  check("page 3 (Q9 after Q6) is out of sequence → its questions get no answer by number, with the reason", ["#9", "#10"].every((k) => s2.get(k)!.answerStatus === "AMBIGUOUS_MAPPING" && !s2.get(k)!.officialAnswer.length && JSON.stringify(s2.get(k)!.issues).includes("not in sequence")), ["#9", "#10"].map((k) => [k, s2.get(k)!.answerStatus, s2.get(k)!.issues]));
  check("a question-page “key” that disagrees with the real key → ambiguous, never the page's value silently (Q12)", s2.get("#12")!.answerStatus === "AMBIGUOUS_MAPPING" && !s2.get("#12")!.finalAnswer.length, [s2.get("#12")!.answerStatus, s2.get("#12")!.issues]);
  check("…and one that agrees (Q11 “(d)” = “D”) is matched to the real key's value", s2.get("#11")!.answerStatus === "OFFICIAL_MATCHED" && s2.get("#11")!.officialAnswer.join() === key24["11"], [s2.get("#11")!.answerStatus, s2.get("#11")!.officialAnswer]);
  check("the cover-page instruction gets no key answer and is flagged as an instruction", s2.get("#1")!.answerStatus === "AMBIGUOUS_MAPPING" && JSON.stringify(s2.get("#1")!.issues).includes("instruction to candidates"), [s2.get("#1")!.answerStatus, s2.get("#1")!.issues]);
  const pvs = await sourceRereadPreview(j2.id);
  const plan = pvs.files[0].scanned!;
  check("scanned dry run: out-of-sequence page 3, the instruction item, missing numbers and a re-scan estimate basis", plan.suspectPages.map((p) => p.page).join() === "3" && plan.instructionItems.length === 1 && plan.missingNumbers.slice(0, 6).join() === "1,2,3,4,7,8" && /no recorded page reads|this import's average/.test(plan.basis), plan);

  // ---------------------------------------------------------------------------------------------------------------
  section("Paper memory — CMS 2025 Paper II (approved questions) and CMS 2013 Paper I");
  const { job: j3, file: f3 } = await jobWithPaper({ examId: exam.id, actorId: admin.id, title: "cms 2025 2", pyp: p2.id, file: "cms_2025_2_.docx", ext: "docx", kind: "docx", status: AiImportJobStatus.COMPLETED });
  const q25 = docxQuestions(await readDocx(path.join(FX, "cms_2025_2_.docx")));
  const subj = (n: number) => ids.get(n <= 40 ? "General Surgery" : n <= 80 ? "Obstetrics & Gynaecology" : "Community Medicine / PSM")!;
  for (const [i, q] of q25.entries()) await prisma.aiImportQuestion.create({ data: questionRow(j3.id, f3.id, q, i, { status: AiImportQuestionStatus.READY, subjectId: subj(q.number!), approvedById: admin.id, approvedAt: new Date(), finalAnswer: q.printedAnswer, officialAnswer: q.printedAnswer, answerStatus: "OFFICIAL_MATCHED" }) });
  const k3 = await keyFile(j3.id, f3.id, admin.id, "Screenshot_key_2025_2.jpg");
  const byNo = new Map((await prisma.aiImportQuestion.findMany({ where: { jobId: j3.id } })).map((q) => [q.sourceNumber, q.id]));
  await prisma.aiImportKeyEntry.createMany({ data: q25.map((q) => ({ jobId: j3.id, keyFileId: k3.id, paperFileId: f3.id, sourceNumber: q.number!, rawValue: q.printedAnswer[0], status: "OK", matchedQuestionId: byNo.get(q.number!) })) });
  const l1 = await learnPaperMemory(j3.id, admin.id);
  let rules = await examPaperRules(exam.id);
  check("learned as PROPOSED only, for PAPER II", l1.paper === "PAPER II" && l1.added > 0 && rules.every((x) => x.status === "PROPOSED"), l1);
  const has = (kind: string) => rules.find((x) => x.kind === kind && x.paper === "PAPER II");
  check("headings, answer line, option labels, numbering “Q1.”, formats, key layout, subject scope learned with evidence", ["SECTION_HEADINGS", "ANSWER_MARK", "OPTION_LABELS", "NUMBERING", "QUESTION_TYPES", "ANSWER_KEY_LAYOUT", "SUBJECT_SCOPE", "ANNOTATION_RELIABILITY"].every((k) => !!has(k) && has(k)!.evidence.length > 0) && (has("NUMBERING")!.value.style === "QN."), rules.map((x) => [x.kind, x.paper, x.key]));
  check("evidence names the import, the file and its SHA-256", has("SECTION_HEADINGS")!.evidence[0].fileSha256 === (await prisma.aiImportFile.findUniqueOrThrow({ where: { id: f3.id } })).sha256 && has("SECTION_HEADINGS")!.evidence[0].jobId === j3.id);
  check("approved marks agree with the approved key 120/120", has("ANNOTATION_RELIABILITY")!.value.agree === 120);
  const l2 = await learnPaperMemory(j3.id, admin.id);
  check("learning the same import again adds nothing", l2.added === 0 && (await examPaperRules(exam.id)).length === rules.length, l2);
  const l3 = await learnPaperMemory(j1.id, admin.id);
  rules = await examPaperRules(exam.id);
  check("CMS 2013 Paper I learned as PAPER I (its marks are not compared: no approved key)", l3.paper === "PAPER I" && !rules.some((x) => x.kind === "ANNOTATION_RELIABILITY" && x.paper === "PAPER I"), l3);
  check("option labels seen in PAPER I and PAPER II → an EXAM proposal", rules.some((x) => x.scope === "EXAM" && x.kind === "OPTION_LABELS" && x.status === "PROPOSED"));
  check("no rule stores answers or AI output", rules.every((x) => !/"(?:answer|finalAnswer|aiAnswer|officialAnswer)"/.test(JSON.stringify(x.value))));
  const scope = rules.find((x) => x.kind === "SUBJECT_SCOPE" && x.paper === "PAPER II")!;
  // Verify 1 of a PAPER II import with a question outside the confirmed subjects.
  const { job: j4, file: f4 } = await jobWithPaper({ examId: exam.id, actorId: admin.id, title: "cms 2025 2 again", pyp: p2.id, file: "cms_2025_2_.docx", ext: "docx", kind: "docx" });
  await prisma.aiImportQuestion.create({ data: questionRow(j4.id, f4.id, q25[96], 0, { subjectId: ids.get("Pediatrics")!, taxonomySource: "admin" }) });
  await runVerify1(j4.id, admin.id);
  const before4 = (await prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId: j4.id } })).data as unknown as ExtractedQuestion;
  check("a PROPOSED scope is not used by Verify 1", !JSON.stringify(before4.paperVerify?.v1?.problems ?? []).includes("Paper memory"));
  await decidePaperRule(exam.id, admin.id, scope.id, "CONFIRMED", "checked");
  await runVerify1(j4.id, admin.id);
  const after4 = await prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId: j4.id } });
  const v1 = (after4.data as unknown as ExtractedQuestion).paperVerify?.v1;
  check("a CONFIRMED scope flags a subject outside it (FORMAT_DEVIATION), the subject is not changed", JSON.stringify(v1?.problems ?? []).includes("Paper memory: PAPER II covers") && after4.subjectId === ids.get("Pediatrics") && after4.issueCodes.includes("FORMAT_DEVIATION"), v1?.problems);
  await decidePaperRule(exam.id, admin.id, scope.id, "REJECTED", "test");
  await runVerify1(j4.id, admin.id);
  const v1b = ((await prisma.aiImportQuestion.findFirstOrThrow({ where: { jobId: j4.id } })).data as unknown as ExtractedQuestion).paperVerify?.v1;
  check("a REJECTED rule is never used", !JSON.stringify(v1b?.problems ?? []).includes("Paper memory"));
  check("every memory change is audited", (await prisma.auditLog.count({ where: { entityId: exam.id, action: { in: ["AI_IMPORT_PAPER_MEMORY_LEARNED", "AI_IMPORT_PAPER_RULE_CONFIRMED", "AI_IMPORT_PAPER_RULE_REJECTED"] } } })) >= 5);
  check("the Question Bank was never touched by this suite", (await prisma.question.count()) === qbBefore);

  // ---------------------------------------------------------------------------------------------------------------
  if (!process.env.KEEP) {
    await prisma.aiImportJob.deleteMany({ where: { id: { in: [j1.id, j2.id, j3.id, j4.id] } } });
    await prisma.setting.deleteMany({ where: { key: `ai.importer.taxonomyMemory:${exam.id}` } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: exam.id } });
    await prisma.examTopic.deleteMany({ where: { examId: exam.id } });
    await prisma.examSubject.deleteMany({ where: { examId: exam.id } });
    await prisma.topic.deleteMany({ where: { subject: { originExamId: exam.id } } });
    await prisma.subject.deleteMany({ where: { originExamId: exam.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
