/**
 * Import History → View Import: select / archive / delete / Resolve & Remove
 * regression. Disposable fixtures only (throwaway exam, subject, paper,
 * student, attempts, mock test, student module, two import runs) — never a
 * real import run. Run against a scratch/rehearsal DB:
 *   DATABASE_URL=… NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-import-history-delete.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { BulkImportRowStatus, BulkImportStatus, ImportRowSeverity, StudentAuthProvider, type BulkImportDuplicateStrategy, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildTaxonomyLookups, mergeRowData, parseImportFile, resolveRow, validateImportRows, type BulkImportRow } from "@/lib/bulk-import";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import {
  SelectionError,
  analyzeImportRun,
  executeImportRollback,
  importRunLifecycle,
  planResolve,
  previewSelection,
  resolveProtectedQuestions,
  resolveSelection,
} from "@/lib/import-rollback";
import { importRunState, rowMatches } from "@/lib/import-history-selection";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { findOrCreateSubject, findOrCreateTopic, linkTopicToExam } from "@/lib/exam-taxonomy";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

let failures = 0;
let passes = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (passed) passes++;
  else failures++;
}

const HEADER = "exam,year,subject,topic,question_text,option_a,option_b,option_c,option_d,correct_answer,difficulty,status";
const N = 120; // > 2 pages of 50 so "Select all N from this import" is exercised

async function main() {
  console.log("=== Import History Delete / Archive / Resolve Verification ===\n");
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `IHD Exam ${suffix}`, code: `IHD-${suffix}`, year: 2026 } });
  const subject = (await findOrCreateSubject(prisma, `IHD Subject ${suffix}`, exam.id)).record;
  const topic = (await findOrCreateTopic(prisma, subject.id, `IHD Topic ${suffix}`)).record;
  await linkTopicToExam(prisma, exam.id, topic.id);
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  const runIds: string[] = [];
  let studentId: string | null = null;
  let mockId: string | null = null;
  let moduleId: string | null = null;
  let paperId: string | null = null;

  const globalBefore = {
    questions: await prisma.question.count({ where: { examId: { not: exam.id } } }),
    runs: await prisma.bulkImportRun.count(),
    attempts: await prisma.testAttempt.count(),
    attemptQuestions: await prisma.testAttemptQuestion.count(),
    answers: await prisma.answer.count(),
    mockLinks: await prisma.mockTestQuestion.count(),
    papers: await prisma.previousYearPaper.count(),
  };

  async function importCsv(lines: string[], strategy: BulkImportDuplicateStrategy) {
    const name = `ihd-${suffix}-${runIds.length + 1}.csv`;
    const { rows } = await parseImportFile(new File([[HEADER, ...lines].join("\n")], name));
    const run = await prisma.bulkImportRun.create({
      data: {
        adminUserId: admin.id,
        filename: name,
        examId: exam.id,
        totalRows: rows.length,
        duplicateStrategy: strategy,
        status: BulkImportStatus.UPLOADED,
        rows: { create: rows.map((r: BulkImportRow) => ({ rowNumber: r.rowNumber, status: BulkImportRowStatus.PENDING, severity: ImportRowSeverity.ERROR, rawData: r as unknown as Prisma.InputJsonValue })) },
      },
    });
    runIds.push(run.id);
    const lookups = await buildTaxonomyLookups(prisma);
    for (const r of await prisma.bulkImportRow.findMany({ where: { runId: run.id } })) {
      const [shape] = validateImportRows([mergeRowData(r.rawData, r.editedData)]);
      const resolved = await resolveRow(prisma, lookups, shape, undefined, lookups.exams.find((e) => e.id === exam.id) ?? null);
      await prisma.bulkImportRow.update({ where: { id: r.id }, data: { severity: resolved.severity } });
    }
    await executeBulkImport({ runId: run.id, adminUserId: admin.id });
    return run;
  }
  const line = (n: number) => `${exam.name},2026,${subject.name},${topic.name},IHD ${suffix} question ${n}?,A,B,C,D,B,MEDIUM,PUBLISHED`;
  const audits = (action: string, runId: string) => prisma.auditLog.count({ where: { action, entityType: "BulkImportRun", entityId: runId } });

  try {
    const run = await importCsv(Array.from({ length: N }, (_, i) => line(i + 1)), "SKIP");
    const other = await importCsv([line(9001), line(9002)], "SKIP");
    const replacer = await importCsv([line(N)], "SKIP"); // SKIPPED duplicate row pointing at a run-1 question
    const rows = await prisma.bulkImportRow.findMany({ where: { runId: run.id }, orderBy: { rowNumber: "asc" } });
    const created = rows.filter((r) => r.status === "SUCCESS");
    check(`fixture: ${N} CREATED rows`, created.length === N, created.length);
    const q = created.map((r) => r.questionId!);
    const rowOf = (qid: string) => created.find((r) => r.questionId === qid)!.id;

    // References
    const student = await prisma.student.create({
      data: { studentId: `IHD-${suffix}`, name: "IHD Student", email: `ihd-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    studentId = student.id;
    const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2026, title: `IHD Paper ${suffix}` } });
    paperId = paper.id;
    const mock = await prisma.mockTest.create({
      data: { examId: exam.id, title: `IHD Mock ${suffix}`, durationMinutes: 10, questions: { create: [q[1], q[4], q[7], q[50]].map((questionId, order) => ({ questionId, order })) } },
    });
    mockId = mock.id;
    await prisma.question.updateMany({ where: { id: { in: [q[2], q[7]] } }, data: { previousYearPaperId: paper.id } });
    const mod = await prisma.customModule.create({
      data: { examId: exam.id, title: `IHD Module ${suffix}`, isStudentOwned: true, createdByStudentId: student.id, status: "ACTIVE", questions: { create: [{ questionId: q[5], order: 0 }] } },
    });
    moduleId = mod.id;

    const submitted = await prisma.testAttempt.create({
      data: {
        studentId: student.id,
        sourceType: "MOCK_TEST",
        testType: "FULL_MOCK",
        mockTestId: mock.id,
        examId: exam.id,
        durationMinutes: 10,
        totalQuestions: 2,
        status: "SUBMITTED",
        submittedAt: new Date(),
        correctCount: 1,
        incorrectCount: 1,
        score: 1,
        maxScore: 2,
      },
    });
    for (const [i, qid] of [q[0], q[4]].entries()) {
      const aq = await prisma.testAttemptQuestion.create({ data: { attemptId: submitted.id, questionId: qid, order: i, questionSnapshot: { text: `snapshot ${i}`, correctLabel: "B" } } });
      await prisma.answer.create({ data: { attemptId: submitted.id, attemptQuestionId: aq.id, studentId: student.id, questionId: qid, selectedOptionLabel: i ? "A" : "B", isCorrect: i === 0, status: "ANSWERED" } });
    }
    const inProgress = await prisma.testAttempt.create({
      data: { studentId: student.id, sourceType: "SUBJECT_TEST", testType: "SUBJECT_TEST", examId: exam.id, durationMinutes: 10, totalQuestions: 1, status: "IN_PROGRESS" },
    });
    await prisma.testAttemptQuestion.create({ data: { attemptId: inProgress.id, questionId: q[3], order: 0, questionSnapshot: { text: "live snapshot" } } });

    const historySnapshot = async () =>
      JSON.stringify({
        attempt: await prisma.testAttempt.findUnique({ where: { id: submitted.id }, select: { status: true, score: true, maxScore: true, correctCount: true, incorrectCount: true, submittedAt: true } }),
        questions: await prisma.testAttemptQuestion.findMany({ where: { attemptId: submitted.id }, orderBy: { order: "asc" }, select: { questionId: true, order: true, questionSnapshot: true } }),
        answers: await prisma.answer.findMany({ where: { attemptId: submitted.id }, orderBy: { questionId: "asc" }, select: { questionId: true, selectedOptionLabel: true, isCorrect: true, status: true } }),
        live: await prisma.testAttemptQuestion.findMany({ where: { attemptId: inProgress.id }, select: { questionId: true, questionSnapshot: true } }),
      });
    const historyBefore = await historySnapshot();

    console.log("\n1. Protection is explainable");
    let analysis = (await analyzeImportRun(run.id))!;
    const row = (qid: string) => analysis.rows.find((r) => r.questionId === qid)!;
    check("submitted attempt → ARCHIVE_ONLY · Historical attempt dependency", row(q[0]).classification === "ARCHIVE_ONLY" && row(q[0]).reasons.includes("Historical attempt dependency (1)"), row(q[0]).reasons);
    check("mock → PROTECTED · Used in 1 Mock Test (with title + attempts)", row(q[1]).classification === "PROTECTED" && row(q[1]).reasons[0] === "Used in 1 Mock Test" && row(q[1]).dependencies[0].items?.[0].title === mock.title && row(q[1]).dependencies[0].items?.[0].attempts === 1, row(q[1]).dependencies);
    check("PYQ link → PROTECTED · Previous Year Paper (gap closed: PYQ was not checked before)", row(q[2]).classification === "PROTECTED" && row(q[2]).reasons[0] === `Previous Year Paper: ${paper.title}`, row(q[2]).reasons);
    check("in-progress attempt → ARCHIVE_ONLY · In-progress attempt dependency", row(q[3]).classification === "ARCHIVE_ONLY" && row(q[3]).reasons[0] === "In-progress attempt dependency (1)", row(q[3]).reasons);
    check("student's own Custom Module → ARCHIVE_ONLY (never detached, never hard deleted)", row(q[5]).classification === "ARCHIVE_ONLY" && row(q[5]).dependencies.some((d) => d.kind === "STUDENT_CUSTOM_MODULE" && !d.detachable));
    check("mock + PYQ → PROTECTED with 2 protective dependencies", row(q[7]).classification === "PROTECTED" && row(q[7]).dependencies.filter((d) => d.level === "PROTECT").length === 2);
    check("unreferenced → SAFE_TO_DELETE", row(q[10]).classification === "SAFE_TO_DELETE" && row(q[10]).eligible);
    check("SKIPPED row in another run is never eligible there", (await analyzeImportRun(replacer.id))!.rows.every((r) => !r.eligible));

    console.log("\n2. Select All with pagination (server-side resolution)");
    const allIds = await resolveSelection(run.id, { kind: "all", filter: "ALL", search: "" });
    check(`"Select all ${N} questions from this import" resolves all ${N} CREATED rows`, allIds.length === N, allIds.length);
    const page1 = analysis.rows.filter((r) => rowMatches(r, "ALL", "")).slice(0, 50);
    check("page 1 holds only 50 rows (browser never receives all)", page1.length === 50);
    const deletableIds = await resolveSelection(run.id, { kind: "all", filter: "DELETABLE", search: "" });
    check("all + DELETABLE filter = exactly the safe rows", deletableIds.length === analysis.summary.safeToDelete && analysis.summary.safeToDelete === N - 8, { got: deletableIds.length, summary: analysis.summary });
    const protectedIds = await resolveSelection(run.id, { kind: "all", filter: "PROTECTED", search: "" });
    check("all + PROTECTED filter = 5 (q1,q2,q4,q7,q50)", protectedIds.length === 5, protectedIds.length);
    const code10 = row(q[10]).questionCode!;
    const searched = await resolveSelection(run.id, { kind: "all", filter: "ALL", search: code10 });
    check(
      "search by question code (contains) includes that row and only matching codes",
      searched.includes(rowOf(q[10])) && analysis.rows.filter((r) => searched.includes(r.rowId)).every((r) => r.questionCode!.toLowerCase().includes(code10.toLowerCase())),
      searched.length
    );
    const byText = await resolveSelection(run.id, { kind: "all", filter: "ALL", search: `question 11?` });
    check("search by question text narrows to that row", byText.length === 1 && byText[0] === rowOf(q[10]), byText.length);
    const pv = (await previewSelection(run.id, allIds))!;
    check("preview counts for all: safe/archive/protected", pv.total === N && pv.safe === N - 8 && pv.archive === 3 && pv.protected === 5, pv);

    console.log("\n3. ID injection rejected");
    const otherRow = (await prisma.bulkImportRow.findFirstOrThrow({ where: { runId: other.id, status: "SUCCESS" } })).id;
    const skippedRow = (await prisma.bulkImportRow.findFirstOrThrow({ where: { runId: replacer.id } })).id;
    const reject = async (ids: string[]) => {
      try {
        await resolveSelection(run.id, { kind: "ids", rowIds: ids });
        return false;
      } catch (e) {
        return e instanceof SelectionError;
      }
    };
    check("row from another import rejected", await reject([otherRow]));
    check("valid ids + one foreign id → whole request rejected", await reject([rowOf(q[10]), rowOf(q[11]), otherRow]));
    check("SKIPPED/REPLACED row id rejected", await reject([skippedRow]));
    check("garbage id rejected", await reject(["not-a-real-row"]));
    check("other import's question untouched", (await prisma.question.count({ where: { importBatchId: other.id } })) === 2);
    check("valid selection accepted", (await resolveSelection(run.id, { kind: "ids", rowIds: [rowOf(q[10])] })).length === 1);

    console.log("\n4. Archive");
    const a1 = await executeImportRollback({ runId: run.id, rowIds: [rowOf(q[10]), rowOf(q[0]), rowOf(q[1])], actorId: admin.id, mode: "ARCHIVE" });
    check("archive: safe + history archived (2), protected untouched (1)", a1.archived.length === 2 && a1.protected.length === 1 && a1.deleted.length === 0, a1);
    check("q10 and q0 now ARCHIVED, still exist", (await prisma.question.count({ where: { id: { in: [q[10], q[0]] }, status: "ARCHIVED" } })) === 2);
    check("protected q1 still PUBLISHED and still in the mock", (await prisma.question.findUnique({ where: { id: q[1] } }))?.status === "PUBLISHED" && (await prisma.mockTestQuestion.count({ where: { mockTestId: mock.id, questionId: q[1] } })) === 1);
    check("audit IMPORT_BULK_ARCHIVED written", (await audits("IMPORT_BULK_ARCHIVED", run.id)) === 1);
    const a2 = await executeImportRollback({ runId: run.id, rowIds: [rowOf(q[11])], actorId: admin.id, mode: "ARCHIVE" });
    check("single archive → IMPORT_QUESTION_ARCHIVED", a2.archived.length === 1 && (await audits("IMPORT_QUESTION_ARCHIVED", run.id)) === 1);
    const a3 = await executeImportRollback({ runId: run.id, rowIds: [rowOf(q[11])], actorId: admin.id, mode: "ARCHIVE" });
    check("re-archive is an idempotent no-op", a3.archived.length === 0 && a3.alreadyProcessed === 1, a3);

    console.log("\n5. Permanent delete (safe only) + protected cannot bypass");
    const d1 = await executeImportRollback({ runId: run.id, rowIds: [rowOf(q[10]), rowOf(q[12]), rowOf(q[0]), rowOf(q[1]), rowOf(q[2])], actorId: admin.id, mode: "DELETE" });
    check("DELETE: 2 safe deleted (incl. an archived-but-unused one)", d1.deleted.length === 2 && d1.deleted.every((d) => [q[10], q[12]].includes(d.questionId)), d1.deleted);
    check("DELETE: history question kept (not archived, not deleted)", d1.keptForHistory.length === 1 && d1.keptForHistory[0].questionId === q[0]);
    check("DELETE: 2 protected untouched", d1.protected.length === 2);
    check("safe unused questions gone", (await prisma.question.count({ where: { id: { in: [q[10], q[12]] } } })) === 0);
    check("history question still exists", (await prisma.question.count({ where: { id: q[0] } })) === 1);
    check("audit IMPORT_BULK_DELETED written", (await audits("IMPORT_BULK_DELETED", run.id)) === 1);
    for (const mode of ["AUTO", "DELETE", "ARCHIVE"] as const) await executeImportRollback({ runId: run.id, rowIds: [rowOf(q[1]), rowOf(q[2]), rowOf(q[7])], actorId: admin.id, mode });
    const protectedAfter = await prisma.question.findMany({ where: { id: { in: [q[1], q[2], q[7]] } }, select: { status: true, previousYearPaperId: true } });
    check("protected questions survive every bulk mode (exist, PUBLISHED, links intact)", protectedAfter.length === 3 && protectedAfter.every((p) => p.status === "PUBLISHED") && protectedAfter.filter((p) => p.previousYearPaperId === paper.id).length === 2);
    check("mock membership intact (4 links)", (await prisma.mockTestQuestion.count({ where: { mockTestId: mock.id } })) === 4);
    const single = await executeImportRollback({ runId: run.id, rowIds: [rowOf(q[13])], actorId: admin.id, mode: "DELETE" });
    check("single delete → IMPORT_QUESTION_DELETED", single.deleted.length === 1 && (await audits("IMPORT_QUESTION_DELETED", run.id)) === 1);

    console.log("\n6. Resolve & Remove");
    const plan = (await planResolve(run.id, allIds))!;
    check("plan lists only the protected rows", plan.rows.length === 5 && plan.rows.every((p) => p.classification === "PROTECTED"), plan.rows.length);
    const planRow = (qid: string) => plan.rows.find((p) => p.rowId === rowOf(qid))!;
    check("plan: code + exam + dependencies shown", planRow(q[2]).questionCode !== null && planRow(q[2]).exam === exam.name && planRow(q[2]).dependencies.some((d) => d.kind === "PYQ_PAPER"));
    check("plan: mock-only → can be deleted after detach", planRow(q[1]).bestOutcome === "DELETE");
    check("plan: mock + historical attempt → archive only", planRow(q[4]).bestOutcome === "ARCHIVE");

    const r0 = await resolveProtectedQuestions({ runId: run.id, rowIds: [rowOf(q[2])], detach: { mockTests: false, pyqPaper: true, adminCustomModules: false }, then: "NONE", actorId: admin.id });
    const q2 = await prisma.question.findUnique({ where: { id: q[2] } });
    check("wrong PYQ link detached, question kept (PUBLISHED, no paper)", r0.detached.length === 1 && q2 !== null && q2.previousYearPaperId === null && q2.status === "PUBLISHED", r0);
    check("paper itself untouched", (await prisma.previousYearPaper.count({ where: { id: paper.id } })) === 1);
    check("audit IMPORT_QUESTION_DETACHED + IMPORT_PROTECTED_OVERRIDE", (await audits("IMPORT_QUESTION_DETACHED", run.id)) === 1 && (await audits("IMPORT_PROTECTED_OVERRIDE", run.id)) === 1);
    analysis = (await analyzeImportRun(run.id))!;
    check("after PYQ detach the question is now deletable", row(q[2]).classification === "SAFE_TO_DELETE");

    const r1 = await resolveProtectedQuestions({ runId: run.id, rowIds: [rowOf(q[1])], detach: { mockTests: true, pyqPaper: false, adminCustomModules: false }, then: "DELETE", actorId: admin.id });
    check("mock-only question: detached then permanently deleted", r1.deleted.length === 1 && (await prisma.question.count({ where: { id: q[1] } })) === 0, r1);
    check("mock still exists with its other questions", (await prisma.mockTest.count({ where: { id: mock.id } })) === 1 && (await prisma.mockTestQuestion.count({ where: { mockTestId: mock.id } })) === 3);

    const r2 = await resolveProtectedQuestions({ runId: run.id, rowIds: [rowOf(q[4])], detach: { mockTests: true, pyqPaper: false, adminCustomModules: false }, then: "DELETE", actorId: admin.id });
    check("mock + submitted attempt: DELETE falls back to ARCHIVE", r2.archived.length === 1 && r2.deleted.length === 0 && (await prisma.question.findUnique({ where: { id: q[4] } }))?.status === "ARCHIVED", r2);

    const r3 = await resolveProtectedQuestions({ runId: run.id, rowIds: [rowOf(q[7])], detach: { mockTests: false, pyqPaper: true, adminCustomModules: false }, then: "DELETE", actorId: admin.id });
    check("only ticked links removed: PYQ detached, mock link kept → still protected", r3.stillProtected.length === 1 && r3.deleted.length === 0 && (await prisma.mockTestQuestion.count({ where: { questionId: q[7] } })) === 1, r3);
    check("q7 still exists, PUBLISHED", (await prisma.question.findUnique({ where: { id: q[7] } }))?.status === "PUBLISHED");

    console.log("\n7. Submitted / in-progress attempts unchanged");
    check("attempt rows, frozen snapshots, answers and score byte-identical", (await historySnapshot()) === historyBefore);

    console.log("\n8. Import history + lifecycle status");
    check("import run record still exists", (await prisma.bulkImportRun.count({ where: { id: run.id } })) === 1);
    check("all BulkImportRows kept (deleted ones keep their code)", (await prisma.bulkImportRow.count({ where: { runId: run.id } })) === N && (await prisma.bulkImportRow.findUnique({ where: { id: rowOf(q[10]) } }))?.questionCode === code10);
    analysis = (await analyzeImportRun(run.id))!;
    const s = analysis.summary;
    const deletedNow = s.laterDeleted + s.alreadyMissing;
    check("summary: deleted 4 (q10,q12,q13,q1)", deletedNow === 4, s);
    check("summary: archived now 3 (q0, q11, q4)", s.archivedNow === 3, s);
    check("summary: active = created − deleted − archived", s.active === N - deletedNow - s.archivedNow, s);
    const lc = (await importRunLifecycle([run.id])).get(run.id)!;
    check("list lifecycle matches detail counts", lc.created === N && lc.deleted === deletedNow && lc.archived === s.archivedNow, { lc, s });
    check("run state = Partially Deleted", importRunState(lc) === "PARTIALLY_DELETED", importRunState(lc));
    check("untouched other run state = Active", importRunState((await importRunLifecycle([other.id])).get(other.id)!) === "ACTIVE");

    console.log("\n9. Delete all deletable via server-side Select All");
    const sel = await resolveSelection(run.id, { kind: "all", filter: "DELETABLE", search: "" });
    const pre = (await previewSelection(run.id, sel))!;
    const bulk = await executeImportRollback({ runId: run.id, rowIds: sel, actorId: admin.id, mode: "DELETE" });
    check(`deleted exactly the ${pre.safe} previewed safe questions`, bulk.deleted.length === pre.safe && bulk.protected.length === 0 && bulk.failed.length === 0, { pre, bulk: { d: bulk.deleted.length, f: bulk.failed } });
    check("history/protected/student-module questions all still exist", (await prisma.question.count({ where: { id: { in: [q[0], q[3], q[4], q[5], q[7], q[50]] } } })) === 6);
    check("run still exists after bulk delete", (await prisma.bulkImportRun.count({ where: { id: run.id } })) === 1);
    check("attempts still byte-identical after bulk delete", (await historySnapshot()) === historyBefore);

    console.log("\n10. Unrelated data untouched");
    check("questions of other exams unchanged", (await prisma.question.count({ where: { examId: { not: exam.id } } })) === globalBefore.questions);
    check("no pre-existing attempt/answer rows touched", (await prisma.testAttempt.count()) === globalBefore.attempts + 2 && (await prisma.answer.count()) === globalBefore.answers + 2);
    check("pre-existing mock links unchanged", (await prisma.mockTestQuestion.count({ where: { mockTestId: { not: mock.id } } })) === globalBefore.mockLinks);

    console.log("\n11. RBAC / server-side enforcement");
    check("MASTER_ADMIN holds IMPORT_ROLLBACK_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.IMPORT_ROLLBACK_MANAGE));
    check("FULL_ADMIN does NOT hold IMPORT_ROLLBACK_MANAGE (read-only)", !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.IMPORT_ROLLBACK_MANAGE));
    const src = readFileSync("app/admin/(dashboard)/questions/bulk-import/history/[runId]/actions.ts", "utf8");
    const body = (name: string) => {
      const start = src.indexOf(`export async function ${name}`);
      const next = src.indexOf("export async function", start + 10);
      return src.slice(start, next === -1 ? undefined : next);
    };
    for (const name of ["executeImportRollbackAction", "resolveProtectedAction"]) {
      check(`${name}: first statement is requirePermission(IMPORT_ROLLBACK_MANAGE)`, /\{\s*const session = await requirePermission\(PERMISSIONS\.IMPORT_ROLLBACK_MANAGE\);/.test(body(name)));
      check(`${name}: validates ids through resolveSelection before acting`, /await scope\(runId, selection\)/.test(body(name)));
    }
    check("executeImportRollbackAction requires server-computed DELETE <n>", /confirmation !== `DELETE \$\{preview\.safe\}`/.test(body("executeImportRollbackAction")));
    check("resolveProtectedAction requires RESOLVE <n>", /`RESOLVE \$\{rowIds\.length\}`/.test(body("resolveProtectedAction")));
    for (const name of ["previewImportSelectionAction", "planResolveAction"]) {
      check(`${name} is read-only`, !/executeImportRollback\(|resolveProtectedQuestions\(/.test(body(name)));
    }
    const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort();
    check("no other server actions exported", JSON.stringify(exported) === JSON.stringify(["executeImportRollbackAction", "planResolveAction", "previewImportSelectionAction", "resolveProtectedAction"]), exported);
    const pageSrc = readFileSync("app/admin/(dashboard)/questions/bulk-import/history/[runId]/page.tsx", "utf8");
    check("page decides manage UI from hasPermission(IMPORT_ROLLBACK_MANAGE)", /hasPermission\(PERMISSIONS\.IMPORT_ROLLBACK_MANAGE\)/.test(pageSrc) && /canManage=\{canRollback\}/.test(pageSrc));
  } finally {
    console.log("\nCleaning up disposable fixtures...");
    if (moduleId) await prisma.customModule.delete({ where: { id: moduleId } });
    if (studentId) await prisma.student.delete({ where: { id: studentId } }); // attempts/answers cascade
    if (mockId) await prisma.mockTest.delete({ where: { id: mockId } });
    await prisma.question.deleteMany({ where: { examId: exam.id } });
    if (paperId) await prisma.previousYearPaper.delete({ where: { id: paperId } });
    await prisma.auditLog.deleteMany({ where: { entityType: "BulkImportRun", entityId: { in: runIds } } });
    await prisma.bulkImportRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.subject.delete({ where: { id: subject.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    const end = { runs: await prisma.bulkImportRun.count(), attempts: await prisma.testAttempt.count(), papers: await prisma.previousYearPaper.count() };
    check("cleanup: runs/attempts/papers back to baseline", end.runs === globalBefore.runs && end.attempts === globalBefore.attempts && end.papers === globalBefore.papers, { globalBefore, end });
    console.log(`\n=== ${failures === 0 ? `ALL ${passes} CHECKS PASSED` : `${failures} CHECK(S) FAILED (${passes} passed)`} ===`);
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
