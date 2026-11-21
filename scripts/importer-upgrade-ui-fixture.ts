/**
 * Browser-suite fixture for the importer upgrade (scratch DB mts_va ONLY, synthetic data, no AI): an admin, two jobs —
 * "VA-UI paper" (8 questions + key, for Verify Answers) and "VA-UI tables" (a Markdown question with a table and its
 * exact source, an OCR-read question). Prints JSON {adminUser, password, jobId, tableJobId, tableQuestionId, ocrQuestionId}.
 *   /root/mts-scratch/va/run.sh scripts/importer-upgrade-ui-fixture.ts > /root/mts-scratch/va/ui-fixture.json
 */
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";

if (!/\/mts_va(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL is not the scratch mts_va database.");
  process.exit(2);
}

async function main() {
  // The mock key, encrypted with this run's AUTH_SECRET (the scratch server must use the same one).
  await saveOpenRouterKey(`sk-or-v1-mock${"u".repeat(40)}-valid`, "script");
  await testOpenRouterConnection();
  await setOpenRouterEnabled(true);
  const password = `VaUi-${Math.random().toString(36).slice(2, 10)}-Pass!`;
  const role = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" }, update: {}, create: { name: "MASTER_ADMIN" } });
  // Permissions come from the role in code (lib/permissions.ts DEFAULT_ROLE_PERMISSIONS): MASTER_ADMIN can use the importer.
  const admin = await prisma.adminUser.upsert({ where: { username: "va-ui-admin" }, update: { passwordHash: await argon2.hash(password), roleId: role.id }, create: { name: "VA UI Admin", username: "va-ui-admin", email: "va-ui-admin@example.test", passwordHash: await argon2.hash(password), roleId: role.id } });
  const exam = await prisma.exam.upsert({ where: { code: "VASYN" }, update: {}, create: { name: "Synthetic VA Exam", code: "VASYN" } });
  const s = await getImporterSettings();
  const settings = { ...s, aiEnabled: true, selection: { mode: "manual" as const }, openaiDirect: false, importerModels: ["mocktext/classifier", "mockvision/checker"], models: { ...s.models, classify: "mocktext/classifier" }, privacy: { dataCollection: "allow" as const, zdr: false } };
  await saveImporterSettings(settings, admin.id);
  await prisma.aiImportJob.deleteMany({ where: { title: { startsWith: "VA-UI" } } });

  const job = await prisma.aiImportJob.create({ data: { title: "VA-UI paper", examId: exam.id, createdById: admin.id, budgetInr: 0, status: "NEEDS_REVIEW", config: settings as never } });
  const paper = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "synthetic-paper.md", ext: "md", declaredBytes: 1, uploadedById: admin.id, role: "PAPER" } });
  const key = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "synthetic-key.md", ext: "md", declaredBytes: 1, uploadedById: admin.id, role: "ANSWER_KEY" } });
  const PAPER: [number, string, string[], string[]][] = [
    [1, "MOCKANS=B", ["B"], ["B"]],
    [2, "MOCKANS=C", ["B"], ["B"]],
    [3, "MOCKANS=A", ["A"], []],
    [4, "MOCKANS=D", ["A"], ["D"]],
    [5, "MOCKANS=A", ["A"], ["A", "C"]],
    [6, "MOCKANS=A", [], ["X"]],
    [7, "MOCKANS=DEFECTIVE", ["C"], ["C"]],
    [8, "MOCKANS=D", ["D"], ["D"]],
  ];
  for (const [n, marker, saved, keys] of PAPER) {
    const data = { section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem: `Synthetic question ${n}: which drug is first-line for condition ${n}? ${marker}`, options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `Drug ${l}${n}` })), printedAnswer: [], contentFormat: "PLAIN", confidence: 1, unreadable: [], figures: [] };
    const q = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: paper.id, sourceKey: `p1-${n}`, sourceLabel: String(n), sourceNumber: n, orderIndex: n, data, questionType: "SINGLE_CORRECT", finalAnswer: saved } });
    for (const rawValue of keys) await prisma.aiImportKeyEntry.create({ data: { jobId: job.id, keyFileId: key.id, sourceNumber: n, rawValue, matchedQuestionId: q.id, page: 1 } });
  }

  const tjob = await prisma.aiImportJob.create({ data: { title: "VA-UI tables", examId: exam.id, createdById: admin.id, budgetInr: 0, status: "NEEDS_REVIEW", config: settings as never } });
  const md = await prisma.aiImportFile.create({ data: { jobId: tjob.id, originalName: "synthetic-tables.md", ext: "md", declaredBytes: 1, uploadedById: admin.id, role: "PAPER" } });
  const src = "### Q1\nA 30-year-old woman has fatigue. Her results:\n\n| Test | Patient | Reference |\n|---|---|---|\n| Haemoglobin | 8.2 g/dL | 13-17 g/dL |\n| MCV | 68 fL | 80-100 fL |\n| Ferritin | 6 ng/mL | 30-400 ng/mL |\n\nWhat is the most likely diagnosis?\n\nA. Iron deficiency anaemia\nB. Thalassaemia trait\nC. Anaemia of chronic disease\nD. Sideroblastic anaemia";
  const tq = await prisma.aiImportQuestion.create({
    data: {
      jobId: tjob.id, fileId: md.id, sourceKey: "md-1", sourceLabel: "1", sourceNumber: 1, orderIndex: 1, questionType: "SINGLE_CORRECT", contentFormat: "RICH_V1", finalAnswer: ["A"],
      data: { section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: src.split("\n").slice(1, 10).join("\n"), options: [["A", "Iron deficiency anaemia"], ["B", "Thalassaemia trait"], ["C", "Anaemia of chronic disease"], ["D", "Sideroblastic anaemia"]].map(([label, text]) => ({ label, text })), printedAnswer: [], contentFormat: "RICH_V1", confidence: 0.98, unreadable: [], figures: [], method: "MARKDOWN", sourceText: src, notes: ["Q1: contains a table — kept row for row and shown as a table; check it against the source."] },
    },
  });
  const oq = await prisma.aiImportQuestion.create({
    data: {
      jobId: tjob.id, fileId: md.id, sourceKey: "ocr-2", sourceLabel: "2", sourceNumber: 2, orderIndex: 2, questionType: "SINGLE_CORRECT", contentFormat: "PLAIN", finalAnswer: ["C"],
      data: { section: "", number: 2, label: "2", pages: [1], type: "SINGLE_CORRECT", stem: "Consider the following statements:\n1. Statement one is about the kidney.\n2. Statement two is about the liver.\nWhich of the above is/are correct?", options: [["A", "1 only"], ["B", "2 only"], ["C", "Both 1 and 2"], ["D", "Neither 1 nor 2"]].map(([label, text]) => ({ label, text })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.9, unreadable: [], figures: [], method: "LOCAL_OCR", ocr: { engine: "rapidocr", text: "2. Consider the following statements:\n1. Statement one is about the kidney.\n2. Statement two is about the liver.\nWhich of the above is/are correct?\n(a) 1 only  (b) 2 only\n(c) Both 1 and 2  (d) Neither 1 nor 2", minConfidence: 0.93, meanConfidence: 0.97, lowLines: [] } },
    },
  });
  console.log(JSON.stringify({ adminUser: admin.username, password, jobId: job.id, tableJobId: tjob.id, tableQuestionId: tq.id, ocrQuestionId: oq.id }));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
