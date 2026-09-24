import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst } from "@/lib/ist-time";
import { getDeletionRecordDetail } from "@/lib/deletion-history";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DeletionActions } from "../deletion-actions";

export const metadata = { title: "Deletion Record — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const STATUS_VARIANT = { PENDING: "warning", APPROVED: "error", REJECTED: "neutral" } as const;
const STATUS_LABEL = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected" } as const;
const METHOD_LABEL: Record<string, string> = { CREDENTIALS: "Password", GOOGLE: "Google", OTP: "Phone" };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--color-muted-foreground)]">{k}</dt>
      <dd className="break-words text-[var(--color-foreground)]">{v ?? "—"}</dd>
    </>
  );
}

function YesNo({ yes }: { yes: boolean }) {
  return <Badge variant={yes ? "success" : "neutral"}>{yes ? "Yes" : "No"}</Badge>;
}

export default async function DeletionRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  const permissions = session?.user?.permissions ?? [];
  if (!session?.user?.id || !permissions.includes(PERMISSIONS.STUDENT_DELETION_VIEW)) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
          Deletion history is limited to Master Admin and Full Admin.
        </CardContent>
      </Card>
    );
  }

  const { id } = await params;
  const detail = await getDeletionRecordDetail(id);
  if (!detail) notFound();
  const { record: r, outcome } = detail;
  const canReview = permissions.includes(PERMISSIONS.STUDENT_DELETION_MANAGE) && r.status === "PENDING";

  // Viewing a deleted student's retained contact details is itself audited.
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "STUDENT_DELETION_RECORD_VIEWED",
      entityType: "DeletionRequest",
      entityId: r.id,
      metadata: { studentCode: r.code },
    },
  });

  const approved = r.status === "APPROVED";
  const pay = outcome.paymentRecordsRetained;
  const paymentTotal = pay.orders + pay.payments + pay.invoices;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={approved ? "/admin/students/deleted" : "/admin/students/deletion-requests"}
            className="text-sm text-[var(--color-primary)] hover:underline"
          >
            ← {approved ? "Deleted Students" : "Deletion Requests"}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-[var(--color-foreground)]">
            {r.name ?? (r.identityUnavailable ? "Historical identity unavailable" : "Name not captured")}
          </h1>
          <p className="font-mono text-sm text-[var(--color-muted-foreground)]">{r.code ?? "—"}</p>
        </div>
        <Badge variant={STATUS_VARIANT[r.status]}>{approved ? "Account Deleted" : STATUS_LABEL[r.status]}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Student Details</CardTitle>
            <CardDescription>As they were when the request was {approved ? "approved" : "filed"}.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <Row k="Name" v={r.name} />
              <Row k="Student ID" v={<span className="font-mono">{r.code ?? "—"}</span>} />
              <Row k="Email" v={r.email ?? r.emailMasked} />
              <Row k="Mobile" v={r.phone ?? r.phoneMasked} />
              <Row k="Account created" v={r.accountCreatedAt ? formatIst(r.accountCreatedAt) : null} />
              <Row k="Login methods" v={r.authMethods.length ? r.authMethods.map((m) => METHOD_LABEL[m] ?? m).join(", ") : null} />
              <Row k="Enrolled exams" v={r.enrolledExams.length ? r.enrolledExams.join(", ") : null} />
              <Row k="Purchased products" v={r.purchasedProducts.length ? r.purchasedProducts.join(", ") : null} />
              <Row k="Internal record ID" v={<span className="font-mono text-xs">{r.originalStudentDbId ?? "—"}</span>} />
            </dl>
            {r.identityUnavailable ? (
              <p className="mt-3 text-xs italic text-[var(--color-muted-foreground)]">
                Historical identity unavailable: this account was deleted before identity retention existed and no
                name, email or phone was kept. Only the Student ID remains.
              </p>
            ) : null}
            {r.contactMaskedOnly ? (
              <p className="mt-3 text-xs italic text-[var(--color-muted-foreground)]">
                This account was deleted before full contact retention was introduced; only a masked email/phone was
                kept and the original cannot be recovered.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Deletion Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <Row k="Reason" v={r.reason || "No reason given"} />
              <Row k="Requested at" v={formatIst(r.requestedAt)} />
              <Row k={r.status === "REJECTED" ? "Rejected at" : "Approved at"} v={r.reviewedAt ? formatIst(r.reviewedAt) : null} />
              <Row k="Reviewed by" v={r.reviewedAt ? (r.reviewer ?? "unknown admin") : null} />
              <Row k="Status" v={approved ? "Approved — Account Deleted" : STATUS_LABEL[r.status]} />
              {r.notes ? <Row k="Notes" v={r.notes} /> : null}
              <Row k="Record ID" v={<span className="font-mono text-xs">{r.id}</span>} />
            </dl>
            {canReview ? (
              <DeletionActions
                requestId={r.id}
                name={r.name ?? "Unknown"}
                code={r.code ?? "—"}
                contact={[r.email, r.phone].filter(Boolean).join(" · ") || "—"}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Outcome</CardTitle>
          <CardDescription>
            {approved
              ? "What happened to the account and its history when this deletion was approved."
              : r.status === "PENDING"
                ? "The account is still live while this request awaits review."
                : "The request was rejected; the account was left unchanged."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
            <Row k="Account deleted" v={<YesNo yes={approved} />} />
            <Row k="Active account" v={<YesNo yes={outcome.activeAccount} />} />
            <Row k="Authentication revoked" v={<YesNo yes={outcome.authRevoked} />} />
            <Row k="Sessions revoked" v={<YesNo yes={outcome.authRevoked} />} />
            <Row
              k="Test attempt records retained"
              v={
                <span className="flex items-center gap-2">
                  <YesNo yes={outcome.attemptsRetained > 0} />
                  <span className="text-[var(--color-muted-foreground)]">{outcome.attemptsRetained} attempts{approved ? ", anonymized" : ""}</span>
                </span>
              }
            />
            <Row
              k="Courses / enrollments retained"
              v={
                <span className="flex items-center gap-2">
                  <YesNo yes={outcome.enrollmentsRetained > 0} />
                  <span className="text-[var(--color-muted-foreground)]">{outcome.enrollmentsRetained} enrollments</span>
                </span>
              }
            />
            <Row
              k="Purchased products retained"
              v={
                <span className="flex items-center gap-2">
                  <YesNo yes={outcome.entitlementsRetained > 0} />
                  <span className="text-[var(--color-muted-foreground)]">
                    {outcome.entitlementsRetained} entitlement records{approved ? " (historical, unusable)" : ""}
                  </span>
                </span>
              }
            />
            <Row
              k="Payment / audit records retained"
              v={
                <span className="flex items-center gap-2">
                  <YesNo yes={paymentTotal > 0} />
                  <span className="text-[var(--color-muted-foreground)]">
                    {pay.orders} orders · {pay.payments} payments · {pay.invoices} invoices
                  </span>
                </span>
              }
            />
            {approved ? (
              <Row
                k="Transferred to a new account"
                v={<span className="text-[var(--color-muted-foreground)]">No — a re-registration starts with no attempts, entitlements or profile.</span>}
              />
            ) : null}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
