import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst } from "@/lib/ist-time";
import { formatIndianMobile } from "@/lib/indian-mobile";
import { getRecoveryRequestDetail, type RecoveryAccountSummary } from "@/lib/account-recovery";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecoveryReviewActions } from "./review-actions";

export const metadata = { title: "Account Recovery Request — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const STATUS_VARIANT = { DRAFT: "neutral", PENDING: "warning", APPROVED: "success", REJECTED: "neutral", CANCELLED: "neutral" } as const;
const METHOD_LABEL: Record<string, string> = { CREDENTIALS: "Password", GOOGLE: "Google", OTP: "Phone OTP" };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--color-muted-foreground)]">{k}</dt>
      <dd className="break-words text-[var(--color-foreground)]">{v ?? "—"}</dd>
    </>
  );
}

function AccountCard({ title, account, testId }: { title: string; account: RecoveryAccountSummary | null; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {account ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <Row k="Name" v={account.name} />
            <Row
              k="Student ID"
              v={
                <Link href={`/admin/students/${account.id}`} className="font-mono text-[var(--color-primary)] hover:underline">
                  {account.studentCode}
                </Link>
              }
            />
            <Row k="Status" v={account.status} />
            <Row k="Signed up with" v={METHOD_LABEL[account.authProvider] ?? account.authProvider} />
            <Row k="Email" v={account.email ? `${account.email}${account.emailVerified ? " (verified)" : ""}` : null} />
            <Row k="Mobile" v={account.mobile ? `${account.mobile}${account.mobileVerified ? " (verified)" : ""}` : null} />
            <Row k="Password set" v={account.hasPassword ? "Yes" : "No"} />
            <Row k="Google linked" v={account.googleLinked ? "Yes" : "No"} />
            <Row k="Test attempts" v={account.attempts} />
            <Row k="Paid payments" v={account.capturedPayments} />
            <Row k="Entitlements" v={account.entitlements} />
            <Row k="Created" v={formatIst(account.createdAt)} />
            <Row k="Last login" v={account.lastLoginAt ? formatIst(account.lastLoginAt) : null} />
          </dl>
        ) : (
          <p className="text-sm text-[var(--color-muted-foreground)]">Account no longer exists.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default async function AccountRecoveryDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
  const { id } = await params;
  const detail = await getRecoveryRequestDetail(id);
  if (!detail) notFound();
  const { request: r, requester, holder } = detail;
  const canReview = permissions.includes(PERMISSIONS.ACCOUNT_RECOVERY_MANAGE) && r.status === "PENDING";
  // After approval the holder keeps only these ways to sign in.
  const holderLosesSignIn = holder && !holder.email && !holder.googleLinked;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/admin/students?tab=account-recovery" className="text-sm text-[var(--color-primary)] hover:underline">
        ← All recovery requests
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Move {formatIndianMobile(r.mobile)} <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
          </CardTitle>
          <CardDescription>
            The requesting student proved this number by SMS OTP on {formatIst(r.mobileProvedAt)}.
            {r.holderEmailProvedAt
              ? ` They ALSO entered a code sent to the holding account's email on ${formatIst(r.holderEmailProvedAt)}.`
              : " They did not prove the holding account's email."}
            {r.conflictingAccounts > 1 ? ` ${r.conflictingAccounts} accounts held a spelling of this number when it was recorded.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <Row k="Submitted" v={r.submittedAt ? formatIst(r.submittedAt) : "Not submitted (draft)"} />
            <Row k="Student's note" v={r.studentNote} />
            {r.reviewedAt ? <Row k="Reviewed" v={`${formatIst(r.reviewedAt)} by ${r.reviewedByName ?? "Admin"}`} /> : null}
            {r.adminNotes ? <Row k="Admin notes" v={r.adminNotes} /> : null}
            {r.holderPreviousMobile ? <Row k="Holder's number before approval" v={r.holderPreviousMobile} /> : null}
          </dl>
          <p className="text-[var(--color-muted-foreground)]">
            Approving moves ONLY the mobile number: the holding account loses the number (and its phone sign-in), and the requesting
            account gets it as verified. Tests, scores, payments and purchases stay where they are on both accounts. Nothing is merged or
            deleted.
          </p>
          {holderLosesSignIn && r.status === "PENDING" ? (
            <p className="rounded-[var(--radius-button)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-[var(--color-foreground)]" data-testid="holder-signin-warning">
              Warning: the holding account has no email and no Google login. After approval it will have no way to sign in. Only approve
              if you are confident both accounts belong to the same person.
            </p>
          ) : null}
          {canReview ? <RecoveryReviewActions requestId={r.id} mobile={formatIndianMobile(r.mobile)} /> : null}
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <AccountCard title="Requesting account (will receive the number)" account={requester} testId="recovery-requester" />
        <AccountCard title="Account holding the number now" account={holder} testId="recovery-holder" />
      </div>
    </div>
  );
}
