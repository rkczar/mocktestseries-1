import "server-only";
import { Prisma, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { TeacherAccessError, type TeacherScope } from "@/lib/teacher/scope";

/**
 * Teacher Portal — students of the teacher's ACTIVE assigned exams (read-only).
 * A student belongs to an exam when enrolled in it, has an attempt in it, or
 * has a LIVE order for one of its products. Contact details, devices and
 * payment credentials are never selected here.
 */

export function studentScopeWhere(examIds: string[]): Prisma.StudentWhereInput {
  return {
    OR: [
      { examEnrollments: { some: { examId: { in: examIds } } } },
      { testAttempts: { some: { examId: { in: examIds } } } },
      { paymentOrders: { some: { environment: "LIVE", product: { examId: { in: examIds } } } } },
    ],
  };
}

export const TEACHER_STUDENT_SELECT = {
  id: true,
  name: true,
  studentId: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
} satisfies Prisma.StudentSelect;

/** The student if they belong to one of the teacher's exams, else "not found". */
export async function studentInScope(scope: TeacherScope, studentDbId: string) {
  if (scope.examIds.length === 0) throw new TeacherAccessError();
  const s = await prisma.student.findFirst({ where: { id: String(studentDbId), ...studentScopeWhere(scope.examIds) }, select: TEACHER_STUDENT_SELECT });
  if (!s) throw new TeacherAccessError();
  return s;
}

/** Same display rule as Admin: an anonymized deleted row is "Account Deleted". */
export function teacherDisplayName(s: { name: string; status: StudentStatus }) {
  return s.status === StudentStatus.DELETED ? "Account Deleted" : s.name;
}

/** Attempts of one student inside the teacher's exams (newest 100) — the shared Test History table's rows. */
export function teacherStudentAttempts(scope: TeacherScope, studentDbId: string) {
  return prisma.testAttempt.findMany({
    where: { studentId: studentDbId, examId: { in: scope.examIds } },
    orderBy: { startedAt: "desc" },
    take: 100,
    include: {
      exam: { select: { name: true } },
      mockTest: { select: { title: true } },
      customModule: { select: { title: true } },
      previousYearPaper: { select: { title: true } },
      grandTest: { select: { title: true } },
      liveTest: { select: { title: true } },
    },
  });
}
