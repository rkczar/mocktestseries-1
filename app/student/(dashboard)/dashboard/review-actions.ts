"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";
import { hasCompletedTest } from "@/lib/student-review";
import { REVIEW_LIMITS, cleanReviewText, looksLikeSpam, publicStudentName } from "@/lib/reviews-shared";

export type StudentReviewResult = { ok: true; message: string } | { ok: false; error: string };

const schema = z.object({
  rating: z.coerce.number().int().min(1, "Choose a rating from 1 to 5 stars.").max(5, "Choose a rating from 1 to 5 stars."),
  comment: z
    .string()
    .transform((v) => cleanReviewText(v, REVIEW_LIMITS.commentMax, { multiline: true }))
    .pipe(z.string().min(REVIEW_LIMITS.commentMin, `Please write at least ${REVIEW_LIMITS.commentMin} characters.`)),
  examId: z.string().max(64).optional(),
});

/** Minimum gap between two edits of a pending review. */
const EDIT_COOLDOWN_MS = 30_000;

/**
 * Submit (or, while still Pending, update) the signed-in student's review.
 * Identity comes only from the server session; the review is always
 * STUDENT_SUBMITTED + PENDING and never public until an admin approves and
 * publishes it. One review per student (unique studentId), only after at
 * least one completed test, no links/phone numbers, and a short cooldown.
 */
export async function submitStudentReviewAction(formData: FormData): Promise<StudentReviewResult> {
  let student: Awaited<ReturnType<typeof requireStudent>>;
  try {
    student = await requireStudent();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) return { ok: false, error: "Please sign in again to share your review." };
    throw error;
  }

  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check your review." };
  const { rating, comment, examId } = parsed.data;
  if (looksLikeSpam(comment)) return { ok: false, error: "Please remove links, handles and phone numbers from your review." };

  const [account, enrollment, existing, completed] = await Promise.all([
    prisma.student.findUnique({ where: { id: student.id }, select: { name: true, status: true } }),
    examId
      ? prisma.studentExamEnrollment.findUnique({
          where: { studentId_examId: { studentId: student.id, examId } },
          select: { exam: { select: { name: true } } },
        })
      : null,
    prisma.review.findUnique({ where: { studentId: student.id }, select: { id: true, status: true, updatedAt: true } }),
    hasCompletedTest(student.id),
  ]);
  if (!account || account.status !== "ACTIVE") return { ok: false, error: "Reviews can only be shared from an active account." };
  if (!completed) return { ok: false, error: "Complete at least one test before sharing a review." };
  if (examId && !enrollment) return { ok: false, error: "Choose one of your enrolled exams." };
  const examName = enrollment?.exam.name ?? null;
  const displayName = publicStudentName(account.name);

  if (existing) {
    if (existing.status !== "PENDING") {
      return { ok: false, error: "Your review has already been reviewed by our team and can no longer be changed." };
    }
    if (Date.now() - existing.updatedAt.getTime() < EDIT_COOLDOWN_MS) {
      return { ok: false, error: "Please wait a few seconds before updating your review again." };
    }
    await prisma.review.update({
      where: { id: existing.id },
      data: {
        displayName,
        rating,
        comment,
        examName,
        originalDisplayName: displayName,
        originalRating: rating,
        originalComment: comment,
      },
    });
    revalidatePath("/student/dashboard");
    return { ok: true, message: "Your review has been updated. It will appear after our team approves it." };
  }

  try {
    await prisma.review.create({
      data: {
        source: "STUDENT_SUBMITTED",
        status: "PENDING",
        isPublished: false,
        studentId: student.id,
        displayName,
        rating,
        comment,
        examName,
        originalDisplayName: displayName,
        originalRating: rating,
        originalComment: comment,
      },
    });
  } catch (error) {
    // A double submit races the unique studentId — the first one won.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: "You have already shared a review." };
    }
    throw error;
  }
  revalidatePath("/student/dashboard");
  return { ok: true, message: "Thank you! Your review has been submitted and will appear after our team approves it." };
}
