import { NextRequest, NextResponse } from "next/server";
import { QuestionStatus } from "@prisma/client";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

/**
 * Bulk mutations for the All Questions table (Publish / Move to Draft /
 * Archive / Delete / Set Review Required). Deliberately separate from the
 * bulk-IMPORT routes under app/api/admin/questions/bulk-import/** (a
 * different workstream owns those) — this only ever mutates rows the caller
 * already selected in the All Questions panel.
 *
 * Gated behind requirePermission(PERMISSIONS.QUESTIONS_MANAGE) same as every
 * other question mutation — FULL_ADMIN (view-only on the Question Bank) must
 * get a 403 here even if a client somehow still shows the buttons.
 */
const ACTIONS = ["PUBLISH", "DRAFT", "ARCHIVE", "DELETE", "SET_REVIEW_REQUIRED"] as const;
type BulkAction = (typeof ACTIONS)[number];

const MAX_IDS = 5000;

export async function POST(request: NextRequest) {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    throw err;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { action, ids, reviewRequired, reviewReason } = body as {
      action?: string;
      ids?: string[];
      reviewRequired?: boolean;
      reviewReason?: string;
    };

    if (!action || !ACTIONS.includes(action as BulkAction)) {
      return NextResponse.json({ error: "Invalid or missing action" }, { status: 400 });
    }
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No question IDs provided" }, { status: 400 });
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json({ error: `Too many questions selected (max ${MAX_IDS})` }, { status: 400 });
    }

    const uniqueIds = Array.from(new Set(ids));
    const act = action as BulkAction;

    if (act === "PUBLISH" || act === "DRAFT" || act === "ARCHIVE") {
      const status =
        act === "PUBLISH" ? QuestionStatus.PUBLISHED : act === "DRAFT" ? QuestionStatus.DRAFT : QuestionStatus.ARCHIVED;

      const result = await prisma.question.updateMany({ where: { id: { in: uniqueIds } }, data: { status } });

      await prisma.auditLog.create({
        data: {
          actorId: session.user.id,
          action: `QUESTION_BULK_${act}`,
          entityType: "Question",
          entityId: null,
          metadata: { ids: uniqueIds, count: result.count, status },
        },
      });

      return NextResponse.json({ success: true, action: act, updatedCount: result.count });
    }

    if (act === "SET_REVIEW_REQUIRED") {
      const nextReviewRequired = reviewRequired ?? true;
      const result = await prisma.question.updateMany({
        where: { id: { in: uniqueIds } },
        data: { reviewRequired: nextReviewRequired, reviewReason: nextReviewRequired ? reviewReason || null : null },
      });

      await prisma.auditLog.create({
        data: {
          actorId: session.user.id,
          action: "QUESTION_BULK_SET_REVIEW_REQUIRED",
          entityType: "Question",
          entityId: null,
          metadata: { ids: uniqueIds, count: result.count, reviewRequired: nextReviewRequired, reviewReason: reviewReason || null },
        },
      });

      return NextResponse.json({ success: true, action: act, updatedCount: result.count });
    }

    // DELETE: protect historical test-attempt integrity — a question ever
    // referenced by a live/mock/custom/grand test, a saved-question bookmark,
    // or a report is force-archived instead of hard-deleted. Only questions
    // with zero references anywhere are actually removed.
    const referenced = await prisma.question.findMany({
      where: {
        id: { in: uniqueIds },
        OR: [
          { mockTestQuestions: { some: {} } },
          { customModuleQuestions: { some: {} } },
          { grandTestQuestions: { some: {} } },
          { liveTestQuestions: { some: {} } },
          { savedByStudents: { some: {} } },
          { reports: { some: {} } },
        ],
      },
      select: { id: true },
    });
    const referencedIds = new Set(referenced.map((r) => r.id));
    const toArchive = uniqueIds.filter((id) => referencedIds.has(id));
    const toDelete = uniqueIds.filter((id) => !referencedIds.has(id));

    const [archived, deleted] = await Promise.all([
      toArchive.length > 0
        ? prisma.question.updateMany({ where: { id: { in: toArchive } }, data: { status: QuestionStatus.ARCHIVED } })
        : Promise.resolve({ count: 0 }),
      toDelete.length > 0 ? prisma.question.deleteMany({ where: { id: { in: toDelete } } }) : Promise.resolve({ count: 0 }),
    ]);

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "QUESTION_BULK_DELETE",
        entityType: "Question",
        entityId: null,
        metadata: {
          ids: uniqueIds,
          requestedCount: uniqueIds.length,
          deletedCount: deleted.count,
          archivedInsteadCount: archived.count,
          archivedIds: toArchive,
        },
      },
    });

    return NextResponse.json({
      success: true,
      action: act,
      deletedCount: deleted.count,
      archivedInsteadCount: archived.count,
      message:
        archived.count > 0
          ? `${deleted.count} question(s) deleted. ${archived.count} question(s) were referenced by test attempts/mock tests/saved questions/reports and were archived instead to protect historical integrity.`
          : `${deleted.count} question(s) deleted.`,
    });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-actions error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bulk action failed" },
      { status: 500 }
    );
  }
}
