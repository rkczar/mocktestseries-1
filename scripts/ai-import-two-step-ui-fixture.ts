/**
 * Synthetic fixture for scripts/verify-importer-two-step-ui.mjs (scratch DB only): one finished import with a clean,
 * a system-issue and a genuine-problem question, automatic checks held at Verify 2, statuses from older rules.
 *   DATABASE_URL=<mts_twostep*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/ai-import-two-step-ui-fixture.ts > fixture.json
 */
import { AiImportJobStatus, AiImportPaperType, type Prisma } from "@prisma/client";

if (!/\/mts_twostep[a-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a mts_twostep* scratch database.");
  process.exit(2);
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { IMPORTER_SETTING_KEY, normalizeImporterSettings } = await import("@/lib/ai-import/config");
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { username: "admin" }, select: { id: true } });
  // A topic of the synthetic taxonomy (scripts/ai-import-synthetic-taxonomy.ts): a clean question must be publishable.
  const link = await prisma.examSubject.findFirstOrThrow({ where: { isActive: true, subject: { topics: { some: {} } } }, select: { examId: true, subjectId: true } });
  const topic = await prisma.topic.findFirstOrThrow({ where: { subjectId: link.subjectId }, select: { id: true, subjectId: true } });
  const exam = { id: link.examId };
  await prisma.aiImportJob.deleteMany({ where: { title: "Two-step UI fixture" } });
  const row = await prisma.setting.findUnique({ where: { key: IMPORTER_SETTING_KEY } });
  const settings = normalizeImporterSettings({ ...((row?.value as object) ?? {}), aiEnabled: false });
  await prisma.setting.upsert({ where: { key: IMPORTER_SETTING_KEY }, update: { value: settings as unknown as Prisma.InputJsonValue }, create: { key: IMPORTER_SETTING_KEY, value: settings as unknown as Prisma.InputJsonValue } });
  const job = await prisma.aiImportJob.create({
    data: {
      title: "Two-step UI fixture",
      status: AiImportJobStatus.NEEDS_REVIEW,
      examId: exam.id,
      paperType: AiImportPaperType.FULL_PAPER,
      createdById: admin.id,
      budgetInr: 0,
      spentInr: 0,
      spentUsd: 0,
      finishedAt: new Date(),
      config: { ...settings, autoVerify: { enabled: true, actorId: admin.id, step: "verify2", held: "paid AI is switched off in Import Settings.", updatedAt: new Date().toISOString() } } as unknown as Prisma.InputJsonValue,
    },
  });
  const q = (n: number, answer: string) => ({ section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem: `Synthetic question ${n}: which enzyme converts angiotensin I into angiotensin II in the pulmonary circulation of adults?`, options: ["A", "B", "C", "D"].map((l) => ({ label: l, printed: `(${l.toLowerCase()})`, text: `${["Renin", "Angiotensin converting enzyme", "Aldosterone synthase", "Chymase"][["A", "B", "C", "D"].indexOf(l)]} variant ${n}` })), printedAnswer: [answer], contentFormat: "PLAIN", confidence: 0.99, unreadable: [], figures: [] });
  const base = { jobId: job.id, fileId: `ui-${job.id}`, pages: [1], questionType: "SINGLE_CORRECT", optionCount: 4, contentFormat: "PLAIN" };
  const rows = [
    { ...base, sourceKey: "q1", sourceLabel: "1", orderIndex: 0, status: "READY", issueCodes: [], data: q(1, "B"), answerStatus: "OFFICIAL_MATCHED", officialAnswer: ["B"], finalAnswer: ["B"], subjectId: topic.subjectId, topicId: topic.id, taxonomySource: "admin", taxonomyConfidence: 1, answerConfirmedById: admin.id },
    { ...base, sourceKey: "q2", sourceLabel: "2", orderIndex: 1, status: "NEEDS_CORRECTION", issueCodes: ["VERIFY2_FAILED"], data: q(2, "C"), answerStatus: "OFFICIAL_MATCHED", officialAnswer: ["C"], finalAnswer: ["C"] },
    { ...base, sourceKey: "q3", sourceLabel: "3", orderIndex: 2, status: "NEEDS_CORRECTION", issueCodes: ["ANSWER_MISMATCH"], data: q(3, "A"), answerStatus: "KEY_MISMATCH", officialAnswer: ["D"], finalAnswer: ["A"], answerConfirmedById: admin.id },
  ];
  for (const r of rows) await prisma.aiImportQuestion.create({ data: r as never });
  await prisma.aiImportEvent.create({ data: { jobId: job.id, type: "AUTO_VERIFY_HELD", message: "fixture" } });
  console.log(JSON.stringify({ jobId: job.id, adminId: admin.id }));
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
