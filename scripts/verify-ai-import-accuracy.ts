/**
 * AI Question Importer — question-level accuracy (2026-10-20): segmentation, figure cropping and mapping,
 * formula fidelity, multi-page questions, answer-key matching and validation.
 *
 *   A. Pure checks (no DB, no AI): box scale / validation, figure ↔ question mapping on a page with several
 *      questions (own region, another question's region, one crop on several questions, whole-page crop,
 *      shared figure, several figures on one question, no region), numbers / signs / exponents compared
 *      between reads and with the text layer, lost superscripts, option label sequence / merged options,
 *      placeholder question text, official key values (single, several, compact, alternatives), joining a
 *      question that continues on the next page, duplicate-number reconciliation.
 *   B. End to end on synthetic SCANNED pages (300 dpi scans in a PDF) through the worker with mocked AI:
 *      several questions and figures per page, crops cut from the original scan with their aspect ratio and
 *      resolution, ambiguous mapping left for the administrator, a question spanning two pages (options and
 *      figure joined), a number read twice kept separately, multiple-correct / assertion–reason types kept,
 *      formula difference between the two reads flagged, answer key matched by number with cardinality
 *      checked, nothing approved automatically.
 *   C. Retry of a failed page asks for cost confirmation first and inserts no duplicates.
 *   D. A continuation whose previous page failed is kept visible, then joined after the retry (no duplicate).
 *
 * Scratch DB + scratch storage + its OWN loopback OpenRouter mock (port 3532, started here) — no real AI
 * request is possible (network guard). Removes its jobs; restores Import Settings.
 *
 *   NODE_OPTIONS=--conditions=react-server OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3532 FX_TEST_BASE_URL=http://127.0.0.1:3532 \
 *     npx tsx scripts/verify-ai-import-accuracy.ts <empty fixtures dir>
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { AiImportFileRole, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, saveImporterSettings } from "@/lib/ai-import/settings";
import { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, retryJob } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";
import { pageSchema, toExtracted } from "@/lib/ai-import/prompts";
import { boxScale, checkFigureMapping, normalizeBox, overlappingRegions, MAPPING_CONFIRMED } from "@/lib/ai-import/figure-map";
import { formulaDiff, formulaTokens, lostSuperscript, numbersMissingFromSource, optionProblems, parseKeyAnswer, placeholderStem } from "@/lib/ai-import/fidelity";
import { checkPageStructure, mergeContinuation, readsAgree } from "@/lib/ai-import/process";
import { duplicateNumbers } from "@/lib/ai-import/quality";
import { readVault } from "@/lib/ai-import/vault";
import type { ExtractedQuestion, NBox } from "@/lib/ai-import/types";
import { getOpenRouterConfig, saveOpenRouterKey, setOpenRouterEnabled } from "@/lib/ai-engine/settings";
import { testOpenRouterConnection } from "@/lib/ai-engine/manage";
import { syncCatalog } from "@/lib/ai-engine/catalog";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const MOCK = process.env.OPENROUTER_TEST_BASE_URL ?? "";
if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !/^http:\/\/127\.0\.0\.1:3532$/.test(MOCK)) {
  console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR (scratch) and OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3532 (this suite's own mock).");
  process.exit(2);
}
const FX = process.argv[2];
if (!FX) {
  console.error("usage: verify-ai-import-accuracy.ts <fixtures dir>");
  process.exit(2);
}
mkdirSync(FX, { recursive: true });

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

// ---- Synthetic fixtures -------------------------------------------------------------------------------

/** Same palette as scripts/ai-import-fixtures.ts / the mock (marker square in the top-right corner). */
const PALETTE: [number, number, number][] = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170]];
const W = 1240;
const H = 1754;
/** Page coordinates (px of a 1240×1754 page) → the 0–1000 integers the reader returns. */
const box = (x: number, y: number, w: number, h: number) => ({ x: Math.round((x / W) * 1000), y: Math.round((y / H) * 1000), w: Math.round((w / W) * 1000), h: Math.round((h / H) * 1000) });
const opts = (a: string[]) => a.map((t, i) => ({ label: `(${i + 1})`, text: t }));

/** A scanned page: an SVG drawn at 300 dpi (2480×3508) embedded as the only image of a PDF page. */
async function scanPage(doc: PDFDocument, marker: number, body: string) {
  const c = PALETTE[marker];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fafaf7"/><rect x="${W - 80}" y="0" width="80" height="80" fill="rgb(${c.join(",")})"/>${body}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const page = doc.addPage([595, 842]);
  page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
}
const t = (x: number, y: number, s: string, size = 26) => `<text x="${x}" y="${y}" font-size="${size}" font-family="DejaVu Sans">${s}</text>`;
const fig = (x: number, y: number, w: number, h: number, fill: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/><circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 3}" fill="#444"/>`;

const F1 = { x: 120, y: 160, w: 420, h: 200 };
const F2A = { x: 120, y: 520, w: 360, h: 220 };
const F2B = { x: 620, y: 520, w: 360, h: 220 };
const F4 = { x: 700, y: 960, w: 300, h: 150 }; // drawn inside Q3's part of the page; the reader gives it to Q4
const F5 = { x: 120, y: 150, w: 300, h: 160 };

async function buildFixtures() {
  const mock: { pages: Record<string, unknown>; keys: Record<string, unknown> } = { pages: {}, keys: {} };
  const doc = await PDFDocument.create();
  await scanPage(
    doc,
    1,
    [
      t(80, 130, "1. Identify the structure shown in the figure."),
      fig(F1.x, F1.y, F1.w, F1.h, "#dde"),
      t(80, 410, "(1) Femur (2) Tibia (3) Ulna (4) Radius"),
      t(80, 490, "2. Compare figure P (left) with figure Q (right)."),
      fig(F2A.x, F2A.y, F2A.w, F2A.h, "#ede"),
      fig(F2B.x, F2B.y, F2B.w, F2B.h, "#eed"),
      t(80, 790, "(1) P is larger (2) Q is larger (3) Equal (4) Cannot say"),
      t(80, 950, "3. If x = 3 × 10^-3 m, then 2x is"),
      fig(F4.x, F4.y, F4.w, F4.h, "#ddd"),
      t(80, 1140, "(1) 6 × 10^-3 m (2) 6 × 10^3 m (3) 1.5 × 10^-3 m (4) 6 m"),
      t(80, 1240, "4. Which graph is described in the passage?"),
      t(80, 1300, "(1) Linear (2) Parabolic (3) Hyperbolic (4) Circular"),
      t(80, 1560, "5. The structure labelled X on the next page is"),
      t(80, 1620, "(1) Aorta (2) Vena cava"),
    ].join("")
  );
  await scanPage(
    doc,
    2,
    [
      fig(F5.x, F5.y, F5.w, F5.h, "#cde"),
      t(80, 360, "(3) Pulmonary artery (4) Pulmonary vein"),
      t(80, 460, "6. One or more options may be correct. Which are noble gases?"),
      t(80, 510, "(1) Helium (2) Neon (3) Nitrogen (4) Argon"),
      t(80, 620, "7. Assertion (A): Ice floats on water."),
      t(80, 660, "Reason (R): Ice is less dense than water."),
      t(80, 710, "(1) Both true, R explains A (2) Both true, R does not explain A (3) A true, R false (4) A false, R true"),
      t(80, 820, "6. Which organ produces insulin?"),
      t(80, 870, "(1) Liver (2) Pancreas (3) Kidney (4) Spleen"),
      t(80, 980, "9. Name the bone shown above."),
      t(80, 1030, "(1) Femur (2) Tibia (3) Fibula (4) Patella"),
      t(80, 1140, "10. One or more options may be correct. Which are prime numbers?"),
      t(80, 1190, "(1) 2 (2) 4 (3) 3 (4) 9"),
    ].join("")
  );
  writeFileSync(path.join(FX, "accuracy-scan.pdf"), await doc.save());

  const region = (x: number, y: number, w: number, h: number) => box(x, y, w, h);
  const p1 = [
    { number: 1, type: "SINGLE_CORRECT", stem: "Identify the structure shown in the figure.", options: opts(["Femur", "Tibia", "Ulna", "Radius"]), region: region(60, 95, 1120, 335), figures: [{ box: box(F1.x, F1.y, F1.w, F1.h), owner: "STEM", caption: null, description: "Bone figure" }], confidence: 0.95 },
    { number: 2, type: "SINGLE_CORRECT", stem: "Compare figure P (left) with figure Q (right).", options: opts(["P is larger", "Q is larger", "Equal", "Cannot say"]), region: region(60, 455, 1120, 360), figures: [{ box: box(F2A.x, F2A.y, F2A.w, F2A.h), owner: "STEM", description: "Figure P" }, { box: box(F2B.x, F2B.y, F2B.w, F2B.h), owner: "STEM", description: "Figure Q" }], confidence: 0.95 },
    { number: 3, type: "SINGLE_CORRECT", stem: "If $x = 3 \\times 10^{-3}$ m, then $2x$ is", rich: true, options: opts(["$6 \\times 10^{-3}$ m", "$6 \\times 10^{3}$ m", "$1.5 \\times 10^{-3}$ m", "$6$ m"]), region: region(60, 915, 1120, 250), figures: [], confidence: 0.95 },
    { number: 4, type: "SINGLE_CORRECT", stem: "Which graph is described in the passage?", options: opts(["Linear", "Parabolic", "Hyperbolic", "Circular"]), region: region(60, 1205, 1120, 120), figures: [{ box: box(F4.x, F4.y, F4.w, F4.h), owner: "STEM", description: "Graph" }], confidence: 0.95 },
    { number: 5, type: "SINGLE_CORRECT", stem: "The structure labelled X on the next page is", options: opts(["Aorta", "Vena cava"]), region: region(60, 1525, 1120, 120), figures: [], confidence: 0.9, continues_on_next_page: true },
  ];
  const p2 = [
    { number: 5, type: "SINGLE_CORRECT", stem: "", options: [{ label: "(3)", text: "Pulmonary artery" }, { label: "(4)", text: "Pulmonary vein" }], region: region(60, 120, 1120, 260), figures: [{ box: box(F5.x, F5.y, F5.w, F5.h), owner: "STEM", description: "Heart, X marked" }], confidence: 0.9, continued_from_previous_page: true },
    { number: 6, type: "MULTIPLE_CORRECT", instructions: "One or more options may be correct.", stem: "Which are noble gases?", options: opts(["Helium", "Neon", "Nitrogen", "Argon"]), region: region(60, 425, 1120, 110), figures: [], confidence: 0.95 },
    { number: 7, type: "ASSERTION_REASON", stem: "Assertion (A): Ice floats on water.\nReason (R): Ice is less dense than water.", options: opts(["Both true, R explains A", "Both true, R does not explain A", "A true, R false", "A false, R true"]), region: region(60, 585, 1120, 150), figures: [], confidence: 0.95 },
    // Printed "8." misread as "6." — the same number twice on this page.
    { number: 6, type: "SINGLE_CORRECT", stem: "Which organ produces insulin?", options: opts(["Liver", "Pancreas", "Kidney", "Spleen"]), region: region(60, 785, 1120, 110), figures: [], confidence: 0.9 },
    // A whole-page "figure" on a page with several questions.
    { number: 9, type: "SINGLE_CORRECT", stem: "Name the bone shown above.", options: opts(["Femur", "Tibia", "Fibula", "Patella"]), region: region(60, 945, 1120, 110), figures: [{ box: { x: 0, y: 0, w: 1000, h: 1000 }, owner: "STEM", description: "page" }], confidence: 0.9 },
    { number: 10, type: "MULTIPLE_CORRECT", instructions: "One or more options may be correct.", stem: "Which are prime numbers?", options: opts(["2", "4", "3", "9"]), region: region(60, 1105, 1120, 110), figures: [], confidence: 0.95 },
  ];
  // The independent second read agrees except for the sign of Q3's exponent (a formula misread).
  mock.pages["1"] = { questions: p1, checker: { questions: p1.map((q) => (q.number === 3 ? { ...q, stem: "If $x = 3 \\times 10^{3}$ m, then $2x$ is" } : q)) } };
  mock.pages["2"] = { questions: p2, checker: { questions: p2 } };
  // Answer key (scanned image, marker 4): Q6 multiple-correct but the key gives ONE answer; Q10 compact "AC".
  const c = PALETTE[4];
  writeFileSync(path.join(FX, "accuracy-key.png"), await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="100%" height="100%" fill="#fff"/><rect x="820" y="0" width="80" height="80" fill="rgb(${c.join(",")})"/>${t(40, 140, "KEY 1-(1) 2-(2) 3-(1) ...")}</svg>`)).png().toBuffer());
  mock.keys["4"] = { entries: [["1", "(1)"], ["2", "(2)"], ["3", "(1)"], ["4", "(1)"], ["5", "(3)"], ["6", "(2)"], ["7", "(1)"], ["8", "(2)"], ["9", "(1)"], ["10", "AC"]].map(([number, answer]) => ({ number: Number(number), answer })) };
  writeFileSync(path.join(FX, "accuracy-mock.json"), JSON.stringify(mock));
}

// ---- Job helpers ---------------------------------------------------------------------------------------

const TAG = `acc-${Date.now().toString(36)}`;
const jobs: string[] = [];
async function upload(actor: string, jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER, paperFileId: string | null = null) {
  const bytes = readFileSync(path.join(FX, file));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  await completeFile({ fileId, actorId: actor });
  return fileId;
}
async function runJob(actor: string, jobId: string) {
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const max = (j.estimate as { maxInr: number | null } | null)?.maxInr ?? null;
  await confirmJob({ jobId, actorId: actor, examId: j.examId, paperType: j.paperType, subjectId: j.subjectId, year: j.year, paperCode: j.paperCode, previousYearPaperId: j.previousYearPaperId, confirmedMaxInr: max });
  await runWorker(300_000);
  return prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
}
const mockStats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()) as { chat: number };
const mockConfig = (c: Record<string, unknown>) => fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) });
const questionsOf = (jobId: string) => prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: { orderIndex: "asc" } });
type QRow = Awaited<ReturnType<typeof questionsOf>>[number];
const byLabel = (qs: QRow[], label: string) => qs.find((q) => q.sourceLabel === label);
const data = (q: QRow | undefined) => q?.data as unknown as ExtractedQuestion | undefined;
const boxOf = (f: { box: unknown }) => f.box as (NBox & { crop?: { from: string; width: number; height: number }; reason?: string }) | null;

// ---- Pure-check helpers --------------------------------------------------------------------------------

function q(n: number | null, region: NBox | null, figures: ExtractedQuestion["figures"], extra: Partial<ExtractedQuestion> = {}): ExtractedQuestion {
  return { section: "", number: n, label: String(n ?? "x"), pages: [1], type: "SINGLE_CORRECT", stem: `Question ${n}`, options: opts(["a", "b", "c", "d"]).map((o, i) => ({ label: "ABCD"[i], printed: o.label, text: o.text })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures, method: "AI_VISION", region, ...extra };
}
const f = (b: NBox | null, extra: Partial<ExtractedQuestion["figures"][number]> = {}): ExtractedQuestion["figures"][number] => ({ owner: "STEM", box: b, confidence: 0.75, ...extra });

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const routerWasEnabled = (await getOpenRouterConfig()).enabled;
  const questionsBefore = await prisma.question.count();
  let mockProc: ChildProcess | null = null;

  try {
    // ------------------------------------------------------------------ A
    section("A. Pure checks (no DB, no AI)");
    check("box scale: 0–1 fractions recognized; 0–1000 integers by default", boxScale([{ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }]) === 1 && boxScale([{ x: 100, y: 200, w: 300, h: 100 }]) === 1000);
    const nb = normalizeBox({ x: 100, y: 200, w: 300, h: 100 }, 1000);
    const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9;
    check("box 0–1000 → 0..1 exactly (no stretching)", nb.problem === null && near(nb.box?.x, 0.1) && near(nb.box?.y, 0.2) && near(nb.box?.w, 0.3) && near(nb.box?.h, 0.1), nb);
    check("box with a coordinate above 1000 (pixels) → not used, with a reason", normalizeBox({ x: 1500, y: 20, w: 300, h: 100 }, 1000).box === null && /outside the page/.test(normalizeBox({ x: 1500, y: 20, w: 300, h: 100 }, 1000).problem ?? ""));
    check("box running past the edge → cut at the edge and reported", (() => {
      const r = normalizeBox({ x: 800, y: 100, w: 400, h: 100 }, 1000);
      return !!r.box && Math.abs(r.box.x + r.box.w - 1) < 1e-9 && /page edge/.test(r.problem ?? "");
    })());
    check("empty / negative box → not used", normalizeBox({ x: 10, y: 10, w: 0, h: 50 }, 1000).box === null && normalizeBox({ x: -5, y: 10, w: 50, h: 50 }, 1000).box === null);
    const fracOut = pageSchema.parse({ questions: [{ number: 1, stem: "s", options: ["a", "b", "c", "d"], region: { x: 0.05, y: 0.1, w: 0.9, h: 0.3 }, figures: [{ box: { x: 0.1, y: 0.15, w: 0.3, h: 0.1 }, owner: "STEM" }] }] });
    const [fq] = toExtracted(fracOut, 1, "mock/x");
    check("toExtracted: a page answered in 0–1 fractions keeps its boxes (not shrunk 1000×) and its region", Math.abs((fq.figures[0].box?.w ?? 0) - 0.3) < 1e-9 && Math.abs((fq.region?.h ?? 0) - 0.3) < 1e-9, [fq.figures[0].box, fq.region]);
    const badOut = pageSchema.parse({ questions: [{ number: 1, stem: "s", options: ["a", "b", "c", "d"], figures: [{ box: { x: 1200, y: 100, w: 300, h: 100 }, owner: "STEM" }] }] });
    const [bq] = toExtracted(badOut, 1, "mock/x");
    check("toExtracted: an unusable figure box → no box, lowered confidence, reason kept", bq.figures[0].box === null && bq.figures[0].confidence < 0.75 && /could not be used/.test(bq.figures[0].mappingReason ?? ""), bq.figures[0]);

    // Mapping on one page with several questions.
    const R1 = { x: 0.05, y: 0.05, w: 0.9, h: 0.2 };
    const R2 = { x: 0.05, y: 0.27, w: 0.9, h: 0.2 };
    const R3 = { x: 0.05, y: 0.5, w: 0.9, h: 0.2 };
    const page = [
      q(1, R1, [f({ x: 0.1, y: 0.08, w: 0.3, h: 0.1 })]),
      q(2, R2, [f({ x: 0.1, y: 0.3, w: 0.3, h: 0.1 }), f({ x: 0.5, y: 0.3, w: 0.3, h: 0.1 })]),
      q(3, R3, [f({ x: 0.1, y: 0.08, w: 0.3, h: 0.1 })]), // Q1's figure handed to Q3 too
      q(4, { x: 0.05, y: 0.72, w: 0.9, h: 0.2 }, [f({ x: 0.5, y: 0.52, w: 0.3, h: 0.1 })]), // lies in Q3's region
    ];
    checkFigureMapping(page);
    check("figure inside its own question's region → confirmed (≥ 0.8) with the reason", page[1].figures.every((x) => x.confidence === MAPPING_CONFIRMED && /inside Q2/.test(x.mappingReason ?? "")), page[1].figures);
    check("question with two figures → both kept and confirmed separately", page[1].figures.length === 2);
    check("one crop given to two questions without a shared marker → both unconfirmed, naming the other", page[0].figures[0].confidence < 0.8 && /Q3/.test(page[0].figures[0].mappingReason ?? "") && page[2].figures[0].confidence < 0.8 && /Q1/.test(page[2].figures[0].mappingReason ?? ""), [page[0].figures[0], page[2].figures[0]]);
    check("figure lying in ANOTHER question's region → unconfirmed, names that question (never moved automatically)", page[3].figures[0].confidence < 0.8 && /inside Q3/.test(page[3].figures[0].mappingReason ?? "") && page[3].figures.length === 1, page[3].figures[0]);
    const whole = [q(1, R1, [f({ x: 0, y: 0, w: 1, h: 1 })]), q(2, R2, [])];
    checkFigureMapping(whole);
    check("whole-page crop on a page with several questions → unconfirmed", whole[0].figures[0].confidence < 0.8 && /most of the page/.test(whole[0].figures[0].mappingReason ?? ""), whole[0].figures[0]);
    const shared = [q(2, R2, [f({ x: 0.1, y: 0.22, w: 0.4, h: 0.04 }, { owner: "SHARED", sharedGroup: "p1:2,3" })]), q(3, R3, [f({ x: 0.1, y: 0.22, w: 0.4, h: 0.04 }, { owner: "SHARED", sharedGroup: "p1:2,3" })])];
    checkFigureMapping(shared);
    check("shared figure directly above the questions sharing it → confirmed for its first question, not flagged as a duplicate crop", shared[0].figures[0].confidence === MAPPING_CONFIRMED && !/without being marked as shared/.test(shared[1].figures[0].mappingReason ?? ""), shared.map((x) => x.figures[0]));
    const noRegion = [q(1, null, [f({ x: 0.1, y: 0.1, w: 0.3, h: 0.1 })])];
    checkFigureMapping(noRegion);
    check("no question region → unconfirmed ('could not be checked'), never guessed", noRegion[0].figures[0].confidence < 0.8 && /could not be checked/.test(noRegion[0].figures[0].mappingReason ?? ""));
    const opt = [q(1, R1, [f({ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, { owner: "UNASSIGNED" })])];
    checkFigureMapping(opt);
    check("figure without an owner → unconfirmed", opt[0].figures[0].confidence < 0.8);
    check("overlapping question areas (merged / split questions) reported", overlappingRegions([q(4, R1, []), q(5, { ...R1, y: R1.y + 0.02 }, [])]).length === 1 && overlappingRegions([q(1, R1, []), q(2, R2, [])]).length === 0);
    const dupPage = [q(6, R1, []), q(7, R2, []), q(6, R3, [])];
    checkPageStructure(dupPage, 2);
    check("number read twice on one page → second kept separately: no number, printed number kept, page-qualified label, flagged", dupPage[0].number === 6 && dupPage[2].number === null && dupPage[2].printedNumber === 6 && dupPage[2].label === "6@p2#2" && dupPage[2].confidence <= 0.5, dupPage[2]);

    // Formulas.
    check("formula tokens: 10^{-3} keeps its negative exponent; x^{2} vs x_{2} differ", formulaTokens("$3 \\times 10^{-3}$").includes("^-3") && formulaDiff("$x^{2}$", "$x_{2}$") !== null);
    check("exponent sign change detected (10^{-3} vs 10^{3})", formulaDiff("If $x = 3 \\times 10^{-3}$ m", "If $x = 3 \\times 10^{3}$ m") !== null);
    check("digit / decimal change detected (1.5 vs 15)", formulaDiff("$1.5$ m", "$15$ m") !== null);
    check("Greek letter / inequality change detected (\\alpha vs \\beta, \\leq vs <)", formulaDiff("$\\alpha \\leq 2$", "$\\beta \\leq 2$") !== null && formulaDiff("$x \\leq 2$", "$x < 2$") !== null);
    check("chemistry subscripts compared (\\ce{H2SO4} vs \\ce{H2SO3})", formulaDiff("\\ce{H2SO4}", "\\ce{H2SO3}") !== null && formulaDiff("\\ce{H2SO4}", "\\ce{H2SO4}") === null);
    check("same value written differently is NOT a difference (10^{23} vs 10²³, \\times vs ×)", formulaDiff("$6.02 \\times 10^{23}$", "6.02 × 10²³") === null, [formulaTokens("$6.02 \\times 10^{23}$"), formulaTokens("6.02 × 10²³")]);
    const base1 = q(3, null, [], { stem: "If $x = 3 \\times 10^{-3}$ m, then the value of $2x$ in metres is" });
    const base2 = { ...base1, stem: "If $x = 3 \\times 10^{3}$ m, then the value of $2x$ in metres is" };
    const ra = readsAgree(base1, base2);
    check("two reads that differ only in an exponent sign do NOT agree (text similarity alone would pass)", !ra.agree && ra.fields.includes("question text numbers"), ra);
    check("number missing from the page's text layer is reported; one present is not", numbersMissingFromSource(["Speed is 45 m/s and 3.2 s"], "Q12. A body moves with speed 54 m/s for 3.2 s. Find the distance travelled. (a) 172.8 m (b) 160 m (c) 150 m (d) 120 m").join() === "45", numbersMissingFromSource(["Speed is 45 m/s and 3.2 s"], "Q12. A body moves with speed 54 m/s for 3.2 s. Find the distance travelled. (a) 172.8 m (b) 160 m (c) 150 m (d) 120 m"));
    check("flattened superscript in plain text detected (3 × 108 m/s, 10-3 mol); a range '10-12 years' is not", lostSuperscript("speed 3 × 108 m/s") !== null && lostSuperscript("0.5 × 10-3 mol") !== null && lostSuperscript("children aged 10-12 years") === null);

    // Options and question text.
    const mk = (labels: string[], texts?: string[]) => labels.map((l, i) => ({ label: "ABCDE"[i], printed: l, text: texts?.[i] ?? `opt ${i}` }));
    check("option labels (a),(b),(d) → an option may be missing", optionProblems(mk(["(a)", "(b)", "(d)"]), 5).some((p) => /missing or out of order/.test(p)));
    check("option label printed twice → may belong to another question", optionProblems(mk(["(a)", "(b)", "(a)", "(c)"]), 5).some((p) => /appears twice/.test(p)));
    check("option text containing the start of the next question → may be merged", optionProblems(mk(["(a)", "(b)", "(c)", "(d)"], ["x", "y", "z", "45 13. Which enzyme digests starch?"]), 12).some((p) => /Q13/.test(p)));
    check("clean options (1)–(4) → no problem", optionProblems(mk(["(1)", "(2)", "(3)", "(4)"]), 5).length === 0);
    check("placeholder / instruction stems detected; real stems pass", !!placeholderStem("...", null, false) && !!placeholderStem("Choose the correct answer.", null, false) && !!placeholderStem("Question text not visible", null, false) && !!placeholderStem("Read the passage", "Read the passage", false) && placeholderStem("Which nerve supplies the deltoid?", null, false) === null);

    // Answer key values.
    const P = ["(1)", "(2)", "(3)", "(4)"];
    const lab = (raw: string, p = P) => parseKeyAnswer(raw, p).labels?.join(",") ?? `✗ ${parseKeyAnswer(raw, p).problem}`;
    check("key '(3)' → C; 'B' → B", lab("(3)") === "C" && lab("B") === "B");
    check("key several answers: 'A,C', 'A & C', 'A and C', '(1)(3)', '1, 3' → A,C", ["A,C", "A & C", "A and C", "(1)(3)", "1, 3"].every((r) => lab(r) === "A,C"), ["A,C", "A & C", "A and C", "(1)(3)", "1, 3"].map((r) => lab(r)));
    check("compact key 'AC' → A,C (only letters that are options of this question)", lab("AC") === "A,C" && lab("AE").startsWith("✗"));
    check("'A or C' (alternatives) → not parsed, needs a decision", lab("A or C").startsWith("✗") && /alternatives/.test(lab("A or C")));
    check("value that is not an option (E of four) → refused, never guessed", lab("E").startsWith("✗"));

    // Continuation joining.
    const prev = q(5, null, [], { stem: "The structure labelled X is", options: mk(["(1)", "(2)"], ["Aorta", "Vena cava"]), continuesOnNextPage: true });
    const cont = q(5, null, [f({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 })], { stem: "", options: [{ label: "A", printed: "(3)", text: "Pulmonary artery" }, { label: "B", printed: "(4)", text: "Pulmonary vein" }], continuedFromPreviousPage: true, pages: [2] });
    const m1 = mergeContinuation(prev, cont, 2);
    check("continuation: options appended in printed order and relabelled A–D, pages 1+2, figure kept", m1.options.map((o) => `${o.label}${o.printed}`).join() === "A(1),B(2),C(3),D(4)" && m1.pages.join() === "1,2" && m1.figures.length === 1, m1.options);
    const m5 = mergeContinuation({ ...prev, options: mk(["(1)", "(2)", "(3)", "(4)"]) }, { ...cont, options: mk(["(5)"]) }, 2);
    check("continuation with a fifth option → kept (never cut to four), type FIVE_OPTIONS", m5.options.length === 5 && m5.type === "FIVE_OPTIONS");
    const mt = mergeContinuation(prev, { ...cont, stem: "continued text of option 2", options: [] }, 2);
    check("continuation text that cannot be placed → kept in the notes, confidence lowered (never dropped)", mt.notes?.some((n) => n.includes("continued text of option 2")) === true && mt.confidence <= 0.4);
    const ms = mergeContinuation({ ...prev, options: [] }, { ...cont, stem: "of the heart?" }, 2);
    check("stem split over two pages → joined text, options from the continuation", ms.stem.endsWith("of the heart?") && ms.options.length === 2);

    check("reconciliation: printed number read on two questions → 'Q6 ×2'", duplicateNumbers([{ fileId: "f", section: "", number: 6, printedNumber: null, status: "READY" }, { fileId: "f", section: "", number: null, printedNumber: 6, status: "READY" }, { fileId: "f", section: "", number: 7, printedNumber: null, status: "READY" }]).join() === "Q6 ×2");

    // ------------------------------------------------------------------ B
    section("B. Scanned pages end to end (mocked AI)");
    await buildFixtures();
    mockProc = spawn(process.execPath, ["scripts/mock-openrouter-vision.mjs", "3532", path.join(FX, "accuracy-mock.json")], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${MOCK}/__mock/stats`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
    await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
    await testOpenRouterConnection();
    await setOpenRouterEnabled(true);
    await syncCatalog();
    const importerModels = ["mockvision/reader", "mockvision/checker", "mocktext/classifier"];
    const settings: ImporterSettings = {
      ...savedSettings,
      aiEnabled: true,
      privacy: { dataCollection: "deny", zdr: false },
      selection: { mode: "manual" },
      importerModels,
      budget: { ...savedSettings.budget, maxRequestInr: 1, keyReserveUsd: 5, retryTransient: false, allowPricierFallback: false },
      limits: { ...savedSettings.limits, concurrency: 2 },
      models: { extract: "mockvision/reader", extractFallbacks: [], verify: "mockvision/checker", classify: null, key: null },
    };
    await saveImporterSettings(settings, actor);
    const jB = await createJob({ actorId: actor, title: `Accuracy scan ${TAG}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null });
    jobs.push(jB);
    const paperB = await upload(actor, jB, "accuracy-scan.pdf");
    await upload(actor, jB, "accuracy-key.png", AiImportFileRole.ANSWER_KEY, paperB);
    const jobB = await runJob(actor, jB);
    const qs = await questionsOf(jB);
    check("job finished processing and waits for review", jobB.status === "NEEDS_REVIEW", [jobB.status, jobB.pauseReason, jobB.errorMessage]);
    check("every printed question is present once: Q1–Q7, Q9, Q10 + the second 'Q6' kept separately (10 rows)", qs.length === 10 && ["1", "2", "3", "4", "5", "6", "7", "9", "10"].every((l) => byLabel(qs, l)) && !!byLabel(qs, "6@p2#2"), qs.map((x) => x.sourceLabel));

    const q1 = byLabel(qs, "1")!;
    const f1 = q1.figures[0];
    const b1 = f1 ? boxOf(f1) : null;
    check("Q1: one figure, cropped (not the whole page), placement confirmed by its region", q1.figures.length === 1 && f1.source === "CROP" && f1.mappingStatus === "OK" && !!b1 && b1.w < 0.5 && /inside Q1/.test(b1.reason ?? ""), q1.figures.map((x) => [x.source, x.mappingStatus, x.box]));
    // Expected crop = box + 1.2 % margin of the 2480×3508 ORIGINAL scan.
    const expW = Math.ceil(((F1.w / W) + 0.024) * 2480);
    const expH = Math.ceil(((F1.h / H) + 0.024) * 3508);
    check("Q1 crop cut from the ORIGINAL 300 dpi scan (not the 150 dpi render), at its resolution", b1?.crop?.from === "scan" && Math.abs(f1.width - expW) <= expW * 0.03 && Math.abs(f1.height - expH) <= expH * 0.03, { from: b1?.crop?.from, w: f1?.width, h: f1?.height, expW, expH });
    check("Q1 crop keeps the figure's aspect ratio (±3 %)", Math.abs(f1.width / f1.height - expW / expH) <= (expW / expH) * 0.03, [f1.width / f1.height, expW / expH]);
    const cropBytes = await readVault(f1.originalKey);
    const cm = await sharp(cropBytes).metadata();
    check("stored crop decodes at the recorded size; provenance kept (file, page, box, crop size, question)", cm.width === f1.width && cm.height === f1.height && f1.pageNumber === 1 && f1.fileId === paperB && f1.questionId === q1.id && b1?.crop?.width === f1.width, [cm.width, cm.height, f1.pageNumber]);
    const page1 = await prisma.aiImportPage.findUniqueOrThrow({ where: { fileId_pageNumber: { fileId: paperB, pageNumber: 1 } } });
    const paperFile = await prisma.aiImportFile.findUniqueOrThrow({ where: { id: paperB } });
    check("original upload and page render kept unchanged (crops are separate vault objects)", !!paperFile.storageKey && !!page1.renderKey && paperFile.sha256 === (await import("node:crypto")).createHash("sha256").update(readFileSync(path.join(FX, "accuracy-scan.pdf"))).digest("hex") && f1.originalKey !== page1.renderKey);
    const q2 = byLabel(qs, "2")!;
    check("Q2: two figures on one question, both cropped separately and confirmed", q2.figures.length === 2 && q2.figures.every((x) => x.mappingStatus === "OK" && x.source === "CROP") && new Set(q2.figures.map((x) => x.originalSha256)).size === 2, q2.figures.map((x) => [x.mappingStatus, x.box]));
    const q4 = byLabel(qs, "4")!;
    check("Q4: figure lying in Q3's part of the page → UNCERTAIN, reason names Q3, Q4 blocked until an admin confirms", q4.figures.length === 1 && q4.figures[0].mappingStatus === "UNCERTAIN" && /Q3/.test(boxOf(q4.figures[0])?.reason ?? "") && q4.issueCodes.includes("IMAGE_MAPPING_UNCERTAIN") && q4.status === "NEEDS_CORRECTION", [q4.figures[0]?.mappingStatus, boxOf(q4.figures[0] ?? { box: null })?.reason, q4.issueCodes]);
    const q3 = byLabel(qs, "3")!;
    check("Q3: no figure attached (the figure drawn in its area was claimed by Q4 and is not duplicated)", q3.figures.length === 0);
    check("Q3: the second read's different exponent sign → VERIFY_DISAGREES + FORMULA_ISSUE (formula kept as read, not changed)", q3.issueCodes.includes("VERIFY_DISAGREES") && q3.issueCodes.includes("FORMULA_ISSUE") && data(q3)?.stem.includes("10^{-3}") === true, [q3.issueCodes, (q3.issues as Record<string, string>)?.FORMULA_ISSUE]);
    const q5 = byLabel(qs, "5")!;
    const d5 = data(q5)!;
    check("Q5 spans pages 1–2: joined into ONE question with options (1)–(4) as A–D", d5.options.map((o) => o.printed).join() === "(1),(2),(3),(4)" && d5.options.map((o) => o.label).join("") === "ABCD" && q5.pages.join() === "1,2" && q5.optionCount === 4, [d5.options, q5.pages]);
    check("Q5: the figure printed on page 2 is cropped from page 2 and linked to Q5", q5.figures.length === 1 && q5.figures[0].pageNumber === 2 && q5.figures[0].source === "CROP" && q5.figures[0].mappingStatus === "OK", q5.figures.map((x) => [x.pageNumber, x.mappingStatus]));
    check("Q5: no separate fragment question left over", !qs.some((x) => x.sourceLabel.startsWith("cont")) && qs.filter((x) => x.sourceNumber === 5).length === 1);
    const q6 = byLabel(qs, "6")!;
    const q6b = byLabel(qs, "6@p2#2")!;
    check("second 'Q6' on page 2: own question, no number, NUMBER_CONFLICT (blocking), original Q6 untouched", data(q6b)?.number === null && data(q6b)?.printedNumber === 6 && q6b.issueCodes.includes("NUMBER_CONFLICT") && data(q6)?.stem === "Which are noble gases?", [q6b.issueCodes, data(q6)?.stem]);
    check("Q6 type kept as MULTIPLE_CORRECT; Q7 as ASSERTION_REASON with both statements on separate lines", q6.questionType === "MULTIPLE_CORRECT" && byLabel(qs, "7")!.questionType === "ASSERTION_REASON" && data(byLabel(qs, "7"))!.stem.split("\n").length === 2);
    const q9 = byLabel(qs, "9")!;
    check("Q9: whole-page crop on a page with several questions → UNCERTAIN with reason", q9.figures[0]?.mappingStatus === "UNCERTAIN" && /most of the page/.test(boxOf(q9.figures[0])?.reason ?? ""), q9.figures.map((x) => [x.mappingStatus, boxOf(x)?.reason]));

    // Answer key.
    check("key matched by number: Q1 → A, Q2 → B (official, kept separate from AI opinion)", q1.answerStatus === "OFFICIAL_MATCHED" && q1.officialAnswer.join() === "A" && q2.officialAnswer.join() === "B" && q1.officialAnswerRaw === "(1)", [q1.answerStatus, q1.officialAnswer, q2.officialAnswer, q1.officialAnswerRaw]);
    check("Q5 (spanning pages) gets its key entry by number: (3) → C", q5.officialAnswer.join() === "C" && q5.answerStatus === "OFFICIAL_MATCHED", [q5.officialAnswer, q5.answerStatus]);
    check("Q6 multiple-correct with ONE key answer → ANSWER_TYPE_CONFLICT, no final answer, official value kept as printed", q6.issueCodes.includes("ANSWER_TYPE_CONFLICT") && q6.finalAnswer.length === 0 && q6.officialAnswerRaw === "(2)" && q6.answerStatus === "AMBIGUOUS_MAPPING", [q6.issueCodes, q6.finalAnswer, q6.answerStatus, q6.officialAnswerRaw]);
    const q10 = byLabel(qs, "10")!;
    check("Q10 multiple-correct with compact key 'AC' → official A,C (cardinality fits)", q10.officialAnswer.join() === "A,C" && q10.answerStatus === "OFFICIAL_MATCHED" && q10.finalAnswer.join() === "A,C", [q10.officialAnswer, q10.answerStatus, q10.issueCodes]);
    check("the copy without a number gets NO key entry (never matched by position)", q6b.officialAnswer.length === 0 && q6b.answerStatus !== "OFFICIAL_MATCHED");
    const unmatched = await prisma.aiImportKeyEntry.findMany({ where: { jobId: jB, status: "UNMATCHED" } });
    check("key entry 8 (no question numbered 8 was read) stays UNMATCHED and is reported", unmatched.some((e) => e.sourceNumber === 8));
    check("nothing approved automatically", qs.every((x) => !x.approvedById && x.status !== "IMPORTED" && x.status !== "PUBLISHED"));

    // ------------------------------------------------------------------ C
    section("C. Retry of a failed page: cost confirmation first, no duplicates");
    const beforeIds = new Set(qs.map((x) => x.id));
    const beforeFigs = qs.reduce((a, x) => a + x.figures.length, 0);
    await prisma.aiImportPage.update({ where: { fileId_pageNumber: { fileId: paperB, pageNumber: 2 } }, data: { status: "FAILED", errorMessage: "suite: simulated failure" } });
    const jc = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jB } });
    await prisma.aiImportJob.update({ where: { id: jB }, data: { budgetInr: jc.spentInr } });
    const s0 = await mockStats();
    const r1 = await retryJob(jB, actor);
    check("retry past the confirmed maximum → not started, priced, no request sent", !r1.started && (await mockStats()).chat === s0.chat && (r1.cost?.neededMaxInr ?? 0) > jc.spentInr, r1);
    const r2 = await retryJob(jB, actor, r1.cost?.neededMaxInr);
    check("…confirmed → queued", r2.started);
    await runWorker(300_000);
    const qsC = await questionsOf(jB);
    check("after the retry: same 10 questions (same ids), no duplicate inserted", qsC.length === 10 && qsC.every((x) => beforeIds.has(x.id)), qsC.map((x) => x.sourceLabel));
    check("…Q5 not joined twice (4 options, one page-2 figure) and figure rows not duplicated", data(byLabel(qsC, "5"))!.options.length === 4 && byLabel(qsC, "5")!.figures.length === 1 && qsC.reduce((a, x) => a + x.figures.length, 0) === beforeFigs, [data(byLabel(qsC, "5"))!.options.length, qsC.reduce((a, x) => a + x.figures.length, 0), beforeFigs]);

    // ------------------------------------------------------------------ D
    section("D. Continuation whose previous page failed: kept visible, joined after the retry");
    await mockConfig({ script: { "mockvision/reader": ["malformed"] } });
    await saveImporterSettings({ ...settings, limits: { ...settings.limits, concurrency: 1 } }, actor);
    const jD = await createJob({ actorId: actor, title: `Accuracy continuation ${TAG}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2024, paperCode: null, previousYearPaperId: null });
    jobs.push(jD);
    const paperD = await upload(actor, jD, "accuracy-scan.pdf");
    await runJob(actor, jD);
    const pagesD = await prisma.aiImportPage.findMany({ where: { fileId: paperD }, orderBy: { pageNumber: "asc" } });
    const qsD1 = await questionsOf(jD);
    const frag = qsD1.find((x) => x.sourceLabel.startsWith("cont"));
    check("page 1 failed (unusable answer, no other model allowed) and page 2 was read", pagesD[0]?.status === "FAILED" && pagesD[1]?.status === "DONE", pagesD.map((p) => [p.pageNumber, p.status, p.errorMessage?.slice(0, 80)]));
    check("the continuation of Q5 is kept as its own flagged question (QUESTION_TEXT_SUSPECT), not lost", !!frag && frag.issueCodes.includes("QUESTION_TEXT_SUSPECT") && data(frag)!.options.length === 2, frag ? [frag.sourceLabel, frag.issueCodes] : qsD1.map((x) => x.sourceLabel));
    const rd = await retryJob(jD, actor);
    if (!rd.started) await retryJob(jD, actor, rd.cost?.neededMaxInr);
    await runWorker(300_000);
    const qsD2 = await questionsOf(jD);
    const q5d = byLabel(qsD2, "5");
    check("after the retry: Q5 joined (4 options, pages 1–2, page-2 figure) and the separate part removed", !!q5d && data(q5d)!.options.length === 4 && q5d.pages.join() === "1,2" && q5d.figures.some((x) => x.pageNumber === 2) && !qsD2.some((x) => x.sourceLabel.startsWith("cont")), q5d ? [data(q5d)!.options.length, q5d.pages, qsD2.map((x) => x.sourceLabel)] : qsD2.map((x) => x.sourceLabel));
    check("…same question set as the clean run (10 rows)", qsD2.length === 10, qsD2.map((x) => x.sourceLabel));

    check("the Question Bank is unchanged", (await prisma.question.count()) === questionsBefore);
    // KEEP=<file>: the scanned-paper job is kept for the browser check (scripts are scratch-only).
    if (process.env.KEEP) {
      jobs.splice(jobs.indexOf(jB), 1);
      const kept = await questionsOf(jB);
      writeFileSync(process.env.KEEP, JSON.stringify({ job: jB, q1: byLabel(kept, "1")?.id, q4: byLabel(kept, "4")?.id, q5: byLabel(kept, "5")?.id, q9: byLabel(kept, "9")?.id }));
    }
  } catch (e) {
    fail++;
    console.error(e);
  } finally {
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    await setOpenRouterEnabled(routerWasEnabled).catch(() => undefined);
    if (jobs.length) {
      await prisma.aiBudgetReservation.deleteMany({ where: { OR: jobs.map((id) => ({ requestKey: { startsWith: `qi:${id}:` } })) } }).catch(() => undefined);
      await prisma.aiImportJob.deleteMany({ where: { id: { in: jobs } } }).catch(() => undefined);
    }
    mockProc?.kill();
  }
  check("network guard: every request of this run went to the loopback mock", blockedHosts.size === 0, [...blockedHosts]);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("SOME CHECKS FAILED");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

void main();
