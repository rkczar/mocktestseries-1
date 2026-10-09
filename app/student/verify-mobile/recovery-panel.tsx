"use client";

import { useActionState, useState } from "react";
import { CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ErrorBanner, SubmitButton } from "@/app/login/login-screen";
import { formatIndianMobile } from "@/lib/indian-mobile";
import type { StudentRecoveryView } from "@/lib/account-recovery";
import {
  sendRecoveryEmailProofAction,
  confirmRecoveryEmailProofAction,
  submitRecoveryRequestAction,
  cancelRecoveryRequestAction,
  type RecoveryActionState,
} from "./actions";

/**
 * Shown when the number the student just proved (SMS OTP) belongs to another
 * account. The request itself was recorded on the server; this panel only lets
 * the student add optional proof + a note, submit it for Admin review, or
 * cancel it. Nothing moves until an Admin approves.
 */
export function RecoveryPanel({ initial, onUseDifferentNumber }: { initial: StudentRecoveryView; onUseDifferentNumber: () => void }) {
  const [view, setView] = useState<StudentRecoveryView | null>(initial);
  const take = (state: RecoveryActionState) => {
    if (state.view !== undefined) setView(state.view);
  };

  if (!view || view.status === "CANCELLED") {
    return (
      <div className="flex flex-col gap-3 text-sm text-[var(--color-muted-foreground)]" data-testid="recovery-cancelled">
        <p>Request cancelled. You can verify a different number instead.</p>
        <Button type="button" variant="outline" onClick={onUseDifferentNumber}>
          Use a different number
        </Button>
      </div>
    );
  }

  if (view.status === "PENDING") return <PendingView view={view} onChange={take} onUseDifferentNumber={onUseDifferentNumber} />;

  if (view.status === "REJECTED") {
    return (
      <div className="flex flex-col gap-3" data-testid="recovery-rejected">
        <p className="flex items-start gap-2 text-sm text-[var(--color-foreground)]">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-error)]" aria-hidden />
          Your request to move {formatIndianMobile(view.mobile)} to this account was not approved. Please verify a different number,
          or contact support from the Contact page.
        </p>
        <Button type="button" variant="outline" onClick={onUseDifferentNumber}>
          Use a different number
        </Button>
      </div>
    );
  }

  return <DraftView view={view} onChange={take} onUseDifferentNumber={onUseDifferentNumber} />;
}

function DraftView({
  view,
  onChange,
  onUseDifferentNumber,
}: {
  view: StudentRecoveryView;
  onChange: (s: RecoveryActionState) => void;
  onUseDifferentNumber: () => void;
}) {
  const [submitState, submitAction] = useActionState(async (prev: RecoveryActionState, fd: FormData) => {
    const next = await submitRecoveryRequestAction(prev, fd);
    onChange(next);
    return next;
  }, {});

  return (
    <div className="flex flex-col gap-4" data-testid="recovery-draft">
      <div className="rounded-[var(--radius-button)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-3 text-sm text-[var(--color-foreground)]">
        <p className="font-semibold">This number is linked to another account</p>
        <p className="mt-1 text-[var(--color-muted-foreground)]">
          You proved that {formatIndianMobile(view.mobile)} is yours, but another MockTestSeries account already uses it. For your
          security we never move or merge accounts automatically. You can ask our team to move the number to this account. The other
          account keeps all its tests, scores and purchases.
        </p>
      </div>

      {view.proofExpired ? (
        <ErrorBanner message="Your number verification has expired. Please verify the number again, then submit." />
      ) : null}

      {view.holderEmailMasked && view.emailProofAvailable ? <EmailProof view={view} onChange={onChange} /> : null}

      <form action={submitAction} className="flex flex-col gap-3" noValidate>
        <input type="hidden" name="requestId" value={view.id} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="recovery-note">Anything our team should know? (optional)</Label>
          <textarea
            id="recovery-note"
            name="note"
            maxLength={500}
            rows={3}
            placeholder="For example: the other account was created by me earlier with phone login."
            className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)]"
          />
        </div>
        <ErrorBanner message={submitState.error} />
        <SubmitButton pendingLabel="Submitting…">Submit Request for Review</SubmitButton>
      </form>
      <Button type="button" variant="outline" onClick={onUseDifferentNumber}>
        Use a different number instead
      </Button>
    </div>
  );
}

function EmailProof({ view, onChange }: { view: StudentRecoveryView; onChange: (s: RecoveryActionState) => void }) {
  const [sendState, sendAction] = useActionState(async (prev: RecoveryActionState, fd: FormData) => {
    const next = await sendRecoveryEmailProofAction(prev, fd);
    return next;
  }, {});
  const [confirmState, confirmAction] = useActionState(async (prev: RecoveryActionState, fd: FormData) => {
    const next = await confirmRecoveryEmailProofAction(prev, fd);
    onChange(next);
    return next;
  }, {});

  if (view.holderEmailProved) {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--color-success)]" data-testid="recovery-email-proved">
        <CheckCircle2 className="h-4 w-4" aria-hidden /> You confirmed the other account&apos;s email ({view.holderEmailMasked}).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-3">
      <p className="text-sm text-[var(--color-foreground)]">
        <span className="font-medium">Optional, speeds up review:</span> if the other account is also yours, confirm its email{" "}
        <span className="font-mono">{view.holderEmailMasked}</span>.
      </p>
      {!sendState.notice ? (
        <form action={sendAction} noValidate className="flex flex-col gap-2">
          <input type="hidden" name="requestId" value={view.id} />
          <ErrorBanner message={sendState.error} />
          <Button type="submit" variant="outline" size="sm">
            Send code to {view.holderEmailMasked}
          </Button>
        </form>
      ) : (
        <form action={confirmAction} noValidate className="flex flex-col gap-2">
          <input type="hidden" name="requestId" value={view.id} />
          <p className="text-xs text-[var(--color-muted-foreground)]">{sendState.notice}</p>
          <Label htmlFor="recovery-email-code">Code from the email</Label>
          <input
            id="recovery-email-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 font-mono tracking-[0.4em] text-[var(--color-foreground)]"
          />
          <ErrorBanner message={confirmState.error} />
          <Button type="submit" size="sm">
            Confirm Email
          </Button>
        </form>
      )}
    </div>
  );
}

function PendingView({
  view,
  onChange,
  onUseDifferentNumber,
}: {
  view: StudentRecoveryView;
  onChange: (s: RecoveryActionState) => void;
  onUseDifferentNumber: () => void;
}) {
  const [cancelState, cancelAction] = useActionState(async (prev: RecoveryActionState, fd: FormData) => {
    const next = await cancelRecoveryRequestAction(prev, fd);
    onChange(next);
    return next;
  }, {});
  return (
    <div className="flex flex-col gap-3" data-testid="recovery-pending">
      <p className="flex items-start gap-2 text-sm text-[var(--color-foreground)]">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
        <span>
          <span className="font-semibold">Request under review.</span> Our team will check your request to move{" "}
          {formatIndianMobile(view.mobile)} to this account. Please sign in again later. You can also verify a different number now.
        </span>
      </p>
      <ErrorBanner message={cancelState.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onUseDifferentNumber}>
          Use a different number
        </Button>
        <form action={cancelAction}>
          <input type="hidden" name="requestId" value={view.id} />
          <Button type="submit" variant="ghost">
            Cancel request
          </Button>
        </form>
      </div>
    </div>
  );
}
