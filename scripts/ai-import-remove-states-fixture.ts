/**
 * Fixture for scripts/verify-ai-import-remove-ui.mjs (scratch DB only): one
 * synthetic import job per lifecycle state, so the file Remove button can be
 * checked in each — Uploading (with an unfinished upload), Uploading with a
 * linked answer key, Awaiting confirmation, Processing, Ready to import and
 * Cancelled — plus two jobs sharing one stored file, and a processed job that
 * produced nothing (scanned paper, AI off: 0 questions, ₹0 — like a mistaken
 * upload that was confirmed) for the safe reset. AI stays OFF.
 *
 *   npx tsx scripts/ai-import-remove-states-fixture.ts setup <fixtures dir> > /tmp/states.json
 *   npx tsx scripts/ai-import-remove-states-fixture.ts cleanup /tmp/states.json
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiImportFileRole, AiImportJobStatus, AiImportPaperType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CHUNK_BYTES } from "@/lib/ai-import/config";
import { addFile, cancelJob, completeFile, confirmJob, createJob, putChunk, requestAnalysis } from "@/lib/ai-import/jobs";
import { runWorker } from "@/lib/ai-import/worker";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

async function setup(fx: string) {
  const actor = (await prisma.adminUser.findFirstOrThrow({ where: { role: { name: "MASTER_ADMIN" } }, select: { id: true } })).id;
  const exam = await prisma.exam.findFirstOrThrow({ where: { code: "RUHSMO" }, select: { id: true } });
  const suffix = Date.now().toString(36);
  const job = (title: string) => createJob({ actorId: actor, title: `${title} ${suffix}`, examId: exam.id, paperType: AiImportPaperType.FULL_PAPER, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 0 });
  const upload = async (jobId: string, file: string, role: AiImportFileRole = AiImportFileRole.PAPER, paperFileId: string | null = null) => {
    const bytes = readFileSync(path.join(fx, file));
    const { fileId, chunks } = await addFile({ jobId, actorId: actor, name: file, size: bytes.length, role, paperFileId });
    for (let i = 0; i < chunks; i++) await putChunk({ fileId, actorId: actor, index: i, bytes: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
    await completeFile({ fileId, actorId: actor });
    return fileId;
  };
  const analyze = async (jobId: string) => {
    await requestAnalysis(jobId, actor);
    await runWorker(120_000);
  };

  const draft = await job("SYNTHETIC uploading");
  await upload(draft, "digital-clean.pdf");
  await upload(draft, "key.csv", AiImportFileRole.ANSWER_KEY);
  // An unfinished upload (no chunks sent): only "Remove upload" applies to it.
  await addFile({ jobId: draft, actorId: actor, name: "half-uploaded.pdf", size: 1000, role: AiImportFileRole.PAPER, paperFileId: null });

  const linked = await job("SYNTHETIC linked key");
  const linkedPaper = await upload(linked, "scanned.pdf");
  await upload(linked, "scanned-key.png", AiImportFileRole.ANSWER_KEY, linkedPaper);

  const awaiting = await job("SYNTHETIC awaiting");
  await upload(awaiting, "digital-clean.pdf");
  await upload(awaiting, "key-digital.pdf", AiImportFileRole.ANSWER_KEY);
  await analyze(awaiting);

  const processing = await job("SYNTHETIC processing");
  await upload(processing, "formula.pdf");
  await analyze(processing);

  const ready = await job("SYNTHETIC CMS PAPER 1 2026");
  await upload(ready, "digital-clean.pdf");
  await upload(ready, "key-digital.pdf", AiImportFileRole.ANSWER_KEY);
  await analyze(ready);
  const r = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: ready } });
  await confirmJob({ jobId: ready, actorId: actor, examId: r.examId, paperType: r.paperType, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 0 });
  await runWorker(300_000);

  // Frozen mid-processing, after the last worker run (the scratch server never starts one: AI_IMPORT_DISABLE_KICK=1).
  await prisma.aiImportJob.update({ where: { id: processing }, data: { status: AiImportJobStatus.PROCESSING, confirmedAt: new Date(), confirmedById: actor, leaseOwner: "frozen-fixture", leaseUntil: new Date(Date.now() + 7 * 86_400_000) } });

  const zero = await job("SYNTHETIC zero output");
  await upload(zero, "scanned.pdf");
  await analyze(zero);
  const z = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: zero } });
  await confirmJob({ jobId: zero, actorId: actor, examId: z.examId, paperType: z.paperType, subjectId: null, year: 2026, paperCode: null, previousYearPaperId: null, budgetInr: 0 });
  await runWorker(300_000);

  const cancelled = await job("SYNTHETIC cancelled");
  await upload(cancelled, "photo.png");
  await analyze(cancelled);
  await cancelJob(cancelled, actor);

  const sharedA = await job("SYNTHETIC shared A");
  await upload(sharedA, "paper.docx");
  const sharedB = await job("SYNTHETIC shared B");
  await upload(sharedB, "paper.docx");

  const statusOf = async (id: string) => (await prisma.aiImportJob.findUniqueOrThrow({ where: { id } })).status;
  const out = { draft, linked, awaiting, processing, ready, cancelled, sharedA, sharedB, zero, statuses: {} as Record<string, string> };
  for (const [k, id] of Object.entries({ draft, linked, awaiting, processing, ready, cancelled, sharedA, sharedB, zero })) out.statuses[k] = await statusOf(id);
  console.log(JSON.stringify(out));
}

async function cleanup(file: string) {
  const f = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const ids = ["draft", "linked", "awaiting", "processing", "ready", "cancelled", "sharedA", "sharedB", "zero"].map((k) => f[k]).filter(Boolean);
  await prisma.aiImportJob.deleteMany({ where: { id: { in: ids } } });
  console.log(JSON.stringify({ removedJobs: ids.length }));
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "setup" ? setup(arg) : cmd === "cleanup" ? cleanup(arg) : Promise.reject(new Error("usage: setup <fixtures dir> | cleanup <json>")))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
