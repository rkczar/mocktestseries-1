/**
 * Phase 0 source protection — scratch-only suite (synthetic rows, scratch vault; never prod).
 *   set -a; . /root/mts-scratch/srcprot/env; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-source-protection.ts
 * A: job whose originals the Question Bank depends on → Delete import refused, files/evidence/questions intact, audited.
 * B: job with no dependencies → deleted; shared paper and evidence-crop figure kept, the rest removed.
 * C: expired originals → dependent ones never offered; never purged automatically; manual purge only when independent.
 * D: temp/work/renders/orphan figures still cleaned; evidence crops never treated as orphans.
 */
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AiImportFileRole, AiImportJobStatus, RoleName } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { putContent, vaultPath, vaultRoot } from "@/lib/ai-import/vault";
import { deleteJob, deleteJobPreview, SourceProtectedError } from "@/lib/ai-import/jobs";
import { autoCleanup, executeCleanup, findCandidates, purgeOriginal, scanStorage } from "@/lib/ai-import/storage";
import { protectedFileIds } from "@/lib/ai-import/source-protection";
import { DEFAULT_IMPORTER_SETTINGS } from "@/lib/ai-import/config";
import { saveImporterSettings } from "@/lib/ai-import/settings";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "") || !process.env.AI_IMPORT_VAULT_DIR?.startsWith("/root/mts-scratch/")) {
  console.error("refusing: needs an mts_* scratch DATABASE_URL and a /root/mts-scratch vault");
  process.exit(2);
}

let failed = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || info === undefined ? "" : " " + JSON.stringify(info)}`);
};
const onDisk = (key: string) => existsSync(vaultPath(key));
const old = new Date(Date.now() - 400 * 86_400_000);
const uniq = () => randomBytes(6).toString("hex");

async function main() {
  const role = await prisma.role.upsert({ where: { name: RoleName.MASTER_ADMIN }, update: {}, create: { name: RoleName.MASTER_ADMIN } });
  const admin = await prisma.adminUser.create({ data: { name: "SP Admin", username: `sp-${uniq()}`, passwordHash: "x", roleId: role.id } });
  const exam = await prisma.exam.create({ data: { name: "SP Exam", code: `SP${uniq()}` } });
  const subject = await prisma.subject.create({ data: { name: "SP Subject", nameKey: `sp-${uniq()}` } });
  const actorId = admin.id;

  const file = async (jobId: string, role: AiImportFileRole, bytes: Buffer, retainUntil: Date | null = null) => {
    const { key } = await putContent("files", bytes, "pdf");
    return prisma.aiImportFile.create({ data: { jobId, role, originalName: `${role}-${uniq()}.pdf`, ext: "pdf", declaredBytes: bytes.length, bytes: bytes.length, uploadedById: actorId, storageKey: key, status: "ANALYZED", retainUntil } });
  };
  const figure = async (jobId: string, fileId: string, bytes: Buffer) => {
    const { key, sha256 } = await putContent("figures", bytes, "png");
    await prisma.aiImportFigure.create({ data: { jobId, fileId, pageNumber: 1, owner: "QUESTION", source: "CROP", originalKey: key, originalSha256: sha256, originalMime: "image/png", width: 1, height: 1, bytes: bytes.length } });
    return key;
  };
  const area = (a: "renders" | "work", jobId: string) => {
    const dir = path.join(vaultRoot(), a, jobId, ...(a === "renders" ? [jobId] : []));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, a === "renders" ? "p1.png" : "scratch.txt"), "x");
    return dir;
  };
  const job = (title: string) => prisma.aiImportJob.create({ data: { title, examId: exam.id, createdById: actorId, budgetInr: 0, status: AiImportJobStatus.COMPLETED } });
  const qbQuestion = () => prisma.question.create({ data: { code: `SP-${uniq()}`, examId: exam.id, subjectId: subject.id, text: "Synthetic question" } });
  const link = (jobId: string, fileId: string, questionId: string | null) =>
    prisma.aiImportQuestion.create({ data: { jobId, fileId, sourceKey: uniq(), sourceLabel: "1", orderIndex: 0, data: {}, questionType: "MCQ", questionId } });

  // ---------------- A — referenced originals
  const jA = await job("SP A referenced");
  const paperA = await file(jA.id, AiImportFileRole.PAPER, Buffer.from(`paper A ${uniq()}`));
  const keyA = await file(jA.id, AiImportFileRole.ANSWER_KEY, Buffer.from(`key A ${uniq()}`));
  const cropBytes = Buffer.from(`crop ${uniq()}`);
  const cropKey = await figure(jA.id, paperA.id, cropBytes); // an extracted figure that is also the evidence crop
  const qA = await qbQuestion();
  const aqA = await link(jA.id, paperA.id, qA.id);
  const evA = await prisma.questionSourceEvidence.create({ data: { questionId: qA.id, aiImportQuestionId: aqA.id, jobId: jA.id, fileId: paperA.id, keyFileId: keyA.id, pages: [1], questionCrops: [{ key: cropKey, page: 1, box: null }] } });
  area("renders", jA.id);

  const preA = await deleteJobPreview(jA.id);
  check("A: preview shows the source-protection block before confirmation", /cannot be deleted/.test(preA?.blocked ?? ""), preA?.blocked);
  check("A: block message gives one distinct count and the kinds (no repeated count)", /\(1 Question Bank question\(s\) depend on it \(imported from it, source evidence from its original paper, official answer-key evidence\)\)/.test(preA?.blocked ?? "") && ((preA?.blocked ?? "").match(/\d+ /g) ?? []).length === 1, preA?.blocked);
  let errA: unknown = null;
  await deleteJob({ jobId: jA.id, actorId }).catch((e) => (errA = e));
  check("A: delete refused with SourceProtectedError 409", errA instanceof SourceProtectedError && (errA as SourceProtectedError).status === 409, String(errA));
  check("A: dependency counts (1 question, 1 evidence, 1 key evidence)", errA instanceof SourceProtectedError && errA.dependencies.questions === 1 && errA.dependencies.evidence === 1 && errA.dependencies.keyEvidence === 1, (errA as SourceProtectedError)?.dependencies);
  check("A: paper, answer key and crop still on disk", onDisk(paperA.storageKey!) && onDisk(keyA.storageKey!) && onDisk(cropKey));
  check("A: job, file rows and importer question intact", !!(await prisma.aiImportJob.findUnique({ where: { id: jA.id } })) && (await prisma.aiImportFile.count({ where: { jobId: jA.id } })) === 2 && !!(await prisma.aiImportQuestion.findUnique({ where: { id: aqA.id } })));
  const evNow = await prisma.questionSourceEvidence.findUnique({ where: { id: evA.id } });
  check("A: evidence row unchanged and its file links resolve", !!evNow && evNow.fileId === paperA.id && evNow.keyFileId === keyA.id && !!(await prisma.aiImportFile.findUnique({ where: { id: evNow.fileId! } })) && !!(await prisma.aiImportFile.findUnique({ where: { id: evNow.keyFileId! } })));
  check("A: Question Bank question intact", !!(await prisma.question.findUnique({ where: { id: qA.id } })));
  check("A: refusal audited once", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_JOB_DELETE_BLOCKED", entityId: jA.id } })) === 1);
  check("A: no JOB_DELETED audit / cleanup row", !(await prisma.auditLog.count({ where: { action: "AI_IMPORT_JOB_DELETED", entityId: jA.id } })));

  // A2 — evidence-only dependency: question came from another job, only the official key file is this job's.
  const jA2 = await job("SP A2 key only");
  const keyA2 = await file(jA2.id, AiImportFileRole.ANSWER_KEY, Buffer.from(`key A2 ${uniq()}`));
  await prisma.questionSourceEvidence.update({ where: { id: evA.id }, data: { keyFileId: keyA2.id } });
  let errA2: unknown = null;
  await deleteJob({ jobId: jA2.id, actorId }).catch((e) => (errA2 = e));
  check("A2: key-evidence-only dependency also refuses delete", errA2 instanceof SourceProtectedError && errA2.dependencies.keyEvidence === 1, String(errA2));
  check("A2: key file survives", onDisk(keyA2.storageKey!));
  await prisma.questionSourceEvidence.update({ where: { id: evA.id }, data: { keyFileId: keyA.id } });

  // A3 — interrupted Bulk Import: the question exists (importBatchId = run) but the importer row was never linked back.
  const jA3 = await job("SP A3 unlinked run");
  const paperA3 = await file(jA3.id, AiImportFileRole.PAPER, Buffer.from(`paper A3 ${uniq()}`));
  const run = await prisma.bulkImportRun.create({ data: { adminUserId: actorId, filename: "ai-import-sp.zip", totalRows: 1, duplicateStrategy: "ADD_AS_NEW" } });
  await prisma.question.create({ data: { code: `SP-${uniq()}`, examId: exam.id, subjectId: subject.id, text: "Synthetic unlinked", importBatchId: run.id } });
  await prisma.aiImportQuestion.create({ data: { jobId: jA3.id, fileId: paperA3.id, sourceKey: uniq(), sourceLabel: "1", orderIndex: 0, data: {}, questionType: "MCQ", bulkImportRunId: run.id } });
  await prisma.aiImportJob.update({ where: { id: jA3.id }, data: { status: AiImportJobStatus.FAILED } });
  let errA3: unknown = null;
  await deleteJob({ jobId: jA3.id, actorId }).catch((e) => (errA3 = e));
  check("A3: unlinked bulk-imported question blocks delete", errA3 instanceof SourceProtectedError && errA3.dependencies.questions === 1, String(errA3));
  check("A3: its paper survives", onDisk(paperA3.storageKey!));

  // A4 — a non-source refusal (job importing) is not audited as a source block.
  await prisma.aiImportJob.update({ where: { id: jA.id }, data: { status: AiImportJobStatus.IMPORTING } });
  let errA4: unknown = null;
  await deleteJob({ jobId: jA.id, actorId }).catch((e) => (errA4 = e));
  check("A4: importing job refused with the importing reason, not audited as a source block", !(errA4 instanceof SourceProtectedError) && /being written/.test(String(errA4)) && (await prisma.auditLog.count({ where: { action: "AI_IMPORT_JOB_DELETE_BLOCKED", entityId: jA.id } })) === 1, String(errA4));
  await prisma.aiImportJob.update({ where: { id: jA.id }, data: { status: AiImportJobStatus.COMPLETED } });

  // ---------------- B — unreferenced job
  const jB = await job("SP B unreferenced");
  const jShare = await job("SP B share");
  const paperBytes = Buffer.from(`paper B ${uniq()}`);
  const paperB = await file(jB.id, AiImportFileRole.PAPER, paperBytes);
  await file(jShare.id, AiImportFileRole.PAPER, paperBytes); // same content → same stored key
  const keyB = await file(jB.id, AiImportFileRole.ANSWER_KEY, Buffer.from(`key B ${uniq()}`));
  const figB = await figure(jB.id, paperB.id, Buffer.from(`fig B ${uniq()}`));
  const figBcrop = await figure(jB.id, paperB.id, cropBytes); // same bytes as job A's evidence crop
  const deadQ = await qbQuestion();
  await link(jB.id, paperB.id, deadQ.id);
  await prisma.question.delete({ where: { id: deadQ.id } }); // a link to a hard-deleted question is no dependency
  area("renders", jB.id);
  area("work", jB.id);
  const preB = await deleteJobPreview(jB.id);
  check("B: preview not blocked", preB?.blocked === null, preB?.blocked);
  const resB = await deleteJob({ jobId: jB.id, actorId });
  check("B: job deleted", !(await prisma.aiImportJob.findUnique({ where: { id: jB.id } })), resB);
  check("B: unshared answer key removed from disk", !onDisk(keyB.storageKey!));
  check("B: paper shared with another job kept", onDisk(paperB.storageKey!) && resB.storedFilesKept === 1 && resB.storedFilesDeleted === 1, resB);
  check("B: own figure removed", !onDisk(figB));
  check("B: figure that is a QB evidence crop kept", onDisk(figBcrop) && cropKey === figBcrop);
  check("B: renders/work removed", !existsSync(path.join(vaultRoot(), "renders", jB.id)) && !existsSync(path.join(vaultRoot(), "work", jB.id)));
  check("B: deletion audited", (await prisma.auditLog.count({ where: { action: "AI_IMPORT_JOB_DELETED", entityId: jB.id } })) === 1);
  check("B: job A untouched", onDisk(paperA.storageKey!) && onDisk(keyA.storageKey!) && onDisk(cropKey));

  // ---------------- C — expired originals
  await prisma.aiImportFile.updateMany({ where: { jobId: jA.id }, data: { retainUntil: old } });
  const jD = await job("SP C independent expired");
  const paperD = await file(jD.id, AiImportFileRole.PAPER, Buffer.from(`paper D ${uniq()}`), old);
  const jRef = await job("SP C expired reference paper");
  const refPaper = await file(jRef.id, AiImportFileRole.PAPER, Buffer.from(`ref ${uniq()}`), old);
  await prisma.aiImportEvent.create({ data: { jobId: jA.id, type: "REFERENCE_ADDED", message: "ref", data: { storageKey: refPaper.storageKey } } });
  let cands = await findCandidates();
  const expired = cands.filter((c) => c.category === "EXPIRED_ORIGINALS").map((c) => c.key);
  check("C: dependent expired originals (paper + key) not offered", !expired.includes(paperA.storageKey!) && !expired.includes(keyA.storageKey!), expired);
  check("C: expired reference paper another import uses not offered", !expired.includes(refPaper.storageKey!), expired);
  const vaultRows = await prisma.aiImportFile.findMany({ where: { jobId: { in: [jA.id, jD.id, jShare.id] } }, select: { id: true, jobId: true, storageKey: true } });
  const prot = await protectedFileIds(prisma, vaultRows);
  check("C: vault marks job A's paper + key protected, independent paper not", prot.has(paperA.id) && prot.has(keyA.id) && !prot.has(paperD.id), [...prot]);
  const scan = await scanStorage();
  check("C: Storage Manager reports protected expired originals separately", scan.originals.expiredProtected >= 2 && scan.originals.expired >= 1, scan.originals);
  check("C: independent expired original offered", expired.includes(paperD.storageKey!), expired);
  await saveImporterSettings({ ...DEFAULT_IMPORTER_SETTINGS, retention: { ...DEFAULT_IMPORTER_SETTINGS.retention, autoCleanup: true } }, actorId);
  const forced = await executeCleanup({ actorId: "system", categories: ["EXPIRED_ORIGINALS"], keys: [paperD.storageKey!], automatic: true });
  check("C: automatic cleanup never purges an original, even when asked directly", onDisk(paperD.storageKey!) && forced.deleted === 0 && /never removed automatically/.test(forced.skipped[0]?.reason ?? ""), forced);
  const crafted = await executeCleanup({ actorId, categories: ["EXPIRED_ORIGINALS"], keys: [paperA.storageKey!, keyA.storageKey!] });
  check("C: manual cleanup with crafted dependent keys refused", onDisk(paperA.storageKey!) && onDisk(keyA.storageKey!) && crafted.deleted === 0 && crafted.skipped.length === 2, crafted);
  // The purge itself re-checks under the locks (a dependency or an import may appear after the candidate scan).
  const directDep = await purgeOriginal(paperA.storageKey!);
  check("C: locked re-check refuses a dependent original", directDep.refused === "Question Bank questions or another import depend on it" && onDisk(paperA.storageKey!), directDep);
  await prisma.aiImportJob.update({ where: { id: jD.id }, data: { status: AiImportJobStatus.IMPORTING } });
  const directBusy = await purgeOriginal(paperD.storageKey!);
  check("C: locked re-check refuses while its import is running", /being worked on/.test(directBusy.refused ?? "") && onDisk(paperD.storageKey!), directBusy);
  await prisma.aiImportJob.update({ where: { id: jD.id }, data: { status: AiImportJobStatus.COMPLETED } });
  const manual = await executeCleanup({ actorId, categories: ["EXPIRED_ORIGINALS"], keys: [paperD.storageKey!] });
  const leftovers = (await import("node:fs")).readdirSync(path.dirname(vaultPath(paperD.storageKey!))).filter((f) => f.startsWith(".removing-"));
  check("C: manual review can still purge an independent expired original (no bytes left aside)", !onDisk(paperD.storageKey!) && !leftovers.length && manual.deleted === 1 && (await prisma.aiImportFile.findUniqueOrThrow({ where: { id: paperD.id } })).status === "PURGED", manual);

  // ---------------- D — other categories
  const jE = await job("SP D finished");
  await prisma.$executeRaw`UPDATE "AiImportJob" SET "updatedAt" = ${old} WHERE "id" IN (${jE.id}, ${jA.id})`;
  const rE = area("renders", jE.id);
  const wE = area("work", jE.id);
  const tmpDir = path.join(vaultRoot(), "tmp", `orphan${uniq()}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(path.join(tmpDir, "chunk"), "x");
  utimesSync(path.join(tmpDir, "chunk"), old, old);
  const { key: orphanFig } = await putContent("figures", Buffer.from(`orphan ${uniq()}`), "png");
  // The crop survives with no AiImportFigure row → only its evidence reference protects it.
  await prisma.aiImportFigure.deleteMany({ where: { originalKey: cropKey } });
  for (const k of [orphanFig, cropKey]) utimesSync(vaultPath(k), old, old);
  cands = await findCandidates();
  const orphans = cands.filter((c) => c.category === "ORPHAN_FIGURES").map((c) => c.key);
  check("D: orphan figure offered, evidence crop not", orphans.includes(orphanFig) && !orphans.includes(cropKey), orphans);
  await autoCleanup();
  check("D: auto cleanup removed temp, worker scratch and old renders", !existsSync(tmpDir) && !existsSync(wE) && !existsSync(rE));
  check("D: auto cleanup left every original and the crop", onDisk(paperA.storageKey!) && onDisk(keyA.storageKey!) && onDisk(cropKey) && onDisk(paperB.storageKey!));
  const lastAuto = await prisma.aiImportCleanup.findFirst({ orderBy: { createdAt: "desc" } });
  check("D: auto cleanup categories exclude originals", !!lastAuto && !lastAuto.categories.includes("EXPIRED_ORIGINALS"), lastAuto?.categories);
  const figRes = await executeCleanup({ actorId, categories: ["ORPHAN_FIGURES"], keys: [orphanFig, cropKey] });
  check("D: orphan figure removed, evidence crop refused", !onDisk(orphanFig) && onDisk(cropKey) && figRes.deleted === 1, figRes);
  check("D: job A originals still referenced by evidence after all cleanups", onDisk(paperA.storageKey!) && onDisk(keyA.storageKey!) && !!(await prisma.questionSourceEvidence.findUnique({ where: { id: evA.id } })));

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
