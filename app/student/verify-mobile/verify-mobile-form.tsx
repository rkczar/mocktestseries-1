"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { IndianMobileInput, OtpBoxInput, ResendCountdown, ErrorBanner, SubmitButton } from "@/app/login/login-screen";
import { formatIndianMobile } from "@/lib/indian-mobile";
import { sendVerifyMobileOtpAction, confirmVerifyMobileOtpAction, type VerifyMobileState } from "./actions";

const VERIFY_MOBILE_PATH = "/student/verify-mobile";

export function VerifyMobileForm({ suggestedDigits, destination }: { suggestedDigits: string; destination: string }) {
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
  return (
    <VerifyMobileSteps
      key={restart.key}
      initialDigits={restart.digits}
      destination={destination}
      onChangeNumber={(digits) => setRestart((r) => ({ key: r.key + 1, digits }))}
    />
  );
}

function VerifyMobileSteps({
  initialDigits,
  destination,
  onChangeNumber,
}: {
  initialDigits: string;
  destination: string;
  onChangeNumber: (digits: string) => void;
}) {
  const router = useRouter();
  const [sendState, sendAction] = useActionState<VerifyMobileState, FormData>(sendVerifyMobileOtpAction, {});
  const [resendState, resendAction] = useActionState<VerifyMobileState, FormData>(sendVerifyMobileOtpAction, {});
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
        <ErrorBanner message={verifyState.error ?? resendState.error} />
        <ResendCountdown onResend={() => resendFormRef.current?.requestSubmit()} />
        <SubmitButton pendingLabel="Verifying…">Verify Mobile Number</SubmitButton>
      </form>
    </>
  );
}
