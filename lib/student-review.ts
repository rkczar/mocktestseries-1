import "server-only";
import { AttemptStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publicStudentName } from "@/lib/reviews-shared";

/**
 * Student side of Reviews: what the Student Dashboard "Share your experience"
 * block shows. A student may write one review, after completing at least one
 * test; it stays editable while Pending and locks once moderated.
 */
export interface StudentReviewState {
  publicName: string;
  exams: { id: string; name: string }[];
  review: { status: "PENDING" | "APPROVED" | "REJECTED"; isPublished: boolean; rating: number; comment: string; examName: string | null } | null;
}

export async function hasCompletedTest(studentDbId: string): Promise<boolean> {
  const attempt = await prisma.testAttempt.findFirst({ where: { studentId: studentDbId, status: AttemptStatus.SUBMITTED }, select: { id: true } });
  return attempt !== null;
}

export async function getStudentReviewState(studentDbId: string): Promise<StudentReviewState | null> {
  const [student, review, eligible] = await Promise.all([
    prisma.student.findUnique({
      where: { id: studentDbId },
      select: { name: true, examEnrollments: { select: { exam: { select: { id: true, name: true } } } } },
    }),
    prisma.review.findUnique({
      where: { studentId: studentDbId },
      // The student sees their own submission, not an admin-edited display copy.
      select: { status: true, isPublished: true, originalRating: true, originalComment: true, rating: true, comment: true, examName: true },
    }),
    hasCompletedTest(studentDbId),
  ]);
  if (!student || (!review && !eligible)) return null;
  return {
    publicName: publicStudentName(student.name),
    exams: student.examEnrollments.map((e) => e.exam),
    review: review
      ? {
          status: review.status,
          isPublished: review.isPublished,
          rating: review.originalRating ?? review.rating,
          comment: review.originalComment ?? review.comment,
          examName: review.examName,
        }
      : null,
  };
}
