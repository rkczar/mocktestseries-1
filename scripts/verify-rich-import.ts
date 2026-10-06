/**
 * NEET Phase 3 — rich content import pipeline (server side).
 *
 * Against a DISPOSABLE database (a production copy is ideal: it carries the
 * real NEET/RUHS taxonomy) and DISPOSABLE storage + staging directories:
 *   A. ZIP reader security matrix (traversal, absolute, symlink, bomb, nested,
 *      executable, SVG, encrypted, duplicate, lying size, bad CRC, depth)
 *   B. manifest parsing + rich lint units
 *   C. LEGACY parse is unchanged (rich columns stay ignored)
 *   D. torture-10 end to end: bundle → stage → validate → process → import,
 *      idempotency (concurrent execute, re-execute, upload key), DB shape,
 *      no base64, content-addressed media, snapshot v2, explanation leak gate,
 *      REPLACE immutability with a frozen attempt, rollback keeps media
 *   E. failure package: every expected ERROR / WARNING
 *
 *   STORAGE_DIR=<scratch> IMPORT_STAGING_DIR=<scratch> DATABASE_URL=<scratch> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-rich-import.ts
 */
import "dotenv/config";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BulkImportRowStatus, BulkImportStatus, ImportRowSeverity, QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildTaxonomyLookups, mergeRowData, parseImportFile, runExamContextFor, type BulkImportRow, type ImportParseMode } from "@/lib/bulk-import";
import { ImportBlockedError, executeBulkImport, recomputeRunCounts } from "@/lib/bulk-import-execute";
import { completeBundle, createBundle, processBundleSlice, putChunk, CHUNK_BYTES, archivePath } from "@/lib/rich-import/bundle";
import { readZipDirectory, readZipEntry } from "@/lib/rich-import/zip";
import { buildZip } from "@/lib/rich-import/zip-writer";
import { lintRichSource, parseCorrect, parseImageCell } from "@/lib/rich-import/manifest";
import { loadRichContext, referencedFilenames, resolveImportRow } from "@/lib/rich-import/validate";
import { isContentAddressedKey, mediaStorage } from "@/lib/media-storage";
import { startPreviousYearPaperAttempt, submitAttempt, revealAnswer, type QuestionSnapshot } from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { executeImportRollback } from "@/lib/import-rollback";
import { failures, hostileZips, legacyRows, toXlsx, torture10, figure } from "./rich-import-fixtures";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
for (const v of ["STORAGE_DIR", "IMPORT_STAGING_DIR"]) {
  if (!process.env[v] || process.env[v]!.startsWith("/var/www/mocktestseries-shared") || process.env[v]!.startsWith("/var/lib/mocktestseries")) {
    console.error(`Set ${v} to a disposable directory.`);
    process.exit(2);
  }
}

let failuresCount = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  if (!passed) failuresCount++;
}
const info = (s: string) => console.log(`  INFO  ${s}`);
const section = (s: string) => console.log(`\n${s}`);

async function refused(fn: () => Promise<unknown>, re?: RegExp): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return !re || re.test(m) ? m : `UNEXPECTED: ${m}`;
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "rich-import-"));
function fileOf(name: string, bytes: Buffer): File {
  return new File([new Uint8Array(bytes)], name);
}

// ---- helpers that mirror the HTTP routes (upload / validate / process) ----
async function uploadBundle(actorId: string, zip: Buffer, name = "bundle.zip") {
  const b = await createBundle({ actorId, filename: name, declaredBytes: zip.length });
  for (let i = 0; i * CHUNK_BYTES < zip.length; i++) await putChunk({ bundleId: b.id, actorId, index: i, bytes: zip.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  return completeBundle({ bundleId: b.id, actorId });
}

async function stageRun(o: { actorId: string; examId: string; file: File; mode: ImportParseMode; bundleId?: string | null; paperId?: string | null; strategy?: "SKIP" | "REPLACE" | "ADD_AS_NEW"; key?: string }) {
  const { rows } = await parseImportFile(o.file, o.mode);
  return prisma.$transaction(async (tx) => {
    const run = await tx.bulkImportRun.create({
      data: {
        adminUserId: o.actorId, filename: o.file.name, format: o.file.name.endsWith(".csv") ? "CSV" : "XLSX", examId: o.examId, totalRows: rows.length,
        duplicateStrategy: o.strategy ?? "SKIP", status: BulkImportStatus.UPLOADED, previousYearPaperId: o.paperId ?? null,
        ...(o.mode === "RICH" ? { importMode: "RICH" as const, bundleId: o.bundleId ?? null } : {}), ...(o.key ? { idempotencyKey: o.key } : {}),
      },
    });
    await tx.bulkImportRow.createMany({ data: rows.map((r) => ({ runId: run.id, rowNumber: r.rowNumber, rawData: r as unknown as Prisma.InputJsonValue, severity: ImportRowSeverity.ERROR })) });
    return run;
  });
}

async function validateRun(runId: string) {
  const run = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: runId } });
  const rows = await prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, orderBy: { rowNumber: "asc" } });
  const lookups = await buildTaxonomyLookups(prisma);
  const ctx = await loadRichContext(runId);
  const rx = runExamContextFor(lookups.exams, run);
  const out: { rowNumber: number; severity: string; errors: string[]; warnings: string[]; infos: string[] }[] = [];
  for (const row of rows) {
    const merged = mergeRowData(row.rawData, row.editedData) as BulkImportRow;
    const r = await resolveImportRow(prisma, lookups, merged, undefined, rx, ctx);
    await prisma.bulkImportRow.update({
      where: { id: row.id },
      data: { severity: r.severity, errors: r.errors, warnings: r.warnings, reviewRequired: r.reviewRequired, ...(ctx ? { infos: r.infos ?? [] } : {}) },
    });
    out.push({ rowNumber: row.rowNumber, severity: r.severity, errors: r.errors, warnings: r.warnings, infos: r.infos ?? [] });
  }
  await prisma.bulkImportRun.update({ where: { id: runId }, data: { status: BulkImportStatus.READY } });
  await recomputeRunCounts(runId);
  return out;
}

async function processAll(runId: string, actorId: string) {
  const run = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: runId } });
  let steps = 0;
  for (;;) {
    const r = await processBundleSlice({ bundleId: run.bundleId!, actorId, wanted: await referencedFilenames(runId), sliceMs: 5_000 });
    steps++;
    if (r.done || steps > 200) return { ...r, steps };
  }
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  const neet = await prisma.exam.findFirstOrThrow({ where: { code: "NEETUG" }, select: { id: true, name: true } });
  const ruhs = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const suffix = Date.now().toString(36);
  const cleanup = { students: [] as string[], runs: [] as string[], paperId: "", restoreNeet: null as boolean | null };

  // Synthetic paper for the PYQ metadata path (scratch only).
  const paper = await prisma.previousYearPaper.create({ data: { examId: neet.id, year: 2025, title: `SYNTHETIC NEET 2025 ${suffix}`, paperCode: "SYN-25", isActive: true } });
  cleanup.paperId = paper.id;

  // ------------------------------------------------------------------ A
  section("A. ZIP reader security");
  const hostile = await hostileZips();
  const expectRefused: Record<string, RegExp> = {
    traversal: /traversal|\.\./i, absolute: /absolute/i, backslash: /backslash/i, symlink: /symbolic link/i, executable: /executable/i, svg: /SVG|markup/i,
    nested: /archive/i, bomb: /zip bomb|ratio/i, encrypted: /Encrypted/i, duplicate: /twice/i, notZip: /not a valid ZIP|not a ZIP/i, deep: /nested too deeply/i,
  };
  for (const [name, re] of Object.entries(expectRefused)) {
    const p = path.join(tmp, `${name}.zip`);
    writeFileSync(p, hostile[name]);
    const msg = await refused(() => readZipDirectory(p), re);
    check(`refuses ${name} archive`, msg !== null && !msg.startsWith("UNEXPECTED"), msg);
  }
  for (const name of ["lyingSize", "badCrc"]) {
    const p = path.join(tmp, `${name}.zip`);
    writeFileSync(p, hostile[name]);
    const entries = await readZipDirectory(p).catch((e) => e as Error);
    const msg = Array.isArray(entries) ? await refused(() => readZipEntry(p, entries[0])) : (entries as Error).message;
    check(`detects ${name} entry on read`, !!msg && /size|CRC|declared|decompress/i.test(msg), msg);
  }
  {
    const good = path.join(tmp, "good.zip");
    const png = await figure("graph", "zip-good");
    writeFileSync(good, buildZip([{ name: "img/a.png", data: png }, { name: "__MACOSX/._a.png", data: Buffer.from("x") }, { name: "readme.pdf", data: Buffer.from("%PDF") }]));
    const entries = await readZipDirectory(good);
    check("good archive: image / junk / unsupported classified", entries.map((e) => e.kind).join(",") === "IMAGE,IGNORED,UNSUPPORTED", entries.map((e) => e.kind));
    check("entry bytes round-trip with CRC verified", (await readZipEntry(good, entries[0])).equals(png));
  }

  // ------------------------------------------------------------------ B
  section("B. manifest + lint units");
  check("parseCorrect single", JSON.stringify(parseCorrect("b")) === '["B"]');
  check("parseCorrect multiple", JSON.stringify(parseCorrect("A, d | B")) === '["A","B","D"]');
  check("parseCorrect invalid → null", parseCorrect("E") === null && parseCorrect("A1") === null);
  {
    const issues: { field: string; message: string }[] = [];
    const refs = parseImageCell("a.png :: Circuit diagram | b.png\nc.png :: decorative", "QUESTION", "Question Images", null, issues);
    check("image cell grammar: 3 refs, alt / none / decorative", refs.length === 3 && refs[0].alt === "Circuit diagram" && refs[1].alt === null && refs[2].decorative && refs[2].alt === "", refs);
    parseImageCell("../x.png | https://evil/x.png | ok.png", "QUESTION", "Question Images", null, issues);
    check("image cell: paths and URLs refused", issues.length === 2, issues);
  }
  {
    const ok = lintRichSource("$v^2=u^2+2as$ and $$E=mc^2$$ with \\ce{2H2 + O2 -> 2H2O}", "Q");
    check("lint: valid formulas → no warnings, stats counted", ok.warnings.length === 0 && ok.stats.formulas === 2 && ok.stats.chemistry === 1, ok);
    const bad = lintRichSource("Unclosed $x^2 and $\\frac{1}{$ and \\ce{H2O and <b>x</b> \\(a\\)", "Q");
    check("lint: unclosed / bad / HTML / \\( flagged", bad.warnings.length >= 3, bad.warnings);
  }

  // ------------------------------------------------------------------ C
  section("C. LEGACY parse unchanged");
  {
    const legacy = legacyRows();
    const headers = [...new Set(legacy.flatMap((r) => Object.keys(r)))];
    const csv = [headers.join(","), ...legacy.map((r) => headers.map((h) => `"${(r[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const { rows } = await parseImportFile(fileOf("legacy.csv", Buffer.from(csv)));
    const keys = Object.keys(rows[0]).sort().join(",");
    check("legacy CSV rows carry no rich keys", !/contentFormat|questionType|reviewFlag|formulaCells/.test(keys), keys);
    check("legacy text kept literal ($ and \\ce stay text)", rows[0].questionText.includes("$5") && rows[0].questionText.includes("\\ce{H2O}"));
    const rich = await parseImportFile(fileOf("legacy.csv", Buffer.from(csv)), "RICH");
    check("same file in RICH mode does read Question Type / Review Required", rich.rows[0].questionType === "MCQ" && rich.rows[0].reviewFlag === "TRUE");
  }

  // ------------------------------------------------------------------ D
  section("D. torture-10 end to end");
  const pkg = await torture10(`SYN-${suffix}`);
  // Unique stems: earlier runs on the same scratch DB must not turn these into text duplicates.
  for (const r of pkg.rows) r["Question Text"] = `${r["Question Text"]} [${suffix}]`;
  const bundle = await uploadBundle(admin.id, buildZip(pkg.files));
  check("bundle inspected (UPLOADED) with 13 images + 1 ignored", bundle.status === "UPLOADED" && bundle.imageCount === 13, { status: bundle.status, imageCount: bundle.imageCount, err: bundle.errorMessage });
  check("bundle archive is in private staging, not under storage/media", archivePath(bundle.id).startsWith(process.env.IMPORT_STAGING_DIR!) && !archivePath(bundle.id).includes("/media/"));
  const run = await stageRun({ actorId: admin.id, examId: neet.id, file: fileOf("torture10.xlsx", toXlsx(pkg.rows)), mode: "RICH", bundleId: bundle.id, paperId: paper.id, key: `k-${suffix}-torture-0001` });
  cleanup.runs.push(run.id);
  let v = await validateRun(run.id);
  check("before processing: the 7 image rows are blocked as 'not processed yet'", v.filter((r) => r.errors.some((e) => /not been processed yet/.test(e))).length === 7, v.map((r) => r.errors));
  const t0 = Date.now();
  const proc = await processAll(run.id, admin.id);
  info(`processed ${proc.ready} images in ${proc.steps} slice(s), ${Date.now() - t0} ms`);
  check("all 13 referenced images processed, none invalid", proc.ready === 13 && proc.invalid === 0, proc);
  v = await validateRun(run.id);
  const errs = v.filter((r) => r.severity === "ERROR");
  check("after processing: no ERROR rows", errs.length === 0, errs);
  check("Q10 has a Review Required warning", v[9].warnings.some((w) => /Review Required: formula needs verification/.test(w)), v[9].warnings);
  check("every row has INFO lines, and INFO never affects severity", v.every((r) => r.infos.length >= 2) && v[1].severity === "VALID", v[1]);
  const mediaBefore = await prisma.mediaObject.count();

  const blocked = await refused(() => executeBulkImport({ runId: run.id, adminUserId: admin.id }));
  check("import refused until warnings are acknowledged (nothing written)", /warnings/.test(blocked ?? "") && (await prisma.question.count({ where: { importBatchId: run.id } })) === 0, blocked);

  const [r1, r2] = await Promise.allSettled([
    executeBulkImport({ runId: run.id, adminUserId: admin.id, acknowledgeWarnings: true }),
    executeBulkImport({ runId: run.id, adminUserId: admin.id, acknowledgeWarnings: true }),
  ]);
  const rejected = [r1, r2].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  check("double-click: second concurrent import refused (ALREADY_RUNNING)", rejected.length === 1 && rejected[0].reason instanceof ImportBlockedError && rejected[0].reason.code === "ALREADY_RUNNING", rejected.map((r) => String(r.reason)));
  const res = ([r1, r2].find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof executeBulkImport>>>).value;
  check("10 questions created, 0 failed", res.successCount === 10 && res.failedCount === 0, res);
  const again = await executeBulkImport({ runId: run.id, adminUserId: admin.id, acknowledgeWarnings: true });
  check("re-running the import creates nothing more", again.attempted === 0 && (await prisma.question.count({ where: { importBatchId: run.id } })) === 10, again);

  const qs = await prisma.question.findMany({
    where: { importBatchId: run.id },
    include: { options: { orderBy: { order: "asc" } }, assets: { orderBy: [{ role: "asc" }, { optionLabel: "asc" }, { order: "asc" }] } },
    orderBy: { createdAt: "asc" },
  });
  const rowsAfter = await prisma.bulkImportRow.findMany({ where: { runId: run.id }, orderBy: { rowNumber: "asc" } });
  const byRow = (n: number) => qs.find((q) => q.id === rowsAfter[n - 1].questionId)!;
  check("all imported questions are DRAFT (import ≠ publish)", qs.every((q) => q.status === QuestionStatus.DRAFT));
  check("no question is VERIFIED / READY_TO_PUBLISH", qs.every((q) => q.editorialStage === "DRAFT" || q.editorialStage === "NEEDS_REVIEW"), qs.map((q) => q.editorialStage));
  check("Q1 PLAIN, Q2–Q10 RICH_V1", byRow(1).contentFormat === "PLAIN" && [2, 3, 4, 5, 6, 7, 8, 9, 10].every((n) => byRow(n).contentFormat === "RICH_V1"));
  check("LaTeX stored verbatim (not rendered, not rewritten)", byRow(2).text === pkg.rows[1]["Question Text"] && byRow(2).options[0].text === "$\\sqrt{2as}$");
  check("mhchem stored verbatim", byRow(5).text.includes("\\ce{N2 + 3H2 <=> 2NH3}") && byRow(5).options[0].text === "\\ce{NH3}");
  check("display equation + circuit: 1 QUESTION asset with author alt", byRow(3).assets.length === 1 && byRow(3).assets[0].role === "QUESTION" && /12 V battery/.test(byRow(3).assets[0].alt));
  check("A–D image options: 4 OPTION assets, empty option text", byRow(8).assets.filter((a) => a.role === "OPTION").map((a) => a.optionLabel).join("") === "ABCD" && byRow(8).options.every((o) => o.text === ""));
  check("two question images + two explanation images (one decorative)", byRow(9).assets.filter((a) => a.role === "QUESTION").length === 2 && byRow(9).assets.filter((a) => a.role === "EXPLANATION").length === 2 && byRow(9).assets.some((a) => a.role === "EXPLANATION" && a.alt === ""));
  // NEET Phase 4: MTF stores the stem as text and List I / List II structurally (matchSpec + LIST_ITEM image).
  {
    const spec = byRow(10).matchSpec as { listI?: { key: string; text: string }[]; listII?: { key: string; text: string }[] } | null;
    check(
      "MTF: stem-only text, structured matchSpec, single correct option, list image is LIST_ITEM I:B",
      byRow(10).questionType === "MATCH_THE_FOLLOWING" &&
        !/List I\n/.test(byRow(10).text) &&
        spec?.listI?.[0]?.text === "\\ce{CH4}" &&
        spec?.listII?.[0]?.text === "Benzene" &&
        byRow(10).options.filter((o) => o.isCorrect).length === 1 &&
        byRow(10).assets.some((a) => a.role === "LIST_ITEM" && a.listKey === "I:B" && a.caption === "List I (B)"),
      { text: byRow(10).text, spec, assets: byRow(10).assets.map((a) => [a.role, a.listKey, a.caption]) }
    );
  }
  check("non-MTF rows stay SINGLE_CORRECT", [1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => byRow(n).questionType === "SINGLE_CORRECT"));
  check("Q10 reviewRequired + author reason preserved, stage NEEDS_REVIEW", byRow(10).reviewRequired && /Author: formula needs verification/.test(byRow(10).reviewReason ?? "") && byRow(10).editorialStage === "NEEDS_REVIEW");
  check("explanations stored", qs.every((q) => (q.explanation ?? "").length > 0));
  check("exactly one correct option on every question", qs.every((q) => q.options.filter((o) => o.isCorrect).length === 1));
  check("linked to the synthetic PYQ paper (paper metadata)", qs.every((q) => q.previousYearPaperId === paper.id && q.source === "PYQ"));
  const allAssets = qs.flatMap((q) => q.assets);
  check("every asset key is content-addressed and the file exists", (await Promise.all(allAssets.map(async (a) => isContentAddressedKey(a.storageKey) && (await mediaStorage().exists(a.storageKey))))).every(Boolean));
  check("no base64 / data: URIs / source filenames in stored text or keys", qs.every((q) => !/data:image|base64/i.test(q.text + (q.explanation ?? ""))) && allAssets.every((a) => !/SYN-/.test(a.storageKey)));
  const finalRun = await prisma.bulkImportRun.findUniqueOrThrow({ where: { id: run.id } });
  check("run records assetCount + formatCounts", finalRun.assetCount === allAssets.length && (finalRun.formatCounts as { RICH_V1: number }).RICH_V1 === 9, { assetCount: finalRun.assetCount, formatCounts: finalRun.formatCounts });
  check("batch traceability: importBatchId + row → question", qs.every((q) => q.importBatchId === run.id) && rowsAfter.every((r) => r.status === BulkImportRowStatus.SUCCESS && r.questionId));
  check("execution lease released", finalRun.executingAt === null);

  // Dedup: re-uploading the same bundle reuses every MediaObject.
  {
    const b2 = await uploadBundle(admin.id, buildZip(pkg.files));
    const run2 = await stageRun({ actorId: admin.id, examId: neet.id, file: fileOf("torture10-again.xlsx", toXlsx(pkg.rows)), mode: "RICH", bundleId: b2.id, paperId: paper.id });
    cleanup.runs.push(run2.id);
    await processAll(run2.id, admin.id);
    check("SHA-256 dedup: identical bundle creates no new MediaObject", (await prisma.mediaObject.count()) === mediaBefore + 0 || (await prisma.mediaObject.count()) === mediaBefore, { before: mediaBefore, after: await prisma.mediaObject.count() });
    const v2 = await validateRun(run2.id);
    check("re-import of the same file: every row flagged as a duplicate (SKIP)", v2.every((r) => r.warnings.some((w) => /Possible duplicate/.test(w))), v2.map((r) => r.warnings));
    const r = await executeBulkImport({ runId: run2.id, adminUserId: admin.id, acknowledgeWarnings: true });
    check("SKIP strategy: 0 created, 10 skipped", r.successCount === 0 && r.skippedCount === 10, r);
  }

  // Snapshot v2 + explanation leak gate.
  section("D2. snapshot, player payload, leak gate");
  await prisma.question.updateMany({ where: { importBatchId: run.id }, data: { status: QuestionStatus.PUBLISHED } }); // scratch only, to take a test
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({ data: { studentId: `RI${tag}-${suffix}`, name: `RI ${tag}`, email: `ri-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
    cleanup.students.push(s.id);
    await prisma.studentExamEnrollment.create({ data: { studentId: s.id, examId: neet.id } }).catch(() => undefined);
    return s.id;
  };
  const s1 = await mkStudent("a");
  const lockMsg = await refused(() => startPreviousYearPaperAttempt(s1, paper.id, { answerMode: "EXAM", durationMode: "FIXED" }), /not available/);
  check("NEET lockdown: even PUBLISHED imported questions cannot be started while the exam is inactive", !!lockMsg && !lockMsg.startsWith("UNEXPECTED"), lockMsg);
  const neetWasActive = (await prisma.exam.findUniqueOrThrow({ where: { id: neet.id }, select: { isActive: true } })).isActive;
  await prisma.exam.update({ where: { id: neet.id }, data: { isActive: true } }); // scratch only, restored in cleanup
  cleanup.restoreNeet = neetWasActive;
  const att = await startPreviousYearPaperAttempt(s1, paper.id, { answerMode: "EXAM", durationMode: "FIXED" });
  const attRows = await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id }, include: { questions: { include: { answer: true }, orderBy: { order: "asc" } } } });
  check("attempt froze 10 questions", attRows.questions.length === 10);
  const snaps = attRows.questions.map((q) => q.questionSnapshot as unknown as QuestionSnapshot & { v?: number; assets?: { storageKey: string }[] });
  // NEET Phase 4: the Match the Following row (10) freezes snapshot v3; every other row v2 as before.
  check("every imported question freezes snapshot v2 (RICH_V1 or explained); the MTF row v3", snaps.every((s, i) => s.v === (i === 9 ? 3 : 2)), snaps.map((s) => s.v));
  check("snapshots carry storage keys, never image bytes", snaps.every((s) => !JSON.stringify(s).includes("base64")) && snaps.some((s) => (s.assets ?? []).length > 0));
  const payload = JSON.stringify(toPlayerQuestions(attRows.questions, { instantMode: false }));
  check("EXAM payload: no explanation text, no EXPLANATION image, no correct label", !payload.includes("left ventricle pumps") && !payload.includes("R_{23}") && !snaps.flatMap((s) => (s.assets ?? []) as { role?: string; storageKey: string }[]).filter((a) => a.role === "EXPLANATION").some((a) => payload.includes(a.storageKey)) && !/correctLabel/.test(payload));
  const qCircuit = attRows.questions.find((q) => (q.questionSnapshot as unknown as { text: string }).text.includes("R_{eq}"))!;
  const practice = await startPreviousYearPaperAttempt(await mkStudent("p"), paper.id, { answerMode: "INSTANT", durationMode: "FIXED" });
  const rev = await revealAnswer(practice.id, (await prisma.testAttempt.findUniqueOrThrow({ where: { id: practice.id } })).studentId, qCircuit.questionId, "A");
  check("authorized reveal returns the imported explanation (rendered RICH_V1)", rev.correctLabel === "A" && rev.explanation?.body?.format === "RICH_V1");
  await submitAttempt(att.id, s1);
  const scored = await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id } });
  check("submit + scoring works on imported questions", scored.status === "SUBMITTED", scored.status);

  // REPLACE immutability with a frozen attempt.
  section("D3. REPLACE keeps history");
  {
    const q3 = byRow(3);
    const oldKey = q3.assets[0].storageKey;
    const replRows = pkg.rows.map((r) => ({ ...r }));
    const newImg = `${replRows[2].Code}-Q1-v2.png`;
    replRows[2]["Question Images"] = `${newImg} :: Revised circuit diagram`;
    const files = [...pkg.files, { name: newImg, data: await figure("circuit", `${suffix}-v2`) }];
    // Published questions are protected from rich REPLACE.
    const b3 = await uploadBundle(admin.id, buildZip(files));
    const run3 = await stageRun({ actorId: admin.id, examId: neet.id, file: fileOf("replace.xlsx", toXlsx([replRows[2]])), mode: "RICH", bundleId: b3.id, paperId: paper.id, strategy: "REPLACE" });
    cleanup.runs.push(run3.id);
    await processAll(run3.id, admin.id);
    let v3 = await validateRun(run3.id);
    check("REPLACE of a PUBLISHED question is an ERROR", v3[0].errors.some((e) => /may only REPLACE rich DRAFT/.test(e)), v3[0].errors);
    await prisma.question.update({ where: { id: q3.id }, data: { status: QuestionStatus.DRAFT } });
    v3 = await validateRun(run3.id);
    const r3 = await executeBulkImport({ runId: run3.id, adminUserId: admin.id, acknowledgeWarnings: true });
    const q3b = await prisma.question.findUniqueOrThrow({ where: { id: q3.id }, include: { assets: true } });
    check("REPLACE updated the same question with the new image", r3.replacedCount === 1 && q3b.assets.length === 1 && q3b.assets[0].storageKey !== oldKey, { r3, v3 });
    check("old image file still exists (never deleted/overwritten)", await mediaStorage().exists(oldKey));
    const frozen = (await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: att.id, questionId: q3.id } })).questionSnapshot as unknown as { assets: { storageKey: string }[] };
    check("submitted attempt still shows the ORIGINAL image", frozen.assets[0].storageKey === oldKey);
  }

  // Rollback keeps media.
  section("D4. rollback keeps immutable media");
  {
    const mediaCount = await prisma.mediaObject.count();
    const keys = (await prisma.questionAsset.findMany({ where: { question: { importBatchId: run.id } }, select: { storageKey: true } })).map((a) => a.storageKey);
    const rb = await executeImportRollback({ runId: run.id, actorId: admin.id, mode: "AUTO" });
    info(`rollback: deleted ${rb.deleted.length}, archived ${rb.archived.length}, protected ${rb.protected.length}`);
    check("rollback deletes nothing that a paper or an attempt depends on (existing PROTECTED/ARCHIVE rules)", rb.deleted.length === 0 && rb.archived.length + rb.protected.length === 10, { d: rb.deleted.length, a: rb.archived.length, p: rb.protected.length });
    check("MediaObjects untouched by rollback", (await prisma.mediaObject.count()) === mediaCount);
    check("every media file still on disk", (await Promise.all(keys.map((k) => mediaStorage().exists(k)))).every(Boolean));
    const att2 = await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id }, include: { questions: true } });
    check("submitted attempt intact after rollback", att2.status === "SUBMITTED" && att2.questions.length === 10);
  }

  // ------------------------------------------------------------------ E
  section("E. failure package");
  {
    const fp = await failures(`SYN-F${suffix}`);
    const fb = await uploadBundle(admin.id, buildZip(fp.files));
    check("failure bundle accepted for inspection (problems are per entry)", fb.status === "UPLOADED", fb.errorMessage);
    const fr = await stageRun({ actorId: admin.id, examId: neet.id, file: fileOf("failures.xlsx", toXlsx(fp.rows)), mode: "RICH", bundleId: fb.id, paperId: paper.id });
    cleanup.runs.push(fr.id);
    await processAll(fr.id, admin.id);
    const fv = await validateRun(fr.id);
    const has = (n: number, re: RegExp, sev: "errors" | "warnings" = "errors") => fv[n - 1][sev].some((e) => re.test(e));
    check("missing image → ERROR with exact file + field", has(1, /Question Images: referenced file "missing-file.png" was not found/));
    check("bad taxonomy → ERROR, never created", has(2, /Physicks.*not found/) && (await prisma.subject.count({ where: { name: "Physicks" } })) === 0);
    check("duplicate code in file → ERROR on both rows", has(3, /appears 2 times/) && has(4, /appears 2 times/));
    check("invalid correct answer → ERROR", has(5, /Correct: "E" is not a valid answer/));
    check("corrupt image → ERROR", has(6, /corrupt\.png" is not a valid image/), fv[5].errors);
    // NEET Phase 4: MULTIPLE_CORRECT is importable; malformed keys still refuse.
    check("MULTIPLE_CORRECT A,C → accepted (no type / answer error)", !fv[6].errors.some((e) => /Question Type|Correct/.test(e)), fv[6].errors);
    check("MULTIPLE_CORRECT with one answer → ERROR (needs at least two)", has(16, /needs at least 2 correct options/), fv[15]?.errors);
    check("MULTIPLE_CORRECT with a repeated label → ERROR (never silently de-duplicated)", has(17, /lists the same option twice/), fv[16]?.errors);
    check("MATCH_THE_FOLLOWING without List II → ERROR", has(18, /needs both lists|each list needs at least two/), fv[17]?.errors);
    check("MATCH_THE_FOLLOWING with a duplicate list key → ERROR", has(19, /appears twice/), fv[18]?.errors);
    check("MATCH_THE_FOLLOWING with two correct options → ERROR", has(20, /exactly one/), fv[19]?.errors);
    check("ambiguous filename → ERROR", has(8, /ambiguous/));
    check("unsupported file → ERROR", has(9, /notes\.txt" cannot be used/));
    check("spreadsheet formula cell → ERROR (never evaluated)", has(10, /Spreadsheet formula in "Option A"/), fv[9].errors);
    check("unknown chapter → ERROR", has(11, /99\. Nonexistent Chapter/));
    check("PLAIN with images → ERROR", has(12, /images need Content Format RICH_V1/));
    check("broken markup → WARNING (not rewritten)", has(13, /unclosed|does not render/i, "warnings"));
    check("path in image reference → ERROR", has(14, /contains a path/));
    check("PUBLISHED requested → WARNING, kept DRAFT", has(15, /PUBLISHED requested/, "warnings"));
    const ctx = await loadRichContext(fr.id);
    const unused = ctx!.bundle!.entries.filter((e) => e.basename === "unused.png")[0];
    check("unused image is never processed (no orphan media)", unused.status === "PENDING");
    const blockedErr = await refused(() => executeBulkImport({ runId: fr.id, adminUserId: admin.id, acknowledgeWarnings: true }), /errors/);
    check("Import Questions refused while ERROR rows exist; nothing written", !!blockedErr && (await prisma.question.count({ where: { importBatchId: fr.id } })) === 0, blockedErr);
    const onlyValid = await executeBulkImport({ runId: fr.id, adminUserId: admin.id, onlyValid: true });
    check("explicit Import Valid Only skips every ERROR row", onlyValid.failedCount === 0 && (await prisma.question.count({ where: { importBatchId: fr.id } })) === onlyValid.successCount, onlyValid);
    // NEET Phase 4: a valid MULTIPLE_CORRECT row really imports (own run: the failure rows reuse QNos of earlier imports).
    {
      const msqRows = [
        { "Code": `MSQ-${suffix}-1`, Year: "2025", QNo: "77", Subject: "PHYSICS", "Chapter/Topic": "2. Kinematics", "Question Type": "MULTIPLE_CORRECT", "Content Format": "RICH_V1", "Question Text": `MSQ import probe ${suffix}: which are vectors? $\\vec{v}$`, "Option A": "Velocity", "Option B": "Speed", "Option C": "Force", "Option D": "Displacement", Correct: "D, A, C", Explanation: "Speed is scalar.", Difficulty: "EASY", Source: "PYQ" },
      ];
      const mr = await stageRun({ actorId: admin.id, examId: neet.id, file: fileOf("msq.xlsx", toXlsx(msqRows)), mode: "RICH", paperId: paper.id });
      cleanup.runs.push(mr.id);
      const mv = await validateRun(mr.id);
      check("valid MULTIPLE_CORRECT row validates without errors", mv[0].errors.length === 0, mv[0].errors);
      await executeBulkImport({ runId: mr.id, adminUserId: admin.id, acknowledgeWarnings: true });
      const mq = await prisma.question.findFirst({ where: { importBatchId: mr.id }, include: { options: true } });
      check(
        "MULTIPLE_CORRECT D,A,C imported as MULTIPLE_CORRECT with exactly A, C, D correct (DRAFT)",
        mq?.questionType === "MULTIPLE_CORRECT" && mq.status === "DRAFT" && mq.options.filter((o) => o.isCorrect).map((o) => o.label).sort().join() === "A,C,D",
        mq && { type: mq.questionType, correct: mq.options.filter((o) => o.isCorrect).map((o) => o.label) }
      );
      if (mq) await prisma.question.delete({ where: { id: mq.id } });
    }
  }

  // ------------------------------------------------------------------ E2
  section("E2. several papers in one year (paper code resolution)");
  {
    const paperB = await prisma.previousYearPaper.create({ data: { examId: neet.id, year: 2025, title: `SYNTHETIC NEET 2025 B ${suffix}`, paperCode: `SYN-25B-${suffix}`, isActive: true } });
    const rowsB = [
      { "Code": `PB-${suffix}-1`, Year: "2025", "Paper Code": paperB.paperCode!, QNo: "1", Subject: "PHYSICS", "Chapter/Topic": "2. Kinematics", "Content Format": "RICH_V1", "Question Text": `Paper B probe ${suffix} $x$`, "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", Correct: "A", Explanation: "e", Difficulty: "EASY", Source: "PYQ" },
      { "Code": `PB-${suffix}-2`, Year: "2025", QNo: "2", Subject: "PHYSICS", "Chapter/Topic": "2. Kinematics", "Content Format": "RICH_V1", "Question Text": `Paper ? probe ${suffix} $y$`, "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", Correct: "A", Explanation: "e", Difficulty: "EASY", Source: "PYQ" },
    ];
    const rb = await stageRun({ actorId: admin.id, examId: neet.id, file: fileOf("paperb.xlsx", toXlsx(rowsB)), mode: "RICH" });
    cleanup.runs.push(rb.id);
    const vb = await validateRun(rb.id);
    check("row with Paper Code resolves to exactly that paper (no error)", vb[0].severity !== "ERROR", vb[0].errors);
    check("PYQ row without Paper Code when 2 papers share the year → ERROR asking for it", vb[1].errors.some((e) => /Previous Year Papers exist for 2025/.test(e)), vb[1].errors);
    await executeBulkImport({ runId: rb.id, adminUserId: admin.id, onlyValid: true, acknowledgeWarnings: true });
    const qb = await prisma.question.findFirst({ where: { importBatchId: rb.id } });
    check("imported question is linked to paper B (not the first 2025 paper)", qb?.previousYearPaperId === paperB.id, qb?.previousYearPaperId);
    await prisma.question.deleteMany({ where: { importBatchId: rb.id } });
    await prisma.previousYearPaper.delete({ where: { id: paperB.id } });
  }

  // ------------------------------------------------------------------ F
  section("F. LEGACY import through the new code");
  {
    const legacy = legacyRows();
    const headers = [...new Set(legacy.flatMap((r) => Object.keys(r)))];
    const csv = [headers.join(","), ...legacy.map((r) => headers.map((h) => `"${(r[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const lr = await stageRun({ actorId: admin.id, examId: ruhs.id, file: fileOf("legacy.csv", Buffer.from(csv)), mode: "LEGACY" });
    cleanup.runs.push(lr.id);
    const lv = await validateRun(lr.id);
    check("legacy rows get no INFO column", (await prisma.bulkImportRow.findMany({ where: { runId: lr.id } })).every((r) => r.infos === null));
    check("legacy missing answer stays a WARNING (not a rich ERROR)", lv[1].severity === "WARNING" && lv[1].warnings.some((w) => /Correct Answer not provided/.test(w)));
    check("legacy unmapped subject stays a WARNING", lv[2].severity === "WARNING");
    const lres = await executeBulkImport({ runId: lr.id, adminUserId: admin.id });
    const lq = await prisma.question.findMany({ where: { importBatchId: lr.id }, include: { options: true }, orderBy: { createdAt: "asc" } });
    check("legacy: warnings imported without acknowledgement (unchanged)", lres.successCount === 3, lres);
    check("legacy: PUBLISHED honoured, PLAIN, no explanation stored, no editorial stage", lq[0].status === "PUBLISHED" && lq[0].contentFormat === "PLAIN" && lq[0].explanation === null && lq[0].editorialStage === null);
    check("legacy: missing answer → forced DRAFT", lq[1].status === "DRAFT");
  }

  // ------------------------------------------------------------------ cleanup
  section("cleanup");
  for (const sid of cleanup.students) {
    await prisma.answer.deleteMany({ where: { attempt: { studentId: sid } } }).catch(() => undefined);
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: sid } } }).catch(() => undefined);
    await prisma.testAttempt.deleteMany({ where: { studentId: sid } }).catch(() => undefined);
    await prisma.studentExamEnrollment.deleteMany({ where: { studentId: sid } }).catch(() => undefined);
    await prisma.student.delete({ where: { id: sid } }).catch(() => undefined);
  }
  for (const id of cleanup.runs) {
    await prisma.question.deleteMany({ where: { importBatchId: id } }).catch(() => undefined);
    const r = await prisma.bulkImportRun.findUnique({ where: { id }, select: { bundleId: true } });
    await prisma.bulkImportRun.delete({ where: { id } }).catch(() => undefined);
    if (r?.bundleId) await prisma.importBundle.delete({ where: { id: r.bundleId } }).catch(() => undefined);
  }
  await prisma.previousYearPaper.delete({ where: { id: cleanup.paperId } }).catch(() => undefined);
  if (cleanup.restoreNeet !== null) await prisma.exam.update({ where: { id: neet.id }, data: { isActive: cleanup.restoreNeet } });
  check("NEET exam isActive restored on scratch", (await prisma.exam.findUniqueOrThrow({ where: { id: neet.id }, select: { isActive: true } })).isActive === (cleanup.restoreNeet ?? false));
  info(`scratch media left in place (immutable by design): ${await prisma.mediaObject.count()} MediaObject rows; storage ${process.env.STORAGE_DIR}`);
  check("scratch files exist check sanity", existsSync(process.env.STORAGE_DIR!));

  console.log(`\n${failuresCount === 0 ? "ALL PASS" : `${failuresCount} FAILURE(S)`}`);
  await prisma.$disconnect();
  process.exit(failuresCount === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Browser E2E support (scripts/verify-rich-import.mjs)
//   setup                 → synthetic paper + 3 password students, prints fixture JSON
//   attempts <fixture>    → after the UI import: publish (scratch!), activate NEET (scratch!),
//                           start desktop/mobile EXAM attempts + a submitted review attempt
//   cleanup <fixture>     → removes everything the E2E created and restores NEET isActive
// ---------------------------------------------------------------------------
async function e2eSetup() {
  const argon2 = (await import("argon2")).default;
  const neet = await prisma.exam.findFirstOrThrow({ where: { code: "NEETUG" }, select: { id: true, name: true, isActive: true } });
  const ruhs = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true, name: true } });
  const suffix = Date.now().toString(36);
  const paper = await prisma.previousYearPaper.create({ data: { examId: neet.id, year: 2025, title: `SYNTHETIC NEET 2025 E2E ${suffix}`, paperCode: "SYN-25", isActive: true } });
  const password = `Ri-${suffix}-Pass!`;
  const hash = await argon2.hash(password);
  const students: Record<string, { id: string; email: string }> = {};
  for (const tag of ["desk", "mobile", "review"]) {
    const { nextStudentId } = await import("@/lib/student-id");
    const st = await prisma.student.create({ data: { studentId: await nextStudentId(), name: `RI E2E ${tag}`, email: `ri-e2e-${tag}-${suffix}@example.test`, passwordHash: hash, authProvider: StudentAuthProvider.CREDENTIALS } });
    await prisma.studentExamEnrollment.create({ data: { studentId: st.id, examId: neet.id } }).catch(() => undefined);
    students[tag] = { id: st.id, email: st.email! };
  }
  console.log(JSON.stringify({ suffix, neetId: neet.id, neetName: neet.name, neetWasActive: neet.isActive, ruhsId: ruhs.id, ruhsName: ruhs.name, paperId: paper.id, paperTitle: paper.title, password, students }, null, 2));
}

async function e2eAttempts(fixturePath: string) {
  const fs = await import("node:fs");
  const F = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const run = await prisma.bulkImportRun.findFirstOrThrow({ where: { previousYearPaperId: F.paperId, importMode: "RICH", status: "IMPORTED" }, orderBy: { createdAt: "desc" } });
  await prisma.question.updateMany({ where: { importBatchId: run.id }, data: { status: QuestionStatus.PUBLISHED } }); // scratch only
  await prisma.exam.update({ where: { id: F.neetId }, data: { isActive: true } }); // scratch only — restored by cleanup
  const desk = await startPreviousYearPaperAttempt(F.students.desk.id, F.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  const mobile = await startPreviousYearPaperAttempt(F.students.mobile.id, F.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  const review = await startPreviousYearPaperAttempt(F.students.review.id, F.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  const order = (await prisma.testAttemptQuestion.findMany({ where: { attemptId: desk.id }, orderBy: { order: "asc" }, select: { questionId: true, questionSnapshot: true } })).map((q) => ({ id: q.questionId, text: (q.questionSnapshot as unknown as { text: string }).text }));
  await submitAttempt(review.id, F.students.review.id);
  F.runId = run.id;
  F.attempts = { desk: desk.id, mobile: mobile.id, review: review.id };
  F.order = order;
  fs.writeFileSync(fixturePath, JSON.stringify(F, null, 2));
  console.log(JSON.stringify({ runId: run.id, attempts: F.attempts, questions: order.length }));
}

async function e2eCleanup(fixturePath: string) {
  const fs = await import("node:fs");
  const F = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const ids = Object.values(F.students as Record<string, { id: string }>).map((s) => s.id);
  await prisma.answer.deleteMany({ where: { attempt: { studentId: { in: ids } } } });
  await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: ids } } } });
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: ids } } });
  for (const t of ["StudentDevice", "StudentSession", "StudentExamEnrollment", "SavedQuestion"]) await prisma.$executeRawUnsafe(`delete from "${t}" where "studentId" = any($1)`, ids).catch(() => undefined);
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  const runs = await prisma.bulkImportRun.findMany({ where: { OR: [{ previousYearPaperId: F.paperId }, { filename: { startsWith: "e2e-" } }, { label: { startsWith: `E2E ${F.suffix}` } }] }, select: { id: true, bundleId: true } });
  for (const r of runs) {
    await prisma.question.deleteMany({ where: { importBatchId: r.id } });
    await prisma.bulkImportRun.delete({ where: { id: r.id } });
    if (r.bundleId) await prisma.importBundle.delete({ where: { id: r.bundleId } }).catch(() => undefined);
  }
  const extraPapers = await prisma.previousYearPaper.findMany({ where: { title: { startsWith: `SYNTHETIC NEET 2025 E2E ${F.suffix}` } }, select: { id: true } });
  for (const p of extraPapers) {
    const prs = await prisma.bulkImportRun.findMany({ where: { previousYearPaperId: p.id }, select: { id: true, bundleId: true } });
    for (const r of prs) {
      await prisma.question.deleteMany({ where: { importBatchId: r.id } });
      await prisma.bulkImportRun.delete({ where: { id: r.id } });
      if (r.bundleId) await prisma.importBundle.delete({ where: { id: r.bundleId } }).catch(() => undefined);
    }
    await prisma.question.deleteMany({ where: { previousYearPaperId: p.id } });
    await prisma.previousYearPaper.delete({ where: { id: p.id } }).catch(() => undefined);
  }
  await prisma.exam.update({ where: { id: F.neetId }, data: { isActive: F.neetWasActive } });
  console.log(JSON.stringify({ cleaned: { runs: runs.length, students: ids.length }, neetActive: F.neetWasActive }));
}

const cmd = process.argv[2];
(cmd === "setup" ? e2eSetup() : cmd === "attempts" ? e2eAttempts(process.argv[3]) : cmd === "cleanup" ? e2eCleanup(process.argv[3]) : main())
  .then(async () => {
    if (cmd) {
      await prisma.$disconnect();
      process.exit(0);
    }
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
