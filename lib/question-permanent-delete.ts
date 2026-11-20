import { unlink } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isSafeStorageKey, mediaRootDir } from "@/lib/media-storage";
import { MANUAL_BATCH } from "@/lib/pyq-import-batches-shared";

/**
 * The ONE permanent global question delete (individual, batch and bulk all call this).
 * Hard-deletes the canonical Question, its AI variants and every question-level dependent row
 * across the platform; never deletes a whole test attempt, student, payment or another question.
 * MASTER_ADMIN only, re-checked from the DB. Audit keeps ids/codes/counts only, never content.
 */

type Db = Prisma.TransactionClient | typeof prisma;
export class QuestionDeleteError extends Error {}

// shortcut: one transaction per request, capped; a background job is needed only above this size.
export const MAX_DELETE = 500;
const AUDIT_ACTION = "QUESTION_PERMANENT_DELETE";

export type DeleteScope = { paperId: string; batchKey?: string };
export type DependencyCounts = Record<string, number>;
export type DeletePreview = {
  questions: {
    id: string;
    code: string | null;
    preview: string;
    status: string;
    retired: boolean;
    subject: string | null;
    topic: string | null;
    batchId: string | null;
    isVariant: boolean;
  }[];
  counts: DependencyCounts;
  otherPapers: number;
  tests: { mock: number; custom: number; grand: number; live: number };
};
export type DeleteResult = {
  operationId: string;
  deleted: number;
  alreadyGone: number;
  counts: DependencyCounts;
  replayed: boolean;
};

async function assertMasterAdmin(db: Db, actorId: string) {
  const admin = await db.adminUser.findUnique({
    where: { id: actorId },
    select: { isActive: true, role: { select: { name: true } } },
  });
  if (!admin?.isActive || admin.role.name !== "MASTER_ADMIN")
    throw new QuestionDeleteError(
      "Only a Master Admin can permanently delete questions.",
    );
}

function cleanIds(ids: unknown): string[] {
  if (
    !Array.isArray(ids) ||
    ids.some((x) => typeof x !== "string" || !/^[a-z0-9]{10,40}$/i.test(x))
  )
    throw new QuestionDeleteError("Invalid question selection.");
  const out = [...new Set(ids as string[])];
  if (out.length === 0)
    throw new QuestionDeleteError("Select at least one question.");
  if (out.length > MAX_DELETE)
    throw new QuestionDeleteError(
      `At most ${MAX_DELETE} questions per deletion.`,
    );
  return out;
}

/** Ids in scope: requested ids must all belong to the paper (and batch, when given); a batch with no ids = the whole batch. */
async function resolveIds(
  db: Db,
  scope: DeleteScope,
  ids: unknown,
): Promise<string[]> {
  const batchWhere: Prisma.QuestionWhereInput = scope.batchKey
    ? { importBatchId: scope.batchKey === MANUAL_BATCH ? null : scope.batchKey }
    : {};
  const where: Prisma.QuestionWhereInput = {
    previousYearPaperId: scope.paperId,
    ...batchWhere,
  };
  if (ids === "ALL_IN_BATCH") {
    if (!scope.batchKey)
      throw new QuestionDeleteError("Batch deletion needs a batch.");
    const all = await db.question.findMany({ where, select: { id: true } });
    if (all.length === 0)
      throw new QuestionDeleteError("This batch has no questions.");
    if (all.length > MAX_DELETE)
      throw new QuestionDeleteError(
        `Batch has ${all.length} questions; the limit is ${MAX_DELETE}.`,
      );
    return all.map((q) => q.id);
  }
  const want = cleanIds(ids);
  const found = await db.question.findMany({
    where: { id: { in: want } },
    select: { id: true, previousYearPaperId: true, importBatchId: true },
  });
  const ok = await db.question.findMany({
    where: { id: { in: want }, ...where },
    select: { id: true },
  });
  if (ok.length !== found.length)
    throw new QuestionDeleteError(
      "Some selected questions are outside this paper or batch. Nothing was deleted.",
    );
  return found.map((q) => q.id); // already-deleted ids drop out here (idempotent)
}

/** Requested ids plus their AI variants (children are deleted with the parent). */
async function withVariants(db: Db, ids: string[]): Promise<string[]> {
  const kids = await db.question.findMany({
    where: { parentQuestionId: { in: ids } },
    select: { id: true },
  });
  return [...new Set([...ids, ...kids.map((k) => k.id)])];
}

async function countDependencies(
  db: Db,
  ids: string[],
): Promise<DependencyCounts> {
  const q = { questionId: { in: ids } };
  const [
    options,
    assets,
    attemptQuestions,
    answers,
    mock,
    custom,
    grand,
    live,
    saved,
    reports,
    aiExplanations,
    aiExplanationVariants,
    revisions,
    importRows,
    aiImportLinks,
    igPosts,
    igQueue,
  ] = await Promise.all([
    db.questionOption.count({ where: q }),
    db.questionAsset.count({ where: q }),
    db.testAttemptQuestion.count({ where: q }),
    db.answer.count({ where: q }),
    db.mockTestQuestion.count({ where: q }),
    db.customModuleQuestion.count({ where: q }),
    db.grandTestQuestion.count({ where: q }),
    db.liveTestQuestion.count({ where: q }),
    db.savedQuestion.count({ where: q }),
    db.reportedQuestion.count({ where: q }),
    db.aIExplanation.count({ where: q }),
    db.aIExplanationVariant.count({ where: q }),
    db.questionRevision.count({ where: q }),
    db.bulkImportRow.count({ where: q }),
    db.aiImportQuestion.count({ where: q }),
    db.instagramPost.count({ where: q }),
    db.instagramBatchItem.count({ where: q }),
  ]);
  return {
    questions: ids.length,
    options,
    assets,
    attemptQuestions,
    answers,
    mock,
    custom,
    grand,
    live,
    saved,
    reports,
    aiExplanations,
    aiExplanationVariants,
    revisions,
    importRows,
    aiImportLinks,
    igPosts,
    igQueue,
  };
}

/** Live CBT / running-attempt isolation: never pull a question out from under a student mid-test. */
async function assertNotInUse(db: Db, ids: string[]) {
  if (!ids.length) return;
  const [running, live] = await Promise.all([
    db.testAttemptQuestion.count({
      where: { questionId: { in: ids }, attempt: { status: "IN_PROGRESS" } },
    }),
    db.liveTestQuestion.count({
      where: {
        questionId: { in: ids },
        liveTest: { status: { in: ["SCHEDULED", "LIVE"] } },
      },
    }),
  ]);
  if (running || live)
    throw new QuestionDeleteError(
      `Blocked: ${running ? `${running} in-progress attempt question(s)` : ""}${running && live ? " and " : ""}${live ? `${live} scheduled/live Live Test question(s)` : ""} use these questions. Retry after the test ends.`,
    );
}

export async function previewQuestionDelete(
  input: { actorId: string; scope: DeleteScope; ids: unknown },
  db: Db = prisma,
): Promise<DeletePreview> {
  await assertMasterAdmin(db, input.actorId);
  const ids = await withVariants(
    db,
    await resolveIds(db, input.scope, input.ids),
  );
  const rows = await db.question.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      code: true,
      text: true,
      status: true,
      retiredAt: true,
      importBatchId: true,
      parentQuestionId: true,
      previousYearPaperId: true,
      subject: { select: { name: true } },
      topic: { select: { name: true } },
    },
  });
  await assertNotInUse(db, ids);
  const counts = await countDependencies(db, ids);
  return {
    questions: rows.map((r) => ({
      id: r.id,
      code: r.code,
      preview: r.text.replace(/\s+/g, " ").slice(0, 120),
      status: r.status,
      retired: !!r.retiredAt,
      subject: r.subject?.name ?? null,
      topic: r.topic?.name ?? null,
      batchId: r.importBatchId,
      isVariant: !!r.parentQuestionId,
    })),
    counts,
    otherPapers: new Set(
      rows
        .map((r) => r.previousYearPaperId)
        .filter((p) => p && p !== input.scope.paperId),
    ).size,
    tests: {
      mock: counts.mock,
      custom: counts.custom,
      grand: counts.grand,
      live: counts.live,
    },
  };
}

export async function permanentlyDeleteQuestions(
  input: {
    actorId: string;
    scope: DeleteScope;
    ids: unknown;
    operationId: string;
    kind: "SINGLE" | "BATCH" | "BULK";
  },
  db: typeof prisma = prisma,
): Promise<DeleteResult> {
  if (!/^[a-z0-9-]{8,64}$/i.test(input.operationId))
    throw new QuestionDeleteError("Invalid operation id.");
  const done = await db.auditLog.findFirst({
    where: { action: AUDIT_ACTION, entityId: input.operationId },
    select: { metadata: true },
  });
  if (done) {
    const m = done.metadata as { deleted: number; counts: DependencyCounts };
    return {
      operationId: input.operationId,
      deleted: m.deleted,
      alreadyGone: 0,
      counts: m.counts,
      replayed: true,
    };
  }
  const requested = input.ids === "ALL_IN_BATCH" ? null : cleanIds(input.ids);

  const result = await db.$transaction(
    async (tx) => {
      await assertMasterAdmin(tx, input.actorId);
      const base = await resolveIds(tx, input.scope, input.ids);
      const ids = await withVariants(tx, base);
      // Lock the rows so a concurrent delete/edit of the same questions waits, then re-reads nothing stale.
      if (ids.length)
        await tx.$queryRaw`SELECT id FROM "Question" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
      const meta = await tx.question.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, importBatchId: true },
      });
      const live = meta.map((m) => m.id);
      await assertNotInUse(tx, live);
      const counts = await countDependencies(tx, live);
      const storageKeys = (
        await tx.questionAsset.findMany({
          where: { questionId: { in: live } },
          select: { storageKey: true },
        })
      ).map((a) => a.storageKey);
      const q = { questionId: { in: live } };

      // FKs without cascade first; attempt rows go per question only (Answer cascades from TestAttemptQuestion).
      await tx.testAttemptQuestion.deleteMany({ where: q });
      await tx.mockTestQuestion.deleteMany({ where: q });
      await tx.customModuleQuestion.deleteMany({ where: q });
      await tx.grandTestQuestion.deleteMany({ where: q });
      await tx.liveTestQuestion.deleteMany({ where: q });
      await tx.instagramBatchItem.deleteMany({ where: q });
      // Plain references: unlink import provenance (evidence kept), and stop the importer re-adding it.
      await tx.bulkImportRow.updateMany({
        where: q,
        data: { questionId: null },
      });
      await tx.aiImportQuestion.updateMany({
        where: q,
        data: {
          questionId: null,
          approvedById: null,
          approvedAt: null,
          status: "REJECTED",
        },
      });
      // Options, assets, saves, reports, AI explanations/variants, revisions cascade; replacedBy/teacher refs SetNull.
      const del = await tx.question.deleteMany({ where: { id: { in: live } } });
      if (del.count !== live.length)
        throw new QuestionDeleteError(
          "Questions changed during deletion. Nothing was deleted; retry.",
        );

      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          action: AUDIT_ACTION,
          entityType: "Question",
          entityId: input.operationId,
          metadata: {
            kind: input.kind,
            paperId: input.scope.paperId,
            batchKey: input.scope.batchKey ?? null,
            deleted: del.count,
            questions: meta.map((m) => ({
              id: m.id,
              code: m.code,
              batchId: m.importBatchId,
            })),
            counts,
            at: new Date().toISOString(),
          },
        },
      });
      return {
        deleted: del.count,
        counts,
        storageKeys,
        alreadyGone: requested ? requested.length - base.length : 0,
      };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  await removeOrphanMedia(db, result.storageKeys);
  return {
    operationId: input.operationId,
    deleted: result.deleted,
    alreadyGone: result.alreadyGone,
    counts: result.counts,
    replayed: false,
  };
}

/**
 * Content-addressed files are shared (schema: MediaObject is otherwise never deleted so frozen attempt snapshots keep
 * rendering): unlink only keys no remaining question asset AND no remaining attempt snapshot uses. Failures are logged, never fatal.
 */
async function removeOrphanMedia(db: typeof prisma, keys: string[]) {
  for (const key of new Set(keys)) {
    if (!isSafeStorageKey(key)) continue;
    if (await db.questionAsset.count({ where: { storageKey: key } })) continue;
    const inSnapshot = await db.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM "TestAttemptQuestion" WHERE "questionSnapshot"::text LIKE ${"%" + key + "%"}`;
    if (Number(inSnapshot[0]?.n ?? 0) > 0) continue;
    try {
      await db.mediaObject.deleteMany({ where: { storageKey: key } });
      await unlink(path.join(mediaRootDir(), key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        console.error("question delete: media cleanup failed", key, err);
    }
  }
}
