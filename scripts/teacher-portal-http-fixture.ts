/**
 * Synthetic fixture for scripts/verify-teacher-portal-http.mjs (Teacher Portal Phase A).
 *   DATABASE_URL=<scratch mts_*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/teacher-portal-http-fixture.ts setup > /tmp/tp.json
 * Creates two exams, questions, mock tests and the accounts: an active teacher
 * (exam A), a teacher of exam B, a FULL_ADMIN viewer and a MASTER_ADMIN.
 * Passwords are random per run and only written to the fixture JSON.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { createFixtureSubject } from "./fixture-taxonomy";

async function main() {
  const db = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "").split("/").pop() ?? "";
  if (!/^mts_/.test(db)) throw new Error("Refusing to run outside a scratch mts_* database.");
  const sfx = Date.now().toString(36);
  const role = (name: "MASTER_ADMIN" | "FULL_ADMIN" | "TEACHER") => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const accounts: Record<string, { username: string; password: string; id: string }> = {};
  const mkUser = async (key: string, r: "MASTER_ADMIN" | "FULL_ADMIN" | "TEACHER", teacherExam?: string) => {
    const password = randomBytes(12).toString("base64url");
    const u = await prisma.adminUser.create({ data: { name: `TPH ${key}`, username: `tph-${key}-${sfx}`, passwordHash: await argon2.hash(password), roleId: (await role(r)).id } });
    if (r === "TEACHER") {
      await prisma.teacherProfile.create({ data: { adminUserId: u.id } });
      if (teacherExam) await prisma.teacherExamAssignment.create({ data: { teacherId: u.id, examId: teacherExam } });
    }
    accounts[key] = { username: u.username, password, id: u.id };
  };
  const examA = await prisma.exam.create({ data: { name: `TPH Exam A ${sfx}`, code: `TPHA${sfx}`.toUpperCase(), isActive: true } });
  const examB = await prisma.exam.create({ data: { name: `TPH Exam B ${sfx}`, code: `TPHB${sfx}`.toUpperCase(), isActive: true } });
  const subjA = await createFixtureSubject(prisma, { examId: examA.id, name: `TPH Subj A ${sfx}` });
  const subjB = await createFixtureSubject(prisma, { examId: examB.id, name: `TPH Subj B ${sfx}` });
  const mkQ = (examId: string, subjectId: string, n: number) =>
    prisma.question.create({
      data: { code: `TPH-${sfx}-${examId === examA.id ? "A" : "B"}${n}`, examId, subjectId, text: `TPH question ${n} of ${examId === examA.id ? "A" : "B"}`, status: "PUBLISHED", options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${label}${n}`, isCorrect: label === "A", order })) } },
    });
  const qa = [await mkQ(examA.id, subjA.id, 1), await mkQ(examA.id, subjA.id, 2), await mkQ(examA.id, subjA.id, 3)];
  const qb = [await mkQ(examB.id, subjB.id, 1), await mkQ(examB.id, subjB.id, 2)];
  const mockA = await prisma.mockTest.create({ data: { examId: examA.id, title: `TPH Mock A ${sfx}`, durationMinutes: 30, status: "PUBLISHED", questions: { create: qa.map((q, order) => ({ questionId: q.id, order })) } } });
  const mockB = await prisma.mockTest.create({ data: { examId: examB.id, title: `TPH Mock B ${sfx}`, durationMinutes: 30, status: "PUBLISHED", questions: { create: qb.map((q, order) => ({ questionId: q.id, order })) } } });
  const grandA = await prisma.grandTest.create({ data: { examId: examA.id, title: `TPH Grand A ${sfx}`, durationMinutes: 30, questionCount: 1, status: "PUBLISHED", questions: { create: [{ questionId: qa[1].id, order: 0 }] } } });
  const liveA = await prisma.mockTest.create({ data: { examId: examA.id, title: `TPH Live CBT A ${sfx}`, durationMinutes: 30, status: "PUBLISHED", enrollmentEnabled: true, questions: { create: [{ questionId: qa[2].id, order: 0 }, { questionId: qa[0].id, order: 1 }] } } });
  await mkUser("teacher", "TEACHER", examA.id);
  await mkUser("teacherB", "TEACHER", examB.id);
  await mkUser("full", "FULL_ADMIN");
  await mkUser("master", "MASTER_ADMIN");
  console.log(JSON.stringify({ sfx, examA: examA.id, examB: examB.id, subjA: subjA.id, qa: qa.map((q) => q.id), qb: qb.map((q) => q.id), mockA: mockA.id, mockB: mockB.id, grandA: grandA.id, liveA: liveA.id, accounts }, null, 1));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
