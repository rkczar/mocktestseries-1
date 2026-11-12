"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { setExamFeature, type ExamFeatures } from "@/lib/exam-features";
import { numberedOmrSpecFor } from "@/lib/exam-downloads";
import { buildNumberedOmrPdf } from "@/lib/omr-numbered";
import { saveGeneratedResourcePdf } from "@/lib/test-resources";

export interface DownloadsActionState {
  error?: string;
  success?: string;
}

const FEATURES: (keyof ExamFeatures)[] = ["omrDownloadEnabled", "paperDownloadEnabled"];

/** Exam → Downloads switch. MASTER_ADMIN (EXAMS_MANAGE), audit-logged. */
export async function setExamDownloadSwitchAction(examId: string, feature: string, enabled: boolean): Promise<DownloadsActionState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  if (!FEATURES.includes(feature as keyof ExamFeatures)) return { error: "Unknown switch." };
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
  if (!exam) return { error: "Exam not found." };
  const next = await setExamFeature(examId, feature as keyof ExamFeatures, enabled, session.user.id ?? "admin");
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "EXAM_DOWNLOAD_SWITCH", entityType: "Exam", entityId: examId, metadata: { feature, enabled, after: { ...next } } },
  });
  revalidatePath("/admin/exams");
  return { success: `${feature === "omrDownloadEnabled" ? "OMR download" : "Paper PDF download"} ${enabled ? "ON" : "OFF"}.` };
}

/** Generates the exam's numbered practice OMR as a NEW, INACTIVE resource (never replaces an existing sheet). */
export async function generateNumberedOmrAction(examId: string): Promise<DownloadsActionState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, code: true } });
  const spec = exam ? numberedOmrSpecFor(exam.code) : null;
  if (!exam || !spec) return { error: "This exam has no numbered OMR layout." };
  const bytes = await buildNumberedOmrPdf(spec);
  const fileUrl = await saveGeneratedResourcePdf(bytes);
  const resource = await prisma.testResource.create({
    data: {
      type: "OMR_TEMPLATE",
      title: `Practice OMR — ${spec.questionCount} Questions (options 1–4)`,
      fileUrl,
      mimeType: "application/pdf",
      fileSizeBytes: bytes.length,
      questionCount: spec.questionCount,
      isActive: false,
      order: 1000,
      examId,
      createdByAdminId: session.user.id,
    },
  });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TEST_RESOURCE_UPLOADED", entityType: "TestResource", entityId: resource.id, metadata: { type: "OMR_TEMPLATE", examId, generated: true } },
  });
  revalidatePath("/admin/exams");
  return { success: "OMR sheet generated (inactive). Activate it, then turn the OMR switch ON." };
}

/** Activate / deactivate an exam-level download file (OMR or paper PDF) of this exam. */
export async function setExamResourceActiveAction(resourceId: string, isActive: boolean): Promise<DownloadsActionState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const r = await prisma.testResource.findUnique({ where: { id: resourceId }, select: { id: true, examId: true, mockTestId: true } });
  if (!r?.examId || r.mockTestId) return { error: "Not an exam-level file." };
  await prisma.testResource.update({ where: { id: resourceId }, data: { isActive } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: isActive ? "TEST_RESOURCE_ACTIVATED" : "TEST_RESOURCE_DEACTIVATED", entityType: "TestResource", entityId: resourceId, metadata: { examId: r.examId } },
  });
  revalidatePath("/admin/exams");
  return { success: isActive ? "File activated." : "File deactivated." };
}
