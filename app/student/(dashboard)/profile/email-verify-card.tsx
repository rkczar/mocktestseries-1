"use client";

import { useActionState } from "react";
import { CheckCircle2, MailCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ErrorBanner, SubmitButton } from "@/app/login/login-screen";
import { sendEmailVerificationAction, confirmEmailVerificationAction, type EmailVerifyState } from "./actions";

/** One-time email verification by a 6-digit code sent to the account email. */
export function EmailVerifyCard({ email }: { email: string }) {
  const [sendState, sendAction] = useActionState<EmailVerifyState, FormData>(sendEmailVerificationAction, {});
  const [confirmState, confirmAction] = useActionState<EmailVerifyState, FormData>(confirmEmailVerificationAction, {});

  return (
    <Card data-testid="email-verify-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailCheck className="h-5 w-5" aria-hidden /> Verify Your Email
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {confirmState.verified ? (
          <p className="flex items-center gap-2 text-sm text-[var(--color-success)]" role="status">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Email Verified Successfully
          </p>
        ) : !sendState.sent ? (
          <form action={sendAction} className="flex flex-col gap-3" noValidate>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Confirm that <span className="font-medium text-[var(--color-foreground)]">{email}</span> is yours. It helps us recover your
              account if you ever lose access to your phone.
            </p>
            <ErrorBanner message={sendState.error} />
            <SubmitButton pendingLabel="Sending code…">Send Code to My Email</SubmitButton>
          </form>
        ) : (
          <form action={confirmAction} className="flex flex-col gap-3" noValidate>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              We sent a 6-digit code to <span className="font-mono">{sendState.maskedEmail}</span>. It expires in 5 minutes.
            </p>
            <Label htmlFor="email-verify-code">Code from the email</Label>
            <input
              id="email-verify-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 font-mono tracking-[0.4em] text-[var(--color-foreground)]"
            />
            <ErrorBanner message={confirmState.error ?? sendState.error} />
            <SubmitButton pendingLabel="Verifying…">Verify Email</SubmitButton>
            <button type="submit" formAction={sendAction} formNoValidate className="text-sm text-[var(--color-primary)] hover:underline">
              Send a new code
            </button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
