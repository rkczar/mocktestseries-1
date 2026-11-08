import "server-only";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

/**
 * Teacher Portal Phase A — the ONE scope layer (docs/TEACHER-PORTAL.md).
 *
 * A teacher is an AdminUser with role TEACHER, an ACTIVE TeacherProfile and a
 * live admin session. Scope = the exams of the teacher's ACTIVE assignments
 * (TeacherExamAssignment.revokedAt IS NULL), re-read on every request, so a
 * revoked exam or a suspended teacher loses access immediately. Every teacher
 * read and write goes through these helpers, and ids posted by the client are
 * always re-checked against the scope: anything outside it is reported as
 * "not found", never as "forbidden", so ids of other exams can't be probed.
 */

export class TeacherAccessError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "TeacherAccessError";
  }
}

export interface TeacherScope {
  teacherId: string;
  name: string;
  examIds: string[];
}

/** Scope for an account id, or null when it is not an active teacher (DB only — no session). */
export async function teacherScope(adminUserId: string): Promise<TeacherScope | null> {
  const user = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
    select: {
      id: true,
      name: true,
      isActive: true,
      role: { select: { name: true } },
      teacherProfile: { select: { status: true } },
      teacherExamAssignments: { where: { revokedAt: null }, select: { examId: true } },
    },
  });
  if (!user || !user.isActive || user.role.name !== "TEACHER" || user.teacherProfile?.status !== "ACTIVE") return null;
  if (!DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.TEACHER_PORTAL)) return null;
  return { teacherId: user.id, name: user.name, examIds: user.teacherExamAssignments.map((a) => a.examId) };
}

export function examInScope(scope: TeacherScope, examId: string | null | undefined): boolean {
  return !!examId && scope.examIds.includes(examId);
}

export function assertExamInScope(scope: TeacherScope, examId: string | null | undefined): void {
  if (!examInScope(scope, examId)) throw new TeacherAccessError();
}

/** Question of an assigned exam, or TeacherAccessError. */
export async function questionInScope(scope: TeacherScope, questionId: string) {
  const q = await prisma.question.findUnique({
    where: { id: String(questionId) },
    select: { id: true, code: true, examId: true, status: true, retiredAt: true, previousYearPaperId: true, source: true },
  });
  if (!q || !examInScope(scope, q.examId)) throw new TeacherAccessError();
  return q;
}

/** Mock Test of an assigned exam, or TeacherAccessError. */
export async function mockTestInScope(scope: TeacherScope, mockTestId: string) {
  const m = await prisma.mockTest.findUnique({
    where: { id: String(mockTestId) },
    select: { id: true, title: true, examId: true, status: true, enrollmentEnabled: true },
  });
  if (!m || !examInScope(scope, m.examId)) throw new TeacherAccessError();
  return m;
}
