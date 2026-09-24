/**
 * Verifies the consolidated Mock Test architecture end to end against the
 * REAL engines (no mocks of the code under test), using only disposable
 * fixtures (own Exam/Subject/Paper/Mock Tests/Student, deleted at the end):
 *
 *  Bulk import (lib/bulk-import.ts parser + lib/bulk-import-execute.ts):
 *   1. CSV, XLS and XLSX parse through the one canonical parser.
 *   2. Question Bank Only target — questions created, nothing attached.
 *   3. Previous Year Paper target — linked to the paper as PYQ.
 *   4. Mock Test target — valid rows become canonical Questions and are
 *      attached in spreadsheet order AFTER existing questions; invalid rows
 *      fail and are never attached; attachedCount reconciled.
 *   5. Duplicates (SKIP) — the existing canonical Question id is attached,
 *      no new Question rows; re-import never duplicates an assignment.
 *   6. Expected-count guard — refused before any write unless confirmed.
 *   7. Exam mismatch — a Mock Test of another exam is refused.
 *   8. Scheduled future Mock Test is a valid target (exam-scoped list).
 *  Scheduling / attempts:
 *   9. Available Now / Scheduled Release / Fixed Window states + start gate
 *      (server time), window caps the attempt's effective end.
 *  10. Student attempt receives exactly the PUBLISHED attached questions in
 *      stored order (Draft imports stay hidden).
 *  11. Result release — held result blocks Ask AI + score aggregates until
 *      the release instant.
 *  12. RBAC — FULL_ADMIN lacks TEST_SERIES_MANAGE and QUESTIONS_MANAGE.
 *
 * Run from the repo root with the react-server condition so
 * `import "server-only"` resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-mock-bulk-import.ts
 */
import "dotenv/config";
import * as XLSX from "xlsx";
import {
  PrismaClient,
  BulkImportRowStatus,
  BulkImportStatus,
  ImportRowSeverity,
  StudentAuthProvider,
  type BulkImportDuplicateStrategy,
  type Prisma,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { parseImportFile, detectImportFileFormat, buildTaxonomyLookups, resolveRow, validateImportRows, mergeRowData, type BulkImportRow } from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";
import { executeBulkImport, MockTargetError } from "@/lib/bulk-import-execute";
import { startMockTestAttempt, submitAttempt, toServerTimedAttempt } from "@/lib/test-attempt";
import { effectiveEndFor } from "@/lib/attempt-timing";
import { hasUnreleasedResultForQuestion, resultReleasedAttemptWhere } from "@/lib/student-data";
import {
  deriveAvailabilityMode,
  deriveMockTestAvailability,
  isMockResultReleased,
  isMockTestAvailable,
  validateMockSchedule,
} from "@/lib/mock-test-schedule";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const HEADER = ["exam", "year", "subject", "topic", "question_text", "option_a", "option_b", "option_c", "option_d", "correct_answer", "difficulty", "status"];

function csvOf(rows: string[][]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [HEADER, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

function sheetFile(rows: string[][], name: string, bookType: "xlsx" | "biff8"): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), "Questions");
  const buf = XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer;
  return new File([buf], name);
}

async function main() {
  console.log("=== Mock Test Bulk Import + Scheduling Verification ===\n");
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `MBI Exam ${suffix}`, code: `MBI-${suffix}`, year: 2026 } });
  const otherExam = await prisma.exam.create({ data: { name: `MBI Other ${suffix}`, code: `MBO-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: `MBI Subject ${suffix}` } });
  const topic = await prisma.topic.create({ data: { subjectId: subject.id, name: `MBI Topic ${suffix}` } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2020, title: `MBI Paper ${suffix}` } });
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  const runIds: string[] = [];
  const studentIds: string[] = [];

  const row = (i: number, extra: Partial<Record<"text" | "correct" | "status" | "subject", string>> = {}): string[] => [
    exam.name,
    "2026",
    extra.subject ?? subject.name,
    topic.name,
    extra.text ?? `MBI ${suffix} question ${i} — which option is correct?`,
    "Alpha",
    "Beta",
    "Gamma",
    "Delta",
    extra.correct ?? "B",
    "MEDIUM",
    extra.status ?? "PUBLISHED",
  ];

  /** Same persistence the upload + validate routes perform, minus HTTP/auth. */
  async function stage(
    file: File,
    opts: { examId?: string; previousYearPaperId?: string; mockTestId?: string; strategy?: BulkImportDuplicateStrategy; source?: "QUESTION_BANK" | "MOCK_TEST" } = {}
  ) {
    const { rows } = await parseImportFile(file);
    const run = await prisma.bulkImportRun.create({
      data: {
        adminUserId: admin.id,
        filename: file.name,
        format: detectImportFileFormat(file.name),
        examId: opts.examId ?? exam.id,
        previousYearPaperId: opts.previousYearPaperId ?? null,
        mockTestId: opts.mockTestId ?? null,
        importSource: opts.source ?? "QUESTION_BANK",
        totalRows: rows.length,
        duplicateStrategy: opts.strategy ?? "SKIP",
        status: BulkImportStatus.UPLOADED,
        rows: {
          create: rows.map((r: BulkImportRow) => ({
            rowNumber: r.rowNumber,
            status: BulkImportRowStatus.PENDING,
            severity: ImportRowSeverity.ERROR,
            rawData: r as unknown as Prisma.InputJsonValue,
          })),
        },
      },
    });
    runIds.push(run.id);
    const [lookups, imageIndex] = await Promise.all([buildTaxonomyLookups(prisma), getImageFilenameIndex()]);
    const ctx = lookups.exams.find((e) => e.id === run.examId) ?? null;
    for (const r of await prisma.bulkImportRow.findMany({ where: { runId: run.id } })) {
      const [shape] = validateImportRows([mergeRowData(r.rawData, r.editedData)]);
      const resolved = await resolveRow(prisma, lookups, shape, imageIndex, ctx);
      await prisma.bulkImportRow.update({
        where: { id: r.id },
        data: { severity: resolved.severity, errors: resolved.errors as Prisma.InputJsonValue, warnings: resolved.warnings as Prisma.InputJsonValue },
      });
    }
    await prisma.bulkImportRun.update({ where: { id: run.id }, data: { status: BulkImportStatus.READY } });
    return { run, parsedRows: rows.length };
  }

  const mockIds: string[] = [];
  async function makeMock(data: Partial<Prisma.MockTestUncheckedCreateInput> = {}) {
    const m = await prisma.mockTest.create({
      data: { examId: exam.id, title: `MBI Mock ${suffix}-${mockIds.length + 1}`, durationMinutes: 60, accessType: "FREE", order: mockIds.length + 1, ...data },
    });
    mockIds.push(m.id);
    return m;
  }
  const orderedIds = async (mockTestId: string) =>
    (await prisma.mockTestQuestion.findMany({ where: { mockTestId }, orderBy: { order: "asc" }, select: { questionId: true, order: true } }));

  try {
    // 1. Parser formats -------------------------------------------------
    console.log("1. Canonical parser: CSV / XLS / XLSX");
    const three = [row(101), row(102), row(103)];
    const csv = await parseImportFile(new File([csvOf(three)], "a.csv"));
    const xlsx = await parseImportFile(sheetFile(three, "a.xlsx", "xlsx"));
    const xls = await parseImportFile(sheetFile(three, "a.xls", "biff8"));
    check("CSV parsed 3 rows", csv.rows.length === 3, csv.errors);
    check("XLSX parsed 3 rows", xlsx.rows.length === 3, xlsx.errors);
    check("XLS parsed 3 rows", xls.rows.length === 3, xls.errors);
    check("XLSX row text preserved", xlsx.rows[1]?.questionText === three[1][4]);

    // 2. Question Bank Only ------------------------------------------------
    console.log("\n2. Import Target: Question Bank Only");
    const qb = await stage(new File([csvOf([row(1), row(2)])], "qb.csv"));
    const qbRes = await executeBulkImport({ runId: qb.run.id, adminUserId: admin.id });
    check("2 created", qbRes.successCount === 2, qbRes);
    check("no Mock Test attachment", qbRes.attachedCount === 0 && qbRes.mockTestId === null);
    const qbQs = await prisma.question.findMany({ where: { importBatchId: qb.run.id } });
    check("canonical questions in exam, not linked to a paper", qbQs.length === 2 && qbQs.every((q) => q.examId === exam.id && !q.previousYearPaperId));

    // 3. Previous Year Paper -------------------------------------------------
    console.log("\n3. Import Target: Previous Year Paper");
    const py = await stage(new File([csvOf([row(11)])], "pyq.csv"), { previousYearPaperId: paper.id });
    await executeBulkImport({ runId: py.run.id, adminUserId: admin.id });
    const pyQ = await prisma.question.findFirst({ where: { importBatchId: py.run.id } });
    check("linked to the paper as PYQ", pyQ?.previousYearPaperId === paper.id && pyQ?.source === "PYQ", pyQ);

    // 4. Mock Test target ------------------------------------------------------
    console.log("\n4. Import Target: Mock Test (append in row order, invalid rows not attached)");
    const mockA = await makeMock({ targetQuestionCount: 10 });
    await prisma.mockTestQuestion.createMany({ data: qbQs.map((q, order) => ({ mockTestId: mockA.id, questionId: q.id, order })) });
    const aRows = [row(21), row(22, { correct: "Z" }), row(23, { text: "" }), row(24), row(25, { status: "DRAFT" })];
    const aFile = sheetFile(aRows, "mock-a.xlsx", "xlsx");
    const a = await stage(aFile, { mockTestId: mockA.id, source: "MOCK_TEST" });
    const aRes = await executeBulkImport({ runId: a.run.id, adminUserId: admin.id });
    const aRowsDb = await prisma.bulkImportRow.findMany({ where: { runId: a.run.id }, orderBy: { rowNumber: "asc" } });
    const failedRows = aRowsDb.filter((r) => r.status === "FAILED");
    check("empty-text row failed, never attached", failedRows.length >= 1 && failedRows.every((r) => !r.questionId), aRowsDb.map((r) => r.status));
    const aIds = await orderedIds(mockA.id);
    const importedInOrder = aRowsDb.filter((r) => r.questionId).map((r) => r.questionId);
    check(
      "existing 2 kept first, imports appended in spreadsheet order",
      aIds.slice(0, 2).every((x, i) => x.questionId === qbQs[i].id) && JSON.stringify(aIds.slice(2).map((x) => x.questionId)) === JSON.stringify(importedInOrder),
      { aIds, importedInOrder }
    );
    check("order is dense 0..n-1", aIds.every((x, i) => x.order === i));
    check("attachedCount reconciled = rows with a question", aRes.attachedCount === importedInOrder.length && aRes.attachedNow === importedInOrder.length, aRes);
    check("question count updated (2 + attached)", aIds.length === 2 + importedInOrder.length);
    const aQs = await prisma.question.findMany({ where: { id: { in: importedInOrder as string[] } } });
    check("attached questions are canonical Question Bank rows of the exam", aQs.length === importedInOrder.length && aQs.every((q) => q.examId === exam.id && q.importBatchId === a.run.id));
    const runA = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: a.run.id } });
    check("Import History records source/target/attached", runA.importSource === "MOCK_TEST" && runA.mockTestId === mockA.id && runA.attachedCount === importedInOrder.length);

    // 5. Duplicates -------------------------------------------------------------
    console.log("\n5. Duplicate handling (SKIP → attach existing id; no duplicate assignment)");
    const questionsBefore = await prisma.question.count({ where: { examId: exam.id } });
    const mockB = await makeMock();
    const dupB = await stage(new File([csvOf([row(21), row(24)])], "dup.csv"), { mockTestId: mockB.id, strategy: "SKIP" });
    const dupRes = await executeBulkImport({ runId: dupB.run.id, adminUserId: admin.id });
    const bIds = (await orderedIds(mockB.id)).map((x) => x.questionId);
    check("no new Question rows for duplicates", (await prisma.question.count({ where: { examId: exam.id } })) === questionsBefore, dupRes);
    check("existing canonical ids attached to Mock B", dupRes.skippedCount === 2 && bIds.length === 2 && bIds.every((id) => importedInOrder.includes(id)));
    const againA = await stage(new File([csvOf([row(21)])], "again.csv"), { mockTestId: mockA.id, strategy: "SKIP" });
    const againRes = await executeBulkImport({ runId: againA.run.id, adminUserId: admin.id });
    const aAfter = await orderedIds(mockA.id);
    check("re-import into Mock A adds no duplicate assignment", againRes.attachedNow === 0 && aAfter.length === aIds.length && new Set(aAfter.map((x) => x.questionId)).size === aAfter.length);

    // 6. Expected-count guard ---------------------------------------------------
    console.log("\n6. Expected question count guard");
    const mockC = await makeMock({ targetQuestionCount: 1 });
    const over = await stage(new File([csvOf([row(31), row(32)])], "over.csv"), { mockTestId: mockC.id });
    let refused: unknown = null;
    try {
      await executeBulkImport({ runId: over.run.id, adminUserId: admin.id });
    } catch (e) {
      refused = e;
    }
    check("exceeding expected is refused (EXCEEDS_EXPECTED)", refused instanceof MockTargetError && refused.code === "EXCEEDS_EXPECTED");
    check("…and nothing was written", (await prisma.question.count({ where: { importBatchId: over.run.id } })) === 0 && (await prisma.mockTestQuestion.count({ where: { mockTestId: mockC.id } })) === 0);
    const overRes = await executeBulkImport({ runId: over.run.id, adminUserId: admin.id, allowExceedTarget: true });
    check("explicit confirmation imports + attaches", overRes.attachedCount === 2);

    // 7. Exam mismatch -----------------------------------------------------------
    console.log("\n7. Cross-exam attachment refused server-side");
    const foreignMock = await prisma.mockTest.create({ data: { examId: otherExam.id, title: `MBI Foreign ${suffix}`, durationMinutes: 30 } });
    mockIds.push(foreignMock.id);
    const cross = await stage(new File([csvOf([row(41)])], "cross.csv"), { mockTestId: foreignMock.id });
    let crossErr: unknown = null;
    try {
      await executeBulkImport({ runId: cross.run.id, adminUserId: admin.id });
    } catch (e) {
      crossErr = e;
    }
    check("EXAM_MISMATCH before any write", crossErr instanceof MockTargetError && crossErr.code === "EXAM_MISMATCH" && (await prisma.question.count({ where: { importBatchId: cross.run.id } })) === 0);

    // 8. Scheduled future target ----------------------------------------------
    console.log("\n8. Scheduled future Mock Test is a valid, exam-scoped target");
    const future = await makeMock({ status: "PUBLISHED", availableFrom: new Date(Date.now() + 20 * 86400_000) });
    const targets = await prisma.mockTest.findMany({ where: { status: { not: "ARCHIVED" }, examId: exam.id }, select: { id: true } });
    check("future scheduled mock listed for its exam", targets.some((t) => t.id === future.id));
    check("other exam's mock not listed", !targets.some((t) => t.id === foreignMock.id));
    check("future mock state is UPCOMING", deriveMockTestAvailability(future) === "UPCOMING");
    const fut = await stage(new File([csvOf([row(51)])], "future.csv"), { mockTestId: future.id });
    check("import into scheduled mock attaches", (await executeBulkImport({ runId: fut.run.id, adminUserId: admin.id })).attachedCount === 1);

    // 9. Scheduling ---------------------------------------------------------------
    console.log("\n9. Availability modes (server time)");
    const t0 = new Date("2026-10-15T04:30:00Z");
    const t1 = new Date("2026-10-15T07:30:00Z");
    const w = { status: "PUBLISHED" as const, availableFrom: t0, availableUntil: t1 };
    check("Available Now mode", deriveAvailabilityMode({ availableFrom: null, availableUntil: null }) === "AVAILABLE_NOW");
    check("Scheduled Release: UPCOMING → AVAILABLE", deriveMockTestAvailability({ availableFrom: t0 }, new Date(t0.getTime() - 1)) === "UPCOMING" && deriveMockTestAvailability({ availableFrom: t0 }, t0) === "AVAILABLE");
    check("Fixed Window: UPCOMING / LIVE_NOW / CLOSED (end exclusive)",
      deriveMockTestAvailability(w, new Date(t0.getTime() - 1)) === "UPCOMING" && deriveMockTestAvailability(w, t0) === "LIVE_NOW" && deriveMockTestAvailability(w, t1) === "CLOSED");
    check("no new attempts after end", isMockTestAvailable(w, new Date(t0.getTime() + 1000)) && !isMockTestAvailable(w, t1));
    check("window caps attempt end", effectiveEndFor(toServerTimedAttempt({ startedAt: new Date(t1.getTime() - 10 * 60_000), durationMinutes: 60, mockTest: { availableUntil: t1 } })).getTime() === t1.getTime());
    check("schedule validation rejects inverted window", validateMockSchedule({ mode: "FIXED_WINDOW", availableFrom: t1, availableUntil: t0, resultReleaseMode: "IMMEDIATE", resultReleaseAt: null }) !== null);
    check("AFTER_WINDOW requires a Fixed Window", validateMockSchedule({ mode: "SCHEDULED_RELEASE", availableFrom: t0, availableUntil: null, resultReleaseMode: "AFTER_WINDOW", resultReleaseAt: null }) !== null);

    const passwordHash = await argon2.hash("Mbi@123456");
    const student = await prisma.student.create({
      data: { studentId: `MBI-${suffix}`, name: "MBI Student", email: `mbi-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    studentIds.push(student.id);
    const closed = await makeMock({ status: "PUBLISHED", availableFrom: new Date(Date.now() - 7200_000), availableUntil: new Date(Date.now() - 3600_000) });
    await prisma.mockTestQuestion.create({ data: { mockTestId: closed.id, questionId: qbQs[0].id, order: 0 } });
    let closedErr: Error | null = null;
    try {
      await startMockTestAttempt(student.id, closed.id);
    } catch (e) {
      closedErr = e as Error;
    }
    check("closed window refuses start (server-side)", Boolean(closedErr?.message.includes("closed")), closedErr?.message);
    let upcomingErr: Error | null = null;
    try {
      await startMockTestAttempt(student.id, future.id);
    } catch (e) {
      upcomingErr = e as Error;
    }
    check("upcoming refuses start", Boolean(upcomingErr?.message.includes("not available yet")), upcomingErr?.message);

    // 10. Attempt receives the right questions ---------------------------------
    console.log("\n10. Student TestAttempt snapshot = published attached questions, stored order");
    await prisma.mockTest.update({ where: { id: mockA.id }, data: { status: "PUBLISHED" } });
    const expectedServed = (
      await prisma.mockTestQuestion.findMany({ where: { mockTestId: mockA.id, question: { status: "PUBLISHED" } }, orderBy: { order: "asc" }, select: { questionId: true } })
    ).map((x) => x.questionId);
    const drafted = (await prisma.mockTestQuestion.count({ where: { mockTestId: mockA.id } })) - expectedServed.length;
    const attempt = await startMockTestAttempt(student.id, mockA.id);
    const served = (await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, orderBy: { order: "asc" }, select: { questionId: true } })).map((x) => x.questionId);
    check("attempt questions == published assignment in order", JSON.stringify(served) === JSON.stringify(expectedServed), { served, expectedServed });
    check("draft import stayed hidden from students", drafted >= 1, { drafted });

    // 11. Result release ----------------------------------------------------------
    console.log("\n11. Result release (held until release instant)");
    const releaseAt = new Date(Date.now() + 3 * 86400_000);
    await prisma.mockTest.update({ where: { id: mockA.id }, data: { resultReleaseMode: "CUSTOM_DATE", resultReleaseAt: releaseAt } });
    await submitAttempt(attempt.id, student.id);
    const mA = await prisma.mockTest.findUniqueOrThrow({ where: { id: mockA.id } });
    check("result not released before instant", !isMockResultReleased(mA) && isMockResultReleased(mA, releaseAt));
    check("Ask AI blocked for held question", await hasUnreleasedResultForQuestion(student.id, served[0]));
    check("score aggregates exclude held attempt", (await prisma.testAttempt.count({ where: { studentId: student.id, status: "SUBMITTED", ...resultReleasedAttemptWhere() } })) === 0);
    check("…and include it after release", (await prisma.testAttempt.count({ where: { studentId: student.id, status: "SUBMITTED", ...resultReleasedAttemptWhere(new Date(releaseAt.getTime() + 1)) } })) === 1);
    await prisma.mockTest.update({ where: { id: mockA.id }, data: { resultReleaseMode: "IMMEDIATE", resultReleaseAt: null } });
    check("IMMEDIATE releases instantly (Ask AI unblocked)", !(await hasUnreleasedResultForQuestion(student.id, served[0])));

    // 12. RBAC ----------------------------------------------------------------------
    console.log("\n12. RBAC");
    const full = DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN;
    check("MASTER_ADMIN has TEST_SERIES_MANAGE + QUESTIONS_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.TEST_SERIES_MANAGE) && DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.QUESTIONS_MANAGE));
    check("FULL_ADMIN read-only: no TEST_SERIES_MANAGE / QUESTIONS_MANAGE", !full.includes(PERMISSIONS.TEST_SERIES_MANAGE) && !full.includes(PERMISSIONS.QUESTIONS_MANAGE));
    check("TEACHER can import to the bank but not attach to Mock Tests", DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.QUESTIONS_MANAGE) && !DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.TEST_SERIES_MANAGE));
  } finally {
    // Cleanup — disposable fixtures only.
    await prisma.answer.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.mockTestQuestion.deleteMany({ where: { mockTestId: { in: mockIds } } });
    await prisma.bulkImportRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.mockTest.deleteMany({ where: { id: { in: mockIds } } });
    await prisma.questionOption.deleteMany({ where: { question: { examId: { in: [exam.id, otherExam.id] } } } });
    await prisma.question.deleteMany({ where: { examId: { in: [exam.id, otherExam.id] } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: runIds } } });
    await prisma.exam.deleteMany({ where: { id: { in: [exam.id, otherExam.id] } } });
    const leftovers = await prisma.exam.count({ where: { code: { in: [`MBI-${suffix}`, `MBO-${suffix}`] } } });
    console.log(`\nCleanup: fixtures removed (${leftovers} leftover exams).`);
    await prisma.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
