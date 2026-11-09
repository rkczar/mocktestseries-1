import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NameCorrectionDialog } from "./name-correction-dialog";
import { StudentPaymentProfile } from "@/app/admin/(dashboard)/payments/_components/student-payment-profile";
import { DeviceAccessSection } from "./device-access-section";
import { StudentTestHistory } from "@/components/admin/student-test-history";

export const metadata = { title: "Student — Mock Test Series.in Admin" };


export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      profile: true,
      deletionRequests: { orderBy: { requestedAt: "desc" }, take: 1 },
      testAttempts: {
        orderBy: { startedAt: "desc" },
        take: 100,
        include: { exam: true, mockTest: true, customModule: true, previousYearPaper: true, grandTest: true, liveTest: true },
      },
    },
  });
  if (!student) notFound();

  const latestDeletionRequest = student.deletionRequests[0];
  const session = await getAdminSession();
  const deleted = student.status === "DELETED";
  const canCorrectName = !deleted && Boolean(session?.user?.permissions?.includes(PERMISSIONS.STUDENTS_MANAGE));
  // A deleted row is anonymized; its person is named by the retained deletion
  // audit record, shown only to admins allowed to see that record.
  const canViewDeletion = Boolean(session?.user?.permissions?.includes(PERMISSIONS.STUDENT_DELETION_VIEW));
  const displayName =
    deleted && latestDeletionRequest?.status === "APPROVED"
      ? canViewDeletion
        ? (latestDeletionRequest.studentNameSnapshot ?? "Historical identity unavailable")
        : "Account Deleted"
      : student.name;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{displayName}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] font-mono">{student.studentId}</p>
          {deleted ? <Badge variant="error" className="mt-1">Account Deleted</Badge> : null}
        </div>
        {canCorrectName ? <NameCorrectionDialog studentId={student.id} name={student.name} /> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Email</p>
            <p className="text-[var(--color-foreground)]">{student.email ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Mobile</p>
            <p className="text-[var(--color-foreground)]">{student.mobile ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Auth Method</p>
            <p className="text-[var(--color-foreground)]">{student.authProvider}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Registered</p>
            <p className="text-[var(--color-foreground)]">{student.createdAt.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Last Activity</p>
            <p className="text-[var(--color-foreground)]">{student.lastLoginAt?.toLocaleString() ?? "Never"}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Status</p>
            <Badge variant={student.status === "ACTIVE" ? "success" : deleted ? "error" : "warning"}>
              {deleted ? "Account Deleted" : student.status.replace(/_/g, " ")}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {!deleted ? <DeviceAccessSection studentId={student.id} canManage={canCorrectName} /> : null}

      {latestDeletionRequest ? (
        <Card>
          <CardHeader>
            <CardTitle>Deletion Request</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[var(--color-muted-foreground)]">
            Status: <Badge variant="warning">{latestDeletionRequest.status}</Badge> · Requested{" "}
            {latestDeletionRequest.requestedAt.toLocaleString()}
            {latestDeletionRequest.reason ? <p className="mt-2">Reason: {latestDeletionRequest.reason}</p> : null}
            <p className="mt-2">
              <Link
                href={`/admin/students/deletion-requests/${latestDeletionRequest.id}`}
                className="text-[var(--color-primary)] hover:underline"
              >
                View deletion record
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Test History</CardTitle>
          <CardDescription>{student.testAttempts.length} attempts (max 100 shown)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <StudentTestHistory attempts={student.testAttempts} />
        </CardContent>
      </Card>

      <StudentPaymentProfile studentId={student.id} />
    </div>
  );
}
