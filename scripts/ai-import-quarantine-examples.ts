/**
 * Quarantines every active classification example of ONE exam's importer memory (owner approval 2, 2026-11-06).
 * Nothing is deleted: entries move, with their full record, into `quarantinedCorrections` (reason, actor, time, batch),
 * and the memory history + audit log record every id. Quarantined examples are never used and never re-activated
 * automatically (re-activation: Taxonomy Reference, one example at a time, only for an approved question).
 *
 *   npx tsx scripts/ai-import-quarantine-examples.ts --exam <examId> --actor <adminUserId> --reason "<why>" [--apply] [--out report.json]
 *
 * Without --apply it is a dry run and writes nothing. The memory row is printed as counts only (no question text).
 */
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { loadExamMemory, quarantineExamples, TAXONOMY_MEMORY_PREFIX } from "@/lib/ai-import/taxonomy-memory";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const examId = arg("exam");
  const actorId = arg("actor");
  const reason = arg("reason");
  const apply = process.argv.includes("--apply");
  const out = arg("out");
  if (!examId || !actorId || !reason) throw new Error("usage: --exam <examId> --actor <adminUserId> --reason <text> [--apply] [--out file]");
  const actor = await prisma.adminUser.findUnique({ where: { id: actorId }, select: { id: true } });
  if (!actor) throw new Error(`actor ${actorId} not found`);
  const before = await loadExamMemory(examId);
  if (!before) throw new Error(`no importer memory for exam ${examId} (${TAXONOMY_MEMORY_PREFIX}${examId})`);
  const report = await quarantineExamples(examId, actorId, reason, { dryRun: !apply });
  const after = await loadExamMemory(examId);
  const summary = {
    mode: apply ? "APPLY" : "DRY RUN",
    examId,
    batch: report.batch,
    memoryVersion: { before: before.version, after: after?.version ?? null },
    before: report.before,
    expectedAfter: report.after,
    actualAfter: after ? { active: after.corrections.length, proposed: after.proposedCorrections?.length ?? 0, quarantined: after.quarantinedCorrections?.length ?? 0 } : null,
    moved: report.moved.length,
    otherEntriesUnchanged: after ? after.synonyms.length === before.synonyms.length && after.confusions.length === before.confusions.length && (after.paperRules?.length ?? 0) === (before.paperRules?.length ?? 0) && (after.headingAliases?.length ?? 0) === (before.headingAliases?.length ?? 0) && (after.formatRules?.length ?? 0) === (before.formatRules?.length ?? 0) : false,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (out) writeFileSync(out, JSON.stringify({ ...summary, entries: report.moved }, null, 2), { mode: 0o600 });
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
