import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst, toIstDateString } from "@/lib/ist-time";
import { listDeletedStudentRecords } from "@/lib/deletion-history";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { DeletedStudentsTable, type DeletedStudentRow } from "./deleted-students-table";

export const metadata = { title: "Deleted Students — Mock Test Series.in Admin" };

/**
 * Deleted Students: every APPROVED deletion, read from the retained
 * DeletionRequest audit record (lib/deletion-history.ts) — the same records
 * Deletion Requests shows, filtered, not a second store. Read-only for every
 * role: there is deliberately no restore, edit or "delete permanently" here
 * (the DB trigger DeletionRequest_audit_guard refuses both anyway).
 */
export default async function DeletedStudentsPage() {
  const session = await getAdminSession();
  const permissions = session?.user?.permissions ?? [];
  // Server-side gate: these records carry real contact details.
  if (!permissions.includes(PERMISSIONS.STUDENT_DELETION_VIEW)) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
          Deleted Students is limited to Master Admin and Full Admin.
        </CardContent>
      </Card>
    );
  }

  const rows: DeletedStudentRow[] = (await listDeletedStudentRecords()).map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    email: r.email ?? (r.contactMaskedOnly ? r.emailMasked : null),
    phone: r.phone ?? (r.contactMaskedOnly ? r.phoneMasked : null),
    contactMaskedOnly: r.contactMaskedOnly,
    identityUnavailable: r.identityUnavailable,
    reason: r.reason,
    requestedAt: formatIst(r.requestedAt),
    requestedDate: toIstDateString(r.requestedAt),
    deletedAt: r.reviewedAt ? formatIst(r.reviewedAt) : null,
    deletedDate: r.reviewedAt ? toIstDateString(r.reviewedAt) : "",
    deletedTs: r.reviewedAt?.getTime() ?? 0,
    reviewer: r.reviewer,
    authMethods: r.authMethods,
    enrolledExams: r.enrolledExams,
    purchasedProducts: r.purchasedProducts,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Deleted Students</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          One entry per approved deletion — the student&apos;s identity and courses as they were when the account was
          deleted. These accounts can no longer sign in; if the same person registers again they get a new Student ID
          and a separate entry here if that account is deleted too. Records are read-only audit history.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Deleted</CardTitle>
          <CardDescription>{rows.length} deleted accounts</CardDescription>
        </CardHeader>
        <CardContent>
          <DeletedStudentsTable rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
