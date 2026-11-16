/**
 * CMS 2026 importer fixes (2026-11-15 audit of jobs cmwhg4ksj… Paper II / cmwhtqe2… Paper I) — regression suite.
 * Scratch DB + scratch storage + the loopback OpenRouter mock: never real AI, never production.
 *
 *   A. Pure (real local-OCR output of the CMS 2026 Paper II key and pages 6 / 26 / 27, scripts/fixtures/ai-import-papers):
 *      scanned key grid → entries (misreads dropped, never guessed); two-column pages split correctly; page 27's
 *      statements 1–4 never become Q1–Q4; options recovered from question text / OCR only when unambiguous.
 *   B. Pipeline on a synthetic 4-page scanned paper (mock vision): option recovery, one bad question isolated, a fully
 *      degenerate page fails alone, answer opinions stop after repeated cut-offs, shifted / off-list classification is
 *      never attached, failed-page retry does not re-read finished pages, worker lanes and leases.
 *   C. Scanned answer key (the REAL CMS 2026 Paper II key PDF, local OCR): empty while OCR is off (PROCESSED + error) →
 *      retryable → read by local OCR → re-read without duplicates.
 *
 *   npx tsx scripts/verify-importer-cms26.ts --fixtures <dir>        (writes cms26-paper.pdf + mock-vision.json)
 *   node scripts/mock-openrouter-vision.mjs 3561 <dir>/mock-vision.json &
 *   AI_IMPORT_DISABLE_KICK=1 OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3561 FX_TEST_BASE_URL=http://127.0.0.1:3561 PG_POOL_MAX=3 \
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> AI_IMPORT_VAULT_DIR=<scratch> DATABASE_URL=<scratch mts_*> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-cms26.ts <dir> [<cms2026 Paper II key PDF>]
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIX = path.join(process.cwd(), "scripts", "fixtures", "ai-import-papers");
const ocrFixture = (name: string) => JSON.parse(readFileSync(path.join(FIX, name), "utf8"));

// ---- Fixture writer (no DB) -----------------------------------------------------------------------------------------
const PALETTE: [number, number, number][] = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0]];
const opt = (xs: string[]) => xs.map((t, i) => ({ label: `(${"abcd"[i]})`, text: t }));
const q = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, type: "SINGLE_CORRECT", stem: `Synthetic item ${n}: which option is correct?`, options: opt([`Alpha ${n}`, `Beta ${n}`, `Gamma ${n}`, `Delta ${n}`]), figures: [], confidence: 0.95, printed_answer: [], ...extra });
async function writeFixtures(dir: string) {
  const sharp = (await import("sharp")).default;
  const { PDFDocument } = await import("pdf-lib");
  mkdirSync(dir, { recursive: true });
  const doc = await PDFDocument.create();
  for (let p = 1; p <= 4; p++) {
    const [r, g, b] = PALETTE[p];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="100%" height="100%" fill="#fafaf7"/><rect x="1160" y="0" width="80" height="61" fill="rgb(${r},${g},${b})"/><rect x="100" y="300" width="500" height="160" fill="#444"/><text x="60" y="200" font-size="26">Page ${p}</text></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const page = doc.addPage([595, 842]);
    page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
  }
  writeFileSync(path.join(dir, "cms26-paper.pdf"), await doc.save());
  // A text-layer paper (read locally, no page AI request): answer opinions and classification only.
  const { StandardFonts } = await import("pdf-lib");
  const tdoc = await PDFDocument.create();
  const font = await tdoc.embedFont(StandardFonts.Helvetica);
  const tp = tdoc.addPage([595, 842]);
  let y = 800;
  for (let n = 1; n <= 5; n++) for (const line of [`${n}. Synthetic text item ${n}: which option is correct?`, `(a) Alpha ${n}`, `(b) Beta ${n}`, `(c) Gamma ${n}`, `(d) Delta ${n}`]) {
    tp.drawText(line, { x: 50, y, size: 11, font });
    y -= 18;
  }
  writeFileSync(path.join(dir, "cms26-text.pdf"), await tdoc.save());
  const mock = {
    pages: {
      "1": { questions: [q(1), q(2)] },
      // Q4: the reader put the options in the question text and returned one "option" (CMS 2026 Q112 pattern).
      "2": { questions: [q(3), q(4, { stem: "Which of the following vaccines are live vaccines?\n(a) BCG, Measles\n(b) OPV, Yellow Fever\n(c) BCG, IPV\n(d) OPV, Hib", options: [{ label: "(a) BCG, Measles", text: "BCG, Measles" }] })] },
      // Q6: one unusable option and nothing to recover it from (CMS 2026 Q35 pattern) — isolated, the page is kept.
      "3": { questions: [q(5), q(6, { options: [{ label: "(a) 1, 2 and 3", text: "1, 2 and 3" }] })] },
      // Every question of page 4 is unusable: the page fails on its own.
      "4": { questions: [q(7, { options: [{ label: "(a) Le Fort IV", text: "Le Fort IV" }] })] },
    },
    keys: {},
  };
  writeFileSync(path.join(dir, "mock-vision.json"), JSON.stringify(mock, null, 1));
  console.log(`fixtures written to ${dir}`);
}

if (process.argv[2] === "--fixtures") {
  writeFixtures(process.argv[3]).then(() => process.exit(0), (e) => (console.error(e), process.exit(1)));
} else {
  main().catch(async (e) => {
    console.error(e);
    process.exit(1);
  });
}

async function main() {
  if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    console.error("Refusing: DATABASE_URL must be a scratch mts_* database.");
    process.exit(2);
  }
  if (!process.env.AI_IMPORT_VAULT_DIR || !process.env.STORAGE_DIR || !process.env.IMPORT_STAGING_DIR || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.OPENROUTER_TEST_BASE_URL ?? "")) {
    console.error("Set AI_IMPORT_VAULT_DIR, STORAGE_DIR, IMPORT_STAGING_DIR (scratch) and OPENROUTER_TEST_BASE_URL (loopback mock).");
    process.exit(2);
  }
  const FX = process.argv[2];
  const KEY_PDF = process.argv[3] ?? null;
  const MOCK = process.env.OPENROUTER_TEST_BASE_URL!;
  // Network guard: only the loopback mock may be contacted (a pass proves no real AI provider was called).
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

  const { AiImportPaperType, AiImportFileRole } = await import("@prisma/client");
  const { prisma } = await import("@/lib/prisma");
  const { CHUNK_BYTES, normalizeImporterSettings } = await import("@/lib/ai-import/config");
  const { saveImporterSettings, getImporterSettings } = await import("@/lib/ai-import/settings");
  const { addFile, completeFile, confirmJob, createJob, putChunk, requestAnalysis, retryJob } = await import("@/lib/ai-import/jobs");
  const { runWorker } = await import("@/lib/ai-import/worker");
  const { effective } = await import("@/lib/ai-import/post");
  const { ocrKeyPairs, keyLooksValid, parseKeyHeader } = await import("@/lib/ai-import/keys");
  const { readOcrPage } = await import("@/lib/ai-import/ocr-page");
  const { splitQuestions } = await import("@/lib/ai-import/local-parse");
  const { optionsFromText, repairDegenerateOptions, incompleteReading, optionOnlyReasons } = await import("@/lib/ai-import/reading-checks");
  const { CLASSIFY_BATCH } = await import("@/lib/ai-import/prompts");
  const { saveOpenRouterKey, setOpenRouterEnabled } = await import("@/lib/ai-engine/settings");
  const { testOpenRouterConnection } = await import("@/lib/ai-engine/manage");
  const { syncCatalog } = await import("@/lib/ai-engine/catalog");
  const { createFixtureSubject, createFixtureTopic } = await import("./fixture-taxonomy");

  let pass = 0;
  let fail = 0;
  const section = (s: string) => console.log(`\n=== ${s}`);
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) pass++;
    else fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  };

  // ======================================================================== A. pure
  section("A1. Scanned answer key read by local OCR (real CMS 2026 Paper II key, Prepp provisional grid)");
  const key = ocrKeyPairs(ocrFixture("cms2026p2-key.ocr.json"), 120);
  const got = new Map(key.pairs.map((p) => [p.number, p.raw]));
  // Values read off the printed grid by a person (2026-11-15), for spot checks across all six columns.
  // The whole printed grid, Q1–Q120, transcribed column by column from the key image (2026-11-15).
  const GRID = "DCCDCABCDBCCBBBBBCDC" + "CBCDCBCBBBBBBDDDABBB" + "CDDCBCAAADBBCCCACCDB" + "BACCCABCABCABCACBDBA" + "CCCDCCCCBBACCBDABBDB" + "CDDADBBACDBBACDCCDAC";
  const truth: Record<number, string> = { 1: "D", 4: "D", 8: "C", 20: "C", 21: "C", 35: "D", 41: "C", 60: "B", 61: "B", 75: "A", 81: "C", 100: "B", 101: "C", 113: "A", 120: "C" };
  check("1. key grid → 112 of 120 entries, a recognisable key", key.pairs.length === 112 && keyLooksValid(key.pairs), key.pairs.length);
  check("   …spot values in every column match the printed grid", Object.entries(truth).every(([n, v]) => got.get(Number(n)) === v), Object.fromEntries(Object.keys(truth).map((n) => [n, got.get(Number(n))])));
  check("   …OCR misreads give NO entry (Q47 value '4', Q106 value '8', Q99 read as '66' between 98 and 100); Q66 (value unread) never gets Q99's answer", [47, 106, 99, 66].every((n) => !got.has(n)), { 66: got.get(66), 99: got.get(99) });
  check("   …every entry read equals the printed grid (all 6 columns checked by a person)", key.pairs.every((p) => GRID[p.number - 1] === p.raw), key.pairs.filter((p) => GRID[p.number - 1] !== p.raw));
  check("   …every value is a single option letter A–D; no number repeated", key.pairs.every((p) => /^[A-D]$/.test(p.raw)) && new Set(key.pairs.map((p) => p.number)).size === key.pairs.length);
  check("   …printed header read (Paper II, Series A, 120 questions)", JSON.stringify(parseKeyHeader(key.text)) === JSON.stringify({ paper: "II", series: "A", set: null, totalQuestions: 120, exam: null }), parseKeyHeader(key.text));
  check("   …low-confidence tokens are never used", ocrKeyPairs({ lines: [{ text: "1", score: 0.99, box: [0, 0, 20, 20] }, { text: "B", score: 0.5, box: [40, 0, 60, 20] }] }).pairs.length === 0);

  section("A2. Two-column pages and numbered statements (real OCR of CMS 2026 Paper II pages 6, 26, 27)");
  const pageQs = (file: string, page: number, last: number) => {
    const st = { last, sectionIdx: 1 };
    const r = readOcrPage(ocrFixture(file), page, st);
    return { qs: r.extraction?.questions ?? [], st };
  };
  const p27 = pageQs("cms2026p2-page27.ocr.json", 27, 113);
  check("7. page 27 → Q114, Q115, Q116 (statements 1–4 are NOT Q1–Q4; no new section)", p27.qs.map((x) => x.label).join() === "114,115,116" && p27.st.last === 116 && p27.st.sectionIdx === 1, p27.qs.map((x) => x.label));
  check("   …Q116 keeps its statements and four options ('(α)' read as '(a)')", p27.qs[2]?.options.length === 4 && /1\. It is to be done/.test(p27.qs[2]?.stem ?? ""), p27.qs[2]);
  check("   …Q115's hanging number moved to the right column (its text is not glued to Q114)", !/115\./.test(p27.qs[0]?.stem ?? "") && /test kits/.test(p27.qs[1]?.stem ?? ""));
  const p6 = pageQs("cms2026p2-page6.ocr.json", 6, 18);
  check("two-column page 6 → Q19–Q22, each with 4 options, no unnumbered fragment", p6.qs.map((x) => `${x.label}:${x.options.length}`).join() === "19:4,20:4,21:4,22:4", p6.qs.map((x) => `${x.label}:${x.options.length}`));
  const p26 = pageQs("cms2026p2-page26.ocr.json", 26, 108);
  check("two-column page 26 → Q109–Q113 (no unnumbered fragment)", p26.qs.map((x) => x.label).join() === "109,110,111,112,113", p26.qs.map((x) => x.label));
  // Synthetic: a restart at 1 whose first two blocks have no options goes back into the open question; a genuine
  // new section (its Q1 has options) still restarts.
  const L = (texts: string[]) => texts.map((text) => ({ text }));
  const stmt = splitQuestions(L(["100. Consider the following statements about registration of pregnancy :", "(a) only one", "(b) two", "(c) three", "(d) four", "1. It is done early.", "2. It is done late.", "3. It is the ASHA."]), { last: 99, sectionIdx: 1 });
  check("   …a statement list after a complete question never opens a new section", stmt.blocks.length === 1 && stmt.blocks[0].number === 100 && /3\. It is the ASHA/.test(stmt.blocks[0].text), stmt.blocks.map((b) => b.label));
  const sec = splitQuestions(L(["100. Last question of part A?", "(a) w", "(b) x", "(c) y", "(d) z", "1. First question of part B?", "(a) p", "(b) q", "(c) r", "(d) s", "2. Second question of part B?", "(a) p", "(b) q", "(c) r", "(d) s"]), { last: 99, sectionIdx: 1 });
  check("   …a genuine restart (its questions have options) still opens a new section", sec.blocks.map((b) => `${b.section}${b.number}`).join() === "100,S21,S22", sec.blocks.map((b) => `${b.section}${b.number}`));

  section("A3. Options inside the question text (CMS 2026 Q35 / Q112 patterns)");
  const inStem = optionsFromText("Which are live vaccines?\n(a) BCG, Measles\n(b) OPV, YF\n(c) BCG, IPV\n(d) OPV, Hib");
  check("5. options recovered from the question text when the (a)–(d) run is unambiguous", inStem?.options.map((o) => o.label).join("") === "ABCD" && inStem.stem === "Which are live vaccines?" && inStem.options[3].text === "OPV, Hib", inStem);
  check("   …OCR's '(α)' accepted as (a) inside a complete run", optionsFromText("Q?\n(α) 1, 2 and 3\n(b) 1, 2 and 4\n(c) 1, 3 and 4\n(d) 2, 3 and 4")?.options[0].text === "1, 2 and 3");
  check("6. a partial run is never completed: (a)(b)(c) only → null", optionsFromText("Q?\n(a) x\n(b) y\n(c) z") === null);
  check("   …a repeated / out-of-order marker is ambiguous → null", optionsFromText("Q?\n(a) x\n(b) y\n(c) z\n(d) w\n(a) again") === null && optionsFromText("Q?\n(a) x\n(c) y\n(b) z\n(d) w") === null);
  const deg = { number: 35, stem: "Which parameters?", options: [{ label: "(a) 1, 2 and 3", printed: "(a) 1, 2 and 3", text: "1, 2 and 3" }], continuedFromPreviousPage: false, continuesOnNextPage: false, notes: [] as string[], confidence: 0.9 };
  const fromOcr = repairDegenerateOptions([deg], (n) => (n === 35 ? "35. Which parameters?\n(α) 1, 2 and 3\n(b) 1, 2 and 4\n(c) 1, 3 and 4\n(d) 2, 3 and 4" : null))[0];
  check("5. a degenerate reading is repaired from the page's local OCR of the same number (flagged, confidence ≤ 0.5)", fromOcr.options.length === 4 && fromOcr.options[3].text === "2, 3 and 4" && (fromOcr.confidence ?? 1) <= 0.5 && /local OCR/.test(fromOcr.notes?.join() ?? ""), fromOcr);
  const unresolved = repairDegenerateOptions([deg], () => null)[0];
  check("6. nothing to recover from → unchanged, still incomplete (no option invented)", unresolved.options.length === 1 && incompleteReading([unresolved]).length === 1);
  check("   …option-only reasons are isolable; a model's own notes are not", optionOnlyReasons(["Q1: one option only, and it is not a printed option (…)"]) && !optionOnlyReasons(["Q1: the question text contains the model's own notes"]));
  check("11. classification requests are smaller (6 questions)", CLASSIFY_BATCH === 6);

  // ======================================================================== B. pipeline
  const suffix = Date.now().toString(36);
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } });
  const actor = admin.id;
  const savedSettings = normalizeImporterSettings(await getImporterSettings());
  const exam = await prisma.exam.create({ data: { name: `C26 Exam ${suffix}`, code: `C26-${suffix}`, isActive: true } });
  const s1 = await createFixtureSubject(prisma, { examId: exam.id, name: `C26 Physiology ${suffix}` });
  await createFixtureTopic(prisma, { subjectId: s1.id, name: `C26 Renal ${suffix}` });
  const s2 = await createFixtureSubject(prisma, { examId: exam.id, name: `C26 Surgery ${suffix}` });
  await createFixtureTopic(prisma, { subjectId: s2.id, name: `C26 Trauma ${suffix}` });
  const jobs: string[] = [];
  const mockCfg = (c: Record<string, unknown>) => realFetch(`${MOCK}/__mock/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
  const upload = async (jobId: string, file: string, role: "PAPER" | "ANSWER_KEY" = "PAPER", paperFileId: string | null = null) => {
    const bytes = readFileSync(file);
    const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: path.basename(file), size: bytes.length, role: role as never, paperFileId });
    for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
    await completeFile({ fileId, actorId: actor });
    return fileId;
  };
  const confirm = async (jobId: string) => {
    const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
    await confirmJob({ jobId, actorId: actor, examId: j.examId, paperType: j.paperType, subjectId: j.subjectId, year: j.year, paperCode: j.paperCode, previousYearPaperId: j.previousYearPaperId, confirmedMaxInr: 1_000_000 });
  };
  try {
    section("B. Pipeline on a synthetic 4-page scanned paper (mock vision, ₹0)");
    await saveOpenRouterKey(`sk-or-v1-mock${"x".repeat(40)}-valid`, "script");
    check("OpenRouter (mock) connection test", (await testOpenRouterConnection()).ok);
    await setOpenRouterEnabled(true);
    await realFetch(`${MOCK}/__mock/reset`, { method: "POST" });
    // The classifier shifts its answers by one question (the CMS 2026 ling-3.0-tiny behaviour).
    await mockCfg({ reasonModels: true, classifyShift: true });
    await syncCatalog();
    await prisma.aiBudgetReservation.deleteMany({ where: { feature: { startsWith: "qimport_" } } });
    const mockIds = (await prisma.aiModel.findMany({ where: { id: { startsWith: "mock" }, isImageModel: false }, select: { id: true } })).map((m) => m.id);
    await saveImporterSettings({ ...savedSettings, aiEnabled: true, selection: { mode: "manual" }, importerModels: mockIds, privacy: { dataCollection: "deny", zdr: false }, limits: { ...savedSettings.limits, concurrency: 2 }, verification: { ...savedSettings.verification, independentAnswer: false }, models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: "mocktext/classifier", key: null } }, actor);
    process.env.AI_IMPORT_OCR = "off";

    const jobId = await createJob({ actorId: actor, title: `C26 paper ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 50 });
    jobs.push(jobId);
    await upload(jobId, path.join(FX, "cms26-paper.pdf"));
    await requestAnalysis(jobId, actor);

    // 9. The analysis lane runs while another worker holds a paid job (lease held by "someone else").
    const busy = await createJob({ actorId: actor, title: `C26 busy ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 1 });
    jobs.push(busy);
    await prisma.aiImportJob.update({ where: { id: busy }, data: { status: "PROCESSING", leaseOwner: "other-worker", leaseUntil: new Date(Date.now() + 10 * 60_000) } });
    const lane = await runWorker(120_000, "analysis");
    const analysed = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
    const busyAfter = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: busy } });
    check("9. analysis lane analysed the new paper while a paid job was leased elsewhere", lane.handled === 1 && analysed.status === "AWAITING_CONFIRMATION", { lane, s: analysed.status });
    check("10. a job leased by another worker is never taken (lease untouched, no page work)", busyAfter.leaseOwner === "other-worker" && busyAfter.status === "PROCESSING" && (await prisma.aiImportPage.count({ where: { jobId: busy } })) === 0);
    await confirm(jobId);
    check("   …the analysis lane never starts paid processing", (await runWorker(30_000, "analysis")).handled === 0 && (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } })).status === "QUEUED");
    await runWorker(300_000);
    const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
    const pages = await prisma.aiImportPage.findMany({ where: { jobId }, orderBy: { pageNumber: "asc" } });
    const qsAll = await prisma.aiImportQuestion.findMany({ where: { jobId } });
    const byNo = (n: number) => qsAll.find((x) => x.sourceNumber === n);
    check("job finished for review", job.status === "NEEDS_REVIEW", { s: job.status, e: job.errorMessage, p: job.pauseReason });
    check("8. page 4 (every question unusable) FAILED alone; pages 1–3 DONE", pages.map((p) => `${p.pageNumber}:${p.status}`).join() === "1:DONE,2:DONE,3:DONE,4:FAILED", pages.map((p) => `${p.pageNumber}:${p.status}`));
    const q4 = byNo(4);
    check("5. Q4's options recovered from its own question text (4 options, flagged for checking)", q4?.optionCount === 4 && effective(q4).options[3]?.text === "OPV, Hib" && q4.status !== "READY", { n: q4?.optionCount, s: q4?.status });
    const q6 = byNo(6);
    check("6. Q6 (one unusable option, nothing to recover from) saved for correction, not invented; page 3 kept", q6?.optionCount === 1 && ["NEEDS_CORRECTION", "NOT_IMPORTABLE"].includes(q6.status) && !q6.approvedById && !!byNo(5), { n: q6?.optionCount, s: q6?.status, codes: q6?.issueCodes });
    check("   …the isolation is recorded", (await prisma.aiImportEvent.count({ where: { jobId, type: "PAGE_QUESTIONS_ISOLATED" } })) === 1);
    check("   …no Q7 row from the failed page; numbers 1–6 once each", !byNo(7) && [1, 2, 3, 4, 5, 6].every((n) => qsAll.filter((x) => x.sourceNumber === n).length === 1), qsAll.map((x) => x.sourceNumber));

    const classified = qsAll.filter((x) => x.taxonomySource?.startsWith("ai"));
    const classifyEvent = await prisma.aiImportEvent.findFirst({ where: { jobId, type: "CLASSIFY_RESULT" } });
    check("11. shifted classifier answers are never attached to another question", classified.length === 0, { classified: classified.map((x) => [x.sourceNumber, x.taxonomySource]), ev: classifyEvent?.message });

    // 13. Retry of the failed page: finished pages are not read or charged again.
    const before = await prisma.aiImportAiCall.groupBy({ by: ["pageId"], where: { jobId, task: "extract" }, _count: true });
    await mockCfg({ reasonModels: true, classifyShift: false });
    const retry = await retryJob(jobId, actor, 1_000_000);
    check("retry of the failed page started", retry.started, retry);
    await runWorker(300_000);
    const after = await prisma.aiImportAiCall.groupBy({ by: ["pageId"], where: { jobId, task: "extract" }, _count: true });
    const donePages = pages.filter((p) => p.status === "DONE").map((p) => p.id);
    const countOf = (rows: typeof before, id: string) => rows.find((r) => r.pageId === id)?._count ?? 0;
    check("13. checkpoint resume: no new extract call for pages 1–3, page 4 read again", donePages.every((id) => countOf(after, id) === countOf(before, id)) && countOf(after, pages[3].id) > countOf(before, pages[3].id), { before, after });
    check("   …no duplicate question rows after the retry", (await prisma.aiImportQuestion.count({ where: { jobId } })) === qsAll.length);

    section("B2. Text-layer paper: answer opinions cut off at the limit, off-list classification codes");
    // mockreason/think: a reasoning model; every answer opinion is cut off. The classifier answers with codes not on the list.
    await mockCfg({ reasonModels: true, script: { "mockreason/think": Array(60).fill("length"), "mocktext/classifier": Array(20).fill("badcodes") } });
    await saveImporterSettings({ ...normalizeImporterSettings(await getImporterSettings()), verification: { ...savedSettings.verification, independentAnswer: true }, models: { extract: "mockvision/reader", extractFallbacks: [], verify: "mockreason/think", classify: "mocktext/classifier", key: null } }, actor);
    const tj = await createJob({ actorId: actor, title: `C26 text ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 50 });
    jobs.push(tj);
    await upload(tj, path.join(FX, "cms26-text.pdf"));
    await requestAnalysis(tj, actor);
    await runWorker(120_000);
    await confirm(tj);
    await runWorker(300_000);
    const tq = await prisma.aiImportQuestion.findMany({ where: { jobId: tj } });
    const opinions = await prisma.aiImportAiCall.findMany({ where: { jobId: tj, stage: "post-answer-opinion" }, select: { questionId: true, ok: true, errorSummary: true } });
    const stopped = await prisma.aiImportEvent.findFirst({ where: { jobId: tj, type: "AI_OPINION_STOPPED" } });
    const asked = new Set(opinions.map((o) => o.questionId)).size;
    check("text paper read locally: 5 questions, no page AI request", tq.length === 5 && (await prisma.aiImportAiCall.count({ where: { jobId: tj, task: "extract" } })) === 0, tq.length);
    check("4. cut-off answer opinions stop after 3 in a row (5 questions needed one)", asked === 3 && opinions.every((o) => !o.ok) && !!stopped && /2 question\(s\) were not sent/.test(stopped.message), { asked, n: opinions.length, ev: stopped?.message });
    check("   …the exact reason is recorded on each call; unanswered questions keep no AI answer (manual verification)", opinions.every((o) => /cut off|output limit/.test(o.errorSummary ?? "")) && tq.every((x) => !x.aiAnswer.length), opinions[0]?.errorSummary);
    check("   …a reasoning model gets the larger, model-aware output limit (2,400 tokens, not 600)", /2400-token/.test(stopped?.message ?? ""), stopped?.message);
    const allowed = new Set([s1.id, s2.id]);
    check("12. off-list taxonomy codes are rejected: no AI subject / topic attached", tq.every((r) => !r.taxonomySource?.startsWith("ai")) && tq.every((r) => r.subjectId === null || allowed.has(r.subjectId)), tq.map((r) => [r.subjectId, r.taxonomySource]));

    // ====================================================================== C. scanned key
    if (KEY_PDF) {
      section("C. Scanned answer key (real CMS 2026 Paper II key PDF, local OCR, no AI)");
      await saveImporterSettings({ ...normalizeImporterSettings(await getImporterSettings()), verification: { ...savedSettings.verification, independentAnswer: false }, models: { extract: "mockvision/reader", extractFallbacks: [], verify: null, classify: null, key: null } }, actor);
      const kj = await createJob({ actorId: actor, title: `C26 key ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 50 });
      jobs.push(kj);
      const paperId = await upload(kj, path.join(FX, "cms26-paper.pdf"));
      const keyId = await upload(kj, KEY_PDF, "ANSWER_KEY", paperId);
      await requestAnalysis(kj, actor);
      await runWorker(120_000);
      await confirm(kj);
      await runWorker(300_000);
      let kf = await prisma.aiImportFile.findUniqueOrThrow({ where: { id: keyId } });
      check("OCR off + no key model → key PROCESSED with an error, 0 entries (the production state)", kf.status === "PROCESSED" && !!kf.errorMessage && (await prisma.aiImportKeyEntry.count({ where: { keyFileId: keyId } })) === 0, { s: kf.status, e: kf.errorMessage });
      delete process.env.AI_IMPORT_OCR;
      const keyCallsBefore = await prisma.aiImportAiCall.count({ where: { jobId: kj, task: "key" } }); // phase 1 may fall back to the extract model
      const r2 = await retryJob(kj, actor, 1_000_000);
      check("2. a PROCESSED-with-error key makes the import retryable", r2.started && (await prisma.aiImportFile.findUniqueOrThrow({ where: { id: keyId } })).status === "ANALYZED", r2);
      await runWorker(400_000);
      kf = await prisma.aiImportFile.findUniqueOrThrow({ where: { id: keyId } });
      const entries = await prisma.aiImportKeyEntry.findMany({ where: { keyFileId: keyId } });
      check("1. scanned one-page key read by local OCR: 112 entries, error cleared", kf.status === "PROCESSED" && !kf.errorMessage && entries.length === 112, { s: kf.status, e: kf.errorMessage, n: entries.length });
      check("   …KEY_READ names local OCR; no AI key request was made by the OCR read", /local OCR/.test((await prisma.aiImportEvent.findFirst({ where: { jobId: kj, type: "KEY_READ" } }))?.message ?? "") && (await prisma.aiImportAiCall.count({ where: { jobId: kj, task: "key" } })) === keyCallsBefore);
      // 3. Read again (a later retry): entries replaced, never added twice.
      await prisma.aiImportFile.update({ where: { id: keyId }, data: { status: "ANALYZED", errorMessage: "simulated earlier failure" } });
      await prisma.aiImportJob.update({ where: { id: kj }, data: { status: "QUEUED", finishedAt: null } });
      await runWorker(400_000);
      check("3. key read again → still 112 entries (no duplicates)", (await prisma.aiImportKeyEntry.count({ where: { keyFileId: keyId } })) === 112);
    } else console.log("\n  (C skipped: no key PDF given)");

    check("no request left the loopback mock", blockedHosts.size === 0, [...blockedHosts]);
  } finally {
    await saveImporterSettings(savedSettings, actor).catch(() => undefined);
    if (!process.env.KEEP) for (const id of jobs) await prisma.aiImportJob.delete({ where: { id } }).catch(() => undefined);
    else console.log(`kept jobs: ${jobs.join(" ")}`);
    await prisma.$disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
