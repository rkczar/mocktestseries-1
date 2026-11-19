/**
 * Importer redesign P1 — answer keys & Verify-1 checks (audit 2026-11-19, area C/F/B). Scratch DB only, no AI, no network.
 *
 *  RC1 a local-OCR key reading with partial coverage is used per entry (only AI vision is refused below 90 %); an
 *      uploaded key that gave no entries is reported with its real state, never "No answer key uploaded".
 *  RC2 one spurious section no longer blocks the whole paper: numbers unique across sections match directly.
 *  RC3 "Correct Answer: (B) 1, 2 and 4" is compared with the key as B only (no false KEY_MISMATCH).
 *  RC4 a key entry held back by the number-sequence guard is shown to the reviewer, never applied.
 *  RC5 a statement-code question whose text lost statement 1 (2–4 present) gets STATEMENT_COUNT_MISMATCH.
 *  RC6 FORMULA_ISSUE from the independent read only on rich (TeX) questions; plain text keeps VERIFY_DISAGREES.
 *  RC7 instructions == stem: the message says the text was copied into the instructions field.
 *
 *   /root/mts-scratch/redesign/run-suite.sh scripts/verify-ai-import-redesign-keys.ts
 */
import { AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { keyReadingIncomplete, type KeyPair } from "@/lib/ai-import/keys";
import { printedAnswerForKey, runPostProcessing } from "@/lib/ai-import/post";
import { placeholderStem } from "@/lib/ai-import/fidelity";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import type { StepContext } from "@/lib/ai-import/process";

if (!/\/mts_redesign(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must be the scratch mts_redesign database.");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const section = (s: string) => console.log(`\n=== ${s}`);
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
}

const TAG = "keys";
const RUN = `${TAG}-${Date.now().toString(36)}`;
const ACTOR = `${TAG}-actor`;
const jobs: string[] = [];
let examId = "";

async function job(title: string, expected: number) {
  const j = await prisma.aiImportJob.create({ data: { title: `${TAG} ${title} ${RUN}`, examId, createdById: ACTOR, budgetInr: 0, status: "NEEDS_REVIEW", confirmedAt: new Date(), paperType: AiImportPaperType.FULL_PAPER, expectedQuestions: expected } });
  jobs.push(j.id);
  const paper = await prisma.aiImportFile.create({ data: { jobId: j.id, role: "PAPER", originalName: `${TAG} paper.docx`, ext: "docx", declaredBytes: 1, uploadedById: ACTOR, status: "PROCESSED", detected: { kind: "docx" } } });
  return { jobId: j.id, paperId: paper.id };
}
async function keyFile(jobId: string, paperId: string, detected: Record<string, unknown>, extra: { status?: "PROCESSED" | "ANALYZED"; errorMessage?: string } = {}) {
  return prisma.aiImportFile.create({ data: { jobId, role: "ANSWER_KEY", paperFileId: paperId, originalName: `${TAG} key.jpg`, ext: "jpg", declaredBytes: 1, uploadedById: ACTOR, status: extra.status ?? "PROCESSED", errorMessage: extra.errorMessage ?? null, detected: detected as never } });
}
async function entries(jobId: string, keyFileId: string, paperId: string, values: Record<number, string>) {
  await prisma.aiImportKeyEntry.createMany({ data: Object.entries(values).map(([n, v]) => ({ jobId, keyFileId, paperFileId: paperId, sourceNumber: Number(n), section: "", rawValue: v, labels: [], page: 1 })) });
}
const OPTS = ["Alpha", "Beta", "Gamma", "Delta"];
async function question(jobId: string, fileId: string, order: number, n: number, extra: Partial<ExtractedQuestion> = {}) {
  const data = { number: n, label: String(n), section: "", type: "SINGLE_CORRECT", stem: `Question ${order} about topic ${order}?`, instructions: "", passage: "", options: OPTS.map((t, i) => ({ label: "ABCD"[i], printed: "abcd"[i], text: t })), printedAnswer: [], printedAnswerRaw: null, figures: [], pages: [1], confidence: 0.95, method: "DOCX", model: null, contentFormat: "TEXT", unreadable: [], notes: [], hints: null, listI: null, listII: null, ...extra };
  return prisma.aiImportQuestion.create({ data: { jobId, fileId, sourceKey: `#${order}`, sourceLabel: String(n), sourceNumber: n, orderIndex: order, pages: data.pages as number[], data: data as never, questionType: "SINGLE_CORRECT", optionCount: 4, status: "EXTRACTED" } });
}
const opts = (texts: string[]) => texts.map((t, i) => ({ label: "ABCD"[i], printed: "abcd"[i], text: t }));
async function post(jobId: string) {
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  await runPostProcessing({ job: j, settings: { ...normalizeImporterSettings(await getImporterSettings()), aiEnabled: false }, verifyMode: "risk", examName: "Exam", subjectName: null, stillRunning: async () => true } as unknown as StepContext);
}
const rowsOf = (jobId: string) => prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: { orderIndex: "asc" }, include: { checks: true } });
const issue = (r: { issues: unknown }, code: string) => ((r.issues ?? {}) as Record<string, string>)[code] ?? "";
const keyCheck = (r: { checks: { name: string; detail: string | null }[] }) => r.checks.find((c) => c.name === "Official answer key")?.detail ?? "";

async function main() {
  examId = (await prisma.exam.create({ data: { name: `${TAG} exam ${RUN}`, code: `${TAG.toUpperCase()}-${RUN}` } })).id;

  section("Pure functions");
  const pairs = (n: number): KeyPair[] => Array.from({ length: n }, (_, i) => ({ number: i + 1, section: "", raw: "ABCD"[i % 4] }));
  check("RC1 local OCR reading of 89/120 is NOT refused for coverage", keyReadingIncomplete("ocr", pairs(89), 120) === null);
  check("RC1 AI vision reading of 89/120 is still refused", JSON.stringify(keyReadingIncomplete("ai", pairs(89), 120)) === JSON.stringify({ read: 89, expected: 120 }));
  check("RC3 '(B) 1, 2 and 4' → B only", JSON.stringify(printedAnswerForKey({ printedAnswer: ["B", "A", "D"], printedAnswerRaw: "Correct Answer: (B) 1, 2 and 4" }, ["a", "b", "c", "d"])) === '["B"]');
  check("RC3 '(A) and (C)' keeps both labels", JSON.stringify(printedAnswerForKey({ printedAnswer: ["A", "C"], printedAnswerRaw: "Answer: (A) and (C)" }, ["a", "b", "c", "d"])) === '["A","C"]');
  check("RC3 plain 'Answer: B' unchanged", JSON.stringify(printedAnswerForKey({ printedAnswer: ["B"], printedAnswerRaw: "Answer: B" }, ["a", "b", "c", "d"])) === '["B"]');
  const ph = placeholderStem("Same text here", "Same text here", false) ?? "";
  check("RC7 instructions == stem: message says copied into instructions / prints twice", /copied into the instructions field/.test(ph) && /print twice/.test(ph), ph);

  section("RC1 — partial OCR key used; unread key reported with its state");
  {
    const { jobId, paperId } = await job("rc1-ocr", 10);
    const k = await keyFile(jobId, paperId, { kind: "jpeg", keyMethod: "ocr" });
    await entries(jobId, k.id, paperId, { 1: "B", 2: "C", 3: "D" });
    for (let i = 1; i <= 4; i++) await question(jobId, paperId, i, i);
    await post(jobId);
    const r = await rowsOf(jobId);
    check("3 of 10 OCR entries on a JPEG key are matched (OFFICIAL_MATCHED)", r.slice(0, 3).every((x) => x.answerStatus === "OFFICIAL_MATCHED") && r[0].finalAnswer.join() === "B", r.map((x) => [x.sourceNumber, x.answerStatus]));
    check("the number with no entry stays unverified", r[3].answerStatus !== "OFFICIAL_MATCHED");

    const b = await job("rc1-ai", 10);
    const kb = await keyFile(b.jobId, b.paperId, { kind: "jpeg", keyMethod: "ai" });
    await entries(b.jobId, kb.id, b.paperId, { 1: "B", 2: "C", 3: "D" });
    await question(b.jobId, b.paperId, 1, 1);
    await post(b.jobId);
    check("an AI-vision partial reading (3/10) is still not used", (await rowsOf(b.jobId))[0].answerStatus !== "OFFICIAL_MATCHED");

    const c = await job("rc1-unread", 120);
    await keyFile(c.jobId, c.paperId, { kind: "jpeg" }, { status: "ANALYZED", errorMessage: "Only 85 of 120 answer-key entries could be read." });
    await question(c.jobId, c.paperId, 1, 1);
    await post(c.jobId);
    const d = keyCheck((await rowsOf(c.jobId))[0]);
    check("check detail shows the key's real state, not 'No answer key uploaded'", !/No answer key uploaded/.test(d) && /was uploaded/.test(d) && /Only 85 of 120/.test(d), d);
  }

  section("RC2 — spurious section: unique numbers still match");
  {
    const { jobId, paperId } = await job("rc2", 10);
    const k = await keyFile(jobId, paperId, { kind: "pdf" });
    const key: Record<number, string> = {};
    for (let n = 1; n <= 10; n++) key[n] = "ABCD"[n % 4];
    await entries(jobId, k.id, paperId, key);
    let o = 1;
    for (let n = 1; n <= 8; n++) await question(jobId, paperId, o++, n);
    for (const n of [1, 2, 9, 10]) await question(jobId, paperId, o++, n, { section: "S2" });
    await post(jobId);
    const r = await rowsOf(jobId);
    const st = (sec: string, n: number) => r.find((x) => (x.data as unknown as ExtractedQuestion).section === sec && x.sourceNumber === n)!;
    check("first-section Q3–Q8 matched to key 3–8", [3, 4, 5, 6, 7, 8].every((n) => st("", n).answerStatus === "OFFICIAL_MATCHED" && st("", n).finalAnswer.join() === key[n]), r.map((x) => [x.sourceNumber, x.answerStatus]));
    check("S2 Q9, Q10 (continue past section 1) matched to key 9, 10", [9, 10].every((n) => st("S2", n).answerStatus === "OFFICIAL_MATCHED" && st("S2", n).finalAnswer.join() === key[n]));
    check("Q1, Q2 printed in both sections stay unmatched (ANSWER_AMBIGUOUS with the reason)", [st("", 1), st("", 2), st("S2", 1), st("S2", 2)].every((x) => x.answerStatus === "AMBIGUOUS_MAPPING" && /repeated in another section/.test(issue(x, "ANSWER_AMBIGUOUS"))));
  }

  section("RC2 safety — a real restarted section with a gap never matches by bare number");
  {
    // Key 1–13, sections 6 + 6 = 12: the sizes do not add up, so the fallback decides.
    const { jobId, paperId } = await job("rc2-safe", 13);
    const k = await keyFile(jobId, paperId, { kind: "pdf" });
    const key: Record<number, string> = {};
    for (let n = 1; n <= 13; n++) key[n] = "ABCD"[n % 4];
    await entries(jobId, k.id, paperId, key);
    let o = 1;
    for (const n of [1, 2, 3, 4, 6]) await question(jobId, paperId, o++, n); // first section lost Q5
    for (const n of [1, 2, 3, 4, 5, 6]) await question(jobId, paperId, o++, n, { section: "B" });
    await post(jobId);
    const r = await rowsOf(jobId);
    const b5 = r.find((x) => (x.data as unknown as ExtractedQuestion).section === "B" && x.sourceNumber === 5)!;
    check("section B Q5 (unique, but restarts inside section 1's range) is NOT matched to key 5", b5.answerStatus !== "OFFICIAL_MATCHED", b5.answerStatus);
  }

  section("RC3 — '(B) 1, 2 and 4' printed answer vs key B");
  {
    const { jobId, paperId } = await job("rc3", 1);
    const k = await keyFile(jobId, paperId, { kind: "pdf" });
    await entries(jobId, k.id, paperId, { 1: "B" });
    await question(jobId, paperId, 1, 1, { printedAnswer: ["B", "A", "D"], printedAnswerRaw: "Correct Answer: (B) 1, 2 and 4" });
    await post(jobId);
    const r = (await rowsOf(jobId))[0];
    check("no false KEY_MISMATCH; official answer B", r.answerStatus === "OFFICIAL_MATCHED" && !r.issueCodes.includes("ANSWER_MISMATCH"), [r.answerStatus, r.issues]);
  }

  section("RC4 — key value held back by the sequence guard is shown");
  {
    const { jobId, paperId } = await job("rc4", 5);
    const k = await keyFile(jobId, paperId, { kind: "pdf" });
    await entries(jobId, k.id, paperId, { 1: "A", 2: "B", 3: "C", 4: "D", 5: "A" });
    let o = 1;
    for (const n of [1, 2, 5, 3]) await question(jobId, paperId, o++, n, { method: "AI_VISION" });
    await post(jobId);
    const r = await rowsOf(jobId);
    const q3 = r.find((x) => x.sourceNumber === 3)!;
    const msg = issue(q3, "ANSWER_AMBIGUOUS");
    check("not applied: AMBIGUOUS_MAPPING, no final answer from the key", q3.answerStatus === "AMBIGUOUS_MAPPING" && q3.finalAnswer.length === 0, [q3.answerStatus, q3.finalAnswer]);
    check("reviewer sees 'Key entry 3 = C found but not applied: <reason>'", /^Key entry 3 = C found but not applied: The printed numbers read on page 1/.test(msg), msg);
    check("the stage-3 check shows it too", /Key entry 3 = C found but not applied/.test(keyCheck(q3)));
  }

  section("RC5 / RC6 — statement check and formula flag");
  {
    const { jobId, paperId } = await job("rc56", 3);
    const codes = opts(["1, 2 and 3 only", "2 and 3 only", "1 and 4 only", "2, 3 and 4 only"]);
    await question(jobId, paperId, 1, 1, { stem: "Consider the following statements:\n2. Second statement.\n3. Third statement.\n4. Fourth statement.\nWhich of the statements given above are correct?", options: codes });
    await question(jobId, paperId, 2, 2, { stem: "Consider the following statements:\n1. First statement.\n2. Second statement.\n3. Third statement.\n4. Fourth statement.\nWhich of the statements given above are correct?", options: codes });
    const ver = { model: "mock/ver", agree: false, fields: ["question text numbers"], detail: "question text: “1 2 3” vs “—”", at: new Date().toISOString() };
    await question(jobId, paperId, 3, 3, { verification: ver });
    await question(jobId, paperId, 4, 4, { verification: ver, contentFormat: "RICH_V1", stem: "Evaluate $x^{2}$ at $x = 3$." });
    await post(jobId);
    const r = await rowsOf(jobId);
    const m = issue(r[0], "STATEMENT_COUNT_MISMATCH");
    check("RC5 statement 1 lost (2–4 present) → STATEMENT_COUNT_MISMATCH with the existing message", /^The options refer to statement 4, but the question text has 3 numbered statement\(s\) — one may be missing or merged with another\./.test(m), [m, r[0].issueCodes]);
    check("RC5 complete statements 1–4 → no flag", !r[1].issueCodes.includes("STATEMENT_COUNT_MISMATCH"), r[1].issues);
    check("RC6 plain-text number diff → VERIFY_DISAGREES, no FORMULA_ISSUE", r[2].issueCodes.includes("VERIFY_DISAGREES") && !r[2].issueCodes.includes("FORMULA_ISSUE"), r[2].issueCodes);
    check("RC6 RICH_V1 with TeX → FORMULA_ISSUE kept", r[3].issueCodes.includes("FORMULA_ISSUE"), r[3].issueCodes);
  }
}

main()
  .catch((e) => {
    fail++;
    console.error(e);
  })
  .finally(async () => {
    if (jobs.length) await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs } } });
    if (examId) await prisma.exam.delete({ where: { id: examId } }).catch(() => undefined);
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
