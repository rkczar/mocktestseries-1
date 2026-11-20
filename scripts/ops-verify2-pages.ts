/**
 * Page-limited Verify 2 retry for one finished import (2026-11-20, CMS 2026 P-I job: pages 9, 10, 23).
 * Reads ONLY the listed page images, never classifies, and caps new spend at CAP_INR (the job's confirmed maximum is
 * set to spent + cap, so the AI gateway refuses any request past it).
 *   Dry run (default, read-only): pages, questions, requests, estimate and maximum.
 *   Apply:  --apply --confirm=<jobId>   (ACTOR=<admin id> required; queues Verify 2 for the worker)
 *   JOB=<id> PAGES=9,10,23 CAP_INR=1.5 MODEL=<model> NODE_OPTIONS=--conditions=react-server npx tsx scripts/ops-verify2-pages.ts
 */
import { prisma } from "@/lib/prisma";
import { requestVerify2, verify2Preview, verify2Units, inScope, type Verify2Scope } from "@/lib/ai-import/paper-verify";

const JOB = process.env.JOB ?? "";
const pages = (process.env.PAGES ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
const cap = Number(process.env.CAP_INR ?? "1.5");
const model = process.env.MODEL ?? "";
const apply = process.argv.includes("--apply");

void (async () => {
  if (!JOB || !pages.length || !model || !(cap > 0) || cap > 20) throw new Error("set JOB, PAGES, MODEL and CAP_INR (0 < cap <= 20, owner limit)");
  const scope: Verify2Scope = { pages, capInr: cap };
  const p = await verify2Preview(JOB, model, scope);
  const units = (await verify2Units(JOB)).filter((u) => inScope(u, scope));
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId: JOB, pages: { hasSome: pages } }, select: { sourceNumber: true, pages: true, status: true }, orderBy: { orderIndex: "asc" } });
  console.log(JSON.stringify({ model: p.model, pagesInScope: units.map((u) => `${u.file.originalName} p${u.pageNumber}`), requests: p.units, classify: p.classifyBatches, questionsToRead: p.questions, questionsOnPages: qs.map((q) => `Q${q.sourceNumber ?? "?"}(p${q.pages.join("/")},${q.status})`), estimateInr: p.estimateInr, maxInrWorstCase: p.maxInr, hardCapInr: cap, spentInr: p.spentInr, problems: (p as { problems?: string[] }).problems ?? [] }, null, 1));
  if (!apply) return console.log("DRY RUN — nothing sent, nothing changed.");
  if (!process.argv.includes(`--confirm=${JOB}`) || !process.env.ACTOR) throw new Error(`refusing: pass --confirm=${JOB} and ACTOR`);
  const r = await requestVerify2({ jobId: JOB, actorId: process.env.ACTOR, model, confirmedMaxInr: p.maxInr, scope });
  console.log("REQUESTED:", JSON.stringify(r).slice(0, 400));
})()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
