/**
 * PYQ membership isolation + cross-exam Mock Builder reuse, against the REAL
 * code (no mocks of the code under test), using only disposable fixtures
 * (own Exams/Subject/Papers/Mocks/Student, deleted at the end):
 *
 *   1. Punjab-like PYQ question added to a RUHS-like mock → mock contains it,
 *      its own paper still contains it, the RUHS paper count is unchanged,
 *      and the Question row (exam / paper / source / code / updatedAt) is untouched.
 *   2. Haryana-like PYQ question → same.
 *   3. A mock-only (non-PYQ) question of the RUHS exam with year 2024 added
 *      to a RUHS mock → RUHS 2024 paper count unchanged.
 *   4. A RUHS 2024 PYQ question in several mocks → still one canonical
 *      Question; the paper count stays exact.
 *   5. Removing a question from a mock → never deletes / reclassifies it.
 *   6. Deleting a mock → questions and PYQ ownership survive.
 *   7. Bulk import into a Mock Test with Source = PYQ + a matching year →
 *      never linked to the mock exam's paper (the RUHS 2024 = 443 bug); a
 *      Question Bank import of the paper's own exam still links (unchanged).
 *   8. Mock import with REPLACE never reclassifies an existing PYQ question.
 *   9. The PYQ attempt serves exactly the canonical paper set; the student
 *      paper count matches it.
 *  10. Server-side bank search: cross-exam filters, paper, year, source,
 *      search, exclude-already-added, pagination, cascading facets, and
 *      untrusted-filter sanitizing.
 *  11. Authorization: every Mock Test question action requires
 *      TEST_SERIES_MANAGE, which only MASTER_ADMIN holds.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-pyq-membership-isolation.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { BulkImportRowStatus, BulkImportStatus, ImportRowSeverity, StudentAuthProvider, type BulkImportDuplicateStrategy, type Prisma } from "@prisma/client";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { buildTaxonomyLookups, mergeRowData, parseImportFile, resolveRow, runExamContextFor, validateImportRows, type BulkImportRow } from "@/lib/bulk-import";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import { addQuestionsToMock, removeQuestionsFromMock, replaceQuestionInMock } from "@/lib/mock-test-questions";
import { BANK_PAGE_SIZE, matchingQuestionIds, sanitizeBankFilters, searchQuestionBank } from "@/lib/mock-question-bank";
import { getExamPapers } from "@/lib/exam-public";
import { startPreviousYearPaperAttempt } from "@/lib/test-attempt";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";
import { createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const HEADER = ["exam", "year", "subject", "topic", "source", "question_text", "option_a", "option_b", "option_c", "option_d", "correct_answer", "difficulty", "status"];
const csvFile = (rows: string[][], name: string) => {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return new File([[HEADER, ...rows].map((r) => r.map(esc).join(",")).join("\n")], name);
};

async function main() {
  console.log("=== PYQ Membership Isolation + Cross-Exam Mock Reuse ===\n");
  const s = Date.now().toString(36);
  const ruhs = await prisma.exam.create({ data: { name: `PMI Ruhs ${s}`, code: `PMIR-${s}`, year: 2026 } });
  const punjab = await prisma.exam.create({ data: { name: `PMI Punjab ${s}`, code: `PMIP-${s}` } });
  const haryana = await prisma.exam.create({ data: { name: `PMI Haryana ${s}`, code: `PMIH-${s}` } });
  const examIds = [ruhs.id, punjab.id, haryana.id];
  const subjectName = `PMI Subject ${s}`;
  const subject = await prisma.subject.create({
    data: {
      name: subjectName,
      nameKey: taxonomyNameKey(subjectName),
      originExamId: ruhs.id,
      examLinks: { create: examIds.map((examId, i) => ({ examId, displayOrder: i })) },
    },
  });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: `PMI Topic ${s}` });
  const ruhs2024 = await prisma.previousYearPaper.create({ data: { examId: ruhs.id, year: 2024, title: `PMI RUHS 2024 ${s}` } });
  const punjab2021 = await prisma.previousYearPaper.create({ data: { examId: punjab.id, year: 2021, title: `PMI Punjab 2021 ${s}` } });
  const haryana2023 = await prisma.previousYearPaper.create({ data: { examId: haryana.id, year: 2023, title: `PMI Haryana 2023 ${s}` } });
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  const mockIds: string[] = [];
  const runIds: string[] = [];
  const studentIds: string[] = [];

  let n = 0;
  const makeQ = async (examId: string, paperId: string | null, year: number | null, label: string) =>
    prisma.question.create({
      data: {
        code: `PMI-${s}-${++n}`,
        examId,
        subjectId: subject.id,
        topicId: topic.id,
        previousYearPaperId: paperId,
        source: paperId ? "PYQ" : "QUESTION_BANK",
        examYear: year,
        status: "PUBLISHED",
        text: `PMI ${s} ${label} #${n}`,
        options: { create: ["A", "B", "C", "D"].map((l, i) => ({ label: l, text: `${l}-${n}`, isCorrect: i === 1, order: i })) },
      },
    });
  const ruhsPyq = [await makeQ(ruhs.id, ruhs2024.id, 2024, "ruhs pyq"), await makeQ(ruhs.id, ruhs2024.id, 2024, "ruhs pyq"), await makeQ(ruhs.id, ruhs2024.id, 2024, "ruhs pyq")];
  const punjabPyq = [await makeQ(punjab.id, punjab2021.id, 2021, "punjab pyq"), await makeQ(punjab.id, punjab2021.id, 2021, "punjab pyq")];
  const haryanaPyq = [await makeQ(haryana.id, haryana2023.id, 2023, "haryana pyq"), await makeQ(haryana.id, haryana2023.id, 2023, "haryana pyq")];
  const dermaOnly = await makeQ(ruhs.id, null, 2024, "derma mock-only");

  const makeMock = async (title: string) => {
    const m = await prisma.mockTest.create({ data: { examId: ruhs.id, title: `PMI ${title} ${s}`, durationMinutes: 60, accessType: "FREE" } });
    mockIds.push(m.id);
    return m;
  };
  const paperCount = (paperId: string) => prisma.question.count({ where: { previousYearPaperId: paperId, status: "PUBLISHED" } });
  const snapshot = (id: string) =>
    prisma.question.findUniqueOrThrow({ where: { id }, select: { examId: true, previousYearPaperId: true, source: true, code: true, examYear: true, updatedAt: true } });
  const inMock = async (mockTestId: string) => (await prisma.mockTestQuestion.findMany({ where: { mockTestId }, orderBy: { order: "asc" } })).map((r) => r.questionId);

  try {
    const m1 = await makeMock("Mock 1");
    const m2 = await makeMock("Mock 2");
    const ruhsBefore = await paperCount(ruhs2024.id);
    check("fixture: RUHS 2024 paper has exactly its 3 original questions", ruhsBefore === 3, ruhsBefore);

    console.log("\n1-2. Punjab / Haryana PYQ questions referenced by a RUHS mock");
    for (const [label, qs, paper] of [
      ["Punjab", punjabPyq, punjab2021],
      ["Haryana", haryanaPyq, haryana2023],
    ] as const) {
      const before = await Promise.all(qs.map((q) => snapshot(q.id)));
      const res = await addQuestionsToMock(m1.id, qs.map((q) => q.id));
      const ids = await inMock(m1.id);
      check(`${label}: added to RUHS mock (cross-exam counted)`, "added" in res && res.added === 2 && res.crossExam === 2 && qs.every((q) => ids.includes(q.id)), res);
      check(`${label}: own PYQ paper still contains both`, (await paperCount(paper.id)) === 2);
      check(`${label}: RUHS 2024 paper count unchanged`, (await paperCount(ruhs2024.id)) === ruhsBefore);
      const after = await Promise.all(qs.map((q) => snapshot(q.id)));
      check(`${label}: Question rows untouched (exam, paper, source, code, updatedAt)`, JSON.stringify(before) === JSON.stringify(after), { before, after });
    }
    const totalQuestions = await prisma.question.count({ where: { examId: { in: examIds } } });
    check("no Question row duplicated by attaching", totalQuestions === 8, totalQuestions);

    console.log("\n3. Mock-only question of the RUHS exam (year 2024)");
    await addQuestionsToMock(m1.id, [dermaOnly.id]);
    check("mock-only question is in the mock", (await inMock(m1.id)).includes(dermaOnly.id));
    check("RUHS 2024 paper count unchanged (year match ≠ membership)", (await paperCount(ruhs2024.id)) === ruhsBefore);
    const publicPaper = (await getExamPapers(ruhs.id)).find((p) => p.id === ruhs2024.id);
    check("public/student paper count = canonical 3", publicPaper?.questionCount === 3, publicPaper);

    console.log("\n4. One RUHS 2024 PYQ question in several mocks");
    await addQuestionsToMock(m1.id, [ruhsPyq[0].id]);
    await addQuestionsToMock(m2.id, [ruhsPyq[0].id, ruhsPyq[0].id]);
    check("still exactly one Question row with that code", (await prisma.question.count({ where: { code: ruhsPyq[0].code } })) === 1);
    check("m2 holds it once (no duplicate slot)", (await inMock(m2.id)).filter((id) => id === ruhsPyq[0].id).length === 1);
    check("RUHS 2024 paper count still exactly 3", (await paperCount(ruhs2024.id)) === 3);

    console.log("\n5. Remove from a mock");
    const pBefore = await snapshot(punjabPyq[0].id);
    await removeQuestionsFromMock(m1.id, [punjabPyq[0].id]);
    check("removed from the mock", !(await inMock(m1.id)).includes(punjabPyq[0].id));
    check("question still exists, ownership identical", JSON.stringify(await snapshot(punjabPyq[0].id)) === JSON.stringify(pBefore));
    check("Punjab 2021 paper still has 2", (await paperCount(punjab2021.id)) === 2);
    const rep = await replaceQuestionInMock(m1.id, haryanaPyq[0].id, punjabPyq[0].id);
    check("replace with another exam's question works (slot swap only)", !("error" in rep) && (await inMock(m1.id)).includes(punjabPyq[0].id), rep);

    console.log("\n6. Delete a mock");
    await prisma.mockTest.delete({ where: { id: m2.id } });
    mockIds.splice(mockIds.indexOf(m2.id), 1);
    check("questions survive mock deletion", (await prisma.question.count({ where: { id: ruhsPyq[0].id } })) === 1);
    check("RUHS 2024 paper still 3 after mock deletion", (await paperCount(ruhs2024.id)) === 3);

    console.log("\n7. Bulk import: Mock Test target never infers a PYQ paper");
    async function stageAndRun(rows: string[][], opts: { mockTestId?: string; strategy?: BulkImportDuplicateStrategy; source: "QUESTION_BANK" | "MOCK_TEST" }) {
      const { rows: parsed } = await parseImportFile(csvFile(rows, `pmi-${s}.csv`));
      const run = await prisma.bulkImportRun.create({
        data: {
          adminUserId: admin.id,
          filename: `pmi-${s}.csv`,
          examId: ruhs.id,
          mockTestId: opts.mockTestId ?? null,
          importSource: opts.source,
          totalRows: parsed.length,
          duplicateStrategy: opts.strategy ?? "ADD_AS_NEW",
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
      runIds.push(run.id);
      const lookups = await buildTaxonomyLookups(prisma);
      const ctx = runExamContextFor(lookups.exams, run);
      const resolved = [];
      for (const r of await prisma.bulkImportRow.findMany({ where: { runId: run.id } })) {
        const [shape] = validateImportRows([mergeRowData(r.rawData, r.editedData)]);
        const res = await resolveRow(prisma, lookups, shape, undefined, ctx);
        resolved.push(res);
        await prisma.bulkImportRow.update({ where: { id: r.id }, data: { severity: res.severity } });
      }
      await prisma.bulkImportRun.update({ where: { id: run.id }, data: { status: BulkImportStatus.READY } });
      const out = await executeBulkImport({ runId: run.id, adminUserId: admin.id, allowExceedTarget: true });
      return { resolved, out, run };
    }
    const importRow = (exam: string, text: string) => [exam, "2024", subjectName, topic.name, "PYQ", text, "a", "b", "c", "d", "B", "MEDIUM", "PUBLISHED"];
    const m3 = await makeMock("Mock 3");
    const other = await stageAndRun([importRow("Haryana MO", `PMI ${s} import haryana 2024`), importRow(ruhs.name, `PMI ${s} import ruhs-named 2024`)], {
      mockTestId: m3.id,
      source: "MOCK_TEST",
    });
    check("preview: mock-target rows never resolve a paper", other.resolved.every((r) => r.resolvedData?.previousYearPaperId === null && r.resolvedData?.source === "QUESTION_BANK"), other.resolved.map((r) => r.resolvedData));
    check("preview: explains why (warning)", other.resolved.every((r) => r.warnings.some((w) => w.includes("never linked"))));
    check("import: both rows created + attached to the mock", other.out.successCount === 2 && (await inMock(m3.id)).length === 2, other.out);
    check("import: RUHS 2024 paper count still exactly 3", (await paperCount(ruhs2024.id)) === 3);
    const qb = await stageAndRun([importRow(ruhs.name, `PMI ${s} import genuine paper q`)], { source: "QUESTION_BANK" });
    check("Question Bank import of the paper's own exam still links to its paper (unchanged)", qb.resolved[0].resolvedData?.previousYearPaperId === ruhs2024.id && (await paperCount(ruhs2024.id)) === 4);
    const genuine = await prisma.question.findFirstOrThrow({ where: { text: `PMI ${s} import genuine paper q` } });

    console.log("\n8. Mock import REPLACE keeps canonical ownership");
    const gBefore = await snapshot(genuine.id);
    const rep8 = await stageAndRun([importRow("Haryana MO", `PMI ${s} import genuine paper q`)], { mockTestId: m3.id, source: "MOCK_TEST", strategy: "REPLACE" });
    const gAfter = await snapshot(genuine.id);
    check("duplicate replaced (not created)", rep8.out.replacedCount === 1 && rep8.out.successCount === 0, rep8.out);
    check("replaced PYQ stays linked to its paper / exam / source", gAfter.previousYearPaperId === ruhs2024.id && gAfter.examId === gBefore.examId && gAfter.source === "PYQ");
    check("RUHS 2024 paper count still 4", (await paperCount(ruhs2024.id)) === 4);

    console.log("\n9. PYQ attempt = canonical paper set");
    const passwordHash = await argon2.hash(`pmi-${s}`);
    const student = await prisma.student.create({
      data: { studentId: `PMI-${s}`, name: "PMI Student", email: `pmi-${s}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    studentIds.push(student.id);
    const attempt = await startPreviousYearPaperAttempt(student.id, ruhs2024.id);
    const served = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, select: { questionId: true } });
    const canonical = await prisma.question.findMany({ where: { previousYearPaperId: ruhs2024.id, status: "PUBLISHED" }, select: { id: true } });
    check("attempt serves exactly the paper's canonical questions", served.length === canonical.length && canonical.every((c) => served.some((x) => x.questionId === c.id)), { served: served.length, canonical: canonical.length });
    check("mock-only / other-exam questions never served by the PYQ attempt", !served.some((x) => [dermaOnly.id, punjabPyq[0].id, haryanaPyq[0].id].includes(x.questionId)));

    console.log("\n10. Server-side bank search");
    const byPaper = await searchQuestionBank({ examId: punjab.id, paperId: punjab2021.id }, 1);
    check("Source Exam + Paper → only that paper's questions", byPaper.total === 2 && byPaper.rows.every((r) => r.examId === punjab.id && r.paperTitle === punjab2021.title && r.isPyq));
    check("row carries provenance (exam code, paper year)", byPaper.rows[0]?.examCode === punjab.code && byPaper.rows[0]?.paperYear === 2021);
    const allFix = await searchQuestionBank({ q: `PMI ${s}` }, 1);
    check("All exams + text search spans every exam", new Set(allFix.rows.map((r) => r.examId)).size === 3, allFix.rows.map((r) => r.examCode));
    const byCode = await searchQuestionBank({ q: punjabPyq[1].code }, 1);
    check("search by question code", byCode.total === 1 && byCode.rows[0].id === punjabPyq[1].id);
    const pyqOnly = await searchQuestionBank({ examId: ruhs.id, source: "PYQ" }, 1);
    const bankOnly = await searchQuestionBank({ examId: ruhs.id, source: "BANK" }, 1);
    check("Source PYQ = paper-linked only", pyqOnly.rows.every((r) => r.isPyq) && pyqOnly.total === 4, pyqOnly.total);
    check("Source Non-PYQ excludes paper questions", bankOnly.rows.every((r) => !r.isPyq) && bankOnly.rows.some((r) => r.id === dermaOnly.id));
    const y2023 = await searchQuestionBank({ year: 2023, q: `PMI ${s}` }, 1);
    check("Year filter (paper year for PYQs)", y2023.total === 2 && y2023.rows.every((r) => r.examId === haryana.id));
    // m1 now holds haryanaPyq[1] (haryanaPyq[0] was replaced out in step 5).
    const excl = await searchQuestionBank({ examId: haryana.id, excludeMockTestId: m1.id }, 1);
    check("hide questions already in this mock", !excl.rows.some((r) => r.id === haryanaPyq[1].id) && excl.rows.some((r) => r.id === haryanaPyq[0].id), excl.rows.map((r) => r.code));
    const facets = (await searchQuestionBank({ examId: haryana.id, subjectId: subject.id }, 1)).facets;
    check("facets cascade (subject → topic; years of that exam)", facets.subjects.some((x) => x.id === subject.id) && facets.topics.some((t) => t.id === topic.id) && facets.years.join() === "2023", facets);
    const paged = await searchQuestionBank({ status: "PUBLISHED" }, 999999);
    check("pagination: page size capped, out-of-range page clamped", paged.rows.length <= BANK_PAGE_SIZE && paged.page === Math.max(1, Math.ceil(paged.total / BANK_PAGE_SIZE)));
    check("select-all ids respects filters", (await matchingQuestionIds({ examId: haryana.id })).length === 2);
    const dirty = sanitizeBankFilters({ examId: "x'; drop table", status: "ARCHIVED", source: "EVIL", year: "20245", difficulty: "IMPOSSIBLE", q: "  ok  " });
    check("untrusted filters sanitized", !dirty.examId && !dirty.status && !dirty.source && !dirty.year && !dirty.difficulty && dirty.q === "ok", dirty);
    const archived = await makeQ(punjab.id, punjab2021.id, 2021, "archived");
    await prisma.question.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
    check("ARCHIVED never offered", !(await searchQuestionBank({ examId: punjab.id }, 1)).rows.some((r) => r.id === archived.id));
    const addArchived = await addQuestionsToMock(m1.id, [archived.id]);
    check("ARCHIVED never attachable", "added" in addArchived && addArchived.added === 0);

    console.log("\n11. Authorization");
    const src = readFileSync("app/admin/(dashboard)/tests/mock/actions.ts", "utf8");
    const exported = [...src.matchAll(/export async function (\w+Question\w*Action)\([^)]*\)[^\n]*\{\n([^\n]*)/g)];
    check(
      "every Mock Test question action checks TEST_SERIES_MANAGE first",
      exported.length >= 6 && exported.every((m) => m[2].includes("requirePermission(PERMISSIONS.TEST_SERIES_MANAGE)")),
      exported.map((m) => m[1])
    );
    check("only MASTER_ADMIN holds TEST_SERIES_MANAGE", Object.entries(DEFAULT_ROLE_PERMISSIONS).every(([role, perms]) => perms.includes(PERMISSIONS.TEST_SERIES_MANAGE) === (role === "MASTER_ADMIN")));
  } finally {
    await prisma.answer.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.mockTestQuestion.deleteMany({ where: { mockTestId: { in: mockIds } } });
    await prisma.bulkImportRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.mockTest.deleteMany({ where: { id: { in: mockIds } } });
    await prisma.questionOption.deleteMany({ where: { question: { examId: { in: examIds } } } });
    await prisma.question.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...runIds, ...mockIds] } } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.subject.deleteMany({ where: { id: subject.id } });
    await deleteFixtureTaxonomy(prisma, examIds);
    await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
