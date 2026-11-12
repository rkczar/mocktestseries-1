/**
 * Per-question import isolation (I-A, 2026-11-12) — a DISPOSABLE scratch database only, synthetic questions only,
 * paid AI off (nothing can reach a provider). Calls the real import path (runImport → Bulk Import pipeline).
 *
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=<scratch mts_*> AI_IMPORT_VAULT_DIR=… STORAGE_DIR=… \
 *     IMPORT_STAGING_DIR=… npx tsx scripts/verify-importer-isolation.ts
 *
 * ISO_PURE_ONLY=1 runs only section A (no database rows are written).
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { AiImportPaperType, AiImportQuestionStatus, type Prisma } from "@prisma/client";

if (!process.env.ISO_PURE_ONLY && (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "") || /mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? ""))) {
  console.error("Refusing: scratch mts_* database only.");
  process.exit(2);
}

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}

const L = (xs: string[]) => xs.map((t, i) => ({ label: "ABCD"[i], printed: `(${i + 1})`, text: t }));

async function pure() {
  const { matchListProblem } = await import("@/lib/ai-import/adapter");
  const { questionProblems } = await import("@/lib/json-import");
  console.log("A. Match-list gate = the Bulk Import parser (pure)");
  const ok = [{ key: "A", text: "Tuberculosis" }, { key: "B", text: "Round worm" }];
  const ii = [{ key: "1", text: "Bacteria" }, { key: "2", text: "Helminth" }];
  const cases: [string, { key?: unknown; text?: unknown }[], boolean][] = [
    ["valid keys", ok, true],
    ["empty key (Q109 pattern)", [{ key: "", text: "Tuberculosis" }, ok[1]], false],
    ["numeric key (latent TypeError before)", [{ key: 1, text: "Tuberculosis" }, ok[1]], false],
    ["key ABCDE", [{ key: "ABCDE", text: "x" }, ok[1]], false],
    ["3-digit key", [{ key: "100", text: "x" }, ok[1]], false],
    ["text with |", [{ key: "A", text: "a | b" }, ok[1]], false],
    ["text with @@", [{ key: "A", text: "a @@ b" }, ok[1]], false],
    ["inner newline", [{ key: "A", text: "a\nb" }, ok[1]], false],
    ["trailing newline is trimmed (accepted, like Bulk Import)", [{ key: "A", text: "Tuberculosis\n" }, ok[1]], true],
    ["missing key", [{ text: "x" }, ok[1]], false],
  ];
  for (const [name, listI, valid] of cases)
    await t(`A ${name}: gate ${valid ? "accepts" : "refuses"} and agrees with questionProblems`, () => {
      const gate = matchListProblem(listI, ii);
      const parser = questionProblems({ type: "MATCH_THE_FOLLOWING", question: "x", options: L(["a", "b", "c", "d"]).map(({ label, text }) => ({ label, text })), correct: "A", matchLists: { listI, listII: ii } }).filter((m) => m.includes("matchLists."));
      assert.equal(gate === null, valid, String(gate));
      assert.equal(parser.length === 0, valid, parser.join(" "));
    });
  await t("A refusal names the item and how to fix it", () => assert.match(matchListProblem([{ key: "", text: "Tuberculosis" }], ii) ?? "", /^List I item "Tuberculosis" needs a key .* correct the lists \(Edit\) first$/));
}

async function db() {
  const argon2 = (await import("argon2")).default;
  const { prisma } = await import("@/lib/prisma");
  const { createJob } = await import("@/lib/ai-import/jobs");
  const { revalidateQuestions } = await import("@/lib/ai-import/review");
  const { runImport } = await import("@/lib/ai-import/adapter");
  const { normalizeImporterSettings } = await import("@/lib/ai-import/config");
  const { getImporterSettings, saveImporterSettings } = await import("@/lib/ai-import/settings");
  const { putContent } = await import("@/lib/ai-import/vault");
  const { createFixtureSubject, createFixtureTopic } = await import("./fixture-taxonomy");

  const sfx = randomBytes(3).toString("hex");
  const role = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" as never }, create: { name: "MASTER_ADMIN" as never }, update: {} });
  const master = await prisma.adminUser.create({ data: { name: `ISO m ${sfx}`, username: `iso-m-${sfx}`, passwordHash: await argon2.hash(randomBytes(12).toString("hex")), roleId: role.id } });
  await saveImporterSettings({ ...normalizeImporterSettings(await getImporterSettings()), aiEnabled: false }, master.id);
  const settings = await getImporterSettings();
  assert.equal(settings.aiEnabled, false);
  const exam = await prisma.exam.create({ data: { name: `ISO Exam ${sfx}`, code: `ISO-${sfx}`, isActive: true } });
  const subj = await createFixtureSubject(prisma, { examId: exam.id, name: `ISO Animal Science ${sfx}` });
  const topic = await createFixtureTopic(prisma, { subjectId: subj.id, name: `ISO Parasitology ${sfx}` });
  const jobId = await createJob({ actorId: master.id, title: `ISO paper ${sfx}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2022, paperCode: null, previousYearPaperId: null, budgetInr: 0 });
  const file = await prisma.aiImportFile.create({ data: { jobId, originalName: "iso-paper.pdf", ext: "pdf", role: "PAPER", status: "PROCESSED", pageCount: 1, detected: { kind: "pdf" }, mime: "application/pdf", declaredBytes: 1000, bytes: 1000, uploadedById: master.id } });
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: "NEEDS_REVIEW", confirmedAt: new Date(), expectedQuestions: 20 } });

  const ids: Record<string, string> = {};
  let n = 0;
  const add = async (key: string, stem: string, over: Record<string, unknown> = {}, row: Partial<Prisma.AiImportQuestionUncheckedCreateInput> = {}) => {
    n++;
    const e = { section: "", number: n, label: String(n), pages: [1], type: "SINGLE_CORRECT", stem: `${stem} [${sfx}]`, options: L([`Alpha ${n}`, `Beta ${n}`, `Gamma ${n}`, `Delta ${n}`]), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "DOCX", ...over };
    const r = await prisma.aiImportQuestion.create({ data: { jobId, fileId: file.id, sourceKey: `#${n}`, sourceNumber: n, sourceLabel: String(n), pages: [1], orderIndex: n, data: e as never, questionType: e.type as string, optionCount: 4, contentFormat: "PLAIN", confidence: 0.95, subjectId: subj.id, topicId: topic.id, taxonomySource: "admin", taxonomyConfidence: 1, officialAnswer: ["A"], officialAnswerRaw: "1", finalAnswer: ["A"], answerStatus: "OFFICIAL_MATCHED", answerConfirmedById: master.id, ...row } });
    ids[key] = r.id;
    return r.id;
  };
  const mtf = (listI: { key: string; text: string }[], listII: { key: string; text: string }[]) => ({ type: "MATCH_THE_FOLLOWING", listI, listII });
  const goodII = [{ key: "A", text: "Helminthic parasite" }, { key: "B", text: "Bacteria" }, { key: "C", text: "Protozoa" }];

  await add("valid1", "Which crop is a legume?");
  await add("valid2", "Match the disease with its cause", mtf([{ key: "I", text: "Tuberculosis" }, { key: "II", text: "Round worm" }, { key: "III", text: "Theileriosis" }], goodII), { questionType: "MATCH_THE_FOLLOWING" });
  await add("q109", "Match the disease with its agent (keyless List I)", mtf([{ key: "", text: "Tuberculosis" }, { key: "", text: "Round worm" }, { key: "", text: "Theileriosis" }], goodII), { questionType: "MATCH_THE_FOLLOWING" });
  await add("q132", "Match the act with its year (all keys missing)", mtf([{ key: "", text: "PFA" }, { key: "", text: "FPO" }, { key: "", text: "AGMARK" }], [{ key: "", text: "1937" }, { key: "", text: "1954" }, { key: "", text: "1955" }]), { questionType: "MATCH_THE_FOLLOWING" });
  await add("mtfNoLists", "Match List I with List II (lists lost)", { type: "MATCH_THE_FOLLOWING" }, { questionType: "MATCH_THE_FOLLOWING" });
  for (let i = 0; i < 6; i++) await add(`nc${i}`, `Approved but needs correction ${i}`);
  await add("formulaCorrupt", "The ISRO launch was on", { options: L(["$13^{\text{th}}$ Feb", "$22^{\\text{nd}}$ July", "$1^{\\text{st}}$ May", "$4^{\\text{th}}$ June"]), contentFormat: "RICH_V1" }, { contentFormat: "RICH_V1" });
  await add("formulaManual", "The formula for standard deviation is", { options: L(["$\\sigma = N$", "$\\sigma = \\sqrt{N}$", "$\\sigma = N^2$", "$\\sigma = 1$"]), contentFormat: "RICH_V1", method: "LOCAL_OCR" }, { contentFormat: "RICH_V1" });
  await add("hold", "Question under academic hold");
  await add("noSubject", "Question without a subject", {}, { subjectId: null, topicId: null });
  await add("withdrawn", "Question deleted by the official key", {}, { answerStatus: "WITHDRAWN" });
  await add("rejected", "Rejected question");
  await add("unapproved", "Valid but not approved yet");
  await add("badAlt", "Question whose figure alt Bulk Import refuses");
  await add("noVaultFile", "Question whose image file is missing");
  await add("valid3", "Which gas do plants take in?");

  // Figures: a real PNG in the scratch vault with an alt the Bulk Import parser refuses (passes importBlocker), and a figure whose file is gone.
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
  const v = await putContent("figures", png, "png");
  const fig = (questionId: string, originalKey: string, description: string | null) => prisma.aiImportFigure.create({ data: { jobId, fileId: file.id, pageNumber: 1, questionId, owner: "QUESTION", source: "EMBEDDED", originalKey, originalSha256: v.sha256, originalMime: "image/png", width: 40, height: 30, bytes: png.length, description, mappingStatus: "OK", confirmedById: master.id } });
  await fig(ids.badAlt, v.key, "Line one :: decorative @@ broken");
  await fig(ids.noVaultFile, "figures/00/0000000000000000000000000000000000000000000000000000000000000000.png", "A figure");

  await revalidateQuestions(jobId, Object.values(ids));
  const now = new Date();
  const approve = Object.keys(ids).filter((k) => !["unapproved", "q132"].includes(k));
  await prisma.aiImportQuestion.updateMany({ where: { id: { in: approve.map((k) => ids[k]) } }, data: { approvedById: master.id, approvedAt: now, reviewedById: master.id, reviewedAt: now } });
  await revalidateQuestions(jobId, Object.values(ids));
  // Prod-shaped states set directly (what revalidation produced on prod FSO 2022): approved but NEEDS_CORRECTION,
  // a damaged formula flag, an open manual-verification flag, an academic hold, a rejection.
  for (let i = 0; i < 6; i++) await prisma.aiImportQuestion.update({ where: { id: ids[`nc${i}`] }, data: { status: AiImportQuestionStatus.NEEDS_CORRECTION, issueCodes: ["VERIFY2_DISAGREES"] } });
  await prisma.aiImportQuestion.update({ where: { id: ids.q109 }, data: { status: AiImportQuestionStatus.NEEDS_CORRECTION } });
  await prisma.aiImportQuestion.update({ where: { id: ids.formulaCorrupt }, data: { status: AiImportQuestionStatus.READY, issueCodes: ["FORMULA_TEXT_CORRUPT"] } });
  await prisma.aiImportQuestion.update({ where: { id: ids.formulaManual }, data: { status: AiImportQuestionStatus.NEEDS_CORRECTION, issueCodes: ["FORMULA_NEEDS_MANUAL_VERIFICATION"] } });
  await prisma.aiImportQuestion.update({ where: { id: ids.hold }, data: { academicReview: "AMBIGUOUS_PENDING_ACADEMIC_REVIEW", academicReviewNote: "S01-T02 vs S03-T01" } });
  await prisma.aiImportQuestion.update({ where: { id: ids.rejected }, data: { status: AiImportQuestionStatus.REJECTED, approvedById: null, approvedAt: null } });
  await prisma.aiImportQuestion.update({ where: { id: ids.withdrawn }, data: { answerStatus: "WITHDRAWN" } });
  if (process.env.ISO_DEBUG) for (const [k, id] of Object.entries(ids)) { const q = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id } }); console.log(`  [debug] ${k} ${q.status} ${q.answerStatus} ${q.issueCodes.join(",")}`); }

  const snap = async (keys: string[]) => JSON.stringify(await prisma.aiImportQuestion.findMany({ where: { id: { in: keys.map((k) => ids[k]) } }, orderBy: { id: "asc" }, select: { id: true, data: true, editedData: true, approvedById: true, approvedAt: true, status: true, issueCodes: true, finalAnswer: true, subjectId: true, topicId: true, academicReview: true, questionId: true } }));
  const protectedKeys = ["q109", "q132", "mtfNoLists", "nc0", "nc1", "nc2", "nc3", "nc4", "nc5", "formulaCorrupt", "formulaManual", "hold", "noSubject", "withdrawn", "rejected", "unapproved"];
  const before = await snap(protectedKeys);
  const pre = await prisma.aiImportQuestion.findMany({ where: { jobId }, select: { id: true, status: true } });
  const readyApproved = pre.filter((q) => q.status === "READY").length;
  console.log(`  (seeded ${Object.keys(ids).length} questions; ${readyApproved} READY after revalidation)`);
  for (const k of ["valid1", "valid2", "valid3", "badAlt", "noVaultFile"]) {
    const s = pre.find((q) => q.id === ids[k])!.status;
    if (s !== "READY") await prisma.aiImportQuestion.update({ where: { id: ids[k] }, data: { status: AiImportQuestionStatus.READY } });
  }
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const plan = { mode: "DRAFT" as const, questionIds: null, requestedById: master.id, requestedAt: now.toISOString() };
  const qCount = () => prisma.question.count({ where: { examId: exam.id } });
  const q0 = await qCount();

  console.log("B. Mixed valid and invalid questions in one import");
  const r1 = await runImport(job, plan, settings);
  const item = (k: string) => r1.items.find((i) => i.id === ids[k]);
  await t("B1 the three valid questions are imported; the Question Bank gains exactly 3", async () => {
    for (const k of ["valid1", "valid2", "valid3"]) assert.equal(item(k)?.outcome, "imported", `${k}: ${JSON.stringify(item(k))}`);
    assert.equal(r1.imported, 3);
    assert.equal((await qCount()) - q0, 3);
  });
  await t("B2 the valid match question is stored as a match question with its source keys", async () => {
    const q = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: ids.valid2 } });
    const bank = await prisma.question.findUniqueOrThrow({ where: { id: q.questionId! } });
    const spec = JSON.stringify(bank.matchSpec);
    for (const k of ["I", "II", "III"]) assert.ok(spec.includes(`"${k}"`), spec);
    assert.equal(bank.questionType, "MATCH_THE_FOLLOWING");
  });
  await t("B3 Q109 pattern (approved, keyless List I) waits for correction, names the item", () => {
    assert.equal(item("q109")?.outcome, "awaiting");
    assert.match(item("q109")!.reason, /needs correction|List I item "Tuberculosis"/);
  });
  await t("B4 Q132 pattern (unapproved, keyless lists) is skipped", () => assert.equal(item("q132")?.outcome, "skipped"));
  await t("B5 a match question without lists is NOT imported as single-correct", () => {
    assert.equal(item("mtfNoLists")?.outcome, "awaiting");
    assert.match(item("mtfNoLists")!.reason, /needs correction|without List I/);
  });
  await t("B6 every approved + NEEDS_CORRECTION question stays out (status gate)", () => {
    for (let i = 0; i < 6; i++) assert.equal(item(`nc${i}`)?.outcome, "awaiting", JSON.stringify(item(`nc${i}`)));
  });
  await t("B7 damaged formula (READY + approved) stays out", () => assert.match(item("formulaCorrupt")?.reason ?? "", /Formula text damaged/));
  await t("B8 open manual formula verification stays out", () => assert.equal(item("formulaManual")?.outcome, "awaiting"));
  await t("B9 academic hold, no subject: stay out with reasons", () => {
    assert.match(item("hold")?.reason ?? "", /academic review/);
    assert.match(item("noSubject")?.reason ?? "", /no subject|Subject|taxonomy/i);
  });
  await t("B10 withdrawn and rejected questions never enter the Question Bank", () => {
    assert.match(item("withdrawn")?.reason ?? "", /deleted in the official answer key/);
    assert.equal(item("rejected")?.outcome, "skipped");
  });
  await t("B11 unapproved valid question is skipped as not approved", () => assert.match(item("unapproved")?.reason ?? "", /not approved/));
  await t("B12 a figure alt Bulk Import refuses fails ONLY that question, with the parser's reason", () => {
    assert.equal(item("badAlt")?.outcome, "failed");
    assert.match(item("badAlt")!.reason, /Bulk Import would refuse it/);
  });
  await t("B13 a missing image file fails ONLY that question", () => {
    assert.equal(item("noVaultFile")?.outcome, "failed");
    assert.match(item("noVaultFile")!.reason, /Could not be packaged/);
  });
  await t("B14 no Question / QuestionAsset rows exist for the failed or blocked questions (no partial records)", async () => {
    const qs = await prisma.aiImportQuestion.findMany({ where: { id: { in: ["badAlt", "noVaultFile", ...protectedKeys].map((k) => ids[k]) } }, select: { questionId: true } });
    assert.ok(qs.every((q) => !q.questionId));
    for (const s of ["figure alt", "image file is missing", "keyless List I", "needs correction 0", "ISRO", "academic hold"]) assert.equal(await prisma.question.count({ where: { text: { contains: s } } }), 0, s);
  });
  await t("B15 blocked questions are byte-identical (content, approval, status, flags)", async () => assert.equal(await snap(protectedKeys), before));
  await t("B16 the itemized result lists every non-imported question once, in source order", () => {
    const seen = r1.items.map((i) => i.id);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(r1.items.length, Object.keys(ids).length);
    const order = Object.keys(ids).map((k) => ids[k]);
    assert.deepEqual(seen, order.filter((id) => seen.includes(id)));
  });

  console.log("C. Retries are idempotent; duplicates are not imported twice");
  const runs1 = await prisma.bulkImportRun.count();
  const q1 = await qCount();
  const jobAfter = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const r2 = await runImport(jobAfter, plan, settings);
  await t("C1 a second run creates 0 Questions", async () => assert.equal((await qCount()) - q1, 0));
  await t("C2 the refused questions are reported again with the same reasons, nothing else imported", () => {
    assert.equal(r2.imported, 0);
    assert.deepEqual(r2.items.filter((i) => i.outcome === "failed").map((i) => i.id).sort(), [ids.badAlt, ids.noVaultFile].sort());
  });
  await t("C3 no new Bulk Import run when nothing is packageable", async () => assert.equal(await prisma.bulkImportRun.count(), runs1));
  await t("C4 a copy of an imported question is skipped as a duplicate (Bulk Import SKIP)", async () => {
    const v1 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: ids.valid1 } });
    const dupId = await add("dup", "x", { ...(v1.data as object), number: 99, label: "99" }, { approvedById: master.id, approvedAt: new Date(), status: AiImportQuestionStatus.READY });
    const r = await runImport(jobAfter, { ...plan, questionIds: [dupId] }, settings);
    assert.equal(r.items.find((i) => i.id === dupId)?.outcome, "skipped", JSON.stringify(r.items));
    assert.equal((await qCount()) - q1, 0);
  });

  console.log("D. Interrupted import (worker died before linking back) is linked, never duplicated");
  await t("D1 an unlinked imported question is linked to its existing Question on retry; a new question still imports", async () => {
    const v3 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: ids.valid3 } });
    const bankId = v3.questionId!;
    await prisma.aiImportQuestion.update({ where: { id: v3.id }, data: { questionId: null, bulkImportRowId: null, importedAt: null, status: AiImportQuestionStatus.READY } });
    const fresh = await add("valid4", "Which vitamin is fat-soluble?", {}, { approvedById: master.id, approvedAt: new Date(), status: AiImportQuestionStatus.READY });
    const before4 = await qCount();
    const r = await runImport(jobAfter, plan, settings);
    const after = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: v3.id } });
    assert.equal(after.status, "IMPORTED");
    assert.equal(after.questionId, bankId);
    assert.equal(r.items.find((i) => i.id === fresh)?.outcome, "imported", JSON.stringify(r.items.find((i) => i.id === fresh)));
    assert.equal((await qCount()) - before4, 1);
    assert.equal(await prisma.question.count({ where: { text: { contains: `Which gas do plants take in? [${sfx}]` } } }), 1);
  });

  console.log("E. Larger batch: 86 approved + NEEDS_CORRECTION questions with 3 valid ones");
  await t("E1 all 86 stay out, unchanged; the 3 valid ones import", async () => {
    const many: string[] = [];
    for (let i = 0; i < 86; i++) many.push(await add(`m${i}`, `Bulk needs-correction ${i}`, {}, { approvedById: master.id, approvedAt: new Date(), status: AiImportQuestionStatus.NEEDS_CORRECTION, issueCodes: ["VERIFY2_DISAGREES"] }));
    const ok: string[] = [];
    for (let i = 0; i < 3; i++) ok.push(await add(`ok${i}`, `Bulk valid question ${i}`, {}, { approvedById: master.id, approvedAt: new Date(), status: AiImportQuestionStatus.READY }));
    const snapMany = JSON.stringify(await prisma.aiImportQuestion.findMany({ where: { id: { in: many } }, orderBy: { id: "asc" } }));
    const b = await qCount();
    const r = await runImport(jobAfter, { ...plan, questionIds: [...many, ...ok] }, settings);
    assert.equal(r.items.filter((i) => i.outcome === "awaiting").length, 86);
    assert.equal(r.imported, 3);
    assert.equal((await qCount()) - b, 3);
    assert.equal(JSON.stringify(await prisma.aiImportQuestion.findMany({ where: { id: { in: many } }, orderBy: { id: "asc" } })), snapMany);
  });

  await t("F no AI call was possible (paid AI off, no AI call rows)", async () => {
    assert.equal((await getImporterSettings()).aiEnabled, false);
    assert.equal(await prisma.aiImportAiCall.count({ where: { jobId } }).catch(() => 0), 0);
  });
  await prisma.$disconnect();
}

async function main() {
  await pure();
  if (!process.env.ISO_PURE_ONLY) await db();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
