/**
 * One-off backfill (2026-11-26): source evidence (QuestionSourceEvidence + stored crops) for every Question Bank question
 * imported by the AI Question Importer before evidence was kept. Resumable (skips questions that already have it),
 * idempotent, read-only for questions/answers. Questions whose original was purged get an "unavailable" row, no image.
 *   cd /var/www/mocktestseries-current && set -a && . ./.env && set +a && PG_POOL_MAX=3 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-question-source.ts [jobId ...]
 */
import { prisma } from "@/lib/prisma";
import { captureQuestionSource } from "@/lib/question-source/capture";

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh"); // re-capture rows that already exist (crop logic changed)
  const jobs = args.filter((a) => !a.startsWith("--"));
  const have = refresh ? new Set<string>() : new Set((await prisma.questionSourceEvidence.findMany({ select: { questionId: true } })).map((r) => r.questionId));
  const rows = await prisma.aiImportQuestion.findMany({ where: { questionId: { not: null }, ...(jobs.length ? { jobId: { in: jobs } } : {}) }, orderBy: [{ jobId: "asc" }, { orderIndex: "asc" }], select: { id: true, questionId: true } });
  const todo = rows.filter((r) => !have.has(r.questionId!));
  const stats = { done: 0, withCrop: 0, withKey: 0, failed: 0 };
  for (const r of todo) {
    try {
      const x = await captureQuestionSource(r.id);
      if (x) { stats.done++; if (x.crops) stats.withCrop++; if (x.key) stats.withKey++; }
    } catch (e) {
      stats.failed++;
      console.error("failed", r.id, (e as Error).message.slice(0, 160));
    }
    if ((stats.done + stats.failed) % 100 === 0) console.log(JSON.stringify(stats));
  }
  console.log("FINAL", todo.length, JSON.stringify(stats));
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
