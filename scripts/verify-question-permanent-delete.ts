/**
 * Synthetic suite for lib/question-permanent-delete.ts. Scratch DB + scratch STORAGE_DIR only.
 *   DATABASE_URL=<mts_* scratch> STORAGE_DIR=<scratch dir> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-question-permanent-delete.ts
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { mediaRootDir } from "@/lib/media-storage";
import { permanentlyDeleteQuestions, previewQuestionDelete } from "@/lib/question-permanent-delete";

const url = process.env.DATABASE_URL ?? "";
if (!/\/mts_[a-z0-9_]+(\?|$)/.test(url)) throw new Error("Refusing: DATABASE_URL must be an mts_* scratch database.");
if (!process.env.STORAGE_DIR || process.env.STORAGE_DIR.startsWith("/var/www")) throw new Error("Refusing: set a scratch STORAGE_DIR.");

const T = "QDEL";
let pass = 0,
  fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
};
const throws = async (fn: () => Promise<unknown>, re: RegExp) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};
const exists = (p: string) => access(p).then(() => true, () => false);
let op = 0;
const opId = () => `${T.toLowerCase()}-op-${Date.now()}-${op++}`;

async function seed() {
  const roles = Object.fromEntries(
    await Promise.all(
      (["MASTER_ADMIN", "FULL_ADMIN"] as const).map(async (name) => [name, (await prisma.role.upsert({ where: { name }, update: {}, create: { name } })).id]),
    ),
  );
  const admin = (role: string, u: string, isActive = true) =>
    prisma.adminUser.create({ data: { name: u, username: `${T}-${u}`, passwordHash: "x", roleId: roles[role], isActive } });
  const master = await admin("MASTER_ADMIN", "master");
  const full = await admin("FULL_ADMIN", "full");
  const inactive = await admin("MASTER_ADMIN", "inactive", false);

  const exam = await prisma.exam.create({ data: { name: `${T} Exam`, code: `${T}EX` } });
  const subject = await prisma.subject.create({ data: { name: `${T} Subject`, nameKey: `${T.toLowerCase()}-subject` } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2026, title: `${T} Paper` } });
  const otherPaper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2025, title: `${T} Other Paper` } });
  const run = (f: string) => prisma.bulkImportRun.create({ data: { adminUserId: master.id, filename: f, totalRows: 3, duplicateStrategy: "SKIP" } });
  const batchA = await run("a.csv");
  const batchB = await run("b.csv");

  const shaShared = "a".repeat(64);
  const sharedKey = `q/aa/${shaShared}.webp`;
  await mkdir(path.dirname(path.join(mediaRootDir(), sharedKey)), { recursive: true });
  await writeFile(path.join(mediaRootDir(), sharedKey), "img");
  const snapKey = `q/bb/${"b".repeat(64)}.webp`;
  await mkdir(path.dirname(path.join(mediaRootDir(), snapKey)), { recursive: true });
  await writeFile(path.join(mediaRootDir(), snapKey), "img");

  const q = (code: string, extra: Record<string, unknown> = {}) =>
    prisma.question.create({
      data: {
        code: `${T}-${code}`,
        examId: exam.id,
        subjectId: subject.id,
        text: `${T} secret text ${code}`,
        status: "PUBLISHED",
        previousYearPaperId: paper.id,
        importBatchId: batchA.id,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `opt ${label}`, order, isCorrect: label === "A" })) },
        ...extra,
      },
    });
  const draft = await q("DRAFT", { status: "DRAFT" });
  const published = await q("PUB");
  const noKey = await q("NOKEY", { options: { create: ["A", "B"].map((label, order) => ({ label, text: label, order, isCorrect: false })) } });
  const retired = await q("RET", { retiredAt: new Date(), status: "ARCHIVED" });
  const variant = await q("VAR", { parentQuestionId: published.id, previousYearPaperId: null, importBatchId: null });
  const keep = await q("KEEP"); // same batch, never selected in single/bulk tests
  const bOnly = await q("BONLY", { importBatchId: batchB.id });
  const foreign = await q("FOREIGN", { previousYearPaperId: otherPaper.id });
  const sharedImgA = await q("IMGA", { importBatchId: batchB.id });
  const sharedImgB = await q("IMGB", { importBatchId: batchB.id });
  const snapImg = await q("SNAP", { importBatchId: batchB.id });

  const asset = (questionId: string, storageKey: string, sha256: string) =>
    prisma.questionAsset.create({ data: { questionId, role: "QUESTION", storageKey, mime: "image/webp", width: 1, height: 1, bytes: 3, sha256, alt: "x" } });
  await asset(sharedImgA.id, sharedKey, shaShared);
  await asset(sharedImgB.id, sharedKey, shaShared);
  await asset(snapImg.id, snapKey, "b".repeat(64));

  const mockA = await prisma.mockTest.create({
    data: { examId: exam.id, title: `${T} Mock A`, durationMinutes: 30, status: "PUBLISHED", questions: { create: [published, keep, draft].map((x, order) => ({ questionId: x.id, order })) } },
  });
  const mockB = await prisma.mockTest.create({
    data: { examId: exam.id, title: `${T} Mock B`, durationMinutes: 30, status: "PUBLISHED", questions: { create: [published, bOnly].map((x, order) => ({ questionId: x.id, order })) } },
  });
  const custom = await prisma.customModule.create({ data: { examId: exam.id, title: `${T} Custom`, questions: { create: [{ questionId: published.id, order: 0 }] } } });

  const student = await prisma.student.create({ data: { studentId: `${T}-S1`, name: "S1", email: "qdel1@example.test", authProvider: "CREDENTIALS" } });
  const other = await prisma.student.create({ data: { studentId: `${T}-S2`, name: "S2", email: "qdel2@example.test", authProvider: "CREDENTIALS" } });
  const attempt = await prisma.testAttempt.create({
    data: { studentId: student.id, sourceType: "MOCK_TEST", examId: exam.id, mockTestId: mockA.id, durationMinutes: 30, totalQuestions: 3, status: "SUBMITTED", score: 2, submittedAt: new Date() },
  });
  const otherAttempt = await prisma.testAttempt.create({
    data: { studentId: other.id, sourceType: "MOCK_TEST", examId: exam.id, mockTestId: mockB.id, durationMinutes: 30, totalQuestions: 2, status: "SUBMITTED", score: 1, submittedAt: new Date() },
  });
  for (const [a, s, qs] of [
    [attempt, student, [published, keep, draft]],
    [otherAttempt, other, [bOnly, snapImg]],
  ] as const) {
    let order = 0;
    for (const x of qs) {
      const taq = await prisma.testAttemptQuestion.create({
        data: { attemptId: a.id, questionId: x.id, order: order++, questionSnapshot: { text: x.text, img: x.id === snapImg.id ? snapKey : null } },
      });
      await prisma.answer.create({ data: { attemptId: a.id, attemptQuestionId: taq.id, studentId: s.id, questionId: x.id } });
    }
  }
  await prisma.savedQuestion.create({ data: { studentId: student.id, questionId: published.id } });
  await prisma.reportedQuestion.create({ data: { studentId: student.id, questionId: published.id } });
  await prisma.aIExplanation.create({ data: { questionId: published.id, content: { text: "ai" }, model: "m" } });
  await prisma.bulkImportRow.create({ data: { runId: batchA.id, rowNumber: 1, questionId: published.id, rawData: {} } }).catch(() => null);

  return { master, full, inactive, paper, otherPaper, batchA, batchB, draft, published, noKey, retired, variant, keep, bOnly, foreign, sharedImgA, sharedImgB, snapImg, sharedKey, snapKey, mockA, mockB, custom, student, other, attempt, otherAttempt };
}

async function orphanCount() {
  const rows = await prisma.$queryRaw<{ t: string; n: bigint }[]>`
    SELECT 'taq' t, count(*) n FROM "TestAttemptQuestion" x WHERE NOT EXISTS (SELECT 1 FROM "Question" q WHERE q.id = x."questionId")
    UNION ALL SELECT 'answer', count(*) FROM "Answer" x WHERE NOT EXISTS (SELECT 1 FROM "Question" q WHERE q.id = x."questionId")
    UNION ALL SELECT 'bulkrow', count(*) FROM "BulkImportRow" x WHERE x."questionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Question" q WHERE q.id = x."questionId")
    UNION ALL SELECT 'igitem', count(*) FROM "InstagramBatchItem" x WHERE NOT EXISTS (SELECT 1 FROM "Question" q WHERE q.id = x."questionId")`;
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

async function main() {
  const s = await seed();
  const P = { paperId: s.paper.id };
  const qCount = () => prisma.question.count({ where: { code: { startsWith: `${T}-` } } });
  const before = await qCount();

  // 15 unauthorized
  ok("FULL_ADMIN rejected", await throws(() => permanentlyDeleteQuestions({ actorId: s.full.id, scope: P, ids: [s.draft.id], operationId: opId(), kind: "SINGLE" }), /Master Admin/));
  ok("inactive MASTER_ADMIN rejected", await throws(() => previewQuestionDelete({ actorId: s.inactive.id, scope: P, ids: [s.draft.id] }), /Master Admin/));
  // cross-paper / cross-batch / malformed
  ok("cross-paper id rejected", await throws(() => permanentlyDeleteQuestions({ actorId: s.master.id, scope: P, ids: [s.draft.id, s.foreign.id], operationId: opId(), kind: "BULK" }), /outside this paper/));
  ok("cross-batch id rejected", await throws(() => permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchA.id }, ids: [s.bOnly.id], operationId: opId(), kind: "BULK" }), /outside this paper/));
  ok("malformed ids rejected", await throws(() => permanentlyDeleteQuestions({ actorId: s.master.id, scope: P, ids: ["x'; DROP"], operationId: opId(), kind: "BULK" }), /Invalid/));
  ok("bad operation id rejected", await throws(() => permanentlyDeleteQuestions({ actorId: s.master.id, scope: P, ids: [s.draft.id], operationId: "../x", kind: "SINGLE" }), /operation id/));
  ok("rejections changed nothing", (await qCount()) === before);

  // preview (16: cancel = preview only, nothing changes)
  const pv = await previewQuestionDelete({ actorId: s.master.id, scope: P, ids: [s.published.id] });
  ok("preview includes AI variant", pv.counts.questions === 2 && pv.questions.some((q) => q.isVariant));
  ok("preview counts dependents", pv.counts.mock === 2 && pv.counts.custom === 1 && pv.counts.attemptQuestions === 1 && pv.counts.answers === 1 && pv.counts.saved === 1 && pv.counts.reports === 1 && pv.counts.aiExplanations === 1, pv.counts);
  ok("preview (cancel) deletes nothing", (await qCount()) === before);

  // 17 DB failure mid-transaction → rollback, error surfaced
  const failing = new Proxy(prisma, {
    get(t, k) {
      if (k !== "$transaction") return Reflect.get(t, k);
      return (fn: (tx: unknown) => Promise<unknown>, o: unknown) =>
        t.$transaction(async (tx) => fn(new Proxy(tx, { get: (tt, kk) => (kk === "auditLog" ? { create: () => Promise.reject(new Error("simulated db failure")) } : Reflect.get(tt, kk)) })), o as never);
    },
  }) as typeof prisma;
  ok("db failure throws (no false success)", await throws(() => permanentlyDeleteQuestions({ actorId: s.master.id, scope: P, ids: [s.draft.id], operationId: opId(), kind: "SINGLE" }, failing), /simulated/));
  ok("db failure rolled back fully", (await prisma.question.count({ where: { id: s.draft.id } })) === 1 && (await prisma.mockTestQuestion.count({ where: { questionId: s.draft.id } })) === 1);

  // 1,5 single draft delete from multi-question batch
  const op1 = opId();
  const r1 = await permanentlyDeleteQuestions({ actorId: s.master.id, scope: P, ids: [s.draft.id], operationId: op1, kind: "SINGLE" });
  ok("single draft deleted", r1.deleted === 1 && (await prisma.question.count({ where: { id: s.draft.id } })) === 0);
  ok("single: options gone", (await prisma.questionOption.count({ where: { questionId: s.draft.id } })) === 0);
  ok("single: attempt kept, its question row + answer gone", (await prisma.testAttempt.count({ where: { id: s.attempt.id } })) === 1 && (await prisma.testAttemptQuestion.count({ where: { attemptId: s.attempt.id } })) === 2 && (await prisma.answer.count({ where: { questionId: s.draft.id } })) === 0);
  ok("single: same-batch question kept", (await prisma.question.count({ where: { id: s.keep.id } })) === 1);
  // 18 retry / replay
  const r1b = await permanentlyDeleteQuestions({ actorId: s.master.id, scope: P, ids: [s.draft.id], operationId: op1, kind: "SINGLE" });
  ok("retry with same op id replays", r1b.replayed && r1b.deleted === 1 && (await prisma.auditLog.count({ where: { entityId: op1 } })) === 1);
  const r1c = await permanentlyDeleteQuestions({ actorId: s.master.id, scope: P, ids: [s.draft.id], operationId: opId(), kind: "SINGLE" });
  ok("re-delete of gone id is a no-op", r1c.deleted === 0 && r1c.alreadyGone === 1);

  // audit content
  const audit = await prisma.auditLog.findFirst({ where: { entityId: op1 } });
  const meta = JSON.stringify(audit?.metadata ?? {});
  ok("audit: actor, ids, codes, counts", audit?.actorId === s.master.id && meta.includes(s.draft.id) && meta.includes(`${T}-DRAFT`) && meta.includes('"counts"'));
  ok("audit: no question text", !meta.includes("secret text"));

  // 2,3,4,6,7,10,11 bulk: published (multi-test, AI, saved, report, variant) + no-key + retired
  const r2 = await permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchA.id }, ids: [s.published.id, s.noKey.id, s.retired.id], operationId: opId(), kind: "BULK" });
  ok("bulk deleted 3 + variant", r2.deleted === 4, r2);
  ok("bulk: mock/custom links removed, tests kept", (await prisma.mockTestQuestion.count({ where: { questionId: s.published.id } })) === 0 && (await prisma.customModuleQuestion.count({ where: { questionId: s.published.id } })) === 0 && (await prisma.mockTest.count({ where: { id: { in: [s.mockA.id, s.mockB.id] } } })) === 2 && (await prisma.customModule.count({ where: { id: s.custom.id } })) === 1);
  ok("bulk: saved/report/AI explanation cascaded", (await prisma.savedQuestion.count({ where: { questionId: s.published.id } })) + (await prisma.reportedQuestion.count({ where: { questionId: s.published.id } })) + (await prisma.aIExplanation.count({ where: { questionId: s.published.id } })) === 0);
  ok("bulk: variant deleted", (await prisma.question.count({ where: { id: s.variant.id } })) === 0);
  ok("bulk: counts match", r2.counts.mock === 2 && r2.counts.custom === 1 && r2.counts.questions === 4, r2.counts);
  ok("unrelated attempt intact", (await prisma.testAttemptQuestion.count({ where: { attemptId: s.otherAttempt.id } })) === 2 && (await prisma.answer.count({ where: { attemptId: s.otherAttempt.id } })) === 2);
  ok("students + attempts intact", (await prisma.student.count({ where: { studentId: { startsWith: `${T}-` } } })) === 2 && (await prisma.testAttempt.count({ where: { id: { in: [s.attempt.id, s.otherAttempt.id] } } })) === 2);
  const att = await prisma.testAttempt.findUnique({ where: { id: s.attempt.id }, select: { score: true, totalQuestions: true } });
  ok("attempt score not rewritten", att?.score === 2 && att?.totalQuestions === 3);

  // 9 shared images: deleting one user keeps the file; snapshot-referenced key kept
  await permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchB.id }, ids: [s.sharedImgA.id], operationId: opId(), kind: "SINGLE" });
  ok("shared image kept while still used", await exists(path.join(mediaRootDir(), s.sharedKey)));
  await permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchB.id }, ids: [s.sharedImgB.id], operationId: opId(), kind: "SINGLE" });
  ok("image removed when last user gone", !(await exists(path.join(mediaRootDir(), s.sharedKey))));

  // 19 concurrent: same ids, different op ids
  const [c1, c2] = await Promise.allSettled([
    permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchB.id }, ids: [s.snapImg.id], operationId: opId(), kind: "SINGLE" }),
    permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchB.id }, ids: [s.snapImg.id], operationId: opId(), kind: "SINGLE" }),
  ]);
  const del = [c1, c2].map((c) => (c.status === "fulfilled" ? c.value.deleted : 0));
  ok("concurrent delete: exactly one deletes", del[0] + del[1] === 1, [c1.status, c2.status, del]);

  // 6,8 batch delete: whole batch B only
  const keepCount = await prisma.question.count({ where: { importBatchId: s.batchA.id } });
  const r3 = await permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchB.id }, ids: "ALL_IN_BATCH", operationId: opId(), kind: "BATCH" });
  ok("batch delete removed batch B", r3.deleted === 1 && (await prisma.question.count({ where: { importBatchId: s.batchB.id } })) === 0, r3);
  ok("batch delete left batch A + other paper", (await prisma.question.count({ where: { importBatchId: s.batchA.id } })) === keepCount && (await prisma.question.count({ where: { id: s.foreign.id } })) === 1);
  ok("batch row itself not deleted (only questions)", (await prisma.bulkImportRun.count({ where: { id: s.batchB.id } })) === 1);
  ok("empty batch re-delete refused", await throws(() => permanentlyDeleteQuestions({ actorId: s.master.id, scope: { ...P, batchKey: s.batchB.id }, ids: "ALL_IN_BATCH", operationId: opId(), kind: "BATCH" }), /no questions/));

  // 21 Live CBT / running-attempt isolation: a question in an IN_PROGRESS attempt or a SCHEDULED/LIVE Live Test is refused
  const keepIds = { actorId: s.master.id, scope: { ...P, batchKey: s.batchA.id }, ids: [s.keep.id] };
  const running = await prisma.testAttempt.create({
    data: { studentId: s.other.id, sourceType: "MOCK_TEST", examId: (await prisma.question.findUniqueOrThrow({ where: { id: s.keep.id } })).examId, mockTestId: s.mockA.id, durationMinutes: 30, totalQuestions: 1, status: "IN_PROGRESS" },
  });
  await prisma.testAttemptQuestion.create({ data: { attemptId: running.id, questionId: s.keep.id, order: 0, questionSnapshot: {} } });
  ok("in-progress attempt blocks preview", await throws(() => previewQuestionDelete(keepIds), /in-progress attempt/));
  ok("in-progress attempt blocks delete", await throws(() => permanentlyDeleteQuestions({ ...keepIds, operationId: opId(), kind: "SINGLE" }), /in-progress attempt/));
  ok("blocked delete removed nothing", (await prisma.question.count({ where: { id: s.keep.id } })) === 1 && (await prisma.testAttemptQuestion.count({ where: { attemptId: running.id } })) === 1);
  await prisma.testAttempt.update({ where: { id: running.id }, data: { status: "SUBMITTED" } });
  const lt = await prisma.liveTest.create({
    data: { examId: running.examId, title: `${T} Live`, startAt: new Date(Date.now() + 3600e3), endAt: new Date(Date.now() + 7200e3), studentDurationMinutes: 30, questionCount: 1, status: "SCHEDULED", questions: { create: [{ questionId: s.keep.id, order: 0 }] } },
  });
  ok("scheduled Live Test blocks delete", await throws(() => permanentlyDeleteQuestions({ ...keepIds, operationId: opId(), kind: "SINGLE" }), /Live Test/));
  await prisma.liveTest.update({ where: { id: lt.id }, data: { status: "LIVE" } });
  ok("running Live Test blocks preview", await throws(() => previewQuestionDelete(keepIds), /Live Test/));
  await prisma.liveTest.update({ where: { id: lt.id }, data: { status: "ENDED" } });
  ok("ended Live Test + submitted attempt: preview allowed", (await previewQuestionDelete(keepIds)).questions.length === 1);

  // 20 orphans
  const orphans = await orphanCount();
  ok("no orphaned references", Object.values(orphans).every((n) => n === 0), orphans);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
