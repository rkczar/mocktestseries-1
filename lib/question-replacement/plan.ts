import "server-only";
import crypto from "node:crypto";
import { Prisma, QuestionStatus, type PrismaClient } from "@prisma/client";
import { evaluatePublishEligibility } from "@/lib/question-publish-policy";

/**
 * Retire / Replace question — the PLAN (docs/QUESTION-RETIREMENT.md).
 *
 * One pure-read computation used twice: by the admin preview (outside any
 * transaction) and again by apply INSIDE its transaction, so what is applied is
 * always what the database holds at commit time. The structural hash lets
 * apply refuse when the references changed since the admin's preview.
 *
 * Policies (owner-approved 2026-11-03):
 *  - D2/P1-B: retired = terminal (ARCHIVED + retiredAt), never served or re-published.
 *  - D7: AI variants of a retired question are retired with it.
 *  - P1-E: a reference with no usable replacement in an ADMIN container
 *    (Mock Test, admin Custom Module, Grand, Live) puts that container on HOLD
 *    (taken offline, prior status recorded); in a student module it is SKIPPED
 *    (the serving guard leaves it out).
 *  - D4/D5: every attempt of a container whose question set changed is invalidated.
 *  - P1-D/D6: any other IN_PROGRESS attempt holding a retired question is
 *    closed; SUBMITTED ones outside changed containers are kept, but their
 *    answers on retired questions leave the student statistics.
 */

export type Db = Prisma.TransactionClient | PrismaClient;

export type ContainerKind = "MOCK_TEST" | "CUSTOM_MODULE" | "GRAND_TEST" | "LIVE_TEST";
export type ReferenceAction = "SWAP" | "SKIP" | "HOLD";

export interface ReplacementPair {
  oldQuestionId: string;
  /** null = retire with no replacement. */
  newQuestionId: string | null;
}

export interface PlannedQuestion {
  id: string;
  code: string;
  status: QuestionStatus;
  examId: string;
  previousYearPaperId: string | null;
  paperQuestionNumber: number | null;
  examYear: number | null;
  source: string;
}

export interface PlannedReference {
  containerKind: ContainerKind;
  containerId: string;
  containerTitle: string;
  containerStatus: string;
  studentOwned: boolean;
  rowId: string;
  order: number;
  /** 1-based position inside the container (rank by order). */
  position: number;
  oldQuestionId: string;
  newQuestionId: string | null;
  action: ReferenceAction;
  /** Why it is not a SWAP. */
  note: string | null;
}

export interface PlannedHold {
  containerKind: ContainerKind;
  containerId: string;
  containerTitle: string;
  priorStatus: string;
  heldStatus: string;
}

export interface ReplacementPlan {
  pairs: { old: PlannedQuestion; new: PlannedQuestion | null }[];
  variants: { id: string; code: string; status: QuestionStatus; parentId: string }[];
  retiredIds: string[];
  references: PlannedReference[];
  holds: PlannedHold[];
  /** Containers whose question set changes (SWAP, SKIP or HOLD) — D4/D5 scope. */
  changedContainers: { kind: ContainerKind; id: string; title: string; studentOwned: boolean }[];
  attempts: {
    /** D4/D5: attempts (IN_PROGRESS + SUBMITTED) of changed containers. */
    containerAttemptIds: string[];
    /** Other IN_PROGRESS attempts holding a retired question (sessions; P1-D / D6). */
    inProgressAttemptIds: string[];
    bySource: Record<string, { inProgress: number; submitted: number }>;
  };
  /** Answers on retired questions in attempts that are KEPT (stats exclusion only). */
  keptAnswersToExclude: number;
  /** Structural fingerprint: retired set + every reference action. */
  hash: string;
  errors: string[];
}

const QUESTION_SELECT = {
  id: true,
  code: true,
  status: true,
  examId: true,
  previousYearPaperId: true,
  paperQuestionNumber: true,
  examYear: true,
  source: true,
  retiredAt: true,
  parentQuestionId: true,
} satisfies Prisma.QuestionSelect;

const ADMIN_HOLD_STATUS: Record<ContainerKind, { from: string[]; to: string }> = {
  MOCK_TEST: { from: ["PUBLISHED"], to: "DRAFT" },
  CUSTOM_MODULE: { from: ["PUBLISHED", "ACTIVE"], to: "INACTIVE" },
  GRAND_TEST: { from: ["PUBLISHED"], to: "DRAFT" },
  LIVE_TEST: { from: ["SCHEDULED", "LIVE"], to: "DRAFT" },
};

type RefRow = {
  kind: ContainerKind;
  containerId: string;
  title: string;
  status: string;
  studentOwned: boolean;
  rowId: string;
  questionId: string;
  order: number;
  position: number;
};

/** Every membership row (all four test types) holding one of `questionIds`, with its 1-based position. */
export async function loadReferences(db: Db, questionIds: string[]): Promise<RefRow[]> {
  if (questionIds.length === 0) return [];
  return db.$queryRaw<RefRow[]>`
    WITH rows AS (
      SELECT 'MOCK_TEST' AS kind, r."mockTestId" AS "containerId", r.id AS "rowId", r."questionId", r."order",
             ROW_NUMBER() OVER (PARTITION BY r."mockTestId" ORDER BY r."order", r.id)::int AS position
      FROM "MockTestQuestion" r
      WHERE r."mockTestId" IN (SELECT "mockTestId" FROM "MockTestQuestion" WHERE "questionId" = ANY(${questionIds}::text[]))
      UNION ALL
      SELECT 'CUSTOM_MODULE', r."customModuleId", r.id, r."questionId", r."order",
             ROW_NUMBER() OVER (PARTITION BY r."customModuleId" ORDER BY r."order", r.id)::int
      FROM "CustomModuleQuestion" r
      WHERE r."customModuleId" IN (SELECT "customModuleId" FROM "CustomModuleQuestion" WHERE "questionId" = ANY(${questionIds}::text[]))
      UNION ALL
      SELECT 'GRAND_TEST', r."grandTestId", r.id, r."questionId", r."order",
             ROW_NUMBER() OVER (PARTITION BY r."grandTestId" ORDER BY r."order", r.id)::int
      FROM "GrandTestQuestion" r
      WHERE r."grandTestId" IN (SELECT "grandTestId" FROM "GrandTestQuestion" WHERE "questionId" = ANY(${questionIds}::text[]))
      UNION ALL
      SELECT 'LIVE_TEST', r."liveTestId", r.id, r."questionId", r."order",
             ROW_NUMBER() OVER (PARTITION BY r."liveTestId" ORDER BY r."order", r.id)::int
      FROM "LiveTestQuestion" r
      WHERE r."liveTestId" IN (SELECT "liveTestId" FROM "LiveTestQuestion" WHERE "questionId" = ANY(${questionIds}::text[]))
    )
    SELECT rows.kind, rows."containerId", rows."rowId", rows."questionId", rows."order", rows.position,
           COALESCE(mt.title, cm.title, gt.title, lt.title) AS title,
           COALESCE(mt.status::text, cm.status::text, gt.status::text, lt.status::text) AS status,
           COALESCE(cm."isStudentOwned", false) AS "studentOwned"
    FROM rows
    LEFT JOIN "MockTest" mt ON rows.kind = 'MOCK_TEST' AND mt.id = rows."containerId"
    LEFT JOIN "CustomModule" cm ON rows.kind = 'CUSTOM_MODULE' AND cm.id = rows."containerId"
    LEFT JOIN "GrandTest" gt ON rows.kind = 'GRAND_TEST' AND gt.id = rows."containerId"
    LEFT JOIN "LiveTest" lt ON rows.kind = 'LIVE_TEST' AND lt.id = rows."containerId"
    ORDER BY rows.kind, rows."containerId", rows.position`;
}

const CONTAINER_COLUMN: Record<ContainerKind, string> = {
  MOCK_TEST: "mockTestId",
  CUSTOM_MODULE: "customModuleId",
  GRAND_TEST: "grandTestId",
  LIVE_TEST: "liveTestId",
};

export function containerColumn(kind: ContainerKind): string {
  return CONTAINER_COLUMN[kind];
}

export async function buildReplacementPlan(db: Db, pairsIn: ReplacementPair[]): Promise<ReplacementPlan> {
  const errors: string[] = [];
  const pairs = pairsIn.map((p) => ({ oldQuestionId: p.oldQuestionId.trim(), newQuestionId: p.newQuestionId?.trim() || null }));
  const oldIds = pairs.map((p) => p.oldQuestionId);
  const newIds = pairs.map((p) => p.newQuestionId).filter((x): x is string => !!x);

  if (pairs.length === 0) errors.push("Nothing to retire.");
  if (new Set(oldIds).size !== oldIds.length) errors.push("A question is listed twice.");
  if (new Set(newIds).size !== newIds.length) errors.push("Two questions cannot share one replacement.");

  const rows = await db.question.findMany({ where: { id: { in: [...oldIds, ...newIds] } }, select: QUESTION_SELECT });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const toPlanned = (q: (typeof rows)[number]): PlannedQuestion => ({
    id: q.id,
    code: q.code,
    status: q.status,
    examId: q.examId,
    previousYearPaperId: q.previousYearPaperId,
    paperQuestionNumber: q.paperQuestionNumber,
    examYear: q.examYear,
    source: q.source,
  });

  const plannedPairs: ReplacementPlan["pairs"] = [];
  for (const p of pairs) {
    const old = byId.get(p.oldQuestionId);
    if (!old) {
      errors.push(`Question ${p.oldQuestionId} was not found.`);
      continue;
    }
    if (old.retiredAt) errors.push(`${old.code} is already retired.`);
    let neu: (typeof rows)[number] | null = null;
    if (p.newQuestionId) {
      neu = byId.get(p.newQuestionId) ?? null;
      if (!neu) errors.push(`Replacement question ${p.newQuestionId} was not found.`);
      else {
        if (neu.id === old.id) errors.push(`${old.code} cannot replace itself.`);
        if (oldIds.includes(neu.id)) errors.push(`${neu.code} is being retired in this same operation.`);
        if (neu.retiredAt) errors.push(`Replacement ${neu.code} is retired.`);
        if (neu.parentQuestionId) errors.push(`Replacement ${neu.code} is an AI variant — use an original question.`);
        if (neu.examId !== old.examId) errors.push(`Replacement ${neu.code} belongs to a different exam than ${old.code}.`);
        if (neu.previousYearPaperId && neu.previousYearPaperId !== old.previousYearPaperId) {
          errors.push(`Replacement ${neu.code} already belongs to another Previous Year Paper.`);
        }
      }
    }
    plannedPairs.push({ old: toPlanned(old), new: neu ? toPlanned(neu) : null });
  }

  // The replacement must be publishable now (same gate as every publish path).
  const unpublishedNew = plannedPairs.map((p) => p.new).filter((n): n is PlannedQuestion => !!n && n.status !== QuestionStatus.PUBLISHED);
  if (unpublishedNew.length) {
    const evaluation = await evaluatePublishEligibility(unpublishedNew.map((n) => n.id), db);
    for (const b of evaluation.blocked) errors.push(`Replacement ${b.code ?? b.id} cannot be published: ${b.reasons.map((r) => r.detail).join(" ")}`);
  }

  // D7: AI variants retire with their source question.
  const variants = oldIds.length
    ? await db.question.findMany({
        where: { parentQuestionId: { in: oldIds }, retiredAt: null, id: { notIn: oldIds } },
        select: { id: true, code: true, status: true, parentQuestionId: true },
        orderBy: { code: "asc" },
      })
    : [];
  const retiredIds = [...new Set([...oldIds, ...variants.map((v) => v.id)])];
  const replacementOf = new Map(plannedPairs.filter((p) => p.new).map((p) => [p.old.id, p.new!.id]));

  // References in every test type.
  const refRows = await loadReferences(db, retiredIds);
  const byContainer = new Map<string, RefRow[]>();
  for (const r of refRows) {
    const key = `${r.kind}:${r.containerId}`;
    byContainer.set(key, [...(byContainer.get(key) ?? []), r]);
  }
  const references: PlannedReference[] = [];
  const holds: PlannedHold[] = [];
  const changedContainers: ReplacementPlan["changedContainers"] = [];
  const retiredSet = new Set(retiredIds);
  for (const rowsOf of byContainer.values()) {
    const affected = rowsOf.filter((r) => retiredSet.has(r.questionId));
    if (affected.length === 0) continue;
    const c = affected[0];
    const present = new Set(rowsOf.map((r) => r.questionId));
    const claimed = new Set<string>();
    let needsHold = false;
    for (const r of affected) {
      const target = replacementOf.get(r.questionId) ?? null;
      let action: ReferenceAction;
      let note: string | null = null;
      if (target && !present.has(target) && !claimed.has(target)) {
        action = "SWAP";
        claimed.add(target);
      } else {
        note = target ? "The replacement is already in this test." : "No replacement for this question.";
        action = c.kind === "CUSTOM_MODULE" && c.studentOwned ? "SKIP" : "HOLD";
        if (action === "HOLD") needsHold = true;
      }
      references.push({
        containerKind: r.kind,
        containerId: r.containerId,
        containerTitle: r.title,
        containerStatus: r.status,
        studentOwned: r.studentOwned,
        rowId: r.rowId,
        order: r.order,
        position: r.position,
        oldQuestionId: r.questionId,
        newQuestionId: action === "SWAP" ? target : null,
        action,
        note,
      });
    }
    changedContainers.push({ kind: c.kind, id: c.containerId, title: c.title, studentOwned: c.studentOwned });
    if (needsHold) {
      const rule = ADMIN_HOLD_STATUS[c.kind];
      holds.push({
        containerKind: c.kind,
        containerId: c.containerId,
        containerTitle: c.title,
        priorStatus: c.status,
        heldStatus: rule.from.includes(c.status) ? rule.to : c.status,
      });
    }
  }

  // Attempts.
  const containerAttemptIds: string[] = [];
  for (const kind of ["MOCK_TEST", "CUSTOM_MODULE", "GRAND_TEST", "LIVE_TEST"] as const) {
    const ids = changedContainers.filter((c) => c.kind === kind).map((c) => c.id);
    if (!ids.length) continue;
    const field = CONTAINER_COLUMN[kind] as "mockTestId";
    const found = await db.testAttempt.findMany({
      where: { [field]: { in: ids }, status: { in: ["IN_PROGRESS", "SUBMITTED"] }, invalidatedAt: null },
      select: { id: true },
    });
    containerAttemptIds.push(...found.map((a) => a.id));
  }
  const containerSet = new Set(containerAttemptIds);
  const inProgress = retiredIds.length
    ? await db.testAttempt.findMany({
        where: { status: "IN_PROGRESS", invalidatedAt: null, questions: { some: { questionId: { in: retiredIds } } } },
        select: { id: true },
      })
    : [];
  const inProgressAttemptIds = inProgress.map((a) => a.id).filter((id) => !containerSet.has(id));
  const allAttemptIds = [...containerAttemptIds, ...inProgressAttemptIds];
  const bySource: ReplacementPlan["attempts"]["bySource"] = {};
  if (allAttemptIds.length) {
    const grouped = await db.testAttempt.groupBy({
      by: ["sourceType", "status"],
      where: { id: { in: allAttemptIds } },
      _count: { _all: true },
    });
    for (const g of grouped) {
      const b = (bySource[g.sourceType] ??= { inProgress: 0, submitted: 0 });
      if (g.status === "IN_PROGRESS") b.inProgress += g._count._all;
      else b.submitted += g._count._all;
    }
  }
  const keptAnswersToExclude = retiredIds.length
    ? await db.answer.count({
        where: { questionId: { in: retiredIds }, statsExcludedAt: null, attemptId: { notIn: allAttemptIds } },
      })
    : 0;

  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        retired: [...retiredIds].sort(),
        pairs: plannedPairs.map((p) => [p.old.id, p.new?.id ?? null]),
        refs: references.map((r) => [r.rowId, r.oldQuestionId, r.action, r.newQuestionId]).sort(),
        holds: holds.map((h) => [h.containerId, h.priorStatus]).sort(),
      })
    )
    .digest("hex")
    .slice(0, 16);

  return {
    pairs: plannedPairs,
    variants: variants.map((v) => ({ id: v.id, code: v.code, status: v.status, parentId: v.parentQuestionId! })),
    retiredIds,
    references,
    holds,
    changedContainers,
    attempts: { containerAttemptIds, inProgressAttemptIds, bySource },
    keptAnswersToExclude,
    hash,
    errors,
  };
}

/** Short JSON-safe summary stored on the record and shown in previews. */
export function summarizePlan(plan: ReplacementPlan) {
  const count = (a: ReferenceAction) => plan.references.filter((r) => r.action === a).length;
  return {
    questionsRetired: plan.pairs.length,
    variantsRetired: plan.variants.length,
    replacements: plan.pairs.filter((p) => p.new).length,
    references: { swap: count("SWAP"), skip: count("SKIP"), hold: count("HOLD") },
    containersChanged: {
      mockTests: plan.changedContainers.filter((c) => c.kind === "MOCK_TEST").length,
      adminModules: plan.changedContainers.filter((c) => c.kind === "CUSTOM_MODULE" && !c.studentOwned).length,
      studentModules: plan.changedContainers.filter((c) => c.kind === "CUSTOM_MODULE" && c.studentOwned).length,
      grandTests: plan.changedContainers.filter((c) => c.kind === "GRAND_TEST").length,
      liveTests: plan.changedContainers.filter((c) => c.kind === "LIVE_TEST").length,
    },
    holds: plan.holds.map((h) => ({ kind: h.containerKind, id: h.containerId, title: h.containerTitle, from: h.priorStatus, to: h.heldStatus })),
    attemptsInvalidated: plan.attempts.containerAttemptIds.length + plan.attempts.inProgressAttemptIds.length,
    attemptsBySource: plan.attempts.bySource,
    keptAnswersExcluded: plan.keptAnswersToExclude,
    hash: plan.hash,
  };
}
export type ReplacementSummary = ReturnType<typeof summarizePlan>;

