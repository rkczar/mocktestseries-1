/**
 * Bulk Import rollback regression ("Delete Questions Created By This
 * Import"). Disposable fixtures only — a throwaway exam, fixture subject,
 * student, attempt and mock test; never a real import run. Run against a
 * scratch/rehearsal DB:
 *   DATABASE_URL=… NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-import-rollback.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { BulkImportRowStatus, BulkImportStatus, ImportRowSeverity, StudentAuthProvider, type BulkImportDuplicateStrategy, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildTaxonomyLookups, mergeRowData, parseImportFile, resolveRow, validateImportRows, type BulkImportRow } from "@/lib/bulk-import";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import { analyzeImportRun, executeImportRollback } from "@/lib/import-rollback";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { findOrCreateSubject, findOrCreateTopic, linkTopicToExam } from "@/lib/exam-taxonomy";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const HEADER = "exam,year,subject,topic,question_text,option_a,option_b,option_c,option_d,correct_answer,difficulty,status";

async function main() {
  console.log("=== Import Rollback Verification ===\n");
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `IRB Exam ${suffix}`, code: `IRB-${suffix}`, year: 2026 } });
  // Real canonical records (unique suffixed names) so the importer resolves them by name; deleted in cleanup.
  const subject = (await findOrCreateSubject(prisma, `IRB Subject ${suffix}`, exam.id)).record;
  const topic = (await findOrCreateTopic(prisma, subject.id, `IRB Topic ${suffix}`)).record;
  await linkTopicToExam(prisma, exam.id, topic.id);
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  const runIds: string[] = [];
  let studentId: string | null = null;
  let mockId: string | null = null;

  const globalBefore = {
    questions: await prisma.question.count({ where: { examId: { not: exam.id } } }),
    subjects: await prisma.subject.count(),
    topics: await prisma.topic.count(),
    subTopics: await prisma.subTopic.count(),
    exams: await prisma.exam.count(),
    runs: await prisma.bulkImportRun.count(),
  };

  async function importCsv(lines: string[], strategy: BulkImportDuplicateStrategy) {
    const name = `irb-${suffix}-${runIds.length + 1}.csv`;
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
  const line = (n: number) => `${exam.name},2026,${subject.name},${topic.name},IRB ${suffix} question ${n}?,A,B,C,D,B,MEDIUM,PUBLISHED`;

  try {
    // A pre-existing question the second run will REPLACE — it must survive rollback of that run.
    const pre = await importCsv([line(0)], "SKIP");
    const preQ = await prisma.question.findFirstOrThrow({ where: { importBatchId: pre.id } });

    console.log("1. Exact ImportRun -> Question traceability");
    const run = await importCsv([line(1), line(2), line(3), line(4), line(5), line(0)], "REPLACE");
    const rows = await prisma.bulkImportRow.findMany({ where: { runId: run.id }, orderBy: { rowNumber: "asc" } });
    const created = rows.filter((r) => r.status === "SUCCESS");
    const replaced = rows.filter((r) => r.status === "REPLACED");
    check("5 CREATED rows, each with its exact question id", created.length === 5 && created.every((r) => r.questionId));
    check("1 REPLACED row pointing at the pre-existing question", replaced.length === 1 && replaced[0].questionId === preQ.id);
    const [q1, q2, q3] = created.map((r) => r.questionId!);

    console.log("\n2. References: attempt (archive-only) + mock test (protected)");
    const student = await prisma.student.create({
      data: { studentId: `IRB-${suffix}`, name: "IRB Student", email: `irb-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    studentId = student.id;
    const attempt = await prisma.testAttempt.create({
      data: { studentId: student.id, sourceType: "SUBJECT_TEST", examId: exam.id, durationMinutes: 10, totalQuestions: 1, status: "SUBMITTED", submittedAt: new Date() },
    });
    const aq = await prisma.testAttemptQuestion.create({ data: { attemptId: attempt.id, questionId: q1, order: 0, questionSnapshot: { text: "snapshot" } } });
    await prisma.answer.create({ data: { attemptId: attempt.id, attemptQuestionId: aq.id, studentId: student.id, questionId: q1, selectedOptionLabel: "B", isCorrect: true, status: "ANSWERED" } });
    const mock = await prisma.mockTest.create({ data: { examId: exam.id, title: `IRB Mock ${suffix}`, durationMinutes: 10, questions: { create: [{ questionId: q2, order: 0 }] } } });
    mockId = mock.id;

    console.log("\n3. Impact analysis");
    const analysis = (await analyzeImportRun(run.id))!;
    const cls = (id: string) => analysis.rows.find((r) => r.questionId === id)?.classification;
    check("attempted question → ARCHIVE_ONLY", cls(q1) === "ARCHIVE_ONLY", analysis.rows.find((r) => r.questionId === q1));
    check("mock-test question → PROTECTED", cls(q2) === "PROTECTED");
    check("unreferenced question → SAFE_TO_DELETE", cls(q3) === "SAFE_TO_DELETE");
    check("REPLACED row is not eligible", analysis.rows.find((r) => r.questionId === preQ.id)?.eligible === false);
    check("summary: created 5 / safe 3 / archive 1 / protected 1", analysis.summary.created === 5 && analysis.summary.safeToDelete === 3 && analysis.summary.archiveOnly === 1 && analysis.summary.protected === 1, analysis.summary);

    console.log("\n4. Delete Selected (one safe question)");
    const q3row = created.find((r) => r.questionId === q3)!;
    const sel = await executeImportRollback({ runId: run.id, rowIds: [q3row.id], actorId: admin.id });
    check("selected: exactly 1 deleted", sel.deleted.length === 1 && sel.deleted[0].questionId === q3 && sel.archived.length === 0);
    check("q3 gone", (await prisma.question.count({ where: { id: q3 } })) === 0);

    console.log("\n5. Delete All Created By This Import");
    const all = await executeImportRollback({ runId: run.id, actorId: admin.id });
    check("deleted 2 more (the rest of the safe ones)", all.deleted.length === 2, all);
    check("archived 1 (attempted)", all.archived.length === 1 && all.archived[0].questionId === q1);
    check("protected 1 (in mock test)", all.protected.length === 1 && all.protected[0].questionId === q2);
    check("q3 counted as already processed (idempotent)", all.alreadyProcessed === 1);
    check("attempted question still exists, ARCHIVED", (await prisma.question.findUnique({ where: { id: q1 } }))?.status === "ARCHIVED");
    check("historical attempt row + answer intact", (await prisma.testAttemptQuestion.count({ where: { attemptId: attempt.id } })) === 1 && (await prisma.answer.count({ where: { attemptId: attempt.id } })) === 1);
    check("mock-test question untouched (still PUBLISHED, still in mock)", (await prisma.question.findUnique({ where: { id: q2 } }))?.status === "PUBLISHED" && (await prisma.mockTestQuestion.count({ where: { mockTestId: mock.id } })) === 1);
    check("REPLACED pre-existing question untouched", (await prisma.question.count({ where: { id: preQ.id } })) === 1);
    check("fixture subject/topic untouched", (await prisma.subject.count({ where: { id: subject.id } })) === 1 && (await prisma.topic.count({ where: { id: topic.id } })) === 1);

    console.log("\n6. Idempotent / double submit");
    const [again1, again2] = await Promise.all([executeImportRollback({ runId: run.id, actorId: admin.id }), executeImportRollback({ runId: run.id, actorId: admin.id })]);
    check("concurrent re-runs delete nothing more", again1.deleted.length + again2.deleted.length === 0);
    check("re-run keeps protected/archived semantics", again1.failed.length + again2.failed.length === 0);

    console.log("\n7. Import History retained + rollback status");
    const kept = await prisma.bulkImportRun.findUnique({ where: { id: run.id } });
    check("import run record still exists", kept !== null);
    check("lastRollbackAt recorded", kept?.lastRollbackAt !== null);
    const after = (await analyzeImportRun(run.id))!;
    check("history shows later deleted 3 / archived 1 / protected 1", after.summary.laterDeleted === 3 && after.summary.laterArchived === 1 && after.summary.laterProtected === 1, after.summary);
    check("deleted rows keep their question code for audit", (await prisma.bulkImportRow.findUnique({ where: { id: q3row.id } }))?.questionCode !== null);

    console.log("\n8. Unrelated data untouched");
    check("questions of other exams unchanged", (await prisma.question.count({ where: { examId: { not: exam.id } } })) === globalBefore.questions);
    check("shared Subjects/Topics/SubTopics/Exams unchanged", (await prisma.subject.count()) === globalBefore.subjects + 0 && (await prisma.topic.count()) === globalBefore.topics && (await prisma.subTopic.count()) === globalBefore.subTopics && (await prisma.exam.count()) === globalBefore.exams);

    console.log("\n9. RBAC");
    check("MASTER_ADMIN holds IMPORT_ROLLBACK_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.IMPORT_ROLLBACK_MANAGE));
    check("FULL_ADMIN does NOT hold IMPORT_ROLLBACK_MANAGE", !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.IMPORT_ROLLBACK_MANAGE));
    check("TEACHER does NOT hold IMPORT_ROLLBACK_MANAGE", !DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.IMPORT_ROLLBACK_MANAGE));
    const actionSrc = readFileSync("app/admin/(dashboard)/questions/bulk-import/history/[runId]/actions.ts", "utf8");
    const execBody = actionSrc.slice(actionSrc.indexOf("export async function executeImportRollbackAction"));
    check("execute action's first statement is requirePermission(IMPORT_ROLLBACK_MANAGE)", /\{\s*const session = await requirePermission\(PERMISSIONS\.IMPORT_ROLLBACK_MANAGE\);/.test(execBody));
  } finally {
    console.log("\nCleaning up disposable fixtures...");
    if (mockId) await prisma.mockTest.delete({ where: { id: mockId } });
    if (studentId) await prisma.student.delete({ where: { id: studentId } }); // attempts/answers cascade
    await prisma.question.deleteMany({ where: { examId: exam.id } });
    await prisma.bulkImportRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.subject.delete({ where: { id: subject.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    const end = { subjects: await prisma.subject.count(), topics: await prisma.topic.count(), exams: await prisma.exam.count(), runs: await prisma.bulkImportRun.count() };
    check("cleanup: subject/topic/exam/run counts back to baseline", end.subjects === globalBefore.subjects - 1 && end.topics === globalBefore.topics - 1 && end.exams === globalBefore.exams - 1 && end.runs === globalBefore.runs, { globalBefore, end });
    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
