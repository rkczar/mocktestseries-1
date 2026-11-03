import "server-only";
import { Prisma, type QuestionSource, type QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REPLACEMENT_LOCK_KEY, ReplacementError } from "@/lib/question-replacement/apply";
import type { ContainerKind, Db } from "@/lib/question-replacement/plan";

/**
 * Rollback of one Retire / Replace (docs/QUESTION-RETIREMENT.md): restores,
 * from the stored record, every question status and paper link, every swapped
 * test / module row (only where it still holds the replacement), every held
 * container (only where it is still in the held status), every invalidated
 * attempt's status and every statistics exclusion. One transaction.
 * Refused once a later operation retired the replacement.
 */

interface NewPrior {
  status: QuestionStatus;
  previousYearPaperId: string | null;
  source: QuestionSource;
  examYear: number | null;
  paperQuestionNumber: number | null;
}

async function unswap(db: Db, kind: ContainerKind, rowId: string, from: string, to: string): Promise<number> {
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

async function unhold(db: Db, kind: ContainerKind, id: string, held: string, prior: string): Promise<number> {
  const where = { id, status: held as never };
  const data = { status: prior as never };
  switch (kind) {
    case "MOCK_TEST":
      return (await db.mockTest.updateMany({ where, data })).count;
    case "CUSTOM_MODULE":
      return (await db.customModule.updateMany({ where, data })).count;
    case "GRAND_TEST":
      return (await db.grandTest.updateMany({ where, data })).count;
    case "LIVE_TEST":
      return (await db.liveTest.updateMany({ where, data })).count;
  }
}

export interface RollbackResult {
  replacementId: string;
  questionsRestored: number;
  rowsUnswapped: number;
  rowsNotUnswapped: number;
  containersRestored: number;
  attemptsRestored: number;
  answersRestored: number;
}

export async function rollbackReplacement(replacementId: string, actor: { adminId: string | null; source: "ADMIN" | "SCRIPT" }): Promise<RollbackResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${REPLACEMENT_LOCK_KEY}, 0))`;
      const record = await tx.questionReplacement.findUnique({ where: { id: replacementId }, include: { items: true, references: true } });
      if (!record) throw new ReplacementError("Replacement record not found.");
      if (record.status !== "APPLIED") throw new ReplacementError("This replacement was already rolled back.");

      const newIds = record.items.map((i) => i.newQuestionId).filter((x): x is string => !!x);
      if (newIds.length) {
        const retiredLater = await tx.question.findMany({ where: { id: { in: newIds }, retiredAt: { not: null } }, select: { code: true } });
        if (retiredLater.length) {
          throw new ReplacementError(`A later change retired ${retiredLater.map((q) => q.code).join(", ")}. Roll that change back first.`);
        }
      }

      // Attempts + statistics first (CHECK: clear invalidatedAt together with the status).
      const attemptsRestored = await tx.$executeRaw`
        UPDATE "TestAttempt"
        SET status = COALESCE("statusBeforeInvalidation", status), "invalidatedAt" = NULL, "invalidationReason" = NULL,
            "invalidatedByReplacementId" = NULL, "statusBeforeInvalidation" = NULL
        WHERE "invalidatedByReplacementId" = ${replacementId}`;
      const answersRestored = await tx.$executeRaw`
        UPDATE "Answer" SET "statsExcludedAt" = NULL, "statsExcludedByReplacementId" = NULL
        WHERE "statsExcludedByReplacementId" = ${replacementId}`;

      // References.
      let rowsUnswapped = 0;
      let rowsNotUnswapped = 0;
      for (const ref of record.references) {
        if (ref.action !== "SWAP" || !ref.newQuestionId) continue;
        const n = await unswap(tx, ref.containerKind, ref.rowId, ref.newQuestionId, ref.oldQuestionId);
        if (n === 1) rowsUnswapped++;
        else rowsNotUnswapped++;
      }
      let containersRestored = 0;
      const seen = new Set<string>();
      for (const ref of record.references) {
        const key = `${ref.containerKind}:${ref.containerId}`;
        if (seen.has(key) || !ref.heldContainerStatus || !ref.priorContainerStatus || ref.heldContainerStatus === ref.priorContainerStatus) continue;
        seen.add(key);
        containersRestored += await unhold(tx, ref.containerKind, ref.containerId, ref.heldContainerStatus, ref.priorContainerStatus);
      }

      // Questions: old ones and their variants back to their prior status, replacements to their prior fields.
      let questionsRestored = 0;
      for (const item of record.items) {
        await tx.question.update({
          where: { id: item.oldQuestionId },
          data: { status: item.oldStatus, retiredAt: null, retiredReason: null, replacedByQuestionId: null },
        });
        questionsRestored++;
        for (const v of (item.retiredVariants as { id: string; status: QuestionStatus }[] | null) ?? []) {
          await tx.question.update({ where: { id: v.id }, data: { status: v.status, retiredAt: null, retiredReason: null } });
        }
        if (item.newQuestionId && item.newQuestionPrior) {
          const prior = item.newQuestionPrior as unknown as NewPrior;
          await tx.question.update({
            where: { id: item.newQuestionId },
            data: {
              status: prior.status,
              previousYearPaperId: prior.previousYearPaperId,
              source: prior.source,
              examYear: prior.examYear,
              paperQuestionNumber: prior.paperQuestionNumber,
            },
          });
        }
      }

      await tx.questionReplacement.update({
        where: { id: replacementId },
        data: { status: "ROLLED_BACK", rolledBackAt: new Date(), rolledBackById: actor.adminId },
      });
      const result: RollbackResult = {
        replacementId,
        questionsRestored,
        rowsUnswapped,
        rowsNotUnswapped,
        containersRestored,
        attemptsRestored,
        answersRestored,
      };
      await tx.auditLog.create({
        data: {
          actorId: actor.adminId,
          action: "QUESTION_REPLACEMENT_ROLLED_BACK",
          entityType: "QuestionReplacement",
          entityId: replacementId,
          metadata: { source: actor.source, ...result } as unknown as Prisma.InputJsonValue,
        },
      });
      return result;
    },
    { timeout: 120_000, maxWait: 30_000 }
  );
}

