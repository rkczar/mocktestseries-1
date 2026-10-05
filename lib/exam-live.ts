import "server-only";
import { prisma } from "@/lib/prisma";
import { TestEngineError } from "@/lib/test-engine-log";

/**
 * Exam-level master switch for students: an exam with `isActive = false` is
 * private (e.g. built up before launch), so none of its papers, tests or
 * questions may be listed, counted or started by a student — even when a
 * valid examId/paperId/moduleId is posted directly. Listings already filter
 * on `exam.isActive`; this is the server-side check every student entry
 * point that takes an id runs as well, so hiding UI is never the control.
 *
 * Admin tools never call this: admins keep full access to inactive exams.
 */
export async function isExamLive(examId: string | null | undefined): Promise<boolean> {
  if (!examId) return false;
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { isActive: true } });
  return exam?.isActive === true;
}

export const EXAM_NOT_LIVE_MESSAGE = "This exam is not available.";

/** Throws the engine's standard "unavailable" refusal (handled by startOrExplain / inline forms). */
export async function assertExamLive(examId: string | null | undefined): Promise<void> {
  if (!(await isExamLive(examId))) throw new TestEngineError("UNAVAILABLE", EXAM_NOT_LIVE_MESSAGE);
}
