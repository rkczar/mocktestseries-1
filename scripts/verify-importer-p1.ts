/**
 * Importer P1 (2026-11-11) — formula parsing, re-scan pass accounting, academic-review hold. Synthetic / copied test
 * text, disposable scratch DB, scratch storage, mock OpenRouter on loopback: never real AI, never production.
 *
 *   npx tsx scripts/importer-recovery-fixtures.ts /tmp/p1
 *   node scripts/mock-openrouter-vision.mjs 3551 /tmp/p1/mock-vision.json &
 *   AI_IMPORT_DISABLE_KICK=1 AI_IMPORT_OCR=off OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3551 FX_TEST_BASE_URL=http://127.0.0.1:3551 \
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> AI_IMPORT_VAULT_DIR=<scratch> DATABASE_URL=<scratch mts_*> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-p1.ts /tmp/p1
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { saveImporterSettings, getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker } from "@/lib/ai-import/adapter";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, resumeJob, setExpectedQuestions } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { approveQuestions, clearAcademicReview, editQuestion, rescanQuestions, revalidateQuestions, setAcademicReview, setAnswer, setTaxonomy } from "@/lib/ai-import/review";
import { effective } from "@/lib/ai-import/post";
import { escapeLatexCommands, parseModelJson } from "@/lib/ai-import/ai";
import { passCount, withPass } from "@/lib/ai-import/verify-core";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { syncCatalog } from "@/lib/ai-engine/catalog";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

const CONFIRM_ANY = 1_000_000;
if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR and IMPORT_STAGING_DIR to scratch directories.");
  process.exit(2);
}
const FX = process.argv[2];
const MOCK = process.env.OPENROUTER_TEST_BASE_URL!;

// Network guard: only the loopback mock may be contacted.
const blockedHosts = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    blockedHosts.add(host);
    throw new Error(`test network guard: request to ${host} refused`);
  }
  return realFetch(input, init);
}) as typeof fetch;

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}
async function expectError(name: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
    check(name, false, "no error");
  } catch (e) {
    check(name, re.test(e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : e);
  }
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0008\u000c\u000d]|\u0009[A-Za-z]/;
const field = (raw: string) => (parseModelJson(`{"s":"${raw}"}`) as { s: string }).s;

/** 1. Formula parsing: model JSON exactly as a model writes it (single backslashes), parsed by the production function. */
function parserChecks() {
  section("1. Formula parsing — unescaped LaTeX never becomes a control character");
  // Copies of the three corrupted FSO 2019 readings, as the model wrote them (test strings only; production untouched).
  const fso: [string, string][] = [
    ["Q63 stem", String.raw`grows between $16 - 26\text{ }^\text{o}\text{C}$ and in soil pH $6 - 7$ ?`],
    ["Q136 option", String.raw`$13^{\text{th}}$ February, 1986`],
    ["Q139 option", String.raw`$22^{\text{nd}}$ July, 2019 from Satish Dhawan Space Centre`],
  ];
  for (const [name, raw] of fso) {
    const v = field(raw);
    check(`FSO copy ${name}: kept exactly, no TAB`, v === raw && !CONTROL.test(v), JSON.stringify(v));
  }
  const cmds = [String.raw`\text{th}`, String.raw`\textbf{x}`, String.raw`\frac{a}{b}`, String.raw`\beta`, String.raw`\bar{X}`, String.raw`\nu`, String.raw`\neq`, String.raw`\nabla`, String.raw`\rho`, String.raw`\right)`, String.raw`\rightarrow`, String.raw`\times`, String.raw`\theta`, String.raw`\tau`, String.raw`\tfrac{1}{2}`, String.raw`\forall`, String.raw`\bigcirc`, String.raw`\begin{matrix}`, String.raw`\notin`, String.raw`\therefore`];
  for (const c of cmds) {
    const v = field(`$${c}$`);
    check(`${c} survives as LaTeX`, v === `$${c}$` && !CONTROL.test(v), JSON.stringify(v));
  }
  // σ = √(Σ(x − x̄)²/N) — the 2019 Q37 option (2), written with single backslashes.
  const sd = String.raw`$\sigma = \sqrt{\frac{\sum (x - \bar{x})^2}{N}}$`;
  check("standard-deviation formula (Q37-style) survives intact", field(sd) === sd, field(sd));
  // Already-correct JSON is untouched (existing formats preserved).
  const ok = JSON.stringify({ s: String.raw`$13^{\text{th}}$ \ce{C6H6Cl6} $$\frac{a}{b}$$ \beta` });
  check("properly escaped JSON is not changed by the repair", escapeLatexCommands(ok) === ok && (JSON.parse(ok) as { s: string }).s === (parseModelJson(ok) as { s: string }).s);
  check("\\ce{} chemistry kept", field(String.raw`\ce{R - CH2 - OH}`) === String.raw`\ce{R - CH2 - OH}`);
  check("$$ display maths kept", field(String.raw`$$\text{H}_3\text{C}$$`) === String.raw`$$\text{H}_3\text{C}$$`);
  // Real JSON escapes stay real.
  check("a real line break before a word stays a line break (\\nThe)", field(String.raw`Line one\nThe second`) === "Line one\nThe second");
  check("a line break before 'i)' stays a line break (\\ni) is not \\ni)", field(String.raw`Statements:\ni) one\nii) two`) === "Statements:\ni) one\nii) two");
  check("a line break before 'e' stays (\\ne is not treated as LaTeX)", field(String.raw`a\ne b`) === "a\ne b");
  check("a TAB before an ordinary word stays a TAB", field(String.raw`Name\tAge`) === "Name\tAge");
  check("\\\" and \\\\ escapes kept", field(String.raw`say \"hi\" \\ done`) === String.raw`say "hi" \ done`);
  check("Devanagari \\u escapes kept", field(String.raw`कर`) === "कर");
  check("mixed: an invalid escape (\\alpha, repair path) AND \\text in one string both survive", field(String.raw`$\alpha + 1^{\text{st}}$`) === String.raw`$\alpha + 1^{\text{st}}$`);
  check("an escaped backslash followed by text (\\\\\\\\text) is not doubled again", escapeLatexCommands(String.raw`"\\text"`) === String.raw`"\\text"`);
  check("a ```json fence still parses", (parseModelJson("```json\n{\"s\":\"$\\text{a}$\"}\n```") as { s: string }).s === String.raw`$\text{a}$`);
  let threw = false;
  try {
    parseModelJson(`{"s":"cut off`);
  } catch {
    threw = true;
  }
  check("a cut-off answer is still an error (nothing invented)", threw);
}

function passUnitChecks() {
  section("2a. Pass log (pure)");
  const a = withPass(null, "rescan", "m1", "2026-01-01T00:00:00Z", "req-1");
  const b = withPass({ passes: a } as never, "rescan", "m1", "2026-01-01T00:01:00Z", "req-1");
  const c = withPass({ passes: b } as never, "rescan", "m2", "2026-01-01T00:02:00Z", "req-2");
  check("same request reference counted once", a.length === 1 && b.length === 1 && c.length === 2 && c[1].model === "m2", c);
  check("passes without a reference still add (Verify 2 unchanged)", withPass({ passes: a } as never, "v2", "m").length === 2);
}

async function upload(actor: string, jobId: string, file: string) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role: "PAPER" as never, paperFileId: null });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  return { fileId, ...(await completeFile({ fileId, actorId: actor })) };
}
async function setSettings(patch: (s: ImporterSettings) => ImporterSettings, actor: string) {
  await saveImporterSettings(patch(normalizeImporterSettings(await getImporterSettings())), actor);
}
const mockCalls = async () => (await (await realFetch(`${MOCK}/__mock/stats`)).json()) as { byModel: Record<string, number> };
const totalCalls = async () => Object.values((await mockCalls()).byModel).reduce((a, b) => a + b, 0);

async function main() {
  parserChecks();
  passUnitChecks();
  if (!FX) throw new Error("fixture directory missing");
  const suffix = Date.now().toString(36);
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.create({ data: { name: `P1 Exam ${suffix}`, code: `P1-${suffix}`, isActive: true, languageMode: "BILINGUAL" } });
  const bio = await createFixtureSubject(prisma, { examId: exam.id, name: `P1 Biology ${suffix}` });
  const cellT = await createFixtureTopic(prisma, { subjectId: bio.id, name: `P1 Cell ${suffix}` });
  const chem = await createFixtureSubject(prisma, { examId: exam.id, name: `P1 Chemistry ${suffix}` });
  const organic = await createFixtureTopic(prisma, { subjectId: chem.id, name: `P1 Organic ${suffix}` });

  section("Setup: bilingual scanned paper, mock vision (₹0)");
  await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
  check("OpenRouter (mock) connection test", (await testOpenRouterConnection()).ok);
  await setOpenRouterEnabled(true);
  await syncCatalog();
  await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
  const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
  await setSettings((s) => ({ ...s, aiEnabled: true, selection: { mode: "manual" }, importerModels: mockIds, models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null }, privacy: { dataCollection: "deny", zdr: false } }), actor);
  await realFetch(`${MOCK}/__mock/reset`, { method: "POST" });
  const jobId = await createJob({ actorId: actor, title: `P1 paper ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  const paper = await upload(actor, jobId, "recovery-paper.pdf");
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  await setExpectedQuestions({ jobId, actorId: actor, expected: 11 });
  const j0 = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  await confirmJob({ jobId, actorId: actor, examId: j0.examId, paperType: j0.paperType, subjectId: j0.subjectId, year: j0.year, paperCode: j0.paperCode, previousYearPaperId: j0.previousYearPaperId, confirmedMaxInr: CONFIRM_ANY });
  await runWorker(300_000);
  check("job processed", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } })).status === "NEEDS_REVIEW");
  const all = async () => prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true, versions: true }, orderBy: { orderIndex: "asc" } });
  const byNo = async (n: number) => (await all()).find((x) => effective(x).number === n)!;
  const passesOf = async (n: number) => ((await byNo(n)).data as unknown as ExtractedQuestion).paperVerify?.passes ?? [];
  const page1 = await prisma.aiImportPage.findFirstOrThrow({ where: { fileId: paper.fileId, pageNumber: 1 } });

  section("2. Re-scan pass accounting");
  const q2 = await byNo(2);
  const p0 = (await passesOf(2)).length;
  // (a) Budget preflight: the importer budget is used up → refused before anything is queued.
  const settings = await getImporterSettings();
  const { istDay, istMonth } = istDayMonth();
  const filler = await prisma.aiBudgetReservation.create({ data: { requestKey: `p1-filler-${suffix}`, feature: "qimport_extract", reservedInr: settings.budget.totalInr + 1, settledInr: settings.budget.totalInr + 1, costKnown: true, status: "SETTLED", istDay, istMonth } });
  const calls0 = await totalCalls();
  await expectError("budget used up → Re-scan refused by the preflight, with the budget message", () => rescanQuestions([q2.id], "question", actor), /Re-scan not started: [^]*budget[^]*no verification pass was used/);
  const pg1a = await prisma.aiImportPage.findUniqueOrThrow({ where: { id: page1.id } });
  check("…nothing queued: job status unchanged, page 1 has no stored request", (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } })).status === "NEEDS_REVIEW" && !(pg1a.rawOutput as { rescan?: unknown }).rescan && pg1a.status === "DONE");
  check("…no pass used by the refused request", (await passesOf(2)).length === p0);
  // (b) A request consumes nothing; (c) a run that reads nothing consumes nothing.
  await prisma.aiBudgetReservation.delete({ where: { id: filler.id } });
  await rescanQuestions([q2.id], "question", actor);
  check("request accepted → no pass used by the request itself", (await passesOf(2)).length === p0);
  // The budget is used up AFTER the request was accepted: the worker refuses at reserve(), nothing is read.
  const filler2 = await prisma.aiBudgetReservation.create({ data: { requestKey: `p1-filler2-${suffix}`, feature: "qimport_extract", reservedInr: settings.budget.totalInr + 1, settledInr: settings.budget.totalInr + 1, costKnown: true, status: "SETTLED", istDay, istMonth } });
  await runWorker(300_000);
  const jb = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const skipped = await prisma.aiImportEvent.count({ where: { jobId, type: { in: ["AI_SKIPPED", "PAUSED_BUDGET"] } } });
  check("run stopped by the budget (page skipped / paused), no AI request sent", skipped > 0 && (await totalCalls()) === calls0, { s: jb.status, skipped, calls: await totalCalls(), calls0 });
  check("…zero readings → no pass used, no candidate", (await passesOf(2)).length === p0 && !(await byNo(2)).versions.some((v) => v.kind === "RESCAN"));
  check("…the stored request is kept for later", !!((await prisma.aiImportPage.findUniqueOrThrow({ where: { id: page1.id } })).rawOutput as { rescan?: unknown }).rescan);
  // (d) The reading completes and its candidate is saved → exactly one pass, with the model that read it.
  await prisma.aiBudgetReservation.delete({ where: { id: filler2.id } });
  if (jb.status === "PAUSED_BUDGET") check("resumed by an administrator", (await resumeJob(jobId, actor, CONFIRM_ANY)).started);
  else await rescanQuestions([q2.id], "question", actor); // the page was skipped: the administrator requests it again
  await runWorker(300_000);
  const reqAt = ((await prisma.aiImportPage.findUniqueOrThrow({ where: { id: page1.id } })).rawOutput as { rescanReads?: { at: string }[] }).rescanReads?.length;
  const ps = await passesOf(2);
  const cand = (await byNo(2)).versions.find((v) => v.kind === "RESCAN" && v.status === "PENDING");
  check("reading saved as a candidate → exactly ONE pass", !!cand && ps.length === p0 + 1 && reqAt === 1, { ps, cand: !!cand });
  check("…the pass names the model that actually read it, and the request it belongs to", ps.at(-1)?.kind === "rescan" && ps.at(-1)?.model === "mockvision/reader" && typeof ps.at(-1)?.ref === "string", ps.at(-1));
  // (e) Worker retry of the SAME request (e.g. a crash before the page was marked done): no second pass.
  const ref = ps.at(-1)!.ref!;
  const raw = (await prisma.aiImportPage.findUniqueOrThrow({ where: { id: page1.id } })).rawOutput as Record<string, unknown>;
  await prisma.aiImportPage.update({ where: { id: page1.id }, data: { status: "PENDING", rawOutput: { ...raw, rescan: { keys: [q2.sourceKey], requestedById: actor, requestedAt: ref, view: { kind: "PAGE" } } } as never } });
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: "QUEUED" } });
  await runWorker(300_000);
  const ps2 = await passesOf(2);
  check("worker retry of the same request → candidate refreshed, still ONE pass for it", ps2.length === p0 + 1 && ps2.filter((p) => p.ref === ref).length === 1, ps2);
  // (f) NOT_FOUND (the band shows nothing): a reading of nothing for this question → no pass.
  const q3 = await byNo(3);
  const p3 = (await passesOf(3)).length;
  await rescanQuestions([q3.id], "question", actor);
  await runWorker(300_000);
  check("Q3 not found in its band → NOT_FOUND recorded, no pass used", (await byNo(3)).versions.some((v) => v.kind === "RESCAN" && v.status === "NOT_FOUND") && (await passesOf(3)).length === p3);
  // (g) The 3-pass limit is still enforced at request time, now on real readings.
  await rescanQuestions([q2.id], "question", actor);
  await runWorker(300_000);
  await rescanQuestions([q2.id], "question", actor);
  await runWorker(300_000);
  check("three completed readings → three passes", passCount(((await byNo(2)).data as unknown as ExtractedQuestion).paperVerify) === 3, await passesOf(2));
  await expectError("a 4th re-scan is refused (3 verification passes per question)", () => rescanQuestions([q2.id], "question", actor), /already had 3 verification passes/);

  section("3. Academic-review hold");
  const q5 = await byNo(5);
  await setTaxonomy(q5.id, actor, bio.id, cellT.id);
  await setAnswer(q5.id, actor, ["A"]);
  await revalidateQuestions(jobId, [q5.id]);
  const ap0 = await approveQuestions([q5.id], actor);
  check("Q5 approvable before any hold (baseline)", ap0.approved === 1, ap0);
  const firstApproval = await prisma.aiImportEvent.findFirstOrThrow({ where: { jobId, type: "QUESTIONS_APPROVED" }, orderBy: { createdAt: "desc" } });
  await setAcademicReview([q5.id], actor, "AMBIGUOUS_PENDING_ACADEMIC_REVIEW", "Primary S01-T01 vs alternative: S02-T01 (test)");
  let r5 = await byNo(5);
  check("setting a hold withdraws the approval (existing rule) and blocks import", !r5.approvedById && /taxonomy pending academic review/.test(importBlocker(r5, await getImporterSettings()) ?? ""));
  const ap1 = await approveQuestions([q5.id], actor);
  check("…approval refused while held", ap1.approved === 0 && /academic review/.test(ap1.refused[0]?.reason ?? ""), ap1);
  await setTaxonomy(q5.id, actor, chem.id, organic.id);
  r5 = await byNo(5);
  check("manual subject/topic selection does NOT clear the hold", r5.academicReview === "AMBIGUOUS_PENDING_ACADEMIC_REVIEW" && r5.subjectId === chem.id);
  await expectError("clearing without a reason is refused", () => clearAcademicReview(q5.id, actor, "  "), /short reason/);
  await prisma.aiImportQuestion.update({ where: { id: q5.id }, data: { subjectId: null, topicId: null } });
  await expectError("clearing with no subject chosen is refused", () => clearAcademicReview(q5.id, actor, "decided"), /Choose the subject/);
  await setTaxonomy(q5.id, actor, chem.id, organic.id);
  const q4 = await byNo(4);
  await expectError("clearing a question that is not held is refused", () => clearAcademicReview(q4.id, actor, "decided"), /no academic-review hold/);
  r5 = await byNo(5);
  const reviewedAt = r5.reviewedAt?.toISOString() ?? null;
  await clearAcademicReview(q5.id, actor, "Organic chemistry per syllabus unit I (test decision)");
  r5 = await byNo(5);
  check("explicit decision clears the hold", r5.academicReview === null && r5.academicReviewNote === null);
  check("…approval fields untouched by the clear (still not approved; reviewedAt unchanged)", !r5.approvedById && (r5.reviewedAt?.toISOString() ?? null) === reviewedAt);
  const ev = await prisma.aiImportEvent.findFirst({ where: { jobId, type: "ACADEMIC_REVIEW_CLEARED" }, orderBy: { createdAt: "desc" } });
  const evData = ev?.data as { previous?: { status?: string; note?: string }; note?: string } | null;
  check("…event records who, the previous status + note, and the decision reason", ev?.actorId === actor && evData?.previous?.status === "AMBIGUOUS_PENDING_ACADEMIC_REVIEW" && /test/.test(evData?.previous?.note ?? "") && /Organic chemistry/.test(evData?.note ?? ""), ev);
  check("…audit log entry written", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_ACADEMIC_REVIEW_CLEARED" } })) >= 1);
  check("…earlier approval history kept (the original approval event is still there, unchanged)", JSON.stringify(await prisma.aiImportEvent.findUnique({ where: { id: firstApproval.id } })) === JSON.stringify(firstApproval));
  const ap2 = await approveQuestions([q5.id], actor);
  check("…and the question is approvable again (approval is a separate, explicit step)", ap2.approved === 1, ap2);

  check("the hold refusal tells the admin how to clear it (Clear hold card), keeping the code", /AMBIGUOUS_PENDING_ACADEMIC_REVIEW\) — choosing a subject\/topic does not clear this hold: .*Clear hold — mapping confirmed/.test(ap1.refused[0]?.reason ?? ""), ap1.refused[0]);

  section("4. Formula damage + manual formula verification (2026-11-11)");
  const fq = await byNo(3);
  const enStem = effective(fq).stem;
  await setTaxonomy(fq.id, actor, bio.id, cellT.id);
  await setAnswer(fq.id, actor, ["A"]);
  // A formula question read by local OCR (synthetic flag on scratch data): checked against the page, one question at a time.
  const fd3 = fq.data as unknown as ExtractedQuestion;
  await prisma.aiImportQuestion.update({ where: { id: fq.id }, data: { data: { ...fd3, method: "LOCAL_OCR" } as never } });
  await revalidateQuestions(jobId, [fq.id]);
  let fr3 = await byNo(3);
  check("formula question read by OCR → FORMULA_NEEDS_MANUAL_VERIFICATION (not blocking)", fr3.issueCodes.includes("FORMULA_NEEDS_MANUAL_VERIFICATION"), fr3.issueCodes);
  const bulk = await approveQuestions([fq.id, q5.id], actor);
  check("…a bulk approval refuses it (decide on its own page)", bulk.refused.some((x) => x.id === fq.id && /decide it on its own/.test(x.reason)), bulk);
  const single = await approveQuestions([fq.id], actor);
  check("…an individual approval (the admin's check) approves it", single.approved === 1, single);
  // The FSO Q136 failure: \text eaten into TAB + "ext" in the stored English stem.
  const damaged = enStem.replace("\\text", "\text");
  await prisma.aiImportQuestion.update({ where: { id: fq.id }, data: { data: { ...fd3, method: "AI_VISION", stem: damaged } as never } });
  await revalidateQuestions(jobId, [fq.id]);
  fr3 = await byNo(3);
  check("TAB-damaged formula → FORMULA_TEXT_CORRUPT (blocking) with a visible spot + suggestion", fr3.issueCodes.includes("FORMULA_TEXT_CORRUPT") && /⟨TAB⟩ext/.test((fr3.issues as Record<string, string>).FORMULA_TEXT_CORRUPT ?? "") && (fr3.issues as Record<string, string>).FORMULA_TEXT_CORRUPT.includes(enStem), fr3.issues);
  check("…import gate blocks it even though it was approved earlier", !!importBlocker({ ...fr3, figures: [] }, await getImporterSettings()));
  const ap3 = await approveQuestions([fq.id], actor);
  check("…approval refused (approval never clears it)", ap3.approved === 0 && /Formula text damaged/.test(ap3.refused[0]?.reason ?? ""), ap3);
  const before = { stem: effective(fr3).stem, data: JSON.stringify(fr3.data) };
  check("…nothing was rewritten automatically", before.stem === damaged);
  const fe3 = effective(fr3);
  await editQuestion(fq.id, actor, { stem: enStem, options: fe3.options.map((o) => ({ label: o.label, text: o.text })), type: fe3.type, contentFormat: fe3.contentFormat });
  fr3 = await byNo(3);
  check("explicit admin correction stores the fixed text (as an audited edit)", effective(fr3).stem === enStem);
  const ap4 = await approveQuestions([fq.id], actor); // approval re-checks first (no AI)
  fr3 = await byNo(3);
  check("…the re-check clears the damage flag and the corrected question is approvable", ap4.approved === 1 && !fr3.issueCodes.includes("FORMULA_TEXT_CORRUPT"), { ap4, codes: fr3.issueCodes });

  check("no real network host was contacted", blockedHosts.size === 0, [...blockedHosts]);
}

main()
  .then(async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error(e);
    console.log(`\n${pass} passed, ${fail + 1} failed`);
    await prisma.$disconnect();
    process.exit(1);
  });
