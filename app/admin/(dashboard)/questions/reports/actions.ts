"use server";

import { revalidatePath } from "next/cache";
import type { ReportStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

export async function setReportStatusAction(reportId: string, status: ReportStatus) {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  await prisma.reportedQuestion.update({
    where: { id: reportId },
    data: { status, reviewedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "QUESTION_REPORT_STATUS_CHANGED",
      entityType: "ReportedQuestion",
      entityId: reportId,
      metadata: { status },
    },
  });
  revalidatePath("/admin/questions/reports");
}
