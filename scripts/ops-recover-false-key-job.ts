/**
 * Recovery of an import whose answer key is not an answer key (2026-11-20: job cmwoezrtp00wt8dkz0olhkbo2, the CMS 2026
 * Paper II TEST BOOKLET linked as Paper I's key). Needs the fail-closed key check (fix/key-integrity) deployed.
 *   Dry run (default, read-only): the key checks and the questions whose status / official answer would change.
 *   Apply: --apply --confirm=<jobId>  → JSON backup of the job's questions / files / key entries, then the deterministic
 *   post-processing only (no AI, aiEnabled forced off), a RECOVERY_FALSE_KEY event, an after-state file and the diff.
 * Never: unlinks / deletes the key file, deletes or edits question text / options, touches imported questions (Q3 stays
 * as it is in the Question Bank), approves, publishes, or sets an answer.
 *   JOB=<id> OUT=<evidence dir> NODE_OPTIONS=--conditions=react-server npx tsx scripts/ops-recover-false-key-job.ts [--apply --confirm=<id>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { keyPaperChecks } from "@/lib/ai-import/key-check";
import { runPostProcessing } from "@/lib/ai-import/post";
import { normalizeImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { logEvent } from "@/lib/ai-import/jobs";

const JOB = process.env.JOB ?? "";
const OUT = process.env.OUT ?? "";
const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes(`--confirm=${JOB}`);
const snap = (jobId: string) => prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: { orderIndex: "asc" }, select: { id: true, sourceNumber: true, status: true, answerStatus: true, officialAnswer: true, finalAnswer: true, approvedById: true, questionId: true, issueCodes: true } });

void (async () => {
  if (!JOB || !OUT) throw new Error("set JOB and OUT");
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: JOB } });
  const checks = await keyPaperChecks(JOB);
  console.log("key checks:", checks.map((c) => `${c.keyFile} → ${c.state}: ${c.detail.slice(0, 160)}`));
  const usable = checks.filter((c) => c.state === "MATCH" || c.state === "CONFIRMED");
  const before = await snap(JOB);
  console.log(`questions ${before.length}; OFFICIAL_MATCHED ${before.filter((q) => q.answerStatus === "OFFICIAL_MATCHED").length}; READY ${before.filter((q) => q.status === "READY").length}; usable keys ${usable.length}`);
  if (!apply) {
    console.log("DRY RUN — nothing changed. Expected after apply: no OFFICIAL_MATCHED from an unusable key; those questions leave READY.");
    return;
  }
  if (!confirmed) throw new Error(`refusing: pass --confirm=${JOB}`);
  if (checks.some((c) => c.state === "MATCH" || c.state === "CONFIRMED")) throw new Error("refusing: a key is usable — this recovery is only for a job whose key is not usable");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/backup.json`, JSON.stringify({ at: new Date().toISOString(), job, questions: await prisma.aiImportQuestion.findMany({ where: { jobId: JOB } }), files: await prisma.aiImportFile.findMany({ where: { jobId: JOB } }), keyEntries: await prisma.aiImportKeyEntry.findMany({ where: { jobId: JOB } }) }, null, 1));
  await runPostProcessing({ job, settings: { ...normalizeImporterSettings(await getImporterSettings()), aiEnabled: false }, verifyMode: "risk", examName: "", subjectName: null, stillRunning: async () => true } as never);
  const after = await snap(JOB);
  const diff = after.map((a) => ({ a, b: before.find((x) => x.id === a.id)! })).filter(({ a, b }) => a.status !== b.status || a.answerStatus !== b.answerStatus || String(a.officialAnswer) !== String(b.officialAnswer)).map(({ a, b }) => ({ id: a.id, n: a.sourceNumber, status: `${b.status}→${a.status}`, answer: `${b.answerStatus}→${a.answerStatus}`, official: `${b.officialAnswer}→${a.officialAnswer}` }));
  writeFileSync(`${OUT}/after.json`, JSON.stringify(after, null, 1));
  writeFileSync(`${OUT}/diff.json`, JSON.stringify(diff, null, 1));
  await logEvent(JOB, "RECOVERY_FALSE_KEY", `Recovery: the answer key was re-checked (${checks.map((c) => `${c.keyFile}: ${c.state}`).join("; ")}); ${diff.length} question(s) changed status or official answer. Nothing was deleted, approved or answered.`, { changed: diff.length, evidence: OUT });
  console.log(`APPLIED: ${diff.length} question(s) changed; evidence ${OUT}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
