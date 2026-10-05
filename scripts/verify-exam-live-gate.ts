/**
 * Inactive-exam (private / pre-launch) server-side gate — lib/exam-live.ts.
 *
 * Builds one exam that holds an ACTIVE Previous Year Paper, PUBLISHED
 * questions, a PUBLISHED Mock Test and Custom Modules, then proves that while
 * the exam is inactive no student read or start reaches any of it by direct
 * id (draft-leak regression), and that the very same calls work once the exam
 * is active (so the refusals come from the gate, not from a broken fixture).
 * Also proves an attempt started while the exam was live is not resumable by
 * id after the exam is deactivated.
 *
 * Run against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-exam-live-gate.ts
 *
 * `setup` / `cleanup <fixture.json>` prepare the same shape (plus an active
 * control exam and a password student) for the HTTP suite,
 * scripts/verify-exam-live-gate.mjs, which posts the student Server Actions
 * and opens the pages with the forged ids.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import argon2 from "argon2";
import {
  AttemptSourceType,
  CustomModuleStatus,
  HomepageSectionKey,
  MockTestStatus,
  PrismaClient,
  QuestionDifficulty,
  QuestionSource,
  QuestionStatus,
  StudentAuthProvider,
  type HomepageConfig,
  type HomepageSection,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  previewFormalTestStart,
  startCustomModuleAttempt,
  startMockTestAttempt,
  startPreviousYearPaperAttempt,
  startSharedCustomModuleAttempt,
  startSubjectTestAttempt,
} from "@/lib/test-attempt";
import {
  getCustomModuleByShareToken,
  getCustomModuleDetailForStudent,
  getDashboardPreviousYearPapers,
  getMockTestDetailForStudent,
  getPreviousYearPaperForStudent,
} from "@/lib/student-data";
import { resolveHomepage } from "@/lib/homepage-render";
import { assertExamLive, isExamLive, EXAM_NOT_LIVE_MESSAGE } from "@/lib/exam-live";
import { nextStudentId } from "@/lib/student-id";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database. Point DATABASE_URL at a disposable copy.");
  process.exit(2);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

/** Resolves to the refusal message, or null when the call did NOT throw. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `ELG Exam ${suffix}`, code: `ELG-${suffix}`, isActive: false } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "ELG Subject" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "ELG Topic" });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2026, title: `ELG Paper ${suffix}`, isActive: true } });

  const questionIds: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const q = await prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        previousYearPaperId: paper.id,
        source: QuestionSource.PYQ,
        examYear: 2026,
        code: `ELG-${suffix}-${i}`,
        text: `Exam-live gate question ${i}?`,
        status: QuestionStatus.PUBLISHED,
        difficulty: QuestionDifficulty.MEDIUM,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label.toLowerCase(), isCorrect: label === "A", order })) },
      },
    });
    questionIds.push(q.id);
  }

  const mock = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `ELG Mock ${suffix}`,
      durationMinutes: 30,
      status: MockTestStatus.PUBLISHED,
      accessType: "FREE",
      questions: { create: questionIds.map((questionId, order) => ({ questionId, order })) },
    },
  });
  const adminModule = await prisma.customModule.create({
    data: {
      examId: exam.id,
      title: `ELG Module ${suffix}`,
      selectionMode: "MANUAL",
      accessType: "FREE",
      status: CustomModuleStatus.PUBLISHED,
      questions: { create: questionIds.map((questionId, order) => ({ questionId, order })) },
    },
  });
  const shareToken = `elg-share-${suffix}`;
  const sharedModule = await prisma.customModule.create({
    data: {
      examId: exam.id,
      title: `ELG Shared ${suffix}`,
      selectionMode: "MANUAL",
      accessType: "FREE",
      status: CustomModuleStatus.ACTIVE,
      shareToken,
      questions: { create: questionIds.map((questionId, order) => ({ questionId, order })) },
    },
  });

  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `ELG${tag}-${suffix}`, name: `ELG ${tag}`, email: `elg-${tag.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };

  // In-memory homepage config (never written): one PYQ section by explicit ids, one by exam.
  const now = new Date();
  const fakeSection = (key: HomepageSectionKey, order: number, references: Record<string, unknown>): HomepageSection => ({
    id: `elg-${key}`,
    homepageConfigId: "elg",
    key,
    isEnabled: true,
    order,
    content: {},
    references: references as never,
    createdAt: now,
    updatedAt: now,
  });
  const homepagePapers = async (references: Record<string, unknown>) => {
    const config = { id: "elg", sections: [fakeSection(HomepageSectionKey.PREVIOUS_YEAR_PAPERS, 0, references)] } as unknown as HomepageConfig & {
      sections: HomepageSection[];
    };
    // Platform statistics use unstable_cache, which only exists inside Next; resolveHomepage
    // already catches that and hides the numbers, so mute its expected log line here.
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[homepage] statistics unavailable")) return;
      consoleError(...args);
    };
    const resolved = await resolveHomepage(config).finally(() => {
      console.error = consoleError;
    });
    return (resolved.sections[0]?.resolved.papers ?? []) as { id: string }[];
  };

  const subjectSelection = { examId: exam.id, subjectId: subject.id, count: 3, durationMinutes: 3, minutesPerQuestion: 1 };

  try {
    console.log("\n--- Helper ---");
    check("isExamLive(inactive exam) = false", (await isExamLive(exam.id)) === false);
    check("isExamLive(unknown id) = false", (await isExamLive("does-not-exist")) === false);
    check("isExamLive(null) = false", (await isExamLive(null)) === false);
    check("assertExamLive throws the standard message", (await refusal(() => assertExamLive(exam.id))) === EXAM_NOT_LIVE_MESSAGE);

    console.log("\n--- Inactive exam: every direct-id start is refused ---");
    const sid = await mkStudent("X1");
    check("PYQ start by paperId refused", (await refusal(() => startPreviousYearPaperAttempt(sid, paper.id))) === EXAM_NOT_LIVE_MESSAGE);
    check(
      "PYQ Pre-Test Setup preview refused",
      (await refusal(() => previewFormalTestStart(sid, { kind: "PREVIOUS_YEAR_PAPER", id: paper.id }))) === EXAM_NOT_LIVE_MESSAGE
    );
    check("Mock Test start by id refused", (await refusal(() => startMockTestAttempt(sid, mock.id))) === EXAM_NOT_LIVE_MESSAGE);
    check(
      "Mock Test Pre-Test Setup preview refused",
      (await refusal(() => previewFormalTestStart(sid, { kind: "MOCK_TEST", id: mock.id }))) === EXAM_NOT_LIVE_MESSAGE
    );
    check("Subject Test with forged examId refused", (await refusal(() => startSubjectTestAttempt(sid, subjectSelection))) === EXAM_NOT_LIVE_MESSAGE);
    check("Custom Module start by id refused", (await refusal(() => startCustomModuleAttempt(sid, adminModule.id))) === EXAM_NOT_LIVE_MESSAGE);
    check("Shared Custom Module start by token refused", (await refusal(() => startSharedCustomModuleAttempt(sid, shareToken))) === EXAM_NOT_LIVE_MESSAGE);
    check("No TestAttempt row was created for the inactive exam", (await prisma.testAttempt.count({ where: { examId: exam.id } })) === 0);

    console.log("\n--- Inactive exam: every direct-id read is empty ---");
    check("getPreviousYearPaperForStudent → null", (await getPreviousYearPaperForStudent(paper.id, sid)) === null);
    check("getDashboardPreviousYearPapers → []", (await getDashboardPreviousYearPapers(sid, exam.id)).length === 0);
    check("getMockTestDetailForStudent → null", (await getMockTestDetailForStudent(sid, mock.id)) === null);
    check("getCustomModuleDetailForStudent → null", (await getCustomModuleDetailForStudent(adminModule.id, sid)) === null);
    check("getCustomModuleByShareToken → null", (await getCustomModuleByShareToken(shareToken)) === null);
    check("Homepage PYQ section by explicit paperIds hides the paper", (await homepagePapers({ paperIds: [paper.id] })).length === 0);
    check("Homepage PYQ section by examId hides the paper", (await homepagePapers({ examId: exam.id })).length === 0);

    console.log("\n--- Control: the same calls work once the exam is active ---");
    await prisma.exam.update({ where: { id: exam.id }, data: { isActive: true } });
    check("isExamLive(active exam) = true", (await isExamLive(exam.id)) === true);
    check("getPreviousYearPaperForStudent → paper", (await getPreviousYearPaperForStudent(paper.id, sid))?.paper.id === paper.id);
    check("getDashboardPreviousYearPapers lists the paper", (await getDashboardPreviousYearPapers(sid, exam.id)).some((p) => p.id === paper.id));
    check("getMockTestDetailForStudent → mock", (await getMockTestDetailForStudent(sid, mock.id)) !== null);
    check("getCustomModuleDetailForStudent → module", (await getCustomModuleDetailForStudent(adminModule.id, sid)) !== null);
    check("getCustomModuleByShareToken → module", (await getCustomModuleByShareToken(shareToken))?.id === sharedModule.id);
    check("Homepage PYQ section by explicit paperIds shows the paper", (await homepagePapers({ paperIds: [paper.id] })).some((p) => p.id === paper.id));
    check("Homepage PYQ section by examId shows the paper", (await homepagePapers({ examId: exam.id })).some((p) => p.id === paper.id));

    const pyq = await startPreviousYearPaperAttempt(await mkStudent("A1"), paper.id);
    check("PYQ start works", pyq.sourceType === AttemptSourceType.PREVIOUS_YEAR_PAPER && pyq.totalQuestions === 6, pyq);
    const mockAttempt = await startMockTestAttempt(await mkStudent("A2"), mock.id);
    check("Mock Test start works", mockAttempt.sourceType === AttemptSourceType.MOCK_TEST, mockAttempt.sourceType);
    const subj = await startSubjectTestAttempt(await mkStudent("A3"), subjectSelection);
    check("Subject Test start works", subj.sourceType === AttemptSourceType.SUBJECT_TEST && subj.totalQuestions === 3, subj);
    const mod = await startCustomModuleAttempt(await mkStudent("A4"), adminModule.id);
    check("Custom Module start works", mod.sourceType === AttemptSourceType.CUSTOM_MODULE, mod.sourceType);
    const shared = await startSharedCustomModuleAttempt(await mkStudent("A5"), shareToken);
    check("Shared Custom Module start works", shared.customModuleId === sharedModule.id, shared.customModuleId);

    console.log("\n--- Deactivating the exam blocks resume-by-id of a running attempt ---");
    const rid = await mkStudent("R1");
    const running = await startPreviousYearPaperAttempt(rid, paper.id);
    check("Running attempt resumes while the exam is live", (await startPreviousYearPaperAttempt(rid, paper.id)).id === running.id);
    await prisma.exam.update({ where: { id: exam.id }, data: { isActive: false } });
    check("Resume by paperId refused after deactivation", (await refusal(() => startPreviousYearPaperAttempt(rid, paper.id))) === EXAM_NOT_LIVE_MESSAGE);
    check(
      "The running attempt itself is untouched (history is immutable)",
      (await prisma.testAttempt.findUnique({ where: { id: running.id }, select: { status: true } }))?.status === "IN_PROGRESS"
    );
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: students } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.customModule.deleteMany({ where: { examId: exam.id } });
    await prisma.mockTest.deleteMany({ where: { examId: exam.id } });
    await prisma.question.deleteMany({ where: { examId: exam.id } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: exam.id } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await deleteFixtureTaxonomy(prisma, [exam.id]);
    await prisma.exam.deleteMany({ where: { id: exam.id } });
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nALL EXAM-LIVE GATE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// HTTP-suite fixture (setup / cleanup)
// ---------------------------------------------------------------------------

const HTTP_PASSWORD = "ExamLiveGate!2345";

async function seedExam(label: string, suffix: string, isActive: boolean) {
  const exam = await prisma.exam.create({ data: { name: `ELG ${label} ${suffix}`, code: `ELG${label}-${suffix}`, isActive } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: `ELG ${label} Subject` });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: `ELG ${label} Topic` });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2026, title: `ELG ${label} Paper ${suffix}`, isActive: true } });
  const questionIds: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const q = await prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        previousYearPaperId: paper.id,
        source: QuestionSource.PYQ,
        examYear: 2026,
        code: `ELG${label}-${suffix}-${i}`,
        text: `Exam-live gate ${label} question ${i}?`,
        status: QuestionStatus.PUBLISHED,
        difficulty: QuestionDifficulty.MEDIUM,
        options: { create: ["A", "B", "C", "D"].map((l, order) => ({ label: l, text: l.toLowerCase(), isCorrect: l === "A", order })) },
      },
    });
    questionIds.push(q.id);
  }
  const mock = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `ELG ${label} Mock ${suffix}`,
      durationMinutes: 30,
      status: MockTestStatus.PUBLISHED,
      accessType: "FREE",
      questions: { create: questionIds.map((questionId, order) => ({ questionId, order })) },
    },
  });
  const module = await prisma.customModule.create({
    data: {
      examId: exam.id,
      title: `ELG ${label} Module ${suffix}`,
      selectionMode: "MANUAL",
      accessType: "FREE",
      status: CustomModuleStatus.PUBLISHED,
      shareToken: `elg-${label.toLowerCase()}-${suffix}`,
      questions: { create: questionIds.map((questionId, order) => ({ questionId, order })) },
    },
  });
  return { examId: exam.id, examName: exam.name, subjectId: subject.id, topicId: topic.id, paperId: paper.id, mockId: mock.id, moduleId: module.id, shareToken: module.shareToken };
}

async function setup() {
  const suffix = Date.now().toString(36);
  const inactive = await seedExam("Hidden", suffix, false);
  const control = await seedExam("Live", suffix, true);
  const student = await prisma.student.create({
    data: {
      studentId: await nextStudentId(),
      name: "ELG Student",
      email: `elg-http-${suffix}@example.test`,
      passwordHash: await argon2.hash(HTTP_PASSWORD),
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });
  await prisma.studentProfile.create({ data: { studentId: student.id } });
  await ensureDefaultExamEnrollmentSafely(student.id);
  console.log(JSON.stringify({ password: HTTP_PASSWORD, email: student.email, studentId: student.id, inactive, control }, null, 2));
  await prisma.$disconnect();
}

async function cleanup(fixturePath: string) {
  const F = JSON.parse(readFileSync(fixturePath, "utf8"));
  const examIds = [F.inactive.examId, F.control.examId];
  await prisma.studentActivity.deleteMany({ where: { studentId: F.studentId } });
  await prisma.testAttempt.deleteMany({ where: { OR: [{ studentId: F.studentId }, { examId: { in: examIds } }] } });
  await prisma.customModule.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.mockTest.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.question.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.previousYearPaper.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: F.studentId } });
  await prisma.studentSession.deleteMany({ where: { studentId: F.studentId } });
  await prisma.studentDevice.deleteMany({ where: { studentId: F.studentId } });
  await prisma.student.deleteMany({ where: { id: F.studentId } });
  await deleteFixtureTaxonomy(prisma, examIds);
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.$disconnect();
  console.log("cleaned up");
}

const mode = process.argv[2];
const run = mode === "setup" ? setup() : mode === "cleanup" ? cleanup(process.argv[3]) : main();
run.catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
