/**
 * Fixture for scripts/verify-practice-exclusion-ui.mjs — DISPOSABLE scratch database only.
 *   setup  → exam + subject + topic, 8 published questions (one with images), a teacher-owned DRAFT, a MASTER_ADMIN and a
 *            TEACHER (random passwords), and a student Subject Test attempt started BEFORE any flag change; prints JSON.
 *   state <fixture.json> → flags + reasons, practice-picker counts (the same server functions the pickers render),
 *            bulk audit-log rows, and a fingerprint of everything that must NOT change (question text, options, answers,
 *            images, attempt snapshots, answers saved).
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/practice-exclusion-ui-fixture.ts setup
 */
import "dotenv/config";
import crypto, { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import argon2 from "argon2";
import { QuestionDifficulty, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { startSubjectTestAttempt } from "@/lib/test-attempt";
import { countPublishedQuestions, distinctYears } from "@/lib/question-selection";
import { getExamSubjectsOverview } from "@/lib/student-data";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "") || /mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: scratch mts_* database only.");
  process.exit(2);
}

async function setup() {
  const sfx = Date.now().toString(36);
  const role = (name: "MASTER_ADMIN" | "TEACHER") => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const exam = await prisma.exam.create({ data: { name: `PXUI Exam ${sfx}`, code: `PXUI${sfx}`.toUpperCase(), isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: `PXUI Current Events ${sfx}` });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: `PXUI Events ${sfx}` });
  const qs = [];
  for (let n = 1; n <= 8; n++) {
    qs.push(
      await prisma.question.create({
        data: {
          code: `PXUI-${sfx}-${n}`, examId: exam.id, subjectId: subject.id, topicId: topic.id, examYear: n <= 4 ? 2019 : 2024, text: `PXUI question ${n}: which event happened?`, status: QuestionStatus.PUBLISHED, difficulty: QuestionDifficulty.MEDIUM,
          ...(n === 1 ? { imageUrl: "/uploads/pxui/stem.png" } : {}),
          options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${label} ${n}`, isCorrect: label === "C", order, ...(n === 1 && label === "B" ? { imageUrl: "/uploads/pxui/opt-b.png" } : {}) })) },
        },
      })
    );
  }
  const accounts: Record<string, { username: string; password: string; id: string }> = {};
  for (const [key, r] of [["master", "MASTER_ADMIN"], ["teacher", "TEACHER"]] as const) {
    const password = randomBytes(12).toString("base64url");
    const u = await prisma.adminUser.create({ data: { name: `PXUI ${key}`, username: `pxui-${key}-${sfx}`, passwordHash: await argon2.hash(password), roleId: (await role(r)).id } });
    if (r === "TEACHER") {
      await prisma.teacherProfile.create({ data: { adminUserId: u.id } });
      await prisma.teacherExamAssignment.create({ data: { teacherId: u.id, examId: exam.id } });
    }
    accounts[key] = { username: u.username, password, id: u.id };
  }
  const draft = await prisma.question.create({
    data: { code: `PXUI-${sfx}-T1`, examId: exam.id, subjectId: subject.id, text: `PXUI teacher draft ${sfx}`, status: QuestionStatus.DRAFT, difficulty: QuestionDifficulty.EASY, createdByAdminId: accounts.teacher.id, options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `t${label}`, isCorrect: label === "A", order })) } },
  });
  const student = await prisma.student.create({ data: { studentId: `PXUI-${sfx}`, name: "PXUI Student", email: `pxui-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  const attempt = await startSubjectTestAttempt(student.id, { examId: exam.id, subjectId: subject.id, count: 8, durationMinutes: 0, minutesPerQuestion: 1 });
  console.log(JSON.stringify({ sfx, examId: exam.id, subjectId: subject.id, topicId: topic.id, questions: qs.map((q) => ({ id: q.id, code: q.code })), draftId: draft.id, attemptId: attempt.id, accounts }, null, 1));
}

async function state(file: string) {
  const F = JSON.parse(readFileSync(file, "utf8"));
  const ids = [...F.questions.map((q: { id: string }) => q.id), F.draftId];
  const rows = await prisma.question.findMany({ where: { id: { in: ids } }, include: { options: { orderBy: { label: "asc" } }, assets: true }, orderBy: { code: "asc" } });
  // Published fixture questions only: the teacher's draft is edited on purpose by the test (its save must really run).
  const content = rows.filter((q) => q.id !== F.draftId).map((q) => ({ code: q.code, text: q.text, textHi: q.textHi, imageUrl: q.imageUrl, status: q.status, examYear: q.examYear, source: q.source, paper: q.previousYearPaperId, subject: q.subjectId, topic: q.topicId, type: q.questionType, assets: q.assets.map((a) => a.storageKey).sort(), options: q.options.map((o) => [o.label, o.text, o.isCorrect, o.imageUrl]) }));
  const tq = await prisma.testAttemptQuestion.findMany({ where: { attemptId: F.attemptId }, orderBy: { order: "asc" } });
  const answers = await prisma.answer.findMany({ where: { attemptId: F.attemptId }, orderBy: { id: "asc" } });
  const attemptPart = { questions: tq.map((t) => [t.questionId, t.order, t.questionSnapshot]), answers: answers.map((a) => [a.questionId, a.status, a.selectedOptionLabel, a.selectedLabels]) };
  const hash = (x: unknown) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
  const audit = await prisma.auditLog.findMany({ where: { action: "QUESTION_BULK_SET_EXCLUDE_FROM_PRACTICE" }, orderBy: { createdAt: "asc" }, select: { actorId: true, metadata: true, createdAt: true } });
  console.log(JSON.stringify({
    flags: Object.fromEntries(rows.map((q) => [q.id, { excluded: q.excludeFromPractice, reason: q.excludeFromPracticeReason }])),
    draftText: rows.find((q) => q.id === F.draftId)?.text ?? null,
    counts: { pool: await countPublishedQuestions({ examId: F.examId, subjectId: F.subjectId }), subjectOverview: (await getExamSubjectsOverview(F.examId)).find((s) => s.id === F.subjectId)?.questionCount ?? null, years: await distinctYears({ examId: F.examId, subjectId: F.subjectId }) },
    // This fixture's bulk operations only (a scratch DB may hold rows of earlier runs).
    audit: audit.filter((a) => ((a.metadata as { ids?: string[] } | null)?.ids ?? []).some((id) => ids.includes(id))).map((a) => ({ actorId: a.actorId, metadata: a.metadata })),
    fingerprint: { content: hash(content), attempt: hash(attemptPart), attemptQuestions: tq.length },
  }));
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "state" ? state(arg) : Promise.reject(new Error("usage: setup | state <fixture.json>")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
