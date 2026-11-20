/**
 * Answer-key integrity + Verify 2 safety regressions (2026-11-20, production job cmwoezrtp00wt8dkz0olhkbo2: the CMS 2026
 * Paper II TEST BOOKLET was linked as Paper I's answer key; Q15's Verify 2 disagreement was cleared by an approval; page 9
 * (FAILED, Q37–Q43) was never sent to Verify 2).
 *   A. Pure (no DB): paper number in the real false-key header, fail-closed identity, booklet / non-mark gate with the
 *      real stored entries, genuine keys (local OCR of the Prepp CMS 2026 keys, fixtures dir) pass the gate.
 *   B. Scratch DB (mts_keyint_* only, no AI, no network): false key never supplies official answers; Q15 approval vs
 *      audited resolution; a FAILED page holding questions is a Verify 2 part; successful parts are not resent.
 *   AI_IMPORT_KEYINT_FIXTURES=<dir with real-key-P1/P2.ocr.json> DATABASE_URL=<scratch mts_keyint_*> PG_POOL_MAX=3 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-key-integrity.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { comparePaperIds, isKeyMark, notAnAnswerKey, paperNumber } from "@/lib/ai-import/key-check";
import { ocrKeyPairs, parseKeyHeader } from "@/lib/ai-import/keys";
import { parseKeyAnswer } from "@/lib/ai-import/fidelity";
import { inScope } from "@/lib/ai-import/paper-verify";
import { structuralPublishIssues } from "@/lib/question-publish-policy";

let pass = 0;
let fail = 0;
const notRun: string[] = [];
function ok(name: string, cond: unknown, info?: unknown) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`, info === undefined ? "" : JSON.stringify(info).slice(0, 300));
  }
}

// The real stored header and representative stored entries of the false key (file cmwof02ps00wy8dkzv8e6sbja).
const FALSE_HEADER = { paper: "T.B.C. : NTDC-T-GSPO — Paper-II", series: "Test Booklet Series A", set: null, totalQuestions: 120, exam: "Combined Medical Services Examination, 2026" };
const FALSE_RAWS = [
  "(c)", "(c)", "(b)", "(d)", "(b)", "(b)", ...Array(29).fill("unreadable"), "a", "a", "b", "a", "(b) Kocher", "(c) 1, 3 and 4", "(c) right subdiaphragmatic abscess", "(b) Lichtenstein’s repair",
  "(b)", "(b)", "(b)", "(b)", "(b)", "(c)", "d", "b", "d", "c", "c", "B", "a", "A", "a", "D", "C", "B", "C", "(a)", "(d)", "(a)", "(d)", "A", "C", "C", "A", "B", "(c)", "(d)", "(a)", "(b)",
  "(a)", "(d)", "(c)", "(b)", "B", "(a)", "(c)", "(a)", "A", "A", "A", "A", "B", "a", "b", "B", "A", "A", "A", "A", "A", "A", "A", "B", "(b) The entire country to have less than", "(a) 35",
  "(a) BCG, Measles, Injectable Polio Vacci", "(a) Local severe disease", "a", "A", "b", "ha kita", "60", "(a)", "(a)", "1",
];

console.log("=== A. Pure checks");
ok("paperNumber reads the real false-key header as Paper 2", paperNumber(FALSE_HEADER.paper) === "2", paperNumber(FALSE_HEADER.paper));
ok("paperNumber keeps the short forms (II, Paper-2, (ii), 1)", paperNumber("II") === "2" && paperNumber("Paper-2") === "2" && paperNumber("(ii)") === "2" && paperNumber("1") === "1");
ok("paperNumber: other long headers (Paper I — General Medicine, PAPER NO. 3)", paperNumber("Paper I — General Medicine & Paediatrics") === "1" && paperNumber("PAPER NO. 3") === "3");
ok("paperNumber: no paper word → null (no guess)", paperNumber("Test Booklet Series A") === null && paperNumber("T.B.C. : NTDC-T-GSPO") === null);
ok("false key vs this job (paper code 1) → MISMATCH", comparePaperIds(FALSE_HEADER, { paper: "1", series: null, totalQuestions: 120, source: "the paper code" }).state === "MISMATCH");
ok("fail closed: key prints a paper, the question paper's number unknown → UNKNOWN (not MATCH) even with the same series", comparePaperIds({ ...FALSE_HEADER, paper: "Paper-I" }, { paper: null, series: "A", totalQuestions: 120, source: "x" }).state === "UNKNOWN");
ok("fail closed: an unreadable printed paper ('T.B.C.') with a known paper → UNKNOWN", comparePaperIds({ ...FALSE_HEADER, paper: "T.B.C. : NTDC-T-GSPO" }, { paper: "1", series: null, totalQuestions: 120, source: "x" }).state === "UNKNOWN");
ok("no header at all → UNKNOWN (fails closed in post.ts)", comparePaperIds(null, { paper: "1", series: null, totalQuestions: 120, source: "x" }).state === "UNKNOWN");
ok("same paper + series → MATCH", comparePaperIds({ paper: "Paper-I", series: "A", set: null, totalQuestions: 120, exam: null }, { paper: "1", series: "A", totalQuestions: 120, source: "x" }).state === "MATCH");
ok("a Test Booklet (32 pages) is never an answer key", /question booklet/.test(notAnAnswerKey(FALSE_HEADER, 32, ["A", "B"]) ?? ""));
ok("the real stored entries alone (any page count) fail the key gate", /not option marks/.test(notAnAnswerKey({ ...FALSE_HEADER, series: "A" }, 1, FALSE_RAWS) ?? ""), notAnAnswerKey({ ...FALSE_HEADER, series: "A" }, 1, FALSE_RAWS));
for (const v of ["60", "unreadable", "(b) Kocher", "(a) 35", "ha kita", "(c) 1, 3 and 4"]) ok(`"${v}" is not a key mark`, !isKeyMark(v));
for (const v of ["B", "(c)", "a.", "A, C", "A & D", "3", "X", "×", "dropped"]) ok(`"${v}" is a key mark`, isKeyMark(v));
for (const v of ["60", "unreadable", "(b) Kocher", "(a) 35"]) ok(`"${v}" never parses as an official answer`, !parseKeyAnswer(v, ["(a)", "(b)", "(c)", "(d)"]).labels);

// Page-limited Verify 2 scope + the unverified-answer publish block (2026-11-20 follow-up).
{
  const sc = { pages: [9, 10, 23], capInr: 1.5 };
  ok("scope: page 9 is in, page 2 is out, a text part is out, no scope = everything", inScope({ kind: "page", pageNumber: 9 }, sc) && !inScope({ kind: "page", pageNumber: 2 }, sc) && !inScope({ kind: "text", pageNumber: undefined }, sc) && inScope({ kind: "page", pageNumber: 2 }, null));
  const base = { reviewRequired: false, reviewReason: null, questionType: "SINGLE_CORRECT" as const, assets: [], text: "Stem", imageUrl: null, options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: l, isCorrect: l === "B", imageUrl: null })) };
  ok("publish blocked while the answer is UNVERIFIED", structuralPublishIssues({ ...base, answerVerification: "UNVERIFIED" }).some((r) => r.code === "ANSWER_UNVERIFIED"));
  ok("publish not blocked for OFFICIAL_KEY / null answer provenance", !structuralPublishIssues({ ...base, answerVerification: "OFFICIAL_KEY" }).length && !structuralPublishIssues({ ...base, answerVerification: null }).length);
}

const FX = process.env.AI_IMPORT_KEYINT_FIXTURES ?? "";
for (const t of ["P1", "P2"]) {
  const f = `${FX}/real-key-${t}.ocr.json`;
  if (!FX || !existsSync(f)) {
    notRun.push(`genuine ${t} key fixture (AI_IMPORT_KEYINT_FIXTURES)`);
    continue;
  }
  const r = ocrKeyPairs(JSON.parse(readFileSync(f, "utf8")), 300);
  const h = parseKeyHeader(r.text);
  ok(`genuine CMS 2026 ${t} key (Prepp, local OCR): ${r.pairs.length} entries, all key marks, passes the key gate`, r.pairs.length >= 100 && r.pairs.every((p) => isKeyMark(p.raw)) && notAnAnswerKey(h, 1, r.pairs.map((p) => p.raw)) === null, { n: r.pairs.length, h });
  if (t === "P2") ok("genuine Paper II key vs a Paper I job → MISMATCH", comparePaperIds(h, { paper: "1", series: null, totalQuestions: 120, source: "x" }).state === "MISMATCH", h);
  if (t === "P1") ok("genuine Paper I key prints no paper number → UNKNOWN (used only after an audited confirmation)", comparePaperIds(h, { paper: "1", series: null, totalQuestions: 120, source: "x" }).state === "UNKNOWN", h);
}

async function dbPart() {
  const DB = process.env.DATABASE_URL ?? "";
  if (!/\/mts_keyint_[a-z0-9_]+$/.test(DB)) {
    notRun.push("B. scratch DB (DATABASE_URL must be a disposable mts_keyint_* database)");
    return;
  }
  const { prisma } = await import("@/lib/prisma");
  const { keyPaperChecks, confirmKeyPaper } = await import("@/lib/ai-import/key-check");
  const { runPostProcessing } = await import("@/lib/ai-import/post");
  const { normalizeImporterSettings } = await import("@/lib/ai-import/config");
  const { getImporterSettings } = await import("@/lib/ai-import/settings");
  const { approveQuestions, resolveVerify2Disagreement } = await import("@/lib/ai-import/review");
  const { fingerprintOf, verify2Units, unitDone } = await import("@/lib/ai-import/paper-verify");
  const { stampOf, verifyState } = await import("@/lib/ai-import/verify-core");
  type Ctx = Parameters<typeof runPostProcessing>[0];
  const TAG = `keyint-${Date.now().toString(36)}`;
  const exam = await prisma.exam.findFirst({ select: { id: true } });
  const admin = await prisma.adminUser.findFirst({ select: { id: true } });
  if (!exam || !admin) {
    notRun.push("B. scratch DB has no exam / admin");
    return;
  }
  const settings = { ...normalizeImporterSettings(await getImporterSettings()), aiEnabled: false };
  const post = async (jobId: string) => runPostProcessing({ job: await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } }), settings, verifyMode: "risk", examName: "Exam", subjectName: null, stillRunning: async () => true } as unknown as Ctx);
  const opts = ["(a)", "(b)", "(c)", "(d)"].map((p, i) => ({ label: "ABCD"[i], printed: p, text: ["first option text", "second option text", "third option text", "fourth option text"][i] }));
  const qData = (n: number, page: number) => ({ number: n, label: String(n), section: "", type: "SINGLE_CORRECT", stem: `Question ${n}: a 50-year-old man presents with breathlessness; which statement is correct ${TAG}?`, instructions: "", passage: "", options: opts, printedAnswer: [], printedAnswerRaw: null, figures: [], pages: [page], confidence: 0.95, method: "LOCAL_OCR", model: null, contentFormat: "TEXT", unreadable: [], notes: [] });
  const job = await prisma.aiImportJob.create({ data: { title: `Key integrity ${TAG}`, examId: exam.id, createdById: admin.id, budgetInr: 0, paperCode: "1", expectedQuestions: 3, status: "NEEDS_REVIEW" } });
  try {
    const paper = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: `paper ${TAG}.pdf`, ext: "pdf", declaredBytes: 1, uploadedById: admin.id, status: "PROCESSED", role: "PAPER", storageKey: `files/zz/${TAG}.pdf`, pageCount: 3, detected: { kind: "pdf" } as never } });
    for (const [n, st] of [[1, "DONE"], [2, "FAILED"], [3, "DONE"]] as const) await prisma.aiImportPage.create({ data: { jobId: job.id, fileId: paper.id, pageNumber: n, status: st, kind: "SCANNED", outcome: "OCR" } });
    const qs = [];
    for (const [n, page] of [[1, 1], [2, 2], [3, 3]] as const) qs.push(await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: paper.id, sourceKey: `#${n}`, sourceLabel: String(n), sourceNumber: n, orderIndex: n, pages: [page], data: qData(n, page) as never, questionType: "SINGLE_CORRECT", optionCount: 4, status: "EXTRACTED" } }));
    // The false key: the booklet header, 32 pages, letters for Q1–Q3 (as the vision models returned).
    const key = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: `QP-booklet-as-key ${TAG}.pdf`, ext: "pdf", declaredBytes: 1, uploadedById: admin.id, status: "PROCESSED", role: "ANSWER_KEY", pageCount: 32, storageKey: `files/a1/${"a1".padEnd(64, "0")}.pdf`, detected: { kind: "pdf", keyHeader: FALSE_HEADER, keyMethod: "ai" } as never } });
    for (const [n, v] of [[1, "(c)"], [2, "B"], [3, "(b) Kocher"]] as const) await prisma.aiImportKeyEntry.create({ data: { jobId: job.id, keyFileId: key.id, sourceNumber: n, rawValue: v, page: 2, section: "" } as never });

    console.log("=== B1. The false key never supplies official answers");
    const chk = (await keyPaperChecks(job.id))[0];
    ok("keyPaperChecks: the booklet key → MISMATCH (question booklet)", chk?.state === "MISMATCH" && /question booklet/.test(chk.detail), chk);
    await post(job.id);
    const after = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id }, orderBy: { sourceNumber: "asc" } });
    ok("no question is OFFICIAL_MATCHED from it; all carry ANSWER_KEY_PAPER_MISMATCH", after.every((q) => q.answerStatus !== "OFFICIAL_MATCHED" && q.issueCodes.includes("ANSWER_KEY_PAPER_MISMATCH") && !q.officialAnswer.length), after.map((q) => [q.answerStatus, q.officialAnswer]));
    ok("no question is Ready", after.every((q) => q.status !== "READY"), after.map((q) => q.status));
    let refused = "";
    try {
      await confirmKeyPaper({ jobId: job.id, keyFileId: key.id, actorId: admin.id, note: "I checked it carefully", source: "OFFICIAL" });
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    ok("a mismatching / non-key file can never be confirmed", /cannot be confirmed/.test(refused), refused);

    console.log("=== B2. Unknown identity fails closed; the audited confirmation is the only way in");
    await prisma.aiImportFile.update({ where: { id: key.id }, data: { pageCount: 1, detected: { kind: "pdf", keyHeader: null, keyMethod: "ocr" } as never } });
    await prisma.aiImportKeyEntry.updateMany({ where: { keyFileId: key.id, sourceNumber: 3 }, data: { rawValue: "D" } });
    const unk = (await keyPaperChecks(job.id))[0];
    ok("a plausible key without a printed identity → UNKNOWN", unk?.state === "UNKNOWN", unk);
    await post(job.id);
    ok("…and its answers are NOT official (fail closed)", (await prisma.aiImportQuestion.findMany({ where: { jobId: job.id } })).every((q) => q.answerStatus !== "OFFICIAL_MATCHED"));
    let short = "";
    try {
      await confirmKeyPaper({ jobId: job.id, keyFileId: key.id, actorId: admin.id, note: "ok", source: "OFFICIAL" });
    } catch (e) {
      short = e instanceof Error ? e.message : "";
    }
    ok("a confirmation needs a real note", /at least 10/.test(short));
    const prov = await confirmKeyPaper({ jobId: job.id, keyFileId: key.id, actorId: admin.id, note: "Prepp provisional key for CMS 2026 Paper I, checked header", source: "PROVISIONAL" });
    ok("a provisional confirmation → PROVISIONAL (labelled, not official)", prov.state === "PROVISIONAL" && /PROVISIONAL key \(not the official key\)/.test(prov.detail), prov);
    await post(job.id);
    ok("…and a provisional key never supplies official answers", (await prisma.aiImportQuestion.findMany({ where: { jobId: job.id } })).every((q) => q.answerStatus !== "OFFICIAL_MATCHED"));
    // Replace the stored confirmation by an official one (a provisional one is not upgraded silently).
    await prisma.aiImportFile.update({ where: { id: key.id }, data: { detected: { kind: "pdf", keyHeader: null, keyMethod: "ocr" } as never } });
    const conf = await confirmKeyPaper({ jobId: job.id, keyFileId: key.id, actorId: admin.id, note: "Compared the key header and five answers with the official UPSC PDF", source: "OFFICIAL" });
    const stored = ((await prisma.aiImportFile.findUniqueOrThrow({ where: { id: key.id } })).detected as { keyPaperConfirmed?: { sha256: string; jobId: string; source: string } }).keyPaperConfirmed;
    ok("confirmation bound to file SHA-256 + job + identity + source", stored?.sha256 === "a1".padEnd(64, "0") && stored?.jobId === job.id && stored?.source === "OFFICIAL", stored);
    ok("confirmed → CONFIRMED, recorded with who / when / note, and a KEY_PAPER_CONFIRMED event", conf.state === "CONFIRMED" && conf.confirmed?.by === admin.id && !!(await prisma.aiImportEvent.findFirst({ where: { jobId: job.id, type: "KEY_PAPER_CONFIRMED" } })));
    await post(job.id);
    ok("…then the key's answers are official", (await prisma.aiImportQuestion.findMany({ where: { jobId: job.id } })).every((q) => q.answerStatus === "OFFICIAL_MATCHED"));

    await prisma.aiImportFile.update({ where: { id: key.id }, data: { storageKey: `files/b2/${"b2".padEnd(64, "0")}.pdf` } });
    const changed = (await keyPaperChecks(job.id))[0];
    ok("a changed file (different SHA-256) voids the confirmation → UNKNOWN again", changed.state === "UNKNOWN" && /no longer applies/.test(changed.detail), changed);
    await prisma.aiImportFile.update({ where: { id: key.id }, data: { storageKey: `files/a1/${"a1".padEnd(64, "0")}.pdf` } });
    console.log("=== B3. Q15: approval never clears a Verify 2 disagreement; resolution is separate and audited");
    const q15 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: qs[0].id }, include: { figures: true } });
    const v2At = new Date(Date.now() - 3600_000).toISOString();
    const v2 = { ...stampOf(fingerprintOf(q15)), at: v2At, model: "google/gemma-4-26b-a4b-it", status: "DISAGREE", fields: [], detail: "question text differs (65% similar); numbers / symbols in question text differ (50 vs —)", part: "paper page 1" };
    const v1 = { ...stampOf(fingerprintOf(q15)), at: v2At, passed: true, problems: [], fixes: [], references: [] };
    await prisma.$executeRaw`UPDATE "AiImportQuestion" SET "data" = jsonb_set("data", '{paperVerify}', ${JSON.stringify({ v1, v2 })}::jsonb) WHERE "id" = ${q15.id}`;
    await post(job.id);
    const before = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q15.id } });
    ok("Q15 carries VERIFY2_DISAGREES", before.issueCodes.includes("VERIFY2_DISAGREES"), before.issueCodes);
    const ap = await approveQuestions([q15.id], admin.id);
    const afterApprove = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q15.id } });
    ok("approving Q15 is refused while the disagreement is open (flag kept, not Ready)", ap.approved === 0 && afterApprove.issueCodes.includes("VERIFY2_DISAGREES") && afterApprove.status !== "READY", { ap, codes: afterApprove.issueCodes, st: afterApprove.status });
    // The production case: an approval given AFTER the Verify 2 result (approved 06:57, result 05:04) used to clear it.
    await prisma.aiImportQuestion.update({ where: { id: q15.id }, data: { approvedById: admin.id, approvedAt: new Date(), reviewedById: admin.id, reviewedAt: new Date() } });
    await post(job.id);
    const legacy = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q15.id } });
    ok("an existing later approval (production Q15 state) no longer clears the flag → blocked from Ready", legacy.issueCodes.includes("VERIFY2_DISAGREES") && legacy.status !== "READY", { codes: legacy.issueCodes, st: legacy.status });
    let noReason = "";
    try {
      await resolveVerify2Disagreement(q15.id, admin.id, "ok");
    } catch (e) {
      noReason = e instanceof Error ? e.message : "";
    }
    ok("resolution needs a reason", /at least 10/.test(noReason));
    await resolveVerify2Disagreement(q15.id, admin.id, "Page 5 prints 'A 50-year-old male' exactly as stored; the second read dropped the 50.");
    const res = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q15.id }, include: { figures: true, checks: true } });
    const vs = verifyState(res.data, fingerprintOf(res));
    const hist = ((res.data as { v2Resolutions?: { v2At: string; by: string; reason: string }[] }).v2Resolutions ?? []);
    ok("after resolution: flag gone, Verify 2 result still DISAGREE on record (history kept)", !res.issueCodes.includes("VERIFY2_DISAGREES") && vs.v2 === "disagree" && vs.pv?.v2?.detail?.includes("50 vs"), { codes: res.issueCodes, v2: vs.v2 });
    ok("resolution recorded: data.v2Resolutions (who / reason / which result), ADMIN check, event", hist.length === 1 && hist[0].v2At === v2At && hist[0].by === admin.id && res.checks.some((c) => c.method === "ADMIN" && /Verify 2 disagreement resolved/.test(c.name)) && !!(await prisma.aiImportEvent.findFirst({ where: { jobId: job.id, type: "VERIFY2_DISAGREEMENT_RESOLVED" } })));
    ok("resolution is not an approval (approval cleared by the re-check, not given)", res.status !== "IMPORTED");
    let twice = "";
    try {
      await resolveVerify2Disagreement(q15.id, admin.id, "again, same result, should be refused");
    } catch (e) {
      twice = e instanceof Error ? e.message : "";
    }
    ok("the same result cannot be resolved twice", /already resolved/.test(twice));
    // A NEW Verify 2 disagreement needs its own decision.
    const fresh = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q15.id }, include: { figures: true } });
    await prisma.$executeRaw`UPDATE "AiImportQuestion" SET "data" = jsonb_set("data", '{paperVerify,v2}', ${JSON.stringify({ ...v2, ...stampOf(fingerprintOf(fresh)), at: new Date().toISOString() })}::jsonb) WHERE "id" = ${q15.id}`;
    await post(job.id);
    const again = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q15.id } });
    ok("a later Verify 2 disagreement re-opens the flag; the earlier resolution stays in history", again.issueCodes.includes("VERIFY2_DISAGREES") && ((again.data as { v2Resolutions?: unknown[] }).v2Resolutions ?? []).length === 1);

    const q2 = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: qs[1].id }, include: { figures: true } });
    await prisma.aiImportQuestion.update({ where: { id: q2.id }, data: { approvedById: admin.id, approvedAt: new Date(Date.now() - 7200_000), reviewedById: admin.id, reviewedAt: new Date(Date.now() - 7200_000) } });
    await prisma.$executeRaw`UPDATE "AiImportQuestion" SET "data" = jsonb_set("data", '{paperVerify}', ${JSON.stringify({ v1: { ...v1, ...stampOf(fingerprintOf(q2)) }, v2: { ...v2, ...stampOf(fingerprintOf(q2)), at: new Date().toISOString() } })}::jsonb) WHERE "id" = ${q2.id}`;
    await post(job.id);
    const q2b = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q2.id } });
    ok("approval given BEFORE a Verify 2 disagreement: the flag appears and the question is not Ready", q2b.issueCodes.includes("VERIFY2_DISAGREES") && q2b.status !== "READY", { codes: q2b.issueCodes, st: q2b.status });
    console.log("=== B4. Verify 2 accounts for every page holding questions");
    const units = await verify2Units(job.id);
    const pagesIn = units.filter((u) => u.kind === "page").map((u) => u.pageNumber);
    ok("a FAILED page holding an extracted question (like page 9) is a Verify 2 part", pagesIn.includes(2) && pagesIn.includes(1) && pagesIn.includes(3), pagesIn);
    await prisma.aiImportPage.create({ data: { jobId: job.id, fileId: paper.id, pageNumber: 4, status: "FAILED", kind: "SCANNED", outcome: "OCR" } });
    const rowsNow = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id }, include: { figures: true } });
    const p1 = units.find((u) => u.pageNumber === 1)!;
    const p2 = units.find((u) => u.pageNumber === 2)!;
    const state = { model: "m/x", doneUnits: [p1.key] } as never;
    ok("idempotent retry: a part already read by the same model with up-to-date results is not resent; the FAILED page is", unitDone(p1, rowsNow, state, "m/x") && !unitDone(p2, rowsNow, state, "m/x"));
    ok("…a different model reads it again (no reuse across models)", !unitDone(p1, [], state, "m/other"));
    ok("a FAILED page with no question is still not sent", !(await verify2Units(job.id)).some((u) => u.pageNumber === 4));
  } finally {
    // Only this fixture's own rows (scratch DB).
    await prisma.aiImportQuestion.deleteMany({ where: { jobId: job.id } }).catch(() => undefined);
    await prisma.aiImportJob.delete({ where: { id: job.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

void (async () => {
  try {
    await dbPart();
  } catch (e) {
    fail++;
    console.log("  FAIL  B crashed:", e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : e);
  }
  for (const n of notRun) console.log(`  NOT RUN  ${n}`);
  console.log(`\nkey-integrity: ${pass} passed, ${fail} failed${notRun.length ? `, ${notRun.length} not run` : ""}`);
  process.exit(fail ? 1 : 0);
})();
