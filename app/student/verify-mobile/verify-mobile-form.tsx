"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { IndianMobileInput, OtpBoxInput, ResendCountdown, ErrorBanner, SubmitButton, WhatsAppSentNotice } from "@/app/login/login-screen";
import { formatIndianMobile } from "@/lib/indian-mobile";
import type { StudentRecoveryView } from "@/lib/account-recovery";
import { sendVerifyMobileOtpAction, sendVerifyMobileOtpWhatsAppAction, confirmVerifyMobileOtpAction, type VerifyMobileState } from "./actions";
import { RecoveryPanel } from "./recovery-panel";

const VERIFY_MOBILE_PATH = "/student/verify-mobile";

export function VerifyMobileForm({
  suggestedDigits,
  destination,
  recovery,
  whatsapp = false,
}: {
  suggestedDigits: string;
  destination: string;
  /** The student's open (or recently reviewed) duplicate-number request, shown first. */
  recovery: StudentRecoveryView | null;
  /** "Get OTP on WhatsApp" after the resend cooldown (lib/auth-provider-config.ts isWhatsAppOtpAvailable). */
  whatsapp?: boolean;
}) {
  const router = useRouter();
  // A sign-in Server Action renders its redirect target inside the action
  // response, so when that target's guard redirects here the browser can still
  // show the ORIGINAL url (e.g. /student/test-series). Move to the real url,
  // keeping that original url as the destination to return to.
  useEffect(() => {
    if (window.location.pathname === VERIFY_MOBILE_PATH) return;
    const original = window.location.pathname + window.location.search;
    router.replace(`${VERIFY_MOBILE_PATH}?callbackUrl=${encodeURIComponent(original)}`);
  }, [router]);

  // "Change number" remounts the steps with fresh action states.
  const [restart, setRestart] = useState<{ key: number; digits: string }>({ key: 0, digits: suggestedDigits });
  const [showRecovery, setShowRecovery] = useState(Boolean(recovery));
  if (showRecovery && recovery) {
    return (
      <RecoveryPanel
        initial={recovery}
        onUseDifferentNumber={() => {
          setShowRecovery(false);
          setRestart((r) => ({ key: r.key + 1, digits: "" }));
        }}
      />
    );
  }
  return (
    <VerifyMobileSteps
      key={restart.key}
      initialDigits={restart.digits}
      destination={destination}
      whatsapp={whatsapp}
      onChangeNumber={(digits) => setRestart((r) => ({ key: r.key + 1, digits }))}
    />
  );
}

function VerifyMobileSteps({
  initialDigits,
  destination,
  whatsapp,
  onChangeNumber,
}: {
  initialDigits: string;
  destination: string;
  whatsapp: boolean;
  onChangeNumber: (digits: string) => void;
}) {
  const router = useRouter();
  const [sendState, sendAction] = useActionState<VerifyMobileState, FormData>(sendVerifyMobileOtpAction, {});
  const [resendState, resendAction] = useActionState<VerifyMobileState, FormData>(sendVerifyMobileOtpAction, {});
  const [whatsappState, whatsappAction] = useActionState<VerifyMobileState, FormData>(sendVerifyMobileOtpWhatsAppAction, {});
  const whatsappFormRef = useRef<HTMLFormElement>(null);
  const [verifyState, verifyAction, verifying] = useActionState<VerifyMobileState, FormData>(confirmVerifyMobileOtpAction, {});
  const verifyFormRef = useRef<HTMLFormElement>(null);
  const resendFormRef = useRef<HTMLFormElement>(null);
  const verifyingRef = useRef(false);
  useEffect(() => {
    verifyingRef.current = verifying;
  }, [verifying]);

  useEffect(() => {
    if (!verifyState.verified) return;
    const t = setTimeout(() => {
      router.replace(destination);
      router.refresh();
    }, 1500);
    return () => clearTimeout(t);
  }, [verifyState.verified, destination, router]);

  if (verifyState.verified) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center" role="status">
        <CheckCircle2 className="h-10 w-10 text-[var(--color-success)]" aria-hidden />
        <p className="text-base font-semibold text-[var(--color-foreground)]">Mobile Number Verified Successfully</p>
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Taking you back…
        </p>
      </div>
    );
  }

  if (verifyState.recovery) {
    return <RecoveryPanel initial={verifyState.recovery} onUseDifferentNumber={() => onChangeNumber("")} />;
  }

  const active = resendState.sent ? resendState : sendState;

  if (!active.sent) {
    return (
      <form action={sendAction} className="flex flex-col gap-4" noValidate>
        <IndianMobileInput id="verify-mobile" defaultValue={initialDigits} autoFocus={!initialDigits} />
        <ErrorBanner message={sendState.error} />
        <SubmitButton pendingLabel="Sending OTP…">Send Verification OTP</SubmitButton>
      </form>
    );
  }

  return (
    <>
      <form ref={resendFormRef} action={resendAction} className="hidden">
        <input type="hidden" name="mobile" value={active.mobile} />
      </form>
      <form ref={whatsappFormRef} action={whatsappAction} className="hidden">
        <input type="hidden" name="mobile" value={active.mobile} />
      </form>
      <form ref={verifyFormRef} action={verifyAction} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="mobile" value={active.mobile} />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enter the 6-digit code sent to{" "}
          <span className="font-medium text-[var(--color-foreground)]">{formatIndianMobile(active.mobile)}</span>.{" "}
          <button
            type="button"
            onClick={() => onChangeNumber(active.mobile?.slice(-10) ?? "")}
            className="text-[var(--color-primary)] hover:underline"
          >
            Change number
          </button>
        </p>
        {active.devCode ? (
          <p className="rounded-[var(--radius-button)] border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
            Dev mode — no SMS provider configured. Your code is <span className="font-mono font-semibold">{active.devCode}</span>.
          </p>
        ) : null}
        <OtpBoxInput autoSubmit={() => !verifyingRef.current && verifyFormRef.current?.requestSubmit()} />
        <WhatsAppSentNotice message={whatsappState.info} />
        <ErrorBanner message={verifyState.error ?? whatsappState.error ?? resendState.error} />
        <ResendCountdown
          onResend={() => resendFormRef.current?.requestSubmit()}
          onWhatsApp={whatsapp ? () => whatsappFormRef.current?.requestSubmit() : undefined}
        />
        <SubmitButton pendingLabel="Verifying…">Verify Mobile Number</SubmitButton>
      </form>
    </>
  );
}
