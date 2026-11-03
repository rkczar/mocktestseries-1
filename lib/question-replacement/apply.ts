import "server-only";
import { Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildReplacementPlan,
  containerColumn,
  summarizePlan,
  type ContainerKind,
  type Db,
  type ReplacementPair,
  type ReplacementPlan,
  type ReplacementSummary,
} from "@/lib/question-replacement/plan";

/**
 * Retire / Replace question — APPLY (docs/QUESTION-RETIREMENT.md).
 *
 * Everything happens in ONE transaction under a global advisory lock, after
 * the plan is rebuilt inside it: publish the replacement, retire the old
 * question(s) and their AI variants, swap every test / module reference in
 * place (same order, so Q64 stays Q64), hold admin tests that lost a question
 * with no replacement, invalidate attempts (D4/D5 + open sessions), exclude
 * answers from statistics, and write the record a rollback needs. Any error
 * rolls back all of it. A second, idempotent sweep runs after commit for a
 * submit that raced the transaction.
 */

export const REPLACEMENT_LOCK_KEY = "question-replacement";
const TX_OPTIONS = { timeout: 120_000, maxWait: 30_000 } as const;

export class ReplacementError extends Error {
  constructor(
    message: string,
    readonly details: string[] = []
  ) {
    super(message);
    this.name = "ReplacementError";
  }
}

export interface ApplyInput {
  pairs: ReplacementPair[];
  reason: string;
  actor: { adminId: string | null; source: "ADMIN" | "SCRIPT" };
  /** The preview's structural hash; apply refuses if the references changed since. Omit only from scripts that re-plan themselves. */
  expectedHash?: string;
}

export interface ApplyResult {
  replacementId: string;
  summary: ReplacementSummary;
  attemptsInvalidated: number;
  answersExcluded: number;
}

/** Read-only preview — exactly what apply would do right now. */
export async function previewReplacement(pairs: ReplacementPair[]): Promise<{ plan: ReplacementPlan; summary: ReplacementSummary }> {
  const plan = await buildReplacementPlan(prisma, pairs);
  return { plan, summary: summarizePlan(plan) };
}

const HOLDABLE: Record<ContainerKind, (db: Db, id: string, to: string, from: string) => Promise<number>> = {
  MOCK_TEST: async (db, id, to, from) =>
    (await db.mockTest.updateMany({ where: { id, status: from as never }, data: { status: to as never } })).count,
  CUSTOM_MODULE: async (db, id, to, from) =>
    (await db.customModule.updateMany({ where: { id, status: from as never }, data: { status: to as never } })).count,
  GRAND_TEST: async (db, id, to, from) =>
    (await db.grandTest.updateMany({ where: { id, status: from as never }, data: { status: to as never } })).count,
  LIVE_TEST: async (db, id, to, from) =>
    (await db.liveTest.updateMany({ where: { id, status: from as never }, data: { status: to as never } })).count,
};

async function swapRow(db: Db, kind: ContainerKind, rowId: string, from: string, to: string): Promise<number> {
  switch (kind) {
    case "MOCK_TEST":
      return (await db.mockTestQuestion.updateMany({ where: { id: rowId, questionId: from }, data: { questionId: to } })).count;
    case "CUSTOM_MODULE":
      return (await db.customModuleQuestion.updateMany({ where: { id: rowId, questionId: from }, data: { questionId: to } })).count;
    case "GRAND_TEST":
      return (await db.grandTestQuestion.updateMany({ where: { id: rowId, questionId: from }, data: { questionId: to } })).count;
    case "LIVE_TEST":
      return (await db.liveTestQuestion.updateMany({ where: { id: rowId, questionId: from }, data: { questionId: to } })).count;
  }
}

/**
 * Invalidate attempts for a replacement: every IN_PROGRESS / SUBMITTED attempt
 * of the changed containers, plus every other IN_PROGRESS attempt holding a
 * retired question. Idempotent (only rows not yet invalidated). Then exclude
 * from statistics every answer of those attempts and every remaining answer on
 * a retired question. Returns the counts it changed.
 */
export async function invalidateForReplacement(
  db: Db,
  replacementId: string,
  scope: {
    containers: { kind: ContainerKind; id: string }[];
    retiredIds: string[];
    reason: string;
    /** Only attempts started at or before this instant — never a fresh attempt on the corrected test. */
    startedBefore: Date;
  }
): Promise<{ attempts: number; answers: number }> {
  const now = new Date();
  let attempts = 0;
  for (const kind of ["MOCK_TEST", "CUSTOM_MODULE", "GRAND_TEST", "LIVE_TEST"] as const) {
    const ids = scope.containers.filter((c) => c.kind === kind).map((c) => c.id);
    if (!ids.length) continue;
    const column = Prisma.raw(`"${containerColumn(kind)}"`);
    attempts += await db.$executeRaw`
      UPDATE "TestAttempt"
      SET "statusBeforeInvalidation" = status, status = 'ABANDONED', "invalidatedAt" = ${now},
          "invalidationReason" = ${scope.reason}, "invalidatedByReplacementId" = ${replacementId}
      WHERE ${column} = ANY(${ids}::text[]) AND status IN ('IN_PROGRESS', 'SUBMITTED') AND "invalidatedAt" IS NULL
        AND "startedAt" <= ${scope.startedBefore}`;
  }
  if (scope.retiredIds.length) {
    attempts += await db.$executeRaw`
      UPDATE "TestAttempt"
      SET "statusBeforeInvalidation" = status, status = 'ABANDONED', "invalidatedAt" = ${now},
          "invalidationReason" = ${scope.reason}, "invalidatedByReplacementId" = ${replacementId}
      WHERE status = 'IN_PROGRESS' AND "invalidatedAt" IS NULL AND "startedAt" <= ${scope.startedBefore}
        AND id IN (SELECT "attemptId" FROM "TestAttemptQuestion" WHERE "questionId" = ANY(${scope.retiredIds}::text[]))`;
  }
  const answers = await db.$executeRaw`
    UPDATE "Answer" SET "statsExcludedAt" = ${now}, "statsExcludedByReplacementId" = ${replacementId}
    WHERE "statsExcludedAt" IS NULL
      AND ("attemptId" IN (SELECT id FROM "TestAttempt" WHERE "invalidatedByReplacementId" = ${replacementId})
           OR "questionId" = ANY(${scope.retiredIds}::text[]))`;
  return { attempts, answers };
}

export async function applyReplacement(input: ApplyInput): Promise<ApplyResult> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ReplacementError("Give a short reason (it is kept in the audit record).");
  const kind = input.pairs.some((p) => p.newQuestionId) ? "REPLACE" : "RETIRE";

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${REPLACEMENT_LOCK_KEY}, 0))`;
    const plan = await buildReplacementPlan(tx, input.pairs);
    if (plan.errors.length) throw new ReplacementError("This change cannot be applied.", plan.errors);
    if (input.expectedHash && input.expectedHash !== plan.hash) {
      throw new ReplacementError("The tests using this question changed since your preview. Preview again before applying.");
    }
    const summary = summarizePlan(plan);
    const now = new Date();

    const record = await tx.questionReplacement.create({
      data: {
        kind,
        reason,
        createdById: input.actor.adminId,
        createdBySource: input.actor.source,
        summary: summary as unknown as Prisma.InputJsonValue,
      },
    });

    // 1. Publish each replacement and give it the old question's paper slot.
    for (const pair of plan.pairs) {
      if (!pair.new) continue;
      const linkPaper = pair.old.previousYearPaperId && !pair.new.previousYearPaperId;
      await tx.question.update({
        where: { id: pair.new.id },
        data: {
          status: QuestionStatus.PUBLISHED,
          ...(pair.old.previousYearPaperId
            ? {
                previousYearPaperId: pair.old.previousYearPaperId,
                source: "PYQ",
                paperQuestionNumber: pair.old.paperQuestionNumber,
                ...(linkPaper && pair.old.examYear !== null ? { examYear: pair.old.examYear } : {}),
              }
            : {}),
        },
      });
    }

    // 2. Retire old questions (+ D7 variants). CHECK: retired ⇒ ARCHIVED.
    const replacedBy = new Map(plan.pairs.filter((p) => p.new).map((p) => [p.old.id, p.new!.id]));
    for (const pair of plan.pairs) {
      await tx.question.update({
        where: { id: pair.old.id },
        data: {
          status: QuestionStatus.ARCHIVED,
          retiredAt: now,
          retiredReason: reason.slice(0, 500),
          replacedByQuestionId: replacedBy.get(pair.old.id) ?? null,
        },
      });
    }
    if (plan.variants.length) {
      await tx.question.updateMany({
        where: { id: { in: plan.variants.map((v) => v.id) } },
        data: { status: QuestionStatus.ARCHIVED, retiredAt: now, retiredReason: `AI variant of a retired question: ${reason}`.slice(0, 500) },
      });
    }

    // Cutoff for invalidation, taken AFTER the old questions are row-locked by
    // the updates above: any start whose transaction began later is blocked by
    // the in-transaction serving guard (FOR SHARE) and refused after commit, so
    // every attempt that can hold old content started at or before this instant.
    const [{ cutoff }] = await tx.$queryRaw<{ cutoff: Date }[]>`SELECT clock_timestamp() AS cutoff`;

    // 3. Items (everything rollback restores on questions).
    await tx.questionReplacementItem.createMany({
      data: plan.pairs.map((pair) => ({
        replacementId: record.id,
        oldQuestionId: pair.old.id,
        oldStatus: pair.old.status,
        newQuestionId: pair.new?.id ?? null,
        newQuestionPrior: pair.new
          ? ({
              status: pair.new.status,
              previousYearPaperId: pair.new.previousYearPaperId,
              source: pair.new.source,
              examYear: pair.new.examYear,
              paperQuestionNumber: pair.new.paperQuestionNumber,
            } as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        retiredVariants: plan.variants
          .filter((v) => v.parentId === pair.old.id)
          .map((v) => ({ id: v.id, status: v.status })) as unknown as Prisma.InputJsonValue,
        paperId: pair.old.previousYearPaperId,
        paperQuestionNumber: pair.old.paperQuestionNumber,
      })),
    });

    // 4. References: swap in place, hold admin containers, skip student modules.
    for (const ref of plan.references) {
      if (ref.action === "SWAP" && ref.newQuestionId) {
        const n = await swapRow(tx, ref.containerKind, ref.rowId, ref.oldQuestionId, ref.newQuestionId);
        if (n !== 1) throw new ReplacementError("A test changed while this was being applied. Preview again.");
      }
    }
    for (const hold of plan.holds) {
      if (hold.heldStatus !== hold.priorStatus) await HOLDABLE[hold.containerKind](tx, hold.containerId, hold.heldStatus, hold.priorStatus);
    }
    const holdOf = new Map(plan.holds.map((h) => [`${h.containerKind}:${h.containerId}`, h]));
    if (plan.references.length) {
      await tx.questionReplacementReference.createMany({
        data: plan.references.map((ref) => {
          const hold = holdOf.get(`${ref.containerKind}:${ref.containerId}`);
          return {
            replacementId: record.id,
            containerKind: ref.containerKind,
            containerId: ref.containerId,
            rowId: ref.rowId,
            oldQuestionId: ref.oldQuestionId,
            newQuestionId: ref.newQuestionId,
            order: ref.order,
            action: ref.action,
            priorContainerStatus: hold?.priorStatus ?? ref.containerStatus,
            heldContainerStatus: hold?.heldStatus ?? null,
          };
        }),
      });
    }

    // 5. Attempts + statistics.
    const counts = await invalidateForReplacement(tx, record.id, {
      containers: plan.changedContainers.map((c) => ({ kind: c.kind, id: c.id })),
      retiredIds: plan.retiredIds,
      reason: `${kind === "REPLACE" ? "Question replaced" : "Question retired"}: ${reason}`.slice(0, 500),
      startedBefore: cutoff,
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actor.adminId,
        action: kind === "REPLACE" ? "QUESTION_REPLACED" : "QUESTION_RETIRED",
        entityType: "QuestionReplacement",
        entityId: record.id,
        metadata: {
          source: input.actor.source,
          reason,
          pairs: plan.pairs.map((p) => ({ old: p.old.code, new: p.new?.code ?? null })),
          variants: plan.variants.map((v) => v.code),
          attemptsInvalidated: counts.attempts,
          answersExcluded: counts.answers,
          summary,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return { record, plan, summary, counts, cutoff };
  }, TX_OPTIONS);

  // Post-commit sweep: a submit or start that raced the transaction. Idempotent.
  const sweep = await prisma.$transaction(
    (tx) =>
      invalidateForReplacement(tx, result.record.id, {
        containers: result.plan.changedContainers.map((c) => ({ kind: c.kind, id: c.id })),
        retiredIds: result.plan.retiredIds,
        reason: `${kind === "REPLACE" ? "Question replaced" : "Question retired"}: ${reason}`.slice(0, 500),
        startedBefore: result.cutoff,
      }),
    TX_OPTIONS
  );

  return {
    replacementId: result.record.id,
    summary: result.summary,
    attemptsInvalidated: result.counts.attempts + sweep.attempts,
    answersExcluded: result.counts.answers + sweep.answers,
  };
}
