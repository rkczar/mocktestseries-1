/**
 * Targeted verification for the Exams/Bulk-Import/Subjects/PYQ upgrade
 * (Bulk Import Exam-first flow, all-columns-ignorable staging, Exam
 * edit/delete, Exam-wise Subjects/Topics, Previous Year Paper <-> Question
 * Bank linking, RBAC). Follows the same pattern as
 * scripts/verify-questionbank-upgrade.ts: exercises lib/*.ts functions and
 * the same DB operations the "use server" actions perform directly against
 * the real (shared) DB, with fixture rows cleaned up at the end, since
 * "use server" action files can't be imported into a plain script.
 *
 * Run from the repo root:
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-exam-pyq-upgrade.ts
 */
import "dotenv/config";
import { PrismaClient, BulkImportDuplicateStrategy, QuestionSource, QuestionStatus, RoleName } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { validateImportRows, resolveRow, buildTaxonomyLookups, type BulkImportRow } from "@/lib/bulk-import";
import { executeBulkImport } from "@/lib/bulk-import-execute";
import { readFileSync } from "fs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}`);
  if (!condition) failures++;
}

function baseRow(overrides: Partial<BulkImportRow> = {}): BulkImportRow {
  return {
    rowNumber: 1,
    exam: "",
    examYear: "",
    subject: "VERIFY-EPU-SUBJECT",
    topic: "",
    subTopic: "",
    source: "",
    questionText: "What is 2 + 2?",
    optionA: "3",
    optionB: "4",
    optionC: "5",
    optionD: "6",
    correctAnswer: "",
    difficulty: "",
    status: "",
    ...overrides,
  };
}

async function main() {
  const createdIds: { exams: string[]; runs: string[]; questions: string[]; papers: string[]; attempts: string[] } = {
    exams: [],
    runs: [],
    questions: [],
    papers: [],
    attempts: [],
  };

  try {
    // ---- 1. RBAC ---------------------------------------------------------
    console.log("\n--- RBAC (Section 23) ---");
    check("FULL_ADMIN does NOT have EXAMS_MANAGE (read-only on the Exams domain)", !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.EXAMS_MANAGE));
    check("FULL_ADMIN still lacks QUESTIONS_MANAGE (unaffected/still read-only on Question Bank)", !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.QUESTIONS_MANAGE));
    check(
      "FULL_ADMIN keeps every OTHER manage permission (not a blanket lockout)",
      [PERMISSIONS.WEBSITE_MANAGE, PERMISSIONS.TESTS_MANAGE, PERMISSIONS.STUDENTS_MANAGE, PERMISSIONS.ANNOUNCEMENTS_MANAGE].every((p) =>
        DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(p)
      )
    );
    check("MASTER_ADMIN has EXAMS_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.EXAMS_MANAGE));
    check("TEACHER still has EXAMS_MANAGE (unaffected by the FULL_ADMIN change)", DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.EXAMS_MANAGE));

    const examsManageFiles = [
      "app/admin/(dashboard)/exams/actions.ts",
      "app/admin/(dashboard)/exams/subjects/actions.ts",
      "app/admin/(dashboard)/exams/topics/actions.ts",
      "app/admin/(dashboard)/exams/previous-year-papers/actions.ts",
    ];
    for (const file of examsManageFiles) {
      const src = readFileSync(file, "utf-8");
      const matches = src.match(/requirePermission\(\s*PERMISSIONS\.EXAMS_MANAGE\s*\)/g) ?? [];
      const exportedFns = (src.match(/^export async function \w+/gm) ?? []).length;
      check(`${file}: every exported function gates on requirePermission(PERMISSIONS.EXAMS_MANAGE) (${matches.length}/${exportedFns})`, matches.length === exportedFns);
    }

    // ---- 2. Bulk Import requires/selects Exam (Section 1) ----------------
    console.log("\n--- Bulk Import Exam selector ---");
    const uploadSrc = readFileSync("app/api/admin/questions/bulk-import/upload/route.ts", "utf-8");
    check("Upload route rejects a missing examId (Exam context is mandatory)", /if \(!examId\)/.test(uploadSrc));
    const workspaceSrc = readFileSync("app/admin/(dashboard)/questions/bulk-import/bulk-import-workspace.tsx", "utf-8");
    check("Workspace disables Upload until an Exam is selected", /disabled=\{!file \|\| !examId/.test(workspaceSrc));
    check("Workspace shows a persistent \"Importing into\" banner", /Importing into:/.test(workspaceSrc));
    check("Workspace offers a Change Exam control", /Change Exam/.test(workspaceSrc));

    // ---- 3. Every uploaded column offers Ignore (Section 3) ---------------
    console.log("\n--- Manage Columns: all ignorable ---");
    check("No \"cannot be ignored\" / \"cannot ignore\" UI copy remains", !/cannot.{0,3}(be )?ignor/i.test(workspaceSrc));
    const bulkActionsSrc = readFileSync("app/api/admin/questions/bulk-import/runs/[runId]/bulk-actions/route.ts", "utf-8");
    check("bulk-actions route no longer blocks IGNORE_COLUMN for required columns", !/cannot be ignored/i.test(bulkActionsSrc));

    // ---- 4. Ignored/missing soft fields never block staging, never silently Publish (Section 5) ----
    console.log("\n--- Soft-default validation severities (no DB) ---");
    const [missingCorrectAnswer] = validateImportRows([baseRow({ exam: "X", examYear: "2026", correctAnswer: "" })]);
    check("Missing Correct Answer is a WARNING (stageable/importable), not an ERROR", missingCorrectAnswer.severity !== "ERROR");
    const [missingDifficulty] = validateImportRows([baseRow({ exam: "X", examYear: "2026", difficulty: "" })]);
    check("Missing Difficulty is a WARNING, not an ERROR", missingDifficulty.severity !== "ERROR");
    const [missingSubject] = validateImportRows([baseRow({ exam: "X", examYear: "2026", subject: "" })]);
    check("Missing Subject is still an ERROR (no default taxonomy — cannot become a Question)", missingSubject.severity === "ERROR");
    const [missingText] = validateImportRows([baseRow({ exam: "X", examYear: "2026", questionText: "" })]);
    check("Missing Question Text is still an ERROR (NOT NULL, no default in schema)", missingText.severity === "ERROR");

    // ---- 5. Full fixture cycle: Exam context fallback + forced Draft ------
    console.log("\n--- Fixture: Exam context fallback, forced Draft (Sections 1/2/5) ---");
    const suffix = Date.now();
    const exam = await prisma.exam.create({ data: { name: `VERIFY-EPU-EXAM-${suffix}`, code: `VERIFYEPU${suffix}`, year: 2026 } });
    createdIds.exams.push(exam.id);
    const subject = await prisma.subject.create({ data: { examId: exam.id, name: "VERIFY-EPU-SUBJECT" } });

    const adminUser = await prisma.adminUser.findFirst({ where: { role: { name: RoleName.MASTER_ADMIN } } });
    if (!adminUser) throw new Error("No MASTER_ADMIN admin user found to attribute the fixture import to");

    const lookups = await buildTaxonomyLookups(prisma);
    const runExamContext = lookups.exams.find((e) => e.id === exam.id) ?? null;

    // Row with NO exam/examYear/correctAnswer at all — everything should
    // fall back to the run's selected Exam context.
    const [shapeParsed] = validateImportRows([baseRow({ subject: subject.name, questionText: `Fixture no-answer question ${suffix}` })]);
    const resolved = await resolveRow(prisma, lookups, shapeParsed, undefined, runExamContext);
    check("A row with no Exam/Year falls back to the run's selected Exam context (no ERROR)", resolved.severity !== "ERROR");
    check("resolvedData.examId matches the run's Exam context", resolved.resolvedData?.examId === exam.id);
    check("resolvedData.examYear falls back to the Exam's own year (2026)", resolved.resolvedData?.examYear === 2026);
    check("forceDraft is true when Correct Answer is missing", resolved.forceDraft === true);

    const run = await prisma.bulkImportRun.create({
      data: {
        adminUserId: adminUser.id,
        filename: "verify-fixture.csv",
        totalRows: 1,
        duplicateStrategy: BulkImportDuplicateStrategy.SKIP,
        examId: exam.id,
      },
    });
    createdIds.runs.push(run.id);
    await prisma.bulkImportRow.create({
      data: { runId: run.id, rowNumber: 1, rawData: baseRow({ subject: subject.name, status: "PUBLISHED", questionText: `Fixture no-answer question ${suffix}` }) as object },
    });

    const result = await executeBulkImport({ runId: run.id, adminUserId: adminUser.id });
    check("Row with no Correct Answer + status=PUBLISHED still imports (not blocked)", result.successCount === 1);

    const createdQuestion = await prisma.question.findFirst({ where: { text: `Fixture no-answer question ${suffix}` } });
    check("A Question was actually created", !!createdQuestion);
    if (createdQuestion) {
      createdIds.questions.push(createdQuestion.id);
      check(
        "BROKEN QUESTION AUTO-PUBLISHED = NO: saved as DRAFT despite file saying PUBLISHED (no Correct Answer)",
        createdQuestion.status === QuestionStatus.DRAFT
      );
      check("Question flagged reviewRequired", createdQuestion.reviewRequired === true);
      check("Question.examId used the run's Exam context", createdQuestion.examId === exam.id);
      check("Question.examYear defaulted from the Exam's own year", createdQuestion.examYear === 2026);
    }

    // ---- 6. Exam edit preserves id + relations (Sections 6/7/8) -----------
    console.log("\n--- Exam rename/edit preserves relationships ---");
    const renamed = await prisma.exam.update({ where: { id: exam.id }, data: { name: `VERIFY-EPU-RENAMED-${suffix}`, examDate: new Date() } });
    check("Exam id unchanged after rename", renamed.id === exam.id);
    check("Exam examDate field is settable (Section 8)", renamed.examDate !== null);
    const subjectStillLinked = await prisma.subject.findUnique({ where: { id: subject.id } });
    check("Subject still linked to the (renamed) Exam", subjectStillLinked?.examId === exam.id);
    const questionStillLinked = createdQuestion ? await prisma.question.findUnique({ where: { id: createdQuestion.id } }) : null;
    check("Question created before the rename is still linked (not recreated)", questionStillLinked?.examId === exam.id);

    // ---- 7. Exam delete is relationship-safe (Section 9) -------------------
    console.log("\n--- Exam delete safety ---");
    const attemptExam = await prisma.exam.create({ data: { name: `VERIFY-EPU-ATTEMPT-EXAM-${suffix}`, code: `VERIFYEPUATT${suffix}` } });
    createdIds.exams.push(attemptExam.id);
    const attemptSubject = await prisma.subject.create({ data: { examId: attemptExam.id, name: "VERIFY-EPU-ATTEMPT-SUBJECT" } });
    const student = await prisma.student.findFirst();
    if (student) {
      const attempt = await prisma.testAttempt.create({
        data: {
          studentId: student.id,
          examId: attemptExam.id,
          subjectId: attemptSubject.id,
          testType: "SUBJECT_TEST",
          sourceType: "SUBJECT_TEST",
          totalQuestions: 0,
          durationMinutes: 10,
        },
      });
      createdIds.attempts.push(attempt.id);
      let blocked = false;
      try {
        await prisma.exam.delete({ where: { id: attemptExam.id } });
      } catch {
        blocked = true;
      }
      check("DB-level FK safety net: an Exam with a TestAttempt cannot be hard-deleted", blocked);
    } else {
      console.log("SKIP — no Student fixture available to create a TestAttempt for the delete-safety check");
    }

    const emptyExam = await prisma.exam.create({ data: { name: `VERIFY-EPU-EMPTY-EXAM-${suffix}`, code: `VERIFYEPUEMPTY${suffix}` } });
    await prisma.exam.delete({ where: { id: emptyExam.id } });
    check("An empty/new Exam with no history deletes cleanly", true);

    // ---- 8. Previous Year Paper <-> Question Bank linking (Sections 16-19) ----
    console.log("\n--- PYQ paper linking ---");
    const paper = await prisma.previousYearPaper.create({
      data: { examId: exam.id, year: 2026, title: `VERIFY-EPU-PAPER-${suffix}`, paperCode: "CODE-1" },
    });
    createdIds.papers.push(paper.id);

    const pyqQuestion = await prisma.question.create({
      data: {
        code: `VERIFY-EPU-PYQ-${suffix}`,
        examId: exam.id,
        subjectId: subject.id,
        text: `Fixture PYQ candidate ${suffix}`,
        difficulty: "MEDIUM",
        status: "DRAFT",
        source: QuestionSource.PYQ,
        examYear: 2026,
      },
    });
    createdIds.questions.push(pyqQuestion.id);

    const candidates = await prisma.question.findMany({ where: { examId: exam.id, examYear: 2026, previousYearPaperId: null } });
    check("Candidate matching finds the unlinked fixture question by Exam+Year", candidates.some((q) => q.id === pyqQuestion.id));

    await prisma.question.updateMany({ where: { id: { in: [pyqQuestion.id] }, examId: exam.id, examYear: 2026 }, data: { previousYearPaperId: paper.id, source: QuestionSource.PYQ } });
    const linked = await prisma.question.findUnique({ where: { id: pyqQuestion.id } });
    check("Linking sets Question.previousYearPaperId (no duplicate Question created)", linked?.previousYearPaperId === paper.id);
    const questionCountAfterLink = await prisma.question.count({ where: { code: pyqQuestion.code } });
    check("Exactly one Question row exists after linking (link, don't duplicate)", questionCountAfterLink === 1);

    await prisma.question.updateMany({ where: { id: pyqQuestion.id, previousYearPaperId: paper.id }, data: { previousYearPaperId: null } });
    const unlinked = await prisma.question.findUnique({ where: { id: pyqQuestion.id } });
    check("Unlinking clears previousYearPaperId", unlinked?.previousYearPaperId === null);
    check("Remove From Paper does NOT delete the Question", !!unlinked);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    if (createdIds.questions.length) await prisma.question.deleteMany({ where: { id: { in: createdIds.questions } } });
    if (createdIds.attempts.length) await prisma.testAttempt.deleteMany({ where: { id: { in: createdIds.attempts } } });
    if (createdIds.papers.length) await prisma.previousYearPaper.deleteMany({ where: { id: { in: createdIds.papers } } });
    if (createdIds.runs.length) {
      await prisma.bulkImportRow.deleteMany({ where: { runId: { in: createdIds.runs } } });
      await prisma.bulkImportRun.deleteMany({ where: { id: { in: createdIds.runs } } });
    }
    if (createdIds.exams.length) await prisma.exam.deleteMany({ where: { id: { in: createdIds.exams } } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
