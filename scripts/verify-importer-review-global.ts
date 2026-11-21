/**
 * Global AI Importer review improvements (2026-11-21): Verify All Answers, Previous / Next, Student preview, labels.
 * Synthetic scratch DB only (mts_*), no AI, no OCR.
 *   DATABASE_URL=<scratch mts_*> PG_POOL_MAX=3 NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-review-global.ts [setup <out.json> | cleanup <in.json>]
 * With no mode: pure + DB checks, then removes its fixture. "setup" keeps the fixture for the browser suite.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import type { AiImportFigure } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { compareAnswer } from "@/lib/ai-import/verify-answers-core";
import { verifyAnswers } from "@/lib/ai-import/verify-answers";
import { studentContent, studentPreviewOf } from "@/lib/ai-import/adapter";
import { parseKeyAnswer } from "@/lib/ai-import/fidelity";
import { keyPaperChecks } from "@/lib/ai-import/key-check";
import { QUESTION_STATUS_LABELS, ANSWER_STATUS_LABELS } from "@/lib/ai-import/config";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const PRINTED = ["(1)", "(2)", "(3)", "(4)"];
const parse = (raw: string) => parseKeyAnswer(raw, PRINTED);
const ok = (rawValue: string) => ({ rawValue, fileProblem: null });

function pureAnswers() {
  const c = (saved: string[], keys: { rawValue: string; fileProblem: string | null }[], unmapped: string[] = []) => compareAnswer({ saved, keys, unmapped, parse });
  check("answer: saved A, key A → Match", c(["A"], [ok("A")]).verdict === "MATCH");
  check("answer: printed (3) key matches saved C", c(["C"], [ok("(3)")]).verdict === "MATCH");
  check("answer: key 3 (digit) matches saved C", c(["C"], [ok("3")]).verdict === "MATCH");
  check("answer: saved B, key C → Mismatch", c(["B"], [ok("C")]).verdict === "MISMATCH");
  check("answer: nothing saved against a clear key → Mismatch", c([], [ok("D")]).verdict === "MISMATCH");
  check("answer: multiple-correct A,C vs key C,A → Match (order-insensitive)", c(["A", "C"], [ok("C,A")]).verdict === "MATCH");
  check("answer: multiple-correct A vs key A,C → Mismatch", c(["A"], [ok("A,C")]).verdict === "MISMATCH");
  check("answer: no key entry → No key", c(["A"], []).verdict === "NO_KEY");
  check("answer: key entry for the number exists but unmapped → Unverified", c(["A"], [], ["A"]).verdict === "UNVERIFIED");
  check("answer: key from an unidentified / other paper's key file → Unverified (never Match)", c(["A"], [{ rawValue: "A", fileProblem: "mismatch — Paper II" }]).verdict === "UNVERIFIED");
  check("answer: listed twice with different values → Unverified", c(["A"], [ok("A"), ok("B")]).verdict === "UNVERIFIED");
  check("answer: listed twice with the same value → Match", c(["A"], [ok("(1)"), ok("1")]).verdict === "MATCH");
  check("answer: bonus / withdrawn → Unverified", c(["A"], [ok("Bonus")]).verdict === "UNVERIFIED" && c(["A"], [ok("*")]).verdict === "UNVERIFIED");
  check("answer: 'A or B' → Unverified", c(["A"], [ok("A or B")]).verdict === "UNVERIFIED");
  check("answer: value outside the options (5) → Unverified", c(["A"], [ok("5")]).verdict === "UNVERIFIED");
}

const fig = (over: Partial<AiImportFigure>): AiImportFigure =>
  ({ id: "f1", jobId: "j", fileId: "f", questionId: "q", pageNumber: 1, owner: "STEM", optionLabel: null, source: "CROP", originalKey: "files/aa/x.png", originalSha256: "x", originalMime: "image/png", width: 400, height: 200, bytes: 10, description: null, mappingStatus: "MAPPED", ...over }) as unknown as AiImportFigure;
const xq = (over: Partial<ExtractedQuestion>): ExtractedQuestion =>
  ({ section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: "Stem", options: ["A", "B", "C", "D"].map((l, i) => ({ label: l, printed: PRINTED[i], text: `Opt ${l}` })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.9, unreadable: [], figures: [], method: "LOCAL_TEXT", ...over }) as ExtractedQuestion;

// Rendered by scripts/verify-importer-review-global.render.tsx (react-dom/server cannot load under react-server).
const previews: ReturnType<typeof studentPreviewOf>[] = [];

function purePreview() {
  // Plain text with "$" gaining an image becomes RICH_V1 with the "$" kept literal — exactly what the import stores.
  const e1 = xq({ stem: "Costs $5 — see figure", instructions: "Read carefully", passage: "Passage text" });
  const c1 = studentContent({ questionType: "SINGLE_CORRECT" }, e1, [fig({})]);
  check("preview: image makes plain text RICH_V1", c1.rich === true);
  check("preview: instructions + passage prefixed, '$' escaped", c1.text === "Read carefully\n\nPassage text\n\nCosts \\$5 — see figure", c1.text);
  check("preview: stem image alt falls back to 'Figure 1 of question 1'", c1.stemImages[0]?.alt === "Figure 1 of question 1");
  const p1 = studentPreviewOf({ id: "Q1", questionType: "SINGLE_CORRECT", finalAnswer: ["B"] }, e1, [fig({})]);
  previews.push(p1);
  check("preview: saved answer B is the only correct option", p1.q.options.filter((o) => o.isCorrect).map((o) => o.label).join() === "B");
  // Structure-only option: the original image, formula only as alt text.
  const e2 = xq({ options: [{ label: "A", printed: "(1)", text: "$\\ce{CH3COOH}$" }, ...xq({}).options.slice(1)] as ExtractedQuestion["options"], contentFormat: "RICH_V1" });
  const c2 = studentContent({ questionType: "SINGLE_CORRECT" }, e2, [fig({ id: "o1", owner: "OPTION", optionLabel: "A" })]);
  check("preview: structure-only option shows only its image (text empty, formula as alt)", c2.options[0].text === "" && /^Structure \(AI transcription, unverified\)/.test(c2.options[0].images[0].alt), c2.options[0]);
  // A missing figure is never shown.
  check("preview: MISSING figure excluded", studentContent({ questionType: "SINGLE_CORRECT" }, xq({}), [fig({ mappingStatus: "MISSING" })]).stemImages.length === 0);
  // Match the following: lists → matchSpec, rendered by the shared MatchLists.
  const e3 = xq({ type: "MATCH_THE_FOLLOWING", listI: [{ key: "A", text: "Heart" }, { key: "B", text: "Lung" }], listII: [{ key: "1", text: "Pump" }, { key: "2", text: "Gas" }] } as Partial<ExtractedQuestion>);
  const p3 = studentPreviewOf({ id: "Q3", questionType: "MATCH_THE_FOLLOWING", finalAnswer: ["A"] }, e3, []);
  previews.push(p3);
  check("preview: match lists become the stored matchSpec", p3.q.questionType === "MATCH_THE_FOLLOWING" && JSON.stringify(p3.q.matchSpec).includes("Heart"));
  let threw = false;
  try {
    studentContent({ questionType: "MATCH_THE_FOLLOWING" }, xq({ type: "MATCH_THE_FOLLOWING" }), []);
  } catch {
    threw = true;
  }
  check("preview: match question without lists is refused (same as the import)", threw);
  check("preview: a section heading is never the explanation", studentContent({ questionType: "SINGLE_CORRECT" }, xq({ hints: { explanation: "SECTION B" } } as Partial<ExtractedQuestion>), []).explanation === null);
  check("preview: a 5th option is not shown (the Question Bank stores 4)", studentContent({ questionType: "SINGLE_CORRECT" }, xq({ options: [...xq({}).options, { label: "E", printed: "(5)", text: "Opt E" }] as ExtractedQuestion["options"] }), []).options.length === 4);
}

function pureLabels() {
  check("label: READY no longer reads as approval", QUESTION_STATUS_LABELS.READY === "Checks passed");
  check("label: INDEPENDENTLY_VERIFIED is not called an answer-key verification", !/^Answer independently verified$/.test(ANSWER_STATUS_LABELS.INDEPENDENTLY_VERIFIED));
}

async function setup(withFigure = false) {
  const sfx = Date.now().toString(36);
  const master = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } } });
  const exam = await prisma.exam.create({ data: { name: `IRG Exam ${sfx}`, code: `IRG${sfx}`.toUpperCase().slice(0, 20) } });
  const job = await prisma.aiImportJob.create({ data: { title: `IRG import ${sfx}`, status: "NEEDS_REVIEW", examId: exam.id, paperCode: "Paper-1", createdById: master.id, budgetInr: 0, confirmedAt: new Date() } });
  const paper = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "paper.docx", ext: "docx", declaredBytes: 1, uploadedById: master.id, status: "PROCESSED", pageCount: 2, role: "PAPER", detected: { kind: "docx" } } });
  const key = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "key.docx", ext: "docx", declaredBytes: 1, uploadedById: master.id, status: "PROCESSED", pageCount: 1, role: "ANSWER_KEY", paperFileId: paper.id, detected: { kind: "docx" } } });
  // A second key whose printed identity is Paper II: never this paper's key.
  const wrong = await prisma.aiImportFile.create({ data: { jobId: job.id, originalName: "key-paper2.docx", ext: "docx", declaredBytes: 1, uploadedById: master.id, status: "PROCESSED", pageCount: 1, role: "ANSWER_KEY", paperFileId: paper.id, detected: { kind: "docx", keyHeader: { paper: "Paper II", series: null, exam: null, set: null } } } });
  const specs: { n: number; saved: string[]; keys?: string[]; wrongKey?: string; unmapped?: string; multi?: boolean; approved?: boolean; status?: string }[] = [
    { n: 1, saved: ["A"], keys: ["A"], approved: true, status: "READY" },
    { n: 2, saved: ["B"], keys: ["C"] },
    { n: 3, saved: [], keys: ["(4)"] },
    { n: 4, saved: ["A"] },
    { n: 5, saved: ["A"], keys: ["A", "B"] },
    { n: 6, saved: ["A"], keys: ["Bonus"] },
    { n: 7, saved: ["A"], unmapped: "A" },
    { n: 8, saved: ["A", "C"], keys: ["C,A"], multi: true },
    { n: 9, saved: ["A"], wrongKey: "A", status: "IMPORTED" },
  ];
  const ids: string[] = [];
  for (const s of specs) {
    const data = xq({ number: s.n, label: String(s.n), stem: `IRG stem ${s.n} ${sfx}`, type: s.multi ? "MULTIPLE_CORRECT" : "SINGLE_CORRECT" });
    const q = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: paper.id, sourceKey: `#${s.n}`, sourceNumber: s.n, sourceLabel: String(s.n), pages: [1], orderIndex: s.n, status: (s.status ?? "NEEDS_CORRECTION") as never, data: data as never, questionType: s.multi ? "MULTIPLE_CORRECT" : "SINGLE_CORRECT", optionCount: 4, finalAnswer: s.saved, ...(s.approved ? { approvedById: master.id, approvedAt: new Date() } : {}) } });
    ids.push(q.id);
    for (const raw of s.keys ?? []) await prisma.aiImportKeyEntry.create({ data: { jobId: job.id, keyFileId: key.id, paperFileId: paper.id, sourceNumber: s.n, rawValue: raw, matchedQuestionId: q.id } });
    if (s.wrongKey) await prisma.aiImportKeyEntry.create({ data: { jobId: job.id, keyFileId: wrong.id, paperFileId: paper.id, sourceNumber: s.n, rawValue: s.wrongKey, matchedQuestionId: q.id } });
    if (s.unmapped) await prisma.aiImportKeyEntry.create({ data: { jobId: job.id, keyFileId: key.id, paperFileId: paper.id, sourceNumber: s.n, rawValue: s.unmapped } });
  }
  // Browser suite only: a real stem image on Q1, written to the SCRATCH vault (never the default vault path).
  if (withFigure) {
    if (!/^\/root\/mts-scratch\//.test(process.env.AI_IMPORT_VAULT_DIR ?? "")) throw new Error("AI_IMPORT_VAULT_DIR must be a /root/mts-scratch/ directory");
    const sharp = (await import("sharp")).default;
    const { putContent } = await import("@/lib/ai-import/vault");
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();
    const v = await putContent("figures", png, "png");
    await prisma.aiImportFigure.create({ data: { jobId: job.id, fileId: paper.id, questionId: ids[0], pageNumber: 1, owner: "STEM", source: "UPLOAD", originalKey: v.key, originalSha256: v.sha256, originalMime: "image/png", width: 400, height: 200, bytes: png.length, description: "IRG blue figure", mappingStatus: "OK" } });
  }
  return { sfx, examId: exam.id, jobId: job.id, ids, master: master.username };
}

async function cleanup(f: { jobId: string; examId: string }) {
  await prisma.aiImportJob.delete({ where: { id: f.jobId } }).catch(() => undefined);
  await prisma.exam.delete({ where: { id: f.examId } }).catch(() => undefined);
}

async function dbChecks(f: Awaited<ReturnType<typeof setup>>) {
  const states = await keyPaperChecks(f.jobId);
  check("fixture: the Paper II key is not this paper's key", states.some((s) => s.keyFile === "key-paper2.docx" && s.state !== "MATCH" && s.state !== "CONFIRMED"), states.map((s) => [s.keyFile, s.state]));
  const before = await prisma.aiImportQuestion.findMany({ where: { jobId: f.jobId }, orderBy: { orderIndex: "asc" }, select: { id: true, updatedAt: true, finalAnswer: true, approvedById: true, answerStatus: true } });
  const keyBefore = await prisma.aiImportKeyEntry.findMany({ where: { jobId: f.jobId }, orderBy: { id: "asc" } });
  const r = await verifyAnswers(f.jobId);
  const v = Object.fromEntries(r.rows.map((x) => [x.label, x.verdict]));
  const want = { Q1: "MATCH", Q2: "MISMATCH", Q3: "MISMATCH", Q4: "NO_KEY", Q5: "UNVERIFIED", Q6: "UNVERIFIED", Q7: "UNVERIFIED", Q8: "MATCH", Q9: "UNVERIFIED" };
  check("verifyAnswers: per-question verdicts", JSON.stringify(v) === JSON.stringify(want), v);
  check("verifyAnswers: counts 2 / 2 / 4 / 1", JSON.stringify(r.counts) === JSON.stringify({ MATCH: 2, MISMATCH: 2, UNVERIFIED: 4, NO_KEY: 1 }), r.counts);
  check("verifyAnswers: Q3 shows the key as D", r.rows[2].official.join() === "D");
  check("verifyAnswers: rows in paper order", r.rows.map((x) => x.label).join() === "Q1,Q2,Q3,Q4,Q5,Q6,Q7,Q8,Q9");
  const after = await prisma.aiImportQuestion.findMany({ where: { jobId: f.jobId }, orderBy: { orderIndex: "asc" }, select: { id: true, updatedAt: true, finalAnswer: true, approvedById: true, answerStatus: true } });
  const keyAfter = await prisma.aiImportKeyEntry.findMany({ where: { jobId: f.jobId }, orderBy: { id: "asc" } });
  check("verifyAnswers: read-only (questions unchanged, nothing approved)", JSON.stringify(before) === JSON.stringify(after));
  check("verifyAnswers: read-only (key entries unchanged)", JSON.stringify(keyBefore) === JSON.stringify(keyAfter));
  check("verifyAnswers: no AI call logged", (await prisma.aiImportAiCall.count({ where: { jobId: f.jobId } })) === 0);
}

async function main() {
  const [mode, path] = process.argv.slice(2);
  if (mode === "setup") {
    writeFileSync(path, JSON.stringify(await setup(true)));
    console.log(`fixture written to ${path}`);
    return;
  }
  if (mode === "cleanup") {
    await cleanup(JSON.parse(readFileSync(path, "utf8")));
    console.log("fixture removed");
    return;
  }
  pureAnswers();
  purePreview();
  pureLabels();
  if (process.env.PREVIEW_OUT) writeFileSync(process.env.PREVIEW_OUT, JSON.stringify(previews));
  const f = await setup();
  try {
    await dbChecks(f);
  } finally {
    await cleanup(f);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
