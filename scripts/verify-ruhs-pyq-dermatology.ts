/**
 * RUHS PYQ + Dermatology (Part 1) regression — against the REAL data and the
 * REAL engines. Content assertions are read-only; the only writes are a
 * disposable student (and its attempts), deleted at the end.
 *
 *   1-4. RUHS 2024 / 2022 / 2015 / 2020 papers = exactly 100 / 100 / 99 / 99,
 *        and every RUHS paper question came from a Question Bank import.
 *   5.   The Dermatology 150 have no PYQ paper, source QUESTION_BANK, the
 *        canonical Dermatology subject, and never enter a RUHS PYQ attempt.
 *   6.   Subject Test RUHS → Dermatology serves them (eligible pool count).
 *   7-8. Custom Module selection: Non-PYQ includes all 150; PYQ excludes all.
 *   9.   Dermatology Mock 1 starts and serves its published questions.
 *  10.   Subject Mock classification: both Dermatology mocks resolve to
 *        Subject Mock → Dermatology; mixed mocks never do; the shared Test
 *        Engine files are byte-identical to the previous release.
 *  11.   No SUBMITTED attempt is invalid; no IN_PROGRESS PYQ attempt holds a
 *        foreign question; a reset (ABANDONED) attempt is never resumed —
 *        the next Start is a fresh attempt on the corrected paper.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ruhs-pyq-dermatology.ts
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { AttemptStatus, StudentAuthProvider } from "@prisma/client";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { countPublishedQuestions, selectPublishedQuestions } from "@/lib/question-selection";
import { startMockTestAttempt, startPreviousYearPaperAttempt, startSubjectTestAttempt } from "@/lib/test-attempt";
import { subjectMockSubjectId } from "@/lib/subject-mocks";
import { getExamPapers } from "@/lib/exam-public";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const DERMA_RUN_ID = "cmujwfrec00z6fykzpwg6iw0a";
const ENGINE_FILES = ["lib/test-attempt.ts", "lib/question-selection.ts", "lib/attempt-timing.ts", "lib/test-player-data.ts", "app/student/attempt/[attemptId]/run/test-player.tsx"];
const BASELINE_SHA = process.env.ENGINE_BASELINE_SHA ?? "032764d";

async function main() {
  console.log("=== RUHS PYQ + Dermatology (Part 1) ===\n");
  const ruhs = await prisma.exam.findUniqueOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const derma = await prisma.subject.findFirstOrThrow({ where: { nameKey: "dermatology" }, select: { id: true } });
  const dermaIds = (await prisma.question.findMany({ where: { importBatchId: DERMA_RUN_ID }, select: { id: true } })).map((q) => q.id);
  const studentIds: string[] = [];

  try {
    console.log("1-4. RUHS paper counts");
    const papers = await getExamPapers(ruhs.id);
    const count = (year: number) => papers.find((p) => p.year === year)?.questionCount;
    for (const [year, expected] of [
      [2024, 100],
      [2022, 100],
      [2015, 99],
      [2020, 99],
    ] as const)
      check(`RUHS MO ${year} = ${expected} (student/public count)`, count(year) === expected, count(year));
    const fromMockImport = await prisma.question.count({ where: { previousYearPaper: { examId: ruhs.id }, importBatch: { mockTestId: { not: null } } } });
    check("no RUHS paper question came from a Mock Test import", fromMockImport === 0, fromMockImport);

    console.log("\n5. Dermatology questions are Question Bank content, not PYQ");
    const dq = await prisma.question.findMany({ where: { id: { in: dermaIds } }, select: { previousYearPaperId: true, source: true, subjectId: true, examId: true, topicId: true } });
    check("150 Dermatology questions found", dq.length === 150, dq.length);
    check("none linked to any Previous Year Paper", dq.every((q) => q.previousYearPaperId === null));
    check("all source = QUESTION_BANK", dq.every((q) => q.source === "QUESTION_BANK"));
    check("all canonical Dermatology subject, RUHS exam, with a topic", dq.every((q) => q.subjectId === derma.id && q.examId === ruhs.id && q.topicId));

    console.log("\n6. Subject Test → RUHS → Dermatology");
    const subjectPool = await countPublishedQuestions({ examId: ruhs.id, subjectId: derma.id });
    const publishedDerma = await prisma.question.count({ where: { id: { in: dermaIds }, status: "PUBLISHED" } });
    check(`eligible Dermatology pool (${subjectPool}) includes all ${publishedDerma} published Dermatology-import questions`, subjectPool >= publishedDerma && publishedDerma === 150);
    const full = await selectPublishedQuestions({ examId: ruhs.id, subjectId: derma.id, count: subjectPool });
    const served = new Set(full.questions.map((q) => q.id));
    check("a full-pool Subject Test draw contains every one of them", dermaIds.every((id) => served.has(id)));

    console.log("\n7-8. Custom Module source filter");
    const nonPyqPool = await countPublishedQuestions({ examId: ruhs.id, subjectId: derma.id, source: "QUESTION_BANK" });
    const nonPyq = await selectPublishedQuestions({ examId: ruhs.id, subjectId: derma.id, source: "QUESTION_BANK", count: nonPyqPool });
    check("Non-PYQ includes all 150", dermaIds.every((id) => nonPyq.questions.some((q) => q.id === id)), nonPyqPool);
    const pyqPool = await countPublishedQuestions({ examId: ruhs.id, subjectId: derma.id, source: "PYQ" });
    const pyq = pyqPool ? await selectPublishedQuestions({ examId: ruhs.id, subjectId: derma.id, source: "PYQ", count: pyqPool }) : { questions: [] };
    check(`PYQ (${pyqPool} Dermatology PYQs) excludes all 150`, !pyq.questions.some((q) => dermaIds.includes(q.id)));
    const pyq2024 = await countPublishedQuestions({ examId: ruhs.id, subjectId: derma.id, source: "PYQ", year: 2024 });
    const pyq2024Paper = await prisma.question.count({ where: { previousYearPaper: { examId: ruhs.id, year: 2024 }, subjectId: derma.id, status: "PUBLISHED" } });
    check("PYQ + Year 2024 = only the RUHS 2024 paper's own Dermatology questions", pyq2024 === pyq2024Paper, { pyq2024, pyq2024Paper });
    // (5 DRAFT AI variants of RUHSMO 2013 W118 carry source PYQ with no paper;
    // DRAFT is never served to students, so only PUBLISHED is asserted.)
    check(
      "no PUBLISHED RUHS question is source PYQ without a paper",
      (await prisma.question.count({ where: { examId: ruhs.id, source: "PYQ", previousYearPaperId: null, status: "PUBLISHED" } })) === 0
    );

    console.log("\n9-11. Engine paths with a disposable student");
    const s = Date.now().toString(36);
    const student = await prisma.student.create({
      data: { studentId: `RPD-${s}`, name: "RPD Student", email: `rpd-${s}@example.test`, passwordHash: await argon2.hash(`rpd-${s}`), authProvider: StudentAuthProvider.CREDENTIALS },
    });
    studentIds.push(student.id);
    const mock1 = await prisma.mockTest.findFirstOrThrow({ where: { title: "DERMATOLOGY MOCK 1" }, select: { id: true } });
    const m = await startMockTestAttempt(student.id, mock1.id);
    const mq = await prisma.testAttemptQuestion.count({ where: { attemptId: m.id } });
    check("Dermatology Mock 1 starts on the canonical engine and serves its 150 questions", mq === 150, mq);

    const st = await startSubjectTestAttempt(student.id, { examId: ruhs.id, subjectId: derma.id, count: 10, durationMinutes: 10 });
    const stIds = (await prisma.testAttemptQuestion.findMany({ where: { attemptId: st.id }, select: { questionId: true } })).map((r) => r.questionId);
    const stQs = await prisma.question.findMany({ where: { id: { in: stIds } }, select: { subjectId: true } });
    check("Subject Test attempt serves only Dermatology questions", stIds.length === 10 && stQs.every((q) => q.subjectId === derma.id));

    const paper2024 = await prisma.previousYearPaper.findFirstOrThrow({ where: { examId: ruhs.id, year: 2024 }, select: { id: true } });
    const a1 = await startPreviousYearPaperAttempt(student.id, paper2024.id);
    const a1Ids = (await prisma.testAttemptQuestion.findMany({ where: { attemptId: a1.id }, select: { questionId: true } })).map((r) => r.questionId);
    check("RUHS 2024 PYQ attempt = 100 questions, none from Dermatology import", a1Ids.length === 100 && !a1Ids.some((id) => dermaIds.includes(id)), a1Ids.length);
    await prisma.testAttempt.update({ where: { id: a1.id }, data: { status: AttemptStatus.ABANDONED } });
    const a2 = await startPreviousYearPaperAttempt(student.id, paper2024.id);
    check("a reset (ABANDONED) attempt is never resumed — Start creates a fresh attempt", a2.id !== a1.id && a2.status === AttemptStatus.IN_PROGRESS);

    console.log("\n10. Subject Mock classification");
    const allMocks = await prisma.mockTest.findMany({ select: { title: true, coverageType: true, coverageSubjectIds: true } });
    const dermaMocks = allMocks.filter((mt) => subjectMockSubjectId(mt) === derma.id).map((mt) => mt.title).sort();
    check("Subject Mock → Dermatology = the two genuine Dermatology mocks", JSON.stringify(dermaMocks) === JSON.stringify(["DERMATOLOGY MOCK 1", "Dermatology Mock Test 2"]), dermaMocks);
    check("no mixed / general mock classified as a Subject Mock", allMocks.filter((mt) => subjectMockSubjectId(mt)).length === 2);
    check("multi-subject SUBJECT_WISE is not a Subject Mock", subjectMockSubjectId({ coverageType: "SUBJECT_WISE", coverageSubjectIds: ["a", "b"] }) === null);
    const diff = execSync(`git diff --stat ${BASELINE_SHA} -- ${ENGINE_FILES.map((f) => `'${f}'`).join(" ")}`, { encoding: "utf8" }).trim();
    check(`shared Test Engine files unchanged since ${BASELINE_SHA}`, diff === "", diff);

    console.log("\n11. Attempt integrity");
    const pyqAttempts = await prisma.testAttempt.findMany({
      where: { previousYearPaperId: { not: null }, status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.IN_PROGRESS] }, studentId: { notIn: studentIds } },
      select: { id: true, status: true, previousYearPaperId: true, questions: { select: { questionId: true } } },
    });
    const paperOf = new Map(
      (
        await prisma.question.findMany({ where: { id: { in: [...new Set(pyqAttempts.flatMap((a) => a.questions.map((q) => q.questionId)))] } }, select: { id: true, previousYearPaperId: true } })
      ).map((q) => [q.id, q.previousYearPaperId])
    );
    const bad = pyqAttempts.filter((a) => a.questions.some((q) => paperOf.get(q.questionId) !== a.previousYearPaperId));
    check("no IN_PROGRESS PYQ attempt holds a foreign question", !bad.some((a) => a.status === "IN_PROGRESS"), bad.map((a) => a.id));
    check("no SUBMITTED PYQ attempt was ever inflated (0 invalid submitted)", !bad.some((a) => a.status === "SUBMITTED"));
    const resets = await prisma.auditLog.count({ where: { action: "PYQ_DATA_CORRECTION", entityType: "TestAttempt" } });
    const abandoned = await prisma.testAttempt.count({ where: { status: AttemptStatus.ABANDONED, studentId: { notIn: studentIds } } });
    check("every reset attempt has a PYQ_DATA_CORRECTION audit row", resets === abandoned && resets >= 3, { resets, abandoned });
  } finally {
    await prisma.answer.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
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
