/**
 * Fixture for scripts/verify-ai-import-ui.mjs (scratch DB only): a FULL_ADMIN
 * (view-only) account, a student, and a synthetic RUHS MO previous-year paper
 * the UI import links to, so a student can open the imported questions in the
 * real test player.
 *
 *   npx tsx scripts/ai-import-ui-fixture.ts setup > /tmp/aiui.json
 *   npx tsx scripts/ai-import-ui-fixture.ts attempt /tmp/aiui.json   (after the UI publishes questions)
 *   npx tsx scripts/ai-import-ui-fixture.ts cleanup /tmp/aiui.json
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { startPreviousYearPaperAttempt } from "@/lib/test-attempt";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

async function setup() {
  const argon2 = (await import("argon2")).default;
  const suffix = Date.now().toString(36);
  const password = `Aiui-${suffix}-Pass!`;
  const hash = await argon2.hash(password);
  const role = await prisma.role.findFirstOrThrow({ where: { name: "FULL_ADMIN" } });
  const full = await prisma.adminUser.create({ data: { name: "AIUI Full Admin", username: `aiui-full-${suffix}`, email: `aiui-full-${suffix}@example.test`, passwordHash: hash, roleId: role.id } });
  const ruhs = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: ruhs.id, year: 2024, title: `SYNTHETIC RUHS 2024 AIUI ${suffix}`, paperCode: `AIUI-${suffix}`, isActive: true } });
  // A second paper for the Importer 2.0 browser suite (its own question numbers).
  const paper2 = await prisma.previousYearPaper.create({ data: { examId: ruhs.id, year: 2022, title: `SYNTHETIC RUHS 2022 AIUI ${suffix}`, isActive: true } });
  const { nextStudentId } = await import("@/lib/student-id");
  const st = await prisma.student.create({ data: { studentId: await nextStudentId(), name: "AIUI Student", email: `aiui-student-${suffix}@example.test`, passwordHash: hash, authProvider: StudentAuthProvider.CREDENTIALS, mobileVerifiedAt: new Date(), emailVerifiedAt: new Date() } });
  await prisma.studentExamEnrollment.create({ data: { studentId: st.id, examId: ruhs.id } }).catch(() => undefined);
  // OpenRouter → the local mock (OPENROUTER_TEST_BASE_URL); the mock models are approved by the server suite's catalog sync.
  const { saveOpenRouterKey, setOpenRouterEnabled } = await import("@/lib/ai-engine/settings");
  const { testOpenRouterConnection } = await import("@/lib/ai-engine/manage");
  const { syncCatalog } = await import("@/lib/ai-engine/catalog");
  await saveOpenRouterKey(`sk-or-v1-mock${"u".repeat(40)}-valid`, "script");
  await testOpenRouterConnection();
  await setOpenRouterEnabled(true);
  await syncCatalog();
  await prisma.aiModel.updateMany({ where: { id: { startsWith: "mock" } }, data: { approved: true } });
  console.log(JSON.stringify({ suffix, password, fullAdmin: full.username, fullAdminId: full.id, paperId: paper.id, paperTitle: paper.title, paper2Id: paper2.id, paper2Title: paper2.title, examId: ruhs.id, student: { id: st.id, email: st.email } }, null, 2));
}

async function attempt(file: string) {
  const F = JSON.parse(readFileSync(file, "utf8"));
  const a = await startPreviousYearPaperAttempt(F.student.id, F.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  F.attemptId = a.id;
  F.attemptQuestions = await prisma.testAttemptQuestion.count({ where: { attemptId: a.id } });
  writeFileSync(file, JSON.stringify(F, null, 2));
  console.log(JSON.stringify({ attemptId: a.id, questions: F.attemptQuestions }));
}

async function cleanup(file: string) {
  const F = JSON.parse(readFileSync(file, "utf8"));
  await prisma.answer.deleteMany({ where: { attempt: { studentId: F.student.id } } });
  await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: F.student.id } } });
  await prisma.testAttempt.deleteMany({ where: { studentId: F.student.id } });
  for (const t of ["StudentDevice", "StudentSession", "StudentExamEnrollment", "SavedQuestion", "StudentLoginAttempt"]) await prisma.$executeRawUnsafe(`delete from "${t}" where "studentId" = $1`, F.student.id).catch(() => undefined);
  await prisma.student.deleteMany({ where: { id: F.student.id } });
  const jobs = await prisma.aiImportJob.findMany({ where: { title: { startsWith: "AIUI " } }, select: { id: true } });
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId: { in: jobs.map((j) => j.id) }, questionId: { not: null } }, select: { questionId: true, bulkImportRunId: true } });
  const runs = [...new Set(qs.map((q) => q.bulkImportRunId).filter((x): x is string => !!x))];
  const extra = await prisma.question.findMany({ where: { OR: [{ previousYearPaperId: { in: [F.paperId, F.paper2Id].filter(Boolean) } }, { code: { startsWith: "AIUI-" } }] }, select: { id: true } });
  const ids = [...new Set([...qs.map((q) => q.questionId!), ...extra.map((x) => x.id)])];
  await prisma.questionAsset.deleteMany({ where: { questionId: { in: ids } } });
  await prisma.questionOption.deleteMany({ where: { questionId: { in: ids } } });
  await prisma.question.deleteMany({ where: { id: { in: ids } } });
  const bundles = (await prisma.bulkImportRun.findMany({ where: { id: { in: runs } }, select: { bundleId: true } })).map((r) => r.bundleId).filter((x): x is string => !!x);
  await prisma.bulkImportRow.deleteMany({ where: { runId: { in: runs } } });
  await prisma.bulkImportRun.deleteMany({ where: { id: { in: runs } } });
  await prisma.importBundle.deleteMany({ where: { id: { in: bundles } } });
  await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  await prisma.previousYearPaper.delete({ where: { id: F.paperId } }).catch(() => undefined);
  if (F.paper2Id) await prisma.previousYearPaper.delete({ where: { id: F.paper2Id } }).catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { actorId: F.fullAdminId } });
  await prisma.adminUser.delete({ where: { id: F.fullAdminId } }).catch(() => undefined);
  await prisma.setting.deleteMany({ where: { key: { in: ["api.openrouter", "ai.importer"] } } });
  await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
  console.log("cleaned");
}

const [cmd, file] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "attempt" ? attempt(file) : cmd === "cleanup" ? cleanup(file) : Promise.reject(new Error("usage: setup | attempt <file> | cleanup <file>")))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
