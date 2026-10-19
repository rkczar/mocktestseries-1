/**
 * Fixture for scripts/verify-ai-import-autoconfig-ui.mjs (scratch DB only): importer settings with Paid AI
 * OFF and a two-model list, the provider routes read from the mock, and one synthetic import that was
 * confirmed and then paused before processing (for "Reconfigure Models for This Job"). Never real AI.
 *
 *   npx tsx scripts/ai-import-autoconfig-ui-fixture.ts setup <fixtures dir> > /tmp/autoconf.json
 *   npx tsx scripts/ai-import-autoconfig-ui-fixture.ts cleanup /tmp/autoconf.json
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES, normalizeImporterSettings } from "@/lib/ai-import/config";
import { saveImporterSettings } from "@/lib/ai-import/settings";
import { refreshRoutes } from "@/lib/ai-import/routes";
import { addFile, completeFile, confirmJob, createJob, pauseJob, putChunk, requestAnalysis } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

export const START = ["mockvision/reader", "mocktext/classifier"];

async function setup(fx: string) {
  const actor = (await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } })).id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  await saveImporterSettings(normalizeImporterSettings({ aiEnabled: false, importerModels: START, privacy: { zdr: false, dataCollection: "deny" }, selection: { mode: "auto" }, limits: { renderDpi: 120, concurrency: 2 } }), actor);
  await refreshRoutes(START);
  const jobId = await createJob({ actorId: actor, title: `SYNTHETIC reconfigure ${Date.now().toString(36)}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  const bytes = readFileSync(path.join(fx, "scanned.pdf"));
  const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: "scanned.pdf", size: bytes.length, role: "PAPER", paperFileId: null });
  for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
  await completeFile({ fileId, actorId: actor });
  await requestAnalysis(jobId, actor);
  await runWorker(120_000);
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  await confirmJob({ jobId, actorId: actor, examId: j.examId, paperType: j.paperType, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 8 });
  // Paused before any worker run (the scratch server never starts one: AI_IMPORT_DISABLE_KICK=1).
  await pauseJob(jobId, actor);
  console.log(JSON.stringify({ jobId, status: (await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } })).status, start: START }));
}

async function cleanup(file: string) {
  const f = JSON.parse(readFileSync(file, "utf8")) as { jobId?: string };
  if (f.jobId) await prisma.aiImportJob.deleteMany({ where: { id: f.jobId } });
  await prisma.setting.deleteMany({ where: { key: { in: ["ai.importer", "ai.importer.routes"] } } });
  console.log(JSON.stringify({ removedJob: f.jobId ?? null }));
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "setup" ? setup(arg) : cmd === "cleanup" ? cleanup(arg) : Promise.reject(new Error("usage: setup <fixtures dir> | cleanup <json>")))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
