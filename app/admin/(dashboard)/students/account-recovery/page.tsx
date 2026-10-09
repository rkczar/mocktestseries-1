import Link from "next/link";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst } from "@/lib/ist-time";
import { formatIndianMobile } from "@/lib/indian-mobile";
import { listRecoveryRequests } from "@/lib/account-recovery";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STATUS_VARIANT = { DRAFT: "neutral", PENDING: "warning", APPROVED: "success", REJECTED: "neutral", CANCELLED: "neutral" } as const;

export default async function AccountRecoveryPage() {
  const session = await getAdminSession();
  const permissions = session?.user?.permissions ?? [];
  if (!permissions.includes(PERMISSIONS.ACCOUNT_RECOVERY_VIEW)) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
          Account recovery requests are limited to Master Admin and Full Admin.
        </CardContent>
      </Card>
    );
  }
  const { rows, drafts } = await listRecoveryRequests();
  const pending = rows.filter((r) => r.status === "PENDING");
  const closed = rows.filter((r) => r.status !== "PENDING");

  const table = (list: typeof rows, empty: string) =>
    list.length === 0 ? (
      <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">{empty}</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="recovery-table">
          <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
            <tr>
              <th className="py-2 pr-3">Submitted</th>
              <th className="py-2 pr-3">Number</th>
              <th className="py-2 pr-3">Requesting account</th>
              <th className="py-2 pr-3">Account holding the number</th>
              <th className="py-2 pr-3">Email proof</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="border-t border-[var(--color-border)]">
                <td className="py-2 pr-3 whitespace-nowrap">{r.submittedAt ? formatIst(r.submittedAt) : "—"}</td>
                <td className="py-2 pr-3 font-mono whitespace-nowrap">{formatIndianMobile(r.mobile)}</td>
                <td className="py-2 pr-3">{r.requester ? `${r.requester.name} (${r.requester.studentId})` : "—"}</td>
                <td className="py-2 pr-3">{r.holder ? `${r.holder.name} (${r.holder.studentId})` : "—"}</td>
                <td className="py-2 pr-3">{r.holderEmailProvedAt ? <Badge variant="success">Proved</Badge> : "—"}</td>
                <td className="py-2 pr-3">
                  <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                </td>
                <td className="py-2 text-right">
                  <Link href={`/admin/students/account-recovery/${r.id}`} className="text-[var(--color-primary)] hover:underline">
                    Review
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Account Recovery</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          A student proved by SMS OTP that they own a mobile number another account already uses. Approving moves ONLY the mobile
          number to the requesting account. Both accounts keep their tests, scores, payments and purchases. Accounts are never merged
          or deleted. {drafts > 0 ? `${drafts} more conflict(s) were recorded but not submitted by the student yet.` : null}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Pending Requests</CardTitle>
          <CardDescription>{pending.length} awaiting review</CardDescription>
        </CardHeader>
        <CardContent>{table(pending, "No pending recovery requests.")}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>{closed.length} reviewed or cancelled</CardDescription>
        </CardHeader>
        <CardContent>{table(closed, "No reviewed requests yet.")}</CardContent>
      </Card>
    </div>
  );
}
