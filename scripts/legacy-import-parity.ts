/**
 * LEGACY importer parity (NEET Phase 3 gate §55).
 *
 * Runs representative legacy (RUHS-style) files through the importer's own
 * library functions — parse → shape validation → DB resolution → execute —
 * and prints a normalized JSON result. Run it from a worktree of the BASELINE
 * commit and from the new commit against the same disposable DB, then diff:
 * the outputs must be identical.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/legacy-import-parity.ts <fixture dir> > out.json
 *
 * Only APIs that exist in both versions are used. Everything it creates is
 * deleted again (questions, runs).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ImportRowSeverity, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildTaxonomyLookups, mergeRowData, parseImportFile, resolveRow, runExamContextFor, validateImportRows, type BulkImportRow } from "@/lib/bulk-import";
import { executeBulkImport } from "@/lib/bulk-import-execute";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

const dir = process.argv[2];
const strip = (o: unknown) => JSON.parse(JSON.stringify(o, (k, v) => (["id", "runId", "questionId", "createdAt", "updatedAt", "code", "questionCode", "importBatchId"].includes(k) ? undefined : v)));

async function runOnce(file: string, examId: string, strategy: "SKIP" | "REPLACE" | "ADD_AS_NEW", adminId: string) {
  const bytes = readFileSync(path.join(dir, file));
  const f = new File([new Uint8Array(bytes)], file);
  const { rows, errors } = await parseImportFile(f);
  const run = await prisma.bulkImportRun.create({ data: { adminUserId: adminId, filename: `parity-${file}`, format: file.endsWith(".csv") ? "CSV" : "XLSX", examId, totalRows: rows.length, duplicateStrategy: strategy, status: "UPLOADED" } });
  await prisma.bulkImportRow.createMany({ data: rows.map((r) => ({ runId: run.id, rowNumber: r.rowNumber, rawData: r as unknown as Prisma.InputJsonValue, severity: ImportRowSeverity.ERROR })) });
  const lookups = await buildTaxonomyLookups(prisma);
  const rx = runExamContextFor(lookups.exams, run);
  const validated = [];
  for (const row of await prisma.bulkImportRow.findMany({ where: { runId: run.id }, orderBy: { rowNumber: "asc" } })) {
    const merged = mergeRowData(row.rawData, row.editedData) as BulkImportRow;
    const [shape] = validateImportRows([merged]);
    const r = await resolveRow(prisma, lookups, shape, undefined, rx);
    validated.push({ row: row.rowNumber, severity: r.severity, errors: r.errors, warnings: r.warnings, reviewRequired: r.reviewRequired, forceDraft: r.forceDraft, dup: r.resolvedData?.duplicateReason ?? null });
    await prisma.bulkImportRow.update({ where: { id: row.id }, data: { severity: r.severity, errors: r.errors, warnings: r.warnings, reviewRequired: r.reviewRequired } });
  }
  const result = await executeBulkImport({ runId: run.id, adminUserId: adminId });
  const qs = await prisma.question.findMany({
    where: { importBatchId: run.id },
    orderBy: { createdAt: "asc" },
    select: { text: true, imageUrl: true, status: true, difficulty: true, source: true, examYear: true, reviewRequired: true, reviewReason: true, contentFormat: true, explanation: true, editorialStage: true, subject: { select: { name: true } }, topic: { select: { name: true } }, options: { orderBy: { order: "asc" }, select: { label: true, text: true, isCorrect: true, order: true, imageUrl: true } }, _count: { select: { assets: true } } },
  });
  const rowsAfter = await prisma.bulkImportRow.findMany({ where: { runId: run.id }, orderBy: { rowNumber: "asc" }, select: { rowNumber: true, status: true, severity: true, errorMessage: true, reviewRequired: true } });
  return { run, out: strip({ file, strategy, parsed: rows, parseErrors: errors, validated, result: { ...result, runId: undefined }, questions: qs, rows: rowsAfter }) };
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });
  const ruhs = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const created: string[] = [];
  const out = [];
  for (const file of ["legacy-ruhs.csv", "legacy-ruhs.xlsx"]) {
    // 1st import creates; the 2nd–4th re-import the same file → duplicate behaviour per strategy.
    for (const strategy of ["SKIP", "SKIP", "REPLACE", "ADD_AS_NEW"] as const) {
      const { run, out: o } = await runOnce(file, ruhs.id, strategy, admin.id);
      created.push(run.id);
      out.push(o);
    }
    for (const id of created.splice(0)) await prisma.question.deleteMany({ where: { importBatchId: id } });
    await prisma.bulkImportRun.deleteMany({ where: { filename: { startsWith: "parity-" } } });
  }
  console.log(JSON.stringify(out, null, 1));
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
