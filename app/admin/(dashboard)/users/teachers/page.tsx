import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AssignExamForm, CreateTeacherForm, RevokeButton, TeacherMobileForm, TeacherStatusButtons } from "./teacher-controls";
import { maskMobile } from "@/lib/teacher/auth";

export const metadata = { title: "Teachers — Mock Test Series.in Admin" };

/**
 * Admin → Users & Access → Teachers (Teacher Portal Phase A). Lists every
 * TEACHER-role account with its profile status and active exam assignments.
 * Changes: Master Admin only (TEACHERS_MANAGE, enforced in ./actions.ts).
 */
export default async function TeachersPage() {
  const session = await getAdminSession();
  const perms = session?.user?.permissions ?? [];
  const canManage = perms.includes(PERMISSIONS.TEACHERS_MANAGE);
  const canViewQueue = perms.includes(PERMISSIONS.TEACHER_APPROVALS_VIEW);
  const [teachers, exams, openRequests] = await Promise.all([
    prisma.adminUser.findMany({
      where: { role: { name: "TEACHER" } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        isActive: true,
        lastLoginAt: true,
        teacherProfile: { select: { status: true, mobile: true, mobileVerifiedAt: true } },
        teacherExamAssignments: { where: { revokedAt: null }, select: { id: true, exam: { select: { id: true, name: true } } } },
      },
    }),
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    canViewQueue ? prisma.teacherContentRequest.count({ where: { status: "OPEN" } }) : Promise.resolve(0),
  ]);
  return (
    <div className="flex flex-col gap-6">
      {canViewQueue ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <p className="font-medium">Teacher Content Approvals</p>
              <p className="text-sm text-[var(--color-muted-foreground)]">{openRequests} request(s) waiting</p>
            </div>
            <Link href="/admin/users/teachers/approvals" className="text-sm underline">Open the approval queue</Link>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Teachers</CardTitle>
          <CardDescription>
            Teachers sign in at /teacher (username and password, or an OTP to their verified registered mobile) and work only in the Teacher Portal, limited to their assigned exams. They can create Draft questions, edit questions (published ones through revisions), unpublish questions from Mock Tests and send requests. Publishing, deletion and restoring are approved here by the Master Admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {teachers.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">No teacher accounts yet.</p> : null}
          {teachers.map((t) => {
            const status = t.teacherProfile?.status ?? "NOT_SET_UP";
            const assigned = new Set(t.teacherExamAssignments.map((a) => a.exam.id));
            return (
              <div key={t.id} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-[var(--color-muted-foreground)]">@{t.username}{t.email ? ` · ${t.email}` : ""}</span>
                  <Badge variant={status === "ACTIVE" ? "success" : status === "SUSPENDED" ? "warning" : "neutral"}>{status === "NOT_SET_UP" ? "Not set up" : status.toLowerCase()}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[var(--color-muted-foreground)]">Registered mobile:</span>
                  <span>{maskMobile(t.teacherProfile?.mobile) ?? "not set"}</span>
                  {t.teacherProfile?.mobile ? (
                    <Badge variant={t.teacherProfile.mobileVerifiedAt ? "success" : "warning"}>{t.teacherProfile.mobileVerifiedAt ? "verified — OTP login on" : "not verified — OTP login off"}</Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[var(--color-muted-foreground)]">Exams:</span>
                  {t.teacherExamAssignments.length === 0 ? <span>none</span> : null}
                  {t.teacherExamAssignments.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5">
                      {a.exam.name}
                      {canManage ? <RevokeButton assignmentId={a.id} examName={a.exam.name} /> : null}
                    </span>
                  ))}
                </div>
                {canManage ? (
                  <div className="flex flex-col gap-2">
                    <AssignExamForm teacherId={t.id} exams={exams.filter((e) => !assigned.has(e.id))} />
                    {t.teacherProfile ? <TeacherMobileForm teacherId={t.id} hasMobile={Boolean(t.teacherProfile.mobile)} /> : null}
                    <TeacherStatusButtons teacherId={t.id} status={status} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add teacher</CardTitle>
            <CardDescription>Creates a sign-in account with the Teacher role. Share the username and temporary password privately; the teacher signs in at /teacher. Password resets are in Admins → Edit.</CardDescription>
          </CardHeader>
          <CardContent><CreateTeacherForm exams={exams} /></CardContent>
        </Card>
      ) : null}
    </div>
  );
}
