import { StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst } from "@/lib/ist-time";
import { maskEmail, maskPhone } from "@/lib/pii-mask";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DeletionActions } from "./deletion-actions";

export const metadata = { title: "Deletion Requests — Mock Test Series.in Admin" };

export default async function DeletionRequestsPage() {
  const [requests, session] = await Promise.all([
    prisma.deletionRequest.findMany({
      orderBy: { requestedAt: "desc" },
      include: {
        student: { select: { studentId: true, name: true, email: true, mobile: true, status: true } },
        reviewedByAdmin: { select: { name: true } },
      },
    }),
    getAdminSession(),
  ]);
  const canReview = Boolean(session?.user?.permissions?.includes(PERMISSIONS.STUDENT_DELETION_MANAGE));

  // History renders from the immutable snapshot. The live Student row is only
  // a fallback for rows filed before snapshots existed, and only while it has
  // not been anonymized — contact is masked here, server-side, so raw email/
  // phone never reach the client.
  const rows = requests.map((r) => {
    const live = r.student.status === StudentStatus.DELETED ? null : r.student;
    return {
      id: r.id,
      status: r.status,
      reason: r.reason,
      notes: r.notes,
      requestedAt: r.requestedAt,
      reviewedAt: r.reviewedAt,
      reviewer: r.reviewedByAdminNameSnapshot ?? r.reviewedByAdmin?.name ?? null,
      name: r.studentNameSnapshot ?? live?.name ?? null,
      code: r.studentCodeSnapshot ?? r.student.studentId,
      email: r.emailMaskedSnapshot ?? maskEmail(live?.email),
      phone: r.phoneMaskedSnapshot ?? maskPhone(live?.mobile),
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Deletion Requests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Approving a request anonymizes the student&apos;s personal information, signs them out everywhere and keeps
          anonymous attempt and payment records for retention. The same email/phone can register a new account later.
          Rejecting leaves the account untouched.
          {canReview ? null : " You have view-only access — only a Master Admin can approve or reject."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
          <CardDescription>{rows.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No deletion requests.</p>
          ) : (
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Student</th>
                  <th className="py-2 pr-4">Contact</th>
                  <th className="py-2 pr-4">Reason</th>
                  <th className="py-2 pr-4">Requested</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Reviewed</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                    <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                      {r.name ?? <span className="italic text-[var(--color-muted-foreground)]">Name not captured</span>}
                      <br />
                      <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{r.code}</span>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">
                      {r.email ?? "—"}
                      <br />
                      {r.phone ?? "—"}
                    </td>
                    <td className="max-w-xs py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {r.reason || "—"}
                      {r.notes ? <div className="mt-1 text-xs italic">{r.notes}</div> : null}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {formatIst(r.requestedAt)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={r.status === "PENDING" ? "warning" : r.status === "APPROVED" ? "error" : "neutral"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                      {r.reviewedAt ? (
                        <>
                          <span className="whitespace-nowrap">{formatIst(r.reviewedAt)}</span>
                          {r.reviewer ? <div>by {r.reviewer}</div> : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      {r.status === "PENDING" && canReview ? (
                        <DeletionActions
                          requestId={r.id}
                          name={r.name ?? "Unknown"}
                          code={r.code}
                          contact={[r.email, r.phone].filter(Boolean).join(" · ") || "—"}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
