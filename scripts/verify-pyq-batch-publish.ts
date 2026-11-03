/**
 * Previous Year Paper import batches + batch publish — server regression.
 *
 *   DATABASE_URL=postgresql://…/mts_pyqbatch_flows NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-pyq-batch-publish.ts
 *
 * Synthetic only (prefix PBAT-); refuses any database whose name lacks
 * "flows". Imports real CSVs through the importer (validateImportRun +
 * executeBulkImport) and covers: the yearless exam-name rule, loose taxonomy
 * match, Paper Question Number rules, the stored review reason, batch labels
 * and statuses, preview reasons, scope refusals (other batch / paper /
 * retired / missing), review re-check + mark reviewed, publish (audit,
 * replay, concurrency, all-or-nothing), and the form "publish after save" gate.
 */
import "dotenv/config";
import { BulkImportRowStatus, BulkImportStatus, ImportRowSeverity, QuestionSource, QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildTaxonomyLookups, examBaseKey, looseTaxonomyKey, parseImportFile, resolveRow, reviewTriggerWarnings, runExamContextFor, validateImportRows, type BulkImportRow } from "@/lib/bulk-import";
import { validateImportRun } from "@/lib/bulk-import-stage";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import { paperQuestionNumberOf } from "@/lib/paper-question-numbers";
import { publishRefusal } from "@/lib/question-publish-policy";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";
import {
  BatchActionError,
  evaluateBatchPublish,
  loadPaperBatchOverview,
  markBatchQuestionsReviewed,
  publishBatchQuestions,
  recheckReviewFlags,
} from "@/lib/pyq-import-batches";
import { MANUAL_BATCH, batchStatus, labelBatches } from "@/lib/pyq-import-batches-shared";
import { createFixtureTopic } from "./fixture-taxonomy";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const section = (t: string) => console.log(`\n== ${t}`);
async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof BatchActionError ? `BATCH:${e.message}` : `THROWN:${e instanceof Error ? e.message : String(e)}`;
  }
}

const HEADER = ["exam", "year", "subject", "topic", "source", "question_number", "question_text", "option_a", "option_b", "option_c", "option_d", "correct_answer", "difficulty", "status"];
const csvFile = (rows: string[][], name: string) => {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return new File([[HEADER, ...rows].map((r) => r.map(esc).join(",")).join("\n")], name);
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const dbName = url.replace(/\?.*$/, "").split("/").pop() ?? "";
  if (dbName === "mocktestseries" || !/flows/.test(dbName)) throw new Error(`Refusing to run outside a scratch *flows* database (got "${dbName}").`);
  const sfx = Date.now().toString(36);

  // ------------------------------------------------------------ pure rules
  section("Pure rules");
  check("examBaseKey: year label stripped", examBaseKey("RUHS MEDICAL OFFICER EXAM 2026") === examBaseKey("RUHS Medical Officer Exam"));
  check("examBaseKey: '(2016)' and '- 2016' stripped", examBaseKey("RUHS Medical Officer Exam (2016)") === "ruhs medical officer exam" && examBaseKey("RUHS Medical Officer Exam - 2016") === "ruhs medical officer exam");
  check("examBaseKey: different exam differs", examBaseKey("RUHS Staff Nurse Exam 2026") !== examBaseKey("RUHS Medical Officer Exam"));
  check("looseTaxonomyKey: spacing around '/' ignored", looseTaxonomyKey("Radiodiagnosis/Radiology") === looseTaxonomyKey("Radiodiagnosis / Radiology"));
  check("looseTaxonomyKey: words still matter", looseTaxonomyKey("Radio diagnosis/Radiology") !== looseTaxonomyKey("Radiodiagnosis/Radiology"));
  check("paperQuestionNumberOf", paperQuestionNumberOf("38") === 38 && paperQuestionNumberOf(" 7 ") === 7 && paperQuestionNumberOf("Q38") === null && paperQuestionNumberOf("0") === null && paperQuestionNumberOf("2.1") === null && paperQuestionNumberOf("") === null);
  check(
    "reviewTriggerWarnings drops 'Sub-topic not provided'",
    JSON.stringify(reviewTriggerWarnings(["Sub-topic not provided", 'Exam "X" does not match any existing Exam — using the selected import Exam "Y" instead.'])) ===
      JSON.stringify(['Exam "X" does not match any existing Exam — using the selected import Exam "Y" instead.'])
  );
  {
    const t = (d: string) => new Date(d);
    const l = labelBatches([
      { key: "a", createdAt: t("2026-01-01"), linked: 100, active: 0 },
      { key: "b", createdAt: t("2026-02-01"), linked: 0, active: 0 },
      { key: "c", createdAt: t("2026-03-01"), linked: 96, active: 96 },
    ]);
    check("labels: retired / previous / corrected", l.get("a")?.label === "RETIRED IMPORT" && l.get("b")?.label === "PREVIOUS IMPORT" && l.get("c")?.label === "CORRECTED IMPORT" && l.get("a")?.isOriginal === true, [...l]);
    const l2 = labelBatches([{ key: "x", createdAt: t("2026-01-01"), linked: 5, active: 5 }]);
    check("labels: single live batch is ORIGINAL", l2.get("x")?.label === "ORIGINAL IMPORT");
    const l3 = labelBatches([
      { key: "x", createdAt: t("2026-01-01"), linked: 5, active: 5 },
      { key: "y", createdAt: t("2026-02-01"), linked: 5, active: 5 },
    ]);
    check("labels: newer live batch without retirement is NEW", l3.get("x")?.label === "ORIGINAL IMPORT" && l3.get("y")?.label === "NEW IMPORT");
  }
  check("status: all retired", batchStatus({ linked: 3, retired: 3, published: 0, draft: 0, rolledBack: 0, runStatus: "COMPLETED" }) === "RETIRED");
  check("status: partial", batchStatus({ linked: 4, retired: 0, published: 2, draft: 2, rolledBack: 0, runStatus: "COMPLETED" }) === "PARTIALLY PUBLISHED");
  check("status: rolled back", batchStatus({ linked: 0, retired: 0, published: 0, draft: 0, rolledBack: 4, runStatus: "ROLLED_BACK" }) === "ROLLED BACK");
  check("status: never imported", batchStatus({ linked: 0, retired: 0, published: 0, draft: 0, rolledBack: 0, runStatus: "READY" }) === "NOT IMPORTED");

  // ------------------------------------------------------------ fixture
  section("Fixture + real imports");
  const exam = await prisma.exam.create({ data: { name: `PBAT Medical Officer Exam ${sfx} 2026`, code: `PBAT${sfx}`.toUpperCase(), year: 2026, isActive: true } });
  const otherExam = await prisma.exam.create({ data: { name: `PBAT Other ${sfx}`, code: `PBATO${sfx}`.toUpperCase(), isActive: true } });
  const subjectName = `PBAT Radiodiagnosis / Radiology ${sfx}`;
  const subject = await prisma.subject.create({
    data: { name: subjectName, nameKey: taxonomyNameKey(subjectName), originExamId: exam.id, examLinks: { create: [{ examId: exam.id, displayOrder: 0 }] } },
  });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: `PBAT Topic ${sfx}` });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2016, title: `PBAT Paper 2016 ${sfx}` } });
  const otherPaper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2017, title: `PBAT Paper 2017 ${sfx}` } });
  let admin = await prisma.adminUser.findFirst({ select: { id: true } });
  if (!admin) {
    const role = await prisma.role.findFirst({ select: { id: true } });
    if (!role) throw new Error("Scratch DB has no Role rows — run prisma/seed.ts first.");
    admin = await prisma.adminUser.create({ data: { name: "PBAT Admin", username: `pbat-${sfx}`, passwordHash: "x", roleId: role.id }, select: { id: true } });
  }
  const actorId = admin.id;

  const yearless = `PBAT Medical Officer Exam ${sfx}`;
  const row = (o: { exam?: string; subject?: string; no: string; text: string; answer?: string; status?: string }) => [
    o.exam ?? exam.name,
    "2016",
    o.subject ?? subjectName,
    topic.name,
    "PYQ",
    o.no,
    o.text,
    "opt a",
    "opt b",
    "opt c",
    "opt d",
    o.answer ?? "B",
    "MEDIUM",
    o.status ?? "DRAFT",
  ];

  async function importCsv(rows: string[][], label: string) {
    const { rows: parsed } = await parseImportFile(csvFile(rows, `${label}.csv`));
    const run = await prisma.bulkImportRun.create({
      data: {
        adminUserId: actorId,
        filename: `${label}.csv`,
        label,
        examId: exam.id,
        examYear: 2016,
        previousYearPaperId: paper.id,
        importSource: "QUESTION_BANK",
        totalRows: parsed.length,
        duplicateStrategy: "ADD_AS_NEW",
        status: BulkImportStatus.UPLOADED,
        rows: {
          create: parsed.map((r: BulkImportRow) => ({
            rowNumber: r.rowNumber,
            status: BulkImportRowStatus.PENDING,
            severity: ImportRowSeverity.ERROR,
            rawData: r as unknown as Prisma.InputJsonValue,
          })),
        },
      },
    });
    await validateImportRun(run.id);
    const out = await executeBulkImport({ runId: run.id, adminUserId: actorId, allowExceedTarget: true });
    const qs = await prisma.question.findMany({ where: { importBatchId: run.id }, orderBy: { paperQuestionNumber: { sort: "asc", nulls: "last" } } });
    return { run, out, qs };
  }

  // Batch 1 — the original import (3 published), later retired.
  const b1 = await importCsv([1, 2, 3].map((n) => row({ no: String(n), text: `PBAT ${sfx} original ${n}`, status: "PUBLISHED" })), `pbat-original-${sfx}`);
  check("batch 1: 3 imported + published", b1.out.successCount === 3 && b1.qs.every((q) => q.status === "PUBLISHED" && q.previousYearPaperId === paper.id), b1.out);
  check("batch 1: numbers 1–3 stored", b1.qs.map((q) => q.paperQuestionNumber).join(",") === "1,2,3");
  await prisma.question.updateMany({ where: { importBatchId: b1.run.id }, data: { status: QuestionStatus.ARCHIVED, retiredAt: new Date(), retiredReason: "PBAT fixture retire" } });

  // Manual (no import) live question holding number 7.
  const manual7 = await prisma.question.create({
    data: {
      code: `PBAT-${sfx}-M7`,
      examId: exam.id,
      subjectId: subject.id,
      topicId: topic.id,
      text: `PBAT ${sfx} manual seven`,
      status: QuestionStatus.PUBLISHED,
      source: QuestionSource.PYQ,
      examYear: 2016,
      previousYearPaperId: paper.id,
      paperQuestionNumber: 7,
      options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${label} m7`, isCorrect: label === "A", order })) },
    },
  });

  // Batch 2 — the corrected import (all DRAFT).
  const b2rows = [
    row({ no: "1", exam: yearless, text: `PBAT ${sfx} corrected 1` }), // yearless exam → recognised, not flagged
    row({ no: "2", exam: yearless, text: `PBAT ${sfx} corrected 2` }),
    row({ no: "3", exam: `PBAT Totally Different ${sfx}`, text: `PBAT ${sfx} corrected 3` }), // genuine mismatch → flagged
    row({ no: "4", subject: `PBAT Radiodiagnosis/Radiology ${sfx}`, text: `PBAT ${sfx} corrected 4` }), // loose subject match
    row({ no: "5", answer: "", text: `PBAT ${sfx} corrected 5` }), // no correct answer → flagged
    row({ no: "abc", text: `PBAT ${sfx} corrected 6` }), // invalid number → flagged
    row({ no: "7", text: `PBAT ${sfx} corrected 7` }), // number held by live manual question → flagged
    row({ no: "8", text: `PBAT ${sfx} corrected 8` }),
    row({ no: "9", text: `PBAT ${sfx} corrected 9` }),
    row({ no: "10", text: `PBAT ${sfx} manual seven` }), // same text as a published paper question
  ];
  const b2 = await importCsv(b2rows, `pbat-corrected-${sfx}`);
  const byText = (n: number | string) => b2.qs.find((q) => q.text === `PBAT ${sfx} corrected ${n}`)!;
  const dupText = b2.qs.find((q) => q.text === `PBAT ${sfx} manual seven`)!;
  check("batch 2: all 10 rows imported as Draft", b2.qs.length === 10 && b2.qs.every((q) => q.status === "DRAFT"), b2.out);
  check("numbers reused from the retired batch are NOT flagged (1, 2, 4)", [1, 2, 4].every((n) => !byText(n).reviewRequired), [1, 2, 4].map((n) => byText(n).reviewReason));
  check("yearless exam name → the selected exam, no review flag", byText(1).examId === exam.id && !byText(1).reviewRequired);
  check("loose subject match → existing subject", byText(4).subjectId === subject.id);
  check("genuine exam mismatch still flagged", byText(3).reviewRequired && /does not match any existing Exam/.test(byText(3).reviewReason ?? ""), byText(3).reviewReason);
  check("stored reviewReason is the trigger, never 'Sub-topic not provided'", b2.qs.every((q) => !/^Sub-topic/.test(q.reviewReason ?? "")), b2.qs.map((q) => q.reviewReason));
  check("missing answer flagged", byText(5).reviewRequired && /^Correct Answer /.test(byText(5).reviewReason ?? ""), byText(5).reviewReason);
  check("invalid number flagged + stored as null", byText(6).reviewRequired && byText(6).paperQuestionNumber === null && /^Paper Question Number /.test(byText(6).reviewReason ?? ""), byText(6).reviewReason);
  check("number held by a live question flagged", byText(7).reviewRequired && /already used by live question/.test(byText(7).reviewReason ?? ""), byText(7).reviewReason);
  const rowWarnings = await prisma.bulkImportRow.findFirst({ where: { questionId: byText(1).id }, select: { warnings: true } });
  check("import row records the 'recognised as the selected import Exam' note", JSON.stringify(rowWarnings?.warnings ?? []).includes("recognised as the selected import Exam"));

  // Ambiguity: when another exam shares the yearless name, it is NOT recognised.
  {
    const sibling = await prisma.exam.create({ data: { name: `PBAT Medical Officer Exam ${sfx} 2025`, code: `PBATS${sfx}`.toUpperCase(), isActive: true } });
    const lookups = await buildTaxonomyLookups(prisma);
    const ctx = runExamContextFor(lookups.exams, { examId: exam.id, mockTestId: null });
    const ambiguous: BulkImportRow = { rowNumber: 1, exam: yearless, examYear: "2016", subject: subjectName, topic: topic.name, subTopic: "", source: "PYQ", questionText: "PBAT ambiguity", optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctAnswer: "B", difficulty: "MEDIUM", status: "DRAFT" };
    const [shape] = validateImportRows([ambiguous]);
    const r = await resolveRow(prisma, lookups, shape, undefined, ctx);
    check("ambiguous yearless name (two exams share it) stays flagged", r.reviewRequired && r.warnings.some((w) => /does not match any existing Exam/.test(w)), r.warnings);
    await prisma.exam.delete({ where: { id: sibling.id } });
  }

  // Legacy state: the 2026-11-03 prod shape — flagged by the old rule, reason "Sub-topic not provided".
  const legacyWarning = `Exam "${yearless}" does not match any existing Exam — using the selected import Exam "${exam.name}" instead.`;
  for (const q of [byText(1), byText(2)]) {
    await prisma.question.update({ where: { id: q.id }, data: { reviewRequired: true, reviewReason: "Sub-topic not provided" } });
    await prisma.bulkImportRow.updateMany({ where: { questionId: q.id }, data: { warnings: ["Sub-topic not provided", legacyWarning] } });
  }

  // ------------------------------------------------------------ overview
  section("Overview (labels, statuses, counts)");
  const ov = await loadPaperBatchOverview(paper.id);
  const ob1 = ov.batches.find((b) => b.key === b1.run.id)!;
  const ob2 = ov.batches.find((b) => b.key === b2.run.id)!;
  const om = ov.batches.find((b) => b.key === MANUAL_BATCH)!;
  check("batch 1 → RETIRED IMPORT / RETIRED / original", ob1?.label === "RETIRED IMPORT" && ob1.status === "RETIRED" && ob1.isOriginal && ob1.ordinal === 1, ob1 && { l: ob1.label, s: ob1.status });
  check("batch 2 → CORRECTED IMPORT / DRAFT", ob2?.label === "CORRECTED IMPORT" && ob2.status === "DRAFT" && ob2.ordinal === 2, ob2 && { l: ob2.label, s: ob2.status });
  check("batch 2 counts (7 flagged: 1, 2 legacy; 3, 5, 6, 7; same-text duplicate)", ob2.counts.linked === 10 && ob2.counts.draft === 10 && ob2.counts.reviewRequired === 7 && ob2.counts.extracted === 10, ob2.counts);
  check("manual group listed (1 published)", om?.label === null && om.ordinal === null && om.counts.published === 1, om?.counts);
  const legacyQ = ov.questions.find((q) => q.id === byText(1).id)!;
  check("legacy flag shows the REAL trigger, not 'Sub-topic not provided'", /does not match any existing Exam/.test(legacyQ.reviewDetail ?? "") && !/Sub-topic not provided/.test(legacyQ.reviewDetail ?? ""), legacyQ.reviewDetail);
  check("retired questions excluded from review counts", ov.questions.filter((q) => q.batchKey === b1.run.id).every((q) => q.retired && !q.reviewRequired));

  // ------------------------------------------------------------ preview
  section("Preview (server validation)");
  const b2ids = b2.qs.map((q) => q.id);
  const retiredId = b1.qs[0].id;
  const bogus = "pbat-does-not-exist";
  const pv = await evaluateBatchPublish({ paperId: paper.id, batchKey: b2.run.id, ids: [...b2ids, retiredId, manual7.id, bogus] });
  const reasonsOf = (id: string) => pv.blocked.find((b) => b.id === id)?.reasons.map((r) => r.code) ?? [];
  check("eligible = 4, 8, 9 (clean drafts)", pv.eligible.map((e) => e.number).sort((a, b) => a! - b!).join(",") === "4,8,9", pv.eligible.map((e) => e.code));
  check("legacy-flagged 1 & 2 blocked: REVIEW_REQUIRED", reasonsOf(byText(1).id).includes("REVIEW_REQUIRED") && reasonsOf(byText(2).id).includes("REVIEW_REQUIRED"));
  check("review reason in preview is the real trigger", /does not match any existing Exam/.test(pv.blocked.find((b) => b.id === byText(1).id)?.reasons[0].detail ?? ""));
  check("no correct answer → ANSWER_KEY", reasonsOf(byText(5).id).includes("ANSWER_KEY"), reasonsOf(byText(5).id));
  check("no number → NUMBER", reasonsOf(byText(6).id).includes("NUMBER"), reasonsOf(byText(6).id));
  check("number used by a published question → DUPLICATE", reasonsOf(byText(7).id).includes("DUPLICATE"), reasonsOf(byText(7).id));
  check("same text as a published question → DUPLICATE", reasonsOf(dupText.id).includes("DUPLICATE"), reasonsOf(dupText.id));
  check("retired question → RETIRED", JSON.stringify(reasonsOf(retiredId)) === JSON.stringify(["NOT_IN_BATCH", "RETIRED"]), reasonsOf(retiredId));
  check("manual question → NOT_IN_BATCH", JSON.stringify(reasonsOf(manual7.id)) === JSON.stringify(["NOT_IN_BATCH"]), reasonsOf(manual7.id));
  check("unknown id → NOT_FOUND", JSON.stringify(reasonsOf(bogus)) === JSON.stringify(["NOT_FOUND"]));
  check("requested counts every id", pv.requested === b2ids.length + 3);
  const pvOther = await evaluateBatchPublish({ paperId: otherPaper.id, batchKey: b2.run.id, ids: [byText(8).id] });
  check("other paper → NOT_IN_PAPER", pvOther.blocked[0]?.reasons.some((r) => r.code === "NOT_IN_PAPER") && pvOther.eligible.length === 0);
  check("preview never writes", (await prisma.question.count({ where: { id: { in: b2ids }, status: "PUBLISHED" } })) === 0);

  // Selection inside the batch that duplicates itself.
  {
    const twin = await prisma.question.create({
      data: {
        code: `PBAT-${sfx}-TWIN`,
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        text: `PBAT ${sfx} corrected 8`,
        status: QuestionStatus.DRAFT,
        source: QuestionSource.PYQ,
        previousYearPaperId: paper.id,
        paperQuestionNumber: 8,
        importBatchId: b2.run.id,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${label} twin`, isCorrect: label === "B", order })) },
      },
    });
    const pvTwin = await evaluateBatchPublish({ paperId: paper.id, batchKey: b2.run.id, ids: [byText(8).id, twin.id] });
    check("same text/number twice in one selection → second blocked DUPLICATE", pvTwin.eligible.length === 1 && pvTwin.blocked[0]?.id === twin.id && pvTwin.blocked[0].reasons.every((r) => r.code === "DUPLICATE"), pvTwin);
    await prisma.question.delete({ where: { id: twin.id } });
  }

  // Input validation.
  check("empty selection refused", (await errorOf(() => evaluateBatchPublish({ paperId: paper.id, batchKey: b2.run.id, ids: [] })))?.startsWith("BATCH:") === true);
  check("non-array refused", (await errorOf(() => evaluateBatchPublish({ paperId: paper.id, batchKey: b2.run.id, ids: "x" })))?.startsWith("BATCH:") === true);
  check("too many ids refused", (await errorOf(() => evaluateBatchPublish({ paperId: paper.id, batchKey: b2.run.id, ids: Array.from({ length: 1001 }, (_, i) => `x${i}`) })))?.startsWith("BATCH:") === true);
  check("unknown batch refused", (await errorOf(() => evaluateBatchPublish({ paperId: paper.id, batchKey: "nope", ids: [byText(8).id] }))) === "BATCH:Import batch not found.");
  check("unknown paper refused", (await errorOf(() => evaluateBatchPublish({ paperId: "nope", batchKey: b2.run.id, ids: [byText(8).id] }))) === "BATCH:Paper not found.");

  // ------------------------------------------------------------ review
  section("Review re-check + mark reviewed");
  const checks = await recheckReviewFlags({ paperId: paper.id, batchKey: b2.run.id, ids: [byText(1).id, byText(2).id, byText(3).id, byText(5).id, byText(8).id] });
  const st = (id: string) => checks.find((c) => c.id === id);
  check("legacy flags 1 & 2 → RESOLVED", st(byText(1).id)?.status === "RESOLVED" && st(byText(2).id)?.status === "RESOLVED", checks);
  check("re-check explains the root cause + new mapping", /without its year label/.test(st(byText(1).id)?.rootCause ?? "") && st(byText(1).id)!.correctedMapping.some((m) => /recognised as the selected import Exam/.test(m)), st(byText(1).id));
  check("genuine mismatch → STILL_PRESENT", st(byText(3).id)?.status === "STILL_PRESENT" && st(byText(3).id)!.remaining.length > 0);
  check("missing answer → STILL_PRESENT", st(byText(5).id)?.status === "STILL_PRESENT");
  check("unflagged → NOT_FLAGGED", st(byText(8).id)?.status === "NOT_FLAGGED");
  check("genuine mismatch: root cause does NOT claim a missing year label", !/year label/.test(st(byText(3).id)?.rootCause ?? ""), st(byText(3).id)?.rootCause);
  {
    const dupChecks = await recheckReviewFlags({ paperId: paper.id, batchKey: b2.run.id, ids: [dupText.id] });
    check("same-text duplicate of a live question stays STILL_PRESENT (self-match never hides it)", dupChecks[0]?.status === "STILL_PRESENT" && dupChecks[0].remaining.some((r) => r.includes(manual7.code)), dupChecks[0]);
    const mrDup = await markBatchQuestionsReviewed({ paperId: paper.id, batchKey: b2.run.id, ids: [dupText.id], actorId });
    check("…and mark reviewed refuses to clear it", mrDup.markedCount === 0 && mrDup.skipped.length === 1, mrDup);
  }
  check("re-check writes nothing", (await prisma.question.count({ where: { id: { in: [byText(1).id, byText(2).id] }, reviewRequired: true } })) === 2);

  const auditBefore = await prisma.auditLog.count({ where: { action: "PYQ_BATCH_MARK_REVIEWED" } });
  // (the duplicate refusal above wrote one audit row of its own)
  const mr = await markBatchQuestionsReviewed({ paperId: paper.id, batchKey: b2.run.id, ids: [byText(1).id, byText(2).id, byText(3).id, retiredId, byText(8).id], actorId });
  check("mark reviewed: only the 2 resolved cleared", mr.markedCount === 2 && mr.marked.every((m) => [byText(1).id, byText(2).id].includes(m.id)), mr);
  check("mark reviewed: mismatch / retired / unflagged skipped with reasons", mr.skipped.length === 3 && mr.skipped.every((s) => s.reason.length > 0), mr.skipped);
  const after12 = await prisma.question.findMany({ where: { id: { in: [byText(1).id, byText(2).id] } }, select: { reviewRequired: true, reviewReason: true, status: true } });
  check("cleared flags stay DRAFT (never auto-published)", after12.every((q) => !q.reviewRequired && q.reviewReason === null && q.status === "DRAFT"), after12);
  check("still flagged: 3", (await prisma.question.findUniqueOrThrow({ where: { id: byText(3).id } })).reviewRequired);
  check("mark reviewed audited once", (await prisma.auditLog.count({ where: { action: "PYQ_BATCH_MARK_REVIEWED" } })) === auditBefore + 1);
  check("retired question untouched by review", (await prisma.question.findUniqueOrThrow({ where: { id: retiredId } })).retiredAt !== null);

  // ------------------------------------------------------------ publish
  section("Publish");
  const reqId = `pbat-${sfx}-req1`;
  const pubIds = [byText(1).id, byText(2).id, byText(3).id, byText(4).id, retiredId];
  const pr = await publishBatchQuestions({ paperId: paper.id, batchKey: b2.run.id, ids: pubIds, actorId, requestId: reqId });
  check("published 1, 2, 4 only", pr.publishedCount === 3 && !pr.replayed && pr.published.map((p) => p.id).sort().join() === [byText(1).id, byText(2).id, byText(4).id].sort().join(), pr);
  check("blocked 3 + retired reported", pr.blocked.length === 2);
  const statuses = await prisma.question.findMany({ where: { id: { in: pubIds } }, select: { id: true, status: true, retiredAt: true } });
  const sOf = (id: string) => statuses.find((s) => s.id === id)!;
  check("DB: 1, 2, 4 PUBLISHED; 3 DRAFT; retired still ARCHIVED", sOf(byText(1).id).status === "PUBLISHED" && sOf(byText(4).id).status === "PUBLISHED" && sOf(byText(3).id).status === "DRAFT" && sOf(retiredId).status === "ARCHIVED" && sOf(retiredId).retiredAt !== null);
  const audit = await prisma.auditLog.findMany({ where: { action: "PYQ_BATCH_PUBLISH", entityId: b2.run.id } });
  check("one publish audit row with ids + blocked reasons", audit.length === 1 && (audit[0].metadata as { publishedCount: number }).publishedCount === 3 && (audit[0].metadata as { blocked: unknown[] }).blocked.length === 2);

  const replay = await publishBatchQuestions({ paperId: paper.id, batchKey: b2.run.id, ids: pubIds, actorId, requestId: reqId });
  check("same requestId → replayed, nothing done twice", replay.replayed && replay.publishedCount === 3 && (await prisma.auditLog.count({ where: { action: "PYQ_BATCH_PUBLISH", entityId: b2.run.id } })) === 1);
  const again = await publishBatchQuestions({ paperId: paper.id, batchKey: b2.run.id, ids: [byText(1).id], actorId, requestId: `pbat-${sfx}-req2` });
  check("new request on published question → alreadyPublished, 0 published", again.publishedCount === 0 && again.alreadyPublished.length === 1);

  // Cross-batch: batch 1's key with batch 2 ids → nothing.
  const cross = await publishBatchQuestions({ paperId: paper.id, batchKey: b1.run.id, ids: [byText(8).id], actorId, requestId: `pbat-${sfx}-cross` });
  check("other batch's question refused (NOT_IN_BATCH), stays Draft", cross.publishedCount === 0 && cross.blocked[0]?.reasons.some((r) => r.code === "NOT_IN_BATCH") && (await prisma.question.findUniqueOrThrow({ where: { id: byText(8).id } })).status === "DRAFT");

  // Concurrency: two different requests for the same 2 drafts at once → published exactly once.
  const [c1, c2] = await Promise.all([
    publishBatchQuestions({ paperId: paper.id, batchKey: b2.run.id, ids: [byText(8).id, byText(9).id], actorId, requestId: `pbat-${sfx}-c1` }),
    publishBatchQuestions({ paperId: paper.id, batchKey: b2.run.id, ids: [byText(8).id, byText(9).id], actorId, requestId: `pbat-${sfx}-c2` }),
  ]);
  check("concurrent publishes: total published = 2, the other sees alreadyPublished", c1.publishedCount + c2.publishedCount === 2 && c1.alreadyPublished.length + c2.alreadyPublished.length === 2, { c1: c1.publishedCount, c2: c2.publishedCount });

  // All-or-nothing: a question flipped to flagged between validation and UPDATE cannot slip through.
  {
    const victim = byText(7);
    await prisma.question.update({ where: { id: victim.id }, data: { reviewRequired: false, reviewReason: null, paperQuestionNumber: 11 } });
    const pv7 = await evaluateBatchPublish({ paperId: paper.id, batchKey: b2.run.id, ids: [victim.id] });
    check("fixed question 7 (new number, review cleared) becomes eligible", pv7.eligible.length === 1, pv7.blocked);
    // Simulate a concurrent change: the UPDATE's guard (reviewRequired:false) must reject it inside the same transaction.
    const err = await errorOf(() =>
      prisma.$transaction(async (tx) => {
        await tx.question.update({ where: { id: victim.id }, data: { reviewRequired: true } });
        const r = await tx.question.updateMany({ where: { id: { in: [victim.id] }, reviewRequired: false, status: "DRAFT", retiredAt: null }, data: { status: "PUBLISHED" } });
        if (r.count !== 1) throw new BatchActionError("guard");
      })
    );
    check("guarded UPDATE refuses a question flagged meanwhile (rolls back)", err === "BATCH:guard" && (await prisma.question.findUniqueOrThrow({ where: { id: victim.id } })).status === "DRAFT");
  }

  const ov2 = await loadPaperBatchOverview(paper.id);
  const ob2b = ov2.batches.find((b) => b.key === b2.run.id)!;
  check("batch 2 now PARTIALLY PUBLISHED, 5 published", ob2b.status === "PARTIALLY PUBLISHED" && ob2b.counts.published === 5, ob2b.counts);
  check("history lists the publishes and the review", ob2b.history.filter((h) => h.action === "PUBLISH").length >= 3 && ob2b.history.some((h) => h.action === "MARK_REVIEWED" && h.count === 2));

  // ------------------------------------------------------------ form gate
  section("Question form publish gate (evaluatePublished)");
  const noAnswer = byText(5);
  await prisma.question.update({ where: { id: noAnswer.id }, data: { reviewRequired: false, reviewReason: null } });
  check("draft without a correct answer refused", (await publishRefusal(noAnswer.id)) !== null);
  await prisma.question.update({ where: { id: noAnswer.id }, data: { status: QuestionStatus.PUBLISHED } });
  check("already PUBLISHED: plain check leaves it alone (no retroactive unpublish)", (await publishRefusal(noAnswer.id)) === null);
  check("evaluatePublished: the same content is refused", /Cannot publish/.test((await publishRefusal(noAnswer.id, prisma, { evaluatePublished: true })) ?? ""));
  await prisma.question.update({ where: { id: noAnswer.id }, data: { status: QuestionStatus.DRAFT } });
  const empty = await prisma.question.create({
    data: {
      code: `PBAT-${sfx}-EMPTY`,
      examId: otherExam.id,
      subjectId: subject.id,
      text: "   ",
      status: QuestionStatus.DRAFT,
      options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label, isCorrect: label === "A", order })) },
    },
  });
  check("empty question text refused (new QUESTION_TEXT rule)", /Question text is empty/.test((await publishRefusal(empty.id)) ?? ""));

  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
