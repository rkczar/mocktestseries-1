import "server-only";
import argon2 from "argon2";
import { z } from "zod";
import { Prisma, type TeacherStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Teacher account management (Admin → Users & Access → Teachers), Phase A.
 * Callers enforce TEACHERS_MANAGE (MASTER_ADMIN only). A teacher is an
 * AdminUser with role TEACHER plus a TeacherProfile; access needs the
 * profile ACTIVE and covers only exams with an active assignment.
 * Suspending / deactivating also ends every existing session at once
 * (sessionsValidAfter), and DEACTIVATED turns the account off (isActive=false).
 */

export type ManageResult = { ok: true; message: string } | { ok: false; error: string };

const createSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  username: z.string().trim().toLowerCase().min(3).max(40).regex(/^[a-z0-9._-]+$/, "Username: lowercase letters, numbers, dot, underscore, hyphen only"),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").optional().or(z.literal("").transform(() => undefined)),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

async function log(db: Pick<Prisma.TransactionClient, "auditLog">, actorId: string, action: string, entityType: string, entityId: string, metadata?: Prisma.InputJsonValue) {
  await db.auditLog.create({ data: { actorId, action, entityType, entityId, metadata } });
}

export async function createTeacher(actorId: string, input: z.input<typeof createSchema>): Promise<ManageResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const d = parsed.data;
  const role = await prisma.role.findUnique({ where: { name: "TEACHER" }, select: { id: true } });
  if (!role) return { ok: false, error: "The Teacher role is missing — run the role seed first." };
  const clash = await prisma.adminUser.findFirst({ where: { OR: [{ username: d.username }, ...(d.email ? [{ email: d.email }] : [])] }, select: { id: true } });
  if (clash) return { ok: false, error: "That username or email is already used." };
  const passwordHash = await argon2.hash(d.password);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.adminUser.create({ data: { name: d.name, username: d.username, email: d.email, passwordHash, roleId: role.id } });
    await tx.teacherProfile.create({ data: { adminUserId: u.id, createdById: actorId } });
    await log(tx, actorId, "TEACHER_CREATED", "AdminUser", u.id, { username: u.username });
    return u;
  });
  return { ok: true, message: `Teacher ${user.username} created. Assign at least one exam so they can work.` };
}

/** ACTIVE / SUSPENDED / DEACTIVATED. Creates the profile for a TEACHER-role account that has none. */
export async function setTeacherStatus(actorId: string, teacherId: string, status: TeacherStatus): Promise<ManageResult> {
  if (!["ACTIVE", "SUSPENDED", "DEACTIVATED"].includes(status)) return { ok: false, error: "Unknown status." };
  const user = await prisma.adminUser.findUnique({ where: { id: String(teacherId) }, select: { id: true, role: { select: { name: true } } } });
  if (!user || user.role.name !== "TEACHER") return { ok: false, error: "Teacher not found." };
  await prisma.$transaction(async (tx) => {
    await tx.teacherProfile.upsert({ where: { adminUserId: user.id }, create: { adminUserId: user.id, status, createdById: actorId }, update: { status } });
    await tx.adminUser.update({
      where: { id: user.id },
      data: { isActive: status !== "DEACTIVATED", ...(status === "ACTIVE" ? {} : { sessionsValidAfter: new Date() }) },
    });
    await log(tx, actorId, `TEACHER_${status}`, "AdminUser", user.id);
  });
  return { ok: true, message: status === "ACTIVE" ? "Teacher is active." : status === "SUSPENDED" ? "Teacher suspended and signed out." : "Teacher deactivated and signed out." };
}

export async function assignExam(actorId: string, teacherId: string, examId: string): Promise<ManageResult> {
  const [user, exam] = await Promise.all([
    prisma.adminUser.findUnique({ where: { id: String(teacherId) }, select: { id: true, role: { select: { name: true } } } }),
    prisma.exam.findUnique({ where: { id: String(examId) }, select: { id: true, name: true } }),
  ]);
  if (!user || user.role.name !== "TEACHER") return { ok: false, error: "Teacher not found." };
  if (!exam) return { ok: false, error: "Exam not found." };
  try {
    await prisma.$transaction(async (tx) => {
      const a = await tx.teacherExamAssignment.create({ data: { teacherId: user.id, examId: exam.id, grantedById: actorId } });
      await log(tx, actorId, "TEACHER_EXAM_ASSIGNED", "TeacherExamAssignment", a.id, { teacherId: user.id, examId: exam.id });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: `Already assigned to ${exam.name}.` };
    throw e;
  }
  return { ok: true, message: `Assigned to ${exam.name}.` };
}

/** Revocation is immediate: the next request of that teacher no longer sees the exam. */
export async function revokeAssignment(actorId: string, assignmentId: string): Promise<ManageResult> {
  const n = await prisma.$transaction(async (tx) => {
    const r = await tx.teacherExamAssignment.updateMany({ where: { id: String(assignmentId), revokedAt: null }, data: { revokedAt: new Date(), revokedById: actorId } });
    if (r.count) await log(tx, actorId, "TEACHER_EXAM_REVOKED", "TeacherExamAssignment", String(assignmentId));
    return r.count;
  });
  return n ? { ok: true, message: "Exam access removed." } : { ok: false, error: "That assignment is already removed." };
}
