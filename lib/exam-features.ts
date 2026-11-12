import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Per-exam download switches (Admin → Exams → <exam> → Downloads), stored as one Setting row per
 * exam: key `exam.features.<examId>`, value { omrDownloadEnabled, paperDownloadEnabled }.
 *
 * A missing row means OFF for both. The migration that introduced this switch
 * (20261113000100_exam_feature_switches) wrote omrDownloadEnabled=true for every exam that already
 * had an active practice OMR, so existing OMR downloads keep working without a manual step; any
 * other exam (e.g. Rajasthan FSO) starts with both downloads OFF.
 */

export const EXAM_FEATURES_KEY_PREFIX = "exam.features.";

export interface ExamFeatures {
  omrDownloadEnabled: boolean;
  paperDownloadEnabled: boolean;
}

export const EXAM_FEATURES_OFF: ExamFeatures = { omrDownloadEnabled: false, paperDownloadEnabled: false };

export function examFeaturesKey(examId: string): string {
  return `${EXAM_FEATURES_KEY_PREFIX}${examId}`;
}

export function parseExamFeatures(value: unknown): ExamFeatures {
  const v = (value ?? {}) as Partial<Record<keyof ExamFeatures, unknown>>;
  return { omrDownloadEnabled: v.omrDownloadEnabled === true, paperDownloadEnabled: v.paperDownloadEnabled === true };
}

export async function getExamFeatures(examId: string): Promise<ExamFeatures> {
  const row = await prisma.setting.findUnique({ where: { key: examFeaturesKey(examId) } });
  return parseExamFeatures(row?.value);
}

/** Several exams in one read (OMR lookup). */
export async function getExamFeaturesMap(examIds: string[]): Promise<Map<string, ExamFeatures>> {
  const ids = [...new Set(examIds)];
  if (ids.length === 0) return new Map();
  const rows = await prisma.setting.findMany({ where: { key: { in: ids.map(examFeaturesKey) } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return new Map(ids.map((id) => [id, parseExamFeatures(byKey.get(examFeaturesKey(id)))]));
}

export async function setExamFeature(examId: string, feature: keyof ExamFeatures, enabled: boolean, adminId: string): Promise<ExamFeatures> {
  const next = { ...(await getExamFeatures(examId)), [feature]: enabled };
  const value = { ...next, updatedAt: new Date().toISOString(), updatedBy: adminId } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: examFeaturesKey(examId) }, create: { key: examFeaturesKey(examId), value }, update: { value } });
  return next;
}
