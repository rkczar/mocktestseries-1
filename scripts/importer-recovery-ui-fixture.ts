/**
 * Fixture for scripts/verify-importer-recovery-ui.mjs — a DISPOSABLE scratch database only. Builds one finished
 * bilingual import directly (no worker, no AI; paid AI stays OFF so every Re-scan click is refused with its reason):
 *   Q1 Pinacol (structure options with images; filed under Physics, the local classifier says Chemistry),
 *   Q2 (filed under Physics, Verify-free local evidence says Chemistry), Q3 MISSING, Q4 with a PENDING re-scan candidate
 *   (English + Hindi differ), Q5, Q6 an empty placeholder with a PENDING candidate.
 *
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=<scratch mts_*> npx tsx scripts/importer-recovery-ui-fixture.ts setup > fx.json
 *   … state <fx.json>  → JSON of the rows the UI test checks
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import sharp from "sharp";
import { AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createJob } from "@/lib/ai-import/jobs";
import { revalidateQuestions } from "@/lib/ai-import/review";
import { placeholderRow } from "@/lib/ai-import/process";
import { storeOriginalFigure } from "@/lib/ai-import/figures";
import { normalizeImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import type { ClassificationRecord, ExtractedQuestion } from "@/lib/ai-import/types";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "") || /mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: scratch mts_* database only.");
  process.exit(2);
}

const PIN = ["$$\\text{H}_3\\text{C}-\\text{C}(\\text{CH}_3)_2-\\text{C}(\\text{CH}_3)(\\text{OH})-\\text{CH}_3$$", "$$\\text{H}_3\\text{C}-\\text{C}(\\text{CH}_3)(\\text{OH})-\\text{C}(\\text{CH}_3)(\\text{OH})-\\text{CH}_3$$", "$$\\text{H}_3\\text{C}-\\text{CH}(\\text{CH}_3)-\\text{C}(\\text{CH}_3)(\\text{OH})-\\text{CH}_3$$", "$$\\text{CH}_3-\\text{CH}(\\text{OH})-\\text{CH}(\\text{OH})-\\text{CH}_3$$"];
const L = (xs: string[]) => xs.map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t }));
const hi = (stem: string, options: string[]) => ({ stem, options: L(options), confidence: 0.95, unreadable: [], sameOptionOrder: true, figuresDiffer: false });
const reg = (y: number) => ({ x: 0.05, y, w: 0.9, h: 0.12 });
const eq = (n: number, page: number, y: number, extra: Partial<ExtractedQuestion> = {}): ExtractedQuestion =>
  ({ section: "", number: n, label: String(n), pages: [page], type: "SINGLE_CORRECT", stem: `UI recovery question ${n}`, options: L(["Alpha", "Beta", "Gamma", "Delta"]), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "AI_VISION", region: reg(y), hi: hi(`यूआई प्रश्न ${n}`, ["अल्फा", "बीटा", "गामा", "डेल्टा"]), ...extra }) as ExtractedQuestion;

async function setup() {
  const sfx = randomBytes(3).toString("hex");
  const role = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" }, create: { name: "MASTER_ADMIN" }, update: {} });
  const password = randomBytes(12).toString("base64url");
  const admin = await prisma.adminUser.create({ data: { name: `RCUI ${sfx}`, username: `rcui-${sfx}`, passwordHash: await argon2.hash(password), roleId: role.id } });
  // Paid AI OFF: every Re-scan is refused with its reason (nothing can be sent to a provider).
  await saveImporterSettings({ ...normalizeImporterSettings(await getImporterSettings()), aiEnabled: false }, admin.id);
  const exam = await prisma.exam.create({ data: { name: `RCUI Exam ${sfx}`, code: `RCUI-${sfx}`, isActive: true, languageMode: "BILINGUAL" } });
  const chem = await createFixtureSubject(prisma, { examId: exam.id, name: `RCUI Chemistry ${sfx}` });
  const organic = await createFixtureTopic(prisma, { subjectId: chem.id, name: `RCUI Organic ${sfx}` });
  const phys = await createFixtureSubject(prisma, { examId: exam.id, name: `RCUI Physics ${sfx}` });
  const mech = await createFixtureTopic(prisma, { subjectId: phys.id, name: `RCUI Mechanics ${sfx}` });
  const jobId = await createJob({ actorId: admin.id, title: `RCUI paper ${sfx}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  const file = await prisma.aiImportFile.create({ data: { jobId, originalName: "rcui-paper.pdf", ext: "pdf", role: "PAPER", status: "PROCESSED", pageCount: 2, detected: { kind: "pdf" }, mime: "application/pdf", declaredBytes: 1000, bytes: 1000, uploadedById: admin.id } });
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: "NEEDS_REVIEW", confirmedAt: new Date(), expectedQuestions: 6 } });
  const local = (subjectId: string, topicId: string): ClassificationRecord => ({ at: new Date().toISOString(), kind: "ok", subjectId: phys.id, topicId: mech.id, subTopicId: null, confidence: 0.6, source: "local classifier", reason: "", ai: null, local: { status: "CLASSIFIED", subjectId, topicId, subTopicId: null, subjectConfidence: 0.85, topicConfidence: 0.75, method: "local terms", reason: "matched “pinacol”, “diol”", candidates: [], evidenceQuestions: 0 } });
  const rows: Record<string, string> = {};
  const create = async (key: string, e: ExtractedQuestion, order: number, extra: Record<string, unknown> = {}) => {
    const r = await prisma.aiImportQuestion.create({ data: { jobId, fileId: file.id, sourceKey: `#${e.number}`, sourceNumber: e.number, sourceLabel: e.label, pages: e.pages, orderIndex: order, data: e as never, questionType: e.type, optionCount: e.options.length, contentFormat: e.contentFormat, confidence: e.confidence, ...extra } });
    rows[key] = r.id;
    return r;
  };
  const q1 = await create("q1", eq(1, 1, 0.05, { stem: "Chemical structure of Pinacol is", options: L(PIN), contentFormat: "RICH_V1", hi: hi("पिनेकॉल की रासायनिक संरचना है", PIN), classification: local(chem.id, organic.id) }), 0, { subjectId: phys.id, topicId: mech.id, taxonomySource: "local classifier" });
  for (const [i, l] of ["A", "B", "C", "D"].entries()) {
    const png = await sharp({ create: { width: 220, height: 120, channels: 3, background: { r: 60 + i * 40, g: 120, b: 160 } } }).png().toBuffer();
    const st = await storeOriginalFigure(png, "png");
    await prisma.aiImportFigure.create({ data: { jobId, fileId: file.id, pageNumber: 1, questionId: q1.id, owner: "OPTION", optionLabel: l, box: { x: 0.1 + i * 0.2, y: 0.1, w: 0.18, h: 0.08 }, source: "CROP", originalKey: st.key, originalSha256: st.sha256, originalMime: st.mime, width: st.width, height: st.height, bytes: st.bytes, description: `Chemical structure option ${l}`, confidence: 0.9 } });
  }
  await create("q2", eq(2, 1, 0.3, { stem: "Pinacol rearrangement gives", classification: local(chem.id, organic.id) }), 1, { subjectId: phys.id, topicId: mech.id, taxonomySource: "local classifier" });
  const q4 = await create("q4", eq(4, 1, 0.7, { stem: "Garbled first read of question 4" }), 2, { subjectId: chem.id, topicId: organic.id, taxonomySource: "admin" });
  await create("q5", eq(5, 2, 0.1), 3, { subjectId: chem.id, topicId: organic.id, taxonomySource: "admin" });
  const q6 = await prisma.aiImportQuestion.create({ data: placeholderRow(jobId, file.id, "#6", { section: "", number: 6, label: "6", pages: [2] }, 4) });
  rows.q6 = q6.id;
  await prisma.aiImportQuestionVersion.create({ data: { questionId: q4.id, jobId, kind: "RESCAN", status: "PENDING", data: eq(4, 1, 0.7, { stem: "Correct text of question 4", hi: hi("प्रश्न 4 का सही पाठ", ["अल्फा", "बीटा", "गामा", "डेल्टा"]) }) as never, figures: [], model: "mockvision/reader", note: "UI fixture candidate" } });
  await prisma.aiImportQuestionVersion.create({ data: { questionId: q6.id, jobId, kind: "RESCAN", status: "PENDING", data: eq(6, 2, 0.4, { stem: "Question 6 found by the re-scan" }) as never, figures: [], model: "mockvision/reader", note: "UI fixture candidate" } });
  await revalidateQuestions(jobId, Object.values(rows));
  // The checks rewrite the classification record from this fixture's tiny taxonomy; the evidence under test is set after.
  for (const key of ["q1", "q2"]) {
    const r = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: rows[key] } });
    await prisma.aiImportQuestion.update({ where: { id: r.id }, data: { subjectId: phys.id, topicId: mech.id, taxonomySource: "local classifier", data: { ...(r.data as object), classification: local(chem.id, organic.id) } as never } });
  }
  console.log(JSON.stringify({ sfx, jobId, examId: exam.id, subjects: { chem: chem.id, phys: phys.id }, topics: { organic: organic.id, mech: mech.id }, rows, accounts: { master: { username: admin.username, password } } }, null, 1));
}

async function state(fxPath: string) {
  const F = JSON.parse(readFileSync(fxPath, "utf8"));
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId: F.jobId }, include: { versions: true } });
  const out = {
    count: qs.length,
    numbers: qs.map((q) => q.sourceNumber).sort((a, b) => (a ?? 0) - (b ?? 0)),
    rows: Object.fromEntries(qs.map((q) => [q.sourceNumber, { id: q.id, subjectId: q.subjectId, topicId: q.topicId, taxonomySource: q.taxonomySource, approved: !!q.approvedById, stem: ((q.editedData ?? q.data) as unknown as ExtractedQuestion).stem, hiStem: ((q.editedData ?? q.data) as unknown as ExtractedQuestion).hi?.stem ?? null, dataStem: (q.data as unknown as ExtractedQuestion).stem, versions: q.versions.map((v) => `${v.kind}:${v.status ?? ""}`).sort() }])),
    rescanRequests: await prisma.auditLog.count({ where: { action: "AI_IMPORT_RESCAN_REQUESTED", entityId: F.jobId } }),
    kept: await prisma.auditLog.count({ where: { action: "AI_IMPORT_TAXONOMY_KEPT" } }),
    job: (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: F.jobId } })).status,
  };
  console.log(JSON.stringify(out));
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "state" ? state(arg) : Promise.reject(new Error("usage: setup | state <fx.json>")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
