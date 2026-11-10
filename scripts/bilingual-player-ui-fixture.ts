/**
 * Fixture for scripts/verify-bilingual-player-ui.mjs — DISPOSABLE database only.
 *   setup              → a BILINGUAL exam (PYQ paper, 3 questions: plain, formula, plain) and an ENGLISH exam (PYQ, 2
 *                        questions); students: MAIN (bilingual attempt started), SETUP (no attempt: pre-test setup),
 *                        EN (English attempt started); prints JSON.
 *   answers <attemptId> → prints the Answer rows of an attempt (count per attempt-question, labels, statuses).
 *   cleanup <json file> → deletes everything setup created.
 *   NODE_OPTIONS="--conditions=react-server" AUTH_SECRET=<scratch> npx tsx scripts/bilingual-player-ui-fixture.ts setup
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaClient, QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encode } from "next-auth/jwt";
import { startPreviousYearPaperAttempt } from "@/lib/test-attempt";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const mintToken = (s: { id: string; studentId: string; name: string; email: string | null }) =>
  encode({ token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email }, secret: process.env.AUTH_SECRET!, salt: "student-session-token" });

async function setup() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `BI UI Exam ${suffix}`, code: `BIUI-${suffix}`, isActive: true, languageMode: "BILINGUAL" } });
  const enExam = await prisma.exam.create({ data: { name: `EN UI Exam ${suffix}`, code: `ENUI-${suffix}`, isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "BI UI Subject" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "BI UI Topic" });
  const enSubject = await createFixtureSubject(prisma, { examId: enExam.id, name: "EN UI Subject" });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2022, title: `BI UI Paper ${suffix}`, heldOn: new Date("2023-06-27") } });
  const enPaper = await prisma.previousYearPaper.create({ data: { examId: enExam.id, year: 2024, title: `EN UI Paper ${suffix}` } });
  const Q = [
    { en: "Example of Gel is", hi: "जैल का उदाहरण है", opts: [["Smoke", "धुआँ"], ["Fog", "कोहरा"], ["Milk", "दूध"], ["Butter", "मक्खन"]], correct: "B", rich: false },
    { en: "If $Y = 7.284 + 0.929X$, then $b_{YX}$ is", hi: "यदि $Y = 7.284 + 0.929X$, तो $b_{YX}$ बराबर होगा", opts: [["$7.284$", "$7.284$"], ["$8.213$", "$8.213$"], ["$6.355$", "$6.355$"], ["$0.929$", "$0.929$"]], correct: "D", rich: true },
    { en: "Aflatoxin is produced by", hi: "एफ्लाटॉक्सिन उत्पन्न की जाती है", opts: [["Aspergillus species", "एस्परजिलस जाति द्वारा"], ["Salmonella species", "साल्मोनेला जाति द्वारा"], ["Fusarium species", "फ्यूजेरियम जाति द्वारा"], ["Streptococcal species", "स्ट्रेप्टोकोकल जाति द्वारा"]], correct: "A", rich: false },
  ];
  for (const [i, q] of Q.entries())
    await prisma.question.create({
      data: {
        examId: exam.id, subjectId: subject.id, topicId: topic.id, code: `BIUI-${suffix}-${i + 1}`, text: q.en, textHi: q.hi, status: QuestionStatus.PUBLISHED, source: QuestionSource.PYQ,
        previousYearPaperId: paper.id, paperQuestionNumber: i + 1, contentFormat: q.rich ? "RICH_V1" : "PLAIN",
        options: { create: q.opts.map(([en, hi], k) => ({ label: "ABCD"[k], text: en, textHi: hi, isCorrect: "ABCD"[k] === q.correct, order: k })) },
      },
    });
  for (let i = 1; i <= 2; i++)
    await prisma.question.create({
      data: { examId: enExam.id, subjectId: enSubject.id, code: `ENUI-${suffix}-${i}`, text: `English-only question ${i}`, status: QuestionStatus.PUBLISHED, source: QuestionSource.PYQ, previousYearPaperId: enPaper.id, paperQuestionNumber: i, options: { create: ["a", "b", "c", "d"].map((t, k) => ({ label: "ABCD"[k], text: `${t}${i}`, isCorrect: k === 0, order: k })) } },
    });
  const mk = async (tag: string) => {
    const s = await prisma.student.create({ data: { studentId: `BIUI${tag}-${suffix}`, name: `BI UI ${tag}`, email: `biui-${tag.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
    return { ...s, token: await mintToken(s) };
  };
  const main = await mk("MAIN");
  const setupStudent = await mk("SETUP");
  const en = await mk("EN");
  const attempt = await startPreviousYearPaperAttempt(main.id, paper.id);
  const enAttempt = await startPreviousYearPaperAttempt(en.id, enPaper.id);
  console.log(JSON.stringify({ examIds: [exam.id, enExam.id], studentIds: [main.id, setupStudent.id, en.id], paperId: paper.id, enPaperId: enPaper.id, token: main.token, setupToken: setupStudent.token, enToken: en.token, attemptId: attempt.id, enAttemptId: enAttempt.id }));
}

async function answers(attemptId: string) {
  const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId }, orderBy: { order: "asc" }, select: { id: true, order: true } });
  const all = await prisma.answer.findMany({ where: { attemptQuestionId: { in: rows.map((r) => r.id) } } });
  console.log(JSON.stringify(rows.map((r) => {
    const a = all.filter((x) => x.attemptQuestionId === r.id);
    return { order: r.order, answers: a.length, label: a[0]?.selectedOptionLabel ?? null, status: a[0]?.status ?? null };
  })));
}

async function cleanup(file: string) {
  const F = JSON.parse(readFileSync(file, "utf8")) as { examIds: string[]; studentIds: string[] };
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: F.studentIds } } });
  await prisma.question.deleteMany({ where: { examId: { in: F.examIds } } });
  await prisma.previousYearPaper.deleteMany({ where: { examId: { in: F.examIds } } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: F.studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: F.studentIds } } });
  await deleteFixtureTaxonomy(prisma, F.examIds);
  await prisma.exam.deleteMany({ where: { id: { in: F.examIds } } });
  console.log("cleaned");
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "answers" ? answers(arg) : cmd === "cleanup" ? cleanup(arg) : Promise.reject(new Error("usage: setup | answers <attemptId> | cleanup <fixture.json>")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
