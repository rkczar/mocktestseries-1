/**
 * Fixture for scripts/verify-fso-reconcile-ui.mjs — DISPOSABLE database only. Synthetic content, no AI, no network.
 *   setup → BILINGUAL exam + PYQ paper Q1..Q4 (Q2 WITHDRAWN); student RUN (attempt started), student DONE (attempt
 *           answered and submitted, for the review page); an importer job with a bilingual-mismatch question (Q5) and a
 *           key-withdrawn question (Q6) for the admin page; MASTER_ADMIN and FULL_ADMIN logins. Prints JSON.
 *   NODE_OPTIONS="--conditions=react-server" AUTH_SECRET=<scratch> npx tsx scripts/fso-reconcile-ui-fixture.ts setup
 */
import "dotenv/config";
import argon2 from "argon2";
import { encode } from "next-auth/jwt";
import { QuestionSource, QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveAnswer, startPreviousYearPaperAttempt, submitAttempt } from "@/lib/test-attempt";
import { createFixtureSubject } from "./fixture-taxonomy";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}
const mintToken = (s: { id: string; studentId: string; name: string; email: string | null }) =>
  encode({ token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email }, secret: process.env.AUTH_SECRET!, salt: "student-session-token" });

async function setup() {
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `FSO UI ${sfx}`, code: `FSOUI-${sfx}`, isActive: true, languageMode: "BILINGUAL" } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: `FSO UI Subject ${sfx}` });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2022, title: `FSO UI Paper ${sfx}` } });
  const Q = [
    { en: "Example of Gel is", hi: "जैल का उदाहरण है", status: QuestionStatus.PUBLISHED },
    { en: "WITHDRAWN-ORIGINAL question text as printed", hi: "वापस लिया गया मूल प्रश्न", status: QuestionStatus.WITHDRAWN },
    { en: "Aflatoxin is produced by", hi: "एफ्लाटॉक्सिन उत्पन्न की जाती है", status: QuestionStatus.PUBLISHED },
    { en: "Milk is an example of", hi: "दूध उदाहरण है", status: QuestionStatus.PUBLISHED },
  ];
  for (const [i, q] of Q.entries())
    await prisma.question.create({
      data: {
        examId: exam.id, subjectId: subject.id, code: `FSOUI-${sfx}-${i + 1}`, text: q.en, textHi: q.hi, status: q.status, source: QuestionSource.PYQ, examYear: 2022,
        previousYearPaperId: paper.id, paperQuestionNumber: i + 1,
        options: { create: ["Alpha", "Beta", "Gamma", "Delta"].map((t, k) => ({ label: "ABCD"[k], text: `${t} ${i + 1}`, textHi: `हिंदी ${t} ${i + 1}`, isCorrect: q.status === QuestionStatus.PUBLISHED && k === 1, order: k })) },
      },
    });
  const student = async (tag: string) => {
    const s = await prisma.student.create({ data: { studentId: `FSOUI${tag}-${sfx}`, name: `FSO UI ${tag}`, email: `fsoui-${tag.toLowerCase()}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
    return { ...s, token: await mintToken(s) };
  };
  const run = await student("RUN");
  const done = await student("DONE");
  const runAttempt = await startPreviousYearPaperAttempt(run.id, paper.id);
  const doneAttempt = await startPreviousYearPaperAttempt(done.id, paper.id);
  const tqs = await prisma.testAttemptQuestion.findMany({ where: { attemptId: doneAttempt.id }, orderBy: { order: "asc" } });
  let seq = 1;
  for (const t of tqs) if (!(t.questionSnapshot as { withdrawn?: boolean }).withdrawn) await saveAnswer(doneAttempt.id, done.id, t.questionId, "B", false, seq++);
  await submitAttempt(doneAttempt.id, done.id);

  const password = `Scratch-${sfx}-Pw!`;
  const role = async (name: string) => prisma.role.findFirstOrThrow({ where: { name: name as never } });
  const master = await prisma.adminUser.create({ data: { name: "FSO UI Master", username: `fsoui-master-${sfx}`, passwordHash: await argon2.hash(password), roleId: (await role("MASTER_ADMIN")).id } });
  const full = await prisma.adminUser.create({ data: { name: "FSO UI Full", username: `fsoui-full-${sfx}`, passwordHash: await argon2.hash(password), roleId: (await role("FULL_ADMIN")).id } });
  const job = await prisma.aiImportJob.create({ data: { title: `FSO UI import ${sfx}`, status: "NEEDS_REVIEW", examId: exam.id, year: 2022, previousYearPaperId: paper.id, expectedQuestions: 8, createdById: master.id, budgetInr: 0 } });
  const file = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "paper.pdf", ext: "pdf", declaredBytes: 1, uploadedById: master.id, status: "PROCESSED", pageCount: 2 } });
  const opts = (p: string) => ["One", "Two", "Three", "Four"].map((t, k) => ({ label: "ABCD"[k], printed: `(${k + 1})`, text: `${p}${t}` }));
  const checks = { at: new Date().toISOString(), content: { status: "FAILED", required: true, detail: "Hindi and English versions do not match" }, answer: { status: "PASSED", required: true, detail: "" }, taxonomy: { status: "PASSED", required: true, detail: "" }, independent: { status: "PASSED", required: true, detail: "" } };
  const data = (n: number, en: string, hi: string) => ({ section: "", number: n, label: String(n), pages: [2], type: "SINGLE_CORRECT", stem: en, options: opts(""), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "AI_VISION", checks, hi: { stem: hi, options: opts("हिं "), confidence: 0.95, unreadable: [], sameOptionOrder: true, figuresDiffer: false } }) as unknown as Prisma.InputJsonValue;
  const mis = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: file.id, sourceKey: "#5", sourceNumber: 5, sourceLabel: "5", pages: [2], orderIndex: 5, status: "NEEDS_CORRECTION", issueCodes: ["BILINGUAL_MISMATCH"], data: data(5, `FORCE-UI stem ${sfx}`, `फोर्स यूआई ${sfx}`), questionType: "SINGLE_CORRECT", optionCount: 4, subjectId: subject.id, answerStatus: "OFFICIAL_MATCHED", officialAnswer: ["C"], finalAnswer: ["C"] } });
  const wd = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: file.id, sourceKey: "#6", sourceNumber: 6, sourceLabel: "6", pages: [2], orderIndex: 6, status: "NEEDS_CORRECTION", issueCodes: ["POSSIBLE_WITHDRAWN"], data: data(6, `WITHDRAWN-UI stem ${sfx}`, `वापस यूआई ${sfx}`), questionType: "SINGLE_CORRECT", optionCount: 4, subjectId: subject.id, answerStatus: "WITHDRAWN", officialAnswerRaw: "*" } });
  console.log(JSON.stringify({ sfx, examId: exam.id, paperId: paper.id, runToken: run.token, runAttemptId: runAttempt.id, doneToken: done.token, doneAttemptId: doneAttempt.id, jobId: job.id, misId: mis.id, wdId: wd.id, master: { username: master.username, password }, full: { username: full.username, password } }));
}

if (process.argv[2] === "setup") setup().finally(() => prisma.$disconnect());
else {
  console.error("usage: setup");
  process.exit(2);
}
