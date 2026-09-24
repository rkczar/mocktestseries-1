import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst, toIstDateString } from "@/lib/ist-time";
import { listDeletionRecords } from "@/lib/deletion-history";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { DeletionHistoryTable, type DeletionHistoryRow } from "./deletion-history-table";

export const metadata = { title: "Deletion Requests — Mock Test Series.in Admin" };

export default async function DeletionRequestsPage() {
  const session = await getAdminSession();
  const permissions = session?.user?.permissions ?? [];
  // Server-side gate: the records carry a deleted student's real contact
  // details, so nothing is loaded for an admin without the view key.
  if (!permissions.includes(PERMISSIONS.STUDENT_DELETION_VIEW)) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
          Deletion history is limited to Master Admin and Full Admin.
        </CardContent>
      </Card>
    );
  }
  const canReview = permissions.includes(PERMISSIONS.STUDENT_DELETION_MANAGE);

  const rows: DeletionHistoryRow[] = (await listDeletionRecords()).map((r) => ({
    id: r.id,
    status: r.status,
    reason: r.reason,
    notes: r.notes,
    name: r.name,
    code: r.code,
    email: r.email ?? (r.contactMaskedOnly ? r.emailMasked : null),
    phone: r.phone ?? (r.contactMaskedOnly ? r.phoneMasked : null),
    contactMaskedOnly: r.contactMaskedOnly,
    requestedAt: formatIst(r.requestedAt),
    requestedDate: toIstDateString(r.requestedAt),
    reviewedAt: r.reviewedAt ? formatIst(r.reviewedAt) : null,
    reviewer: r.reviewer,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Deletion Requests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Every request is kept as a permanent audit record with the student&apos;s name, Student ID and contact details
          as they were at deletion. Approving signs the student out everywhere, anonymizes the active account and
          releases its email/phone/Google login — the same person can register again and gets a new Student ID. No
          password, OTP or token is ever retained.
          {canReview ? null : " You have view-only access — only a Master Admin can approve or reject."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deletion History</CardTitle>
          <CardDescription>{rows.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          <DeletionHistoryTable rows={rows} canReview={canReview} />
        </CardContent>
      </Card>
    </div>
  );
}
