/**
 * Paper-level Previous Year Paper duration (PreviousYearPaper.durationMinutes).
 *
 * Checks that a NEW PYQ attempt freezes paper.durationMinutes ?? exam.durationMinutes ?? 120
 * for Standard Mode, that Practice / Per Question / Custom are unchanged, and that
 * changing the paper's duration later never rewrites an existing attempt.
 *
 * Run against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-pyq-duration.ts
 */
import "dotenv/config";
import { PrismaClient, AttemptSourceType, QuestionDifficulty, QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { previewFormalTestStart, startPreviousYearPaperAttempt } from "@/lib/test-attempt";
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

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `PYD Exam ${suffix}`, code: `PYD-${suffix}`, isActive: true } });
  const examWithDuration = await prisma.exam.create({ data: { name: `PYD Exam2 ${suffix}`, code: `PYD2-${suffix}`, isActive: true, durationMinutes: 90 } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "PYD Subject" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "PYD Topic" });
  const subject2 = await createFixtureSubject(prisma, { examId: examWithDuration.id, name: "PYD Subject2" });

  const mkPaper = (examId: string, title: string, durationMinutes: number | null) =>
    prisma.previousYearPaper.create({ data: { examId, year: 2024, title: `${title} ${suffix}`, durationMinutes } });
  const paper120 = await mkPaper(exam.id, "PYD 120", 120);
  const paperNull = await mkPaper(exam.id, "PYD null", null);
  const paperExamFallback = await mkPaper(examWithDuration.id, "PYD exam fallback", null);

  let n = 0;
  const addQuestions = async (paperId: string, examId: string, subjectId: string, topicId: string | null, count: number) => {
    for (let i = 0; i < count; i++) {
      n++;
      await prisma.question.create({
        data: {
          examId,
          subjectId,
          topicId,
          previousYearPaperId: paperId,
          source: QuestionSource.PYQ,
          code: `PYD-${suffix}-${n}`,
          text: `Duration question ${n}?`,
          status: QuestionStatus.PUBLISHED,
          difficulty: QuestionDifficulty.MEDIUM,
          options: {
            create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label.toLowerCase(), isCorrect: label === "B", order })),
          },
        },
      });
    }
  };
  await addQuestions(paper120.id, exam.id, subject.id, topic.id, 5);
  await addQuestions(paperNull.id, exam.id, subject.id, topic.id, 3);
  await addQuestions(paperExamFallback.id, examWithDuration.id, subject2.id, null, 3);

  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `PYD${tag}-${suffix}`, name: `PYD ${tag}`, email: `pyd-${tag.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };

  try {
    console.log("\n--- Standard Mode duration source ---");
    {
      const sid = await mkStudent("S1");
      const preview = await previewFormalTestStart(sid, { kind: "PREVIOUS_YEAR_PAPER", id: paper120.id });
      const standard = preview && "summary" in preview ? preview.summary?.standardMinutes : undefined;
      check("Pre-Test Setup shows paper duration (120)", standard === 120, preview);
      const a = await startPreviousYearPaperAttempt(sid, paper120.id, { durationMode: "FIXED", answerMode: "EXAM" });
      check("Standard attempt frozen at 120 (paper.durationMinutes)", a.durationMode === "FIXED" && a.durationMinutes === 120, a);
      check("Standard attempt is EXAM mode", a.answerMode === "EXAM");
      const default_ = await startPreviousYearPaperAttempt(await mkStudent("S1b"), paper120.id);
      check("No-config start (legacy path) also uses 120", default_.durationMinutes === 120, default_.durationMinutes);
    }
    {
      const a = await startPreviousYearPaperAttempt(await mkStudent("S2"), paperNull.id, { durationMode: "FIXED", answerMode: "EXAM" });
      check("Paper null + exam null → 120 (no 60 fallback)", a.durationMinutes === 120, a.durationMinutes);
      const b = await startPreviousYearPaperAttempt(await mkStudent("S3"), paperExamFallback.id, { durationMode: "FIXED", answerMode: "EXAM" });
      check("Paper null + exam 90 → 90", b.durationMinutes === 90, b.durationMinutes);
    }

    console.log("\n--- Other timing modes unchanged ---");
    {
      const p = await startPreviousYearPaperAttempt(await mkStudent("P1"), paper120.id, { durationMode: "FIXED", answerMode: "INSTANT" });
      check("Practice Mode → UNLIMITED, 0 minutes", p.answerMode === "INSTANT" && p.durationMode === "UNLIMITED" && p.durationMinutes === 0, p);
      const q = await startPreviousYearPaperAttempt(await mkStudent("Q1"), paper120.id, { durationMode: "PER_QUESTION", answerMode: "EXAM" });
      check("Per Question → 1 min × 5 questions", q.durationMode === "PER_QUESTION" && q.durationMinutes === 5, q);
      const c = await startPreviousYearPaperAttempt(await mkStudent("C1"), paper120.id, { durationMode: "CUSTOM", customMinutes: 45, answerMode: "EXAM" });
      check("Custom → 45 as chosen", c.durationMode === "CUSTOM" && c.durationMinutes === 45, c);
    }

    console.log("\n--- Changing the paper later affects NEW attempts only ---");
    {
      const sid = await mkStudent("H1");
      const old = await startPreviousYearPaperAttempt(sid, paper120.id, { durationMode: "FIXED", answerMode: "EXAM" });
      const before = await prisma.testAttempt.findMany({ where: { previousYearPaperId: paper120.id }, orderBy: { id: "asc" } });
      await prisma.previousYearPaper.update({ where: { id: paper120.id }, data: { durationMinutes: 75 } });
      const after = await prisma.testAttempt.findMany({ where: { previousYearPaperId: paper120.id }, orderBy: { id: "asc" } });
      check("Existing attempts untouched by a paper duration change", JSON.stringify(before) === JSON.stringify(after));
      const resumed = await startPreviousYearPaperAttempt(sid, paper120.id, { durationMode: "FIXED", answerMode: "EXAM" });
      check("Resuming an in-progress attempt keeps its 120", resumed.id === old.id && resumed.durationMinutes === 120, resumed);
      const fresh = await startPreviousYearPaperAttempt(await mkStudent("H2"), paper120.id, { durationMode: "FIXED", answerMode: "EXAM" });
      check("A NEW attempt picks up 75", fresh.durationMinutes === 75 && fresh.sourceType === AttemptSourceType.PREVIOUS_YEAR_PAPER, fresh);
    }
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: students } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.question.deleteMany({ where: { examId: { in: [exam.id, examWithDuration.id] } } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: { in: [exam.id, examWithDuration.id] } } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await deleteFixtureTaxonomy(prisma, [exam.id, examWithDuration.id]);
    await prisma.exam.deleteMany({ where: { id: { in: [exam.id, examWithDuration.id] } } });
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nALL PYQ DURATION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
