/**
 * Fixture for scripts/verify-importer-p1-ui.mjs — a DISPOSABLE scratch database only. One finished bilingual import
 * with two questions under a taxonomy academic-review hold (QA, QB), a Master Admin and a Full Admin account.
 * Paid AI stays OFF (nothing can reach a provider).
 *
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=<scratch mts_*> npx tsx scripts/importer-p1-ui-fixture.ts setup > fx.json
 *   … state <fx.json>  → JSON of what the UI test checks
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createJob } from "@/lib/ai-import/jobs";
import { revalidateQuestions, setAcademicReview } from "@/lib/ai-import/review";
import { normalizeImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "") || /mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: scratch mts_* database only.");
  process.exit(2);
}

const L = (xs: string[]) => xs.map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t }));
const eq = (n: number, stem: string, hi: string): ExtractedQuestion =>
  ({ section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem, options: L(["Alpha", "Beta", "Gamma", "Delta"]), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "AI_VISION", region: { x: 0.05, y: 0.1 * n, w: 0.9, h: 0.1 }, hi: { stem: hi, options: L(["अल्फा", "बीटा", "गामा", "डेल्टा"]), confidence: 0.95, unreadable: [], sameOptionOrder: true, figuresDiffer: false, confirmedById: "fixture" } }) as unknown as ExtractedQuestion;

async function account(role: string, sfx: string, tag: string) {
  const r = await prisma.role.upsert({ where: { name: role as never }, create: { name: role as never }, update: {} });
  const password = randomBytes(12).toString("base64url");
  const u = await prisma.adminUser.create({ data: { name: `P1UI ${tag} ${sfx}`, username: `p1ui-${tag}-${sfx}`, passwordHash: await argon2.hash(password), roleId: r.id } });
  return { id: u.id, username: u.username, password };
}

async function setup() {
  const sfx = randomBytes(3).toString("hex");
  const master = await account("MASTER_ADMIN", sfx, "m");
  const full = await account("FULL_ADMIN", sfx, "f");
  await saveImporterSettings({ ...normalizeImporterSettings(await getImporterSettings()), aiEnabled: false }, master.id);
  const exam = await prisma.exam.create({ data: { name: `P1UI Exam ${sfx}`, code: `P1UI-${sfx}`, isActive: true, languageMode: "BILINGUAL" } });
  const food = await createFixtureSubject(prisma, { examId: exam.id, name: `P1UI Food Technology ${sfx}` });
  const post = await createFixtureTopic(prisma, { subjectId: food.id, name: `P1UI Post-harvest ${sfx}` });
  const jobId = await createJob({ actorId: master.id, title: `P1UI paper ${sfx}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  const file = await prisma.aiImportFile.create({ data: { jobId, originalName: "p1ui-paper.pdf", ext: "pdf", role: "PAPER", status: "PROCESSED", pageCount: 1, detected: { kind: "pdf" }, mime: "application/pdf", declaredBytes: 1000, bytes: 1000, uploadedById: master.id } });
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: "NEEDS_REVIEW", confirmedAt: new Date(), expectedQuestions: 5 } });
  const rows: Record<string, string> = {};
  for (const [key, n, stem, hi] of [["qa", 1, "The enzymatic browning in cut surface of fruits is due to", "फलों की कटी सतह पर भूरापन किसके कारण है"], ["qb", 2, "Which packaging is used for butter?", "मक्खन की पैकिंग में क्या प्रयुक्त होता है"]] as const) {
    const e = eq(n, stem, hi);
    const r = await prisma.aiImportQuestion.create({ data: { jobId, fileId: file.id, sourceKey: `#${n}`, sourceNumber: n, sourceLabel: String(n), pages: [1], orderIndex: n, data: e as never, questionType: e.type, optionCount: 4, contentFormat: "PLAIN", confidence: 0.95, subjectId: food.id, topicId: post.id, taxonomySource: "admin", officialAnswer: ["A"], officialAnswerRaw: "1", finalAnswer: ["A"], answerStatus: "OFFICIAL_MATCHED", answerConfirmedById: master.id } });
    rows[key] = r.id;
  }
  // 2026-11-11 formula checks: QC = copy of the FSO Q136 damage (\text eaten into a TAB in an option; approved before the
  // check existed), QD = a formula question read by local OCR, QE = a clean question. Synthetic text only.
  const formula = async (key: string, n: number, stem: string, options: string[], method: string, approved: boolean) => {
    const e = { ...eq(n, stem, `${stem} (हिंदी)`), options: L(options), contentFormat: "RICH_V1", method } as unknown as ExtractedQuestion;
    (e as unknown as { hi: { options: unknown } }).hi.options = L(options);
    const r = await prisma.aiImportQuestion.create({ data: { jobId, fileId: file.id, sourceKey: `#${n}`, sourceNumber: n, sourceLabel: String(n), pages: [1], orderIndex: n, data: e as never, questionType: e.type, optionCount: 4, contentFormat: "RICH_V1", confidence: 0.95, subjectId: food.id, topicId: post.id, taxonomySource: "admin", officialAnswer: ["A"], officialAnswerRaw: "1", finalAnswer: ["A"], answerStatus: "OFFICIAL_MATCHED", answerConfirmedById: master.id, ...(approved ? { approvedById: master.id, approvedAt: new Date(), reviewedById: master.id, reviewedAt: new Date() } : {}) } });
    rows[key] = r.id;
  };
  // "\t" below is a real TAB: the stored damage exactly as FSO Q136 holds it.
  await formula("qc", 3, "The ISRO launch was on", ["$13^{\text{th}}$ February, 1986", "$22^{\text{nd}}$ July, 2019", "$1^{\text{st}}$ May", "$4^{\text{th}}$ June"], "AI_VISION", true);
  await formula("qd", 4, "The formula for standard deviation is", ["$\\sigma = \\frac{\\sum(X-\\bar{X})}{N}$", "$\\sigma = \\sqrt{\\frac{\\sum(x-\\bar{x})^2}{N}}$", "$\\sigma = \\sqrt{\\frac{\\sum(X-\\bar{X})}{N}}$", "$\\sigma = \\sqrt{\\frac{\\sum X}{N}}$"], "LOCAL_OCR", false);
  await formula("qe", 5, "Water boils at", ["$100^{\\circ}\\text{C}$", "$90^{\\circ}\\text{C}$", "$80^{\\circ}\\text{C}$", "$70^{\\circ}\\text{C}$"], "AI_VISION", false);
  await revalidateQuestions(jobId, Object.values(rows));
  await setAcademicReview([rows.qa, rows.qb], master.id, "AMBIGUOUS_PENDING_ACADEMIC_REVIEW", "Primary S08-T03 vs alternative: S03-T02 Biochemistry (test)");
  console.log(JSON.stringify({ sfx, jobId, rows, accounts: { master: { username: master.username, password: master.password }, full: { username: full.username, password: full.password } } }, null, 1));
}

async function state(fxPath: string) {
  const F = JSON.parse(readFileSync(fxPath, "utf8"));
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId: F.jobId } });
  const out = {
    rows: Object.fromEntries(qs.map((q) => [q.id, { hold: q.academicReview, note: q.academicReviewNote, approved: !!q.approvedById, codes: q.issueCodes, data: JSON.stringify(((d) => [d.stem, d.options.map((o) => o.text), d.hi?.stem ?? null, d.hi?.options.map((o) => o.text) ?? null])(q.data as unknown as ExtractedQuestion)), edited: q.editedData !== null, questionId: q.questionId, reviewedAt: q.reviewedAt?.toISOString() ?? null, subjectId: q.subjectId, topicId: q.topicId }])),
    cleared: await prisma.aiImportEvent.count({ where: { jobId: F.jobId, type: "ACADEMIC_REVIEW_CLEARED" } }),
    clearedNote: ((await prisma.aiImportEvent.findFirst({ where: { jobId: F.jobId, type: "ACADEMIC_REVIEW_CLEARED" }, orderBy: { createdAt: "desc" } }))?.data as { note?: string } | null)?.note ?? null,
    audit: await prisma.auditLog.count({ where: { action: "AI_IMPORT_ACADEMIC_REVIEW_CLEARED" } }),
    bankQuestions: await prisma.question.count(),
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
