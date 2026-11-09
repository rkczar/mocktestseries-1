"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmMobileAction, sendMobileVerifyCodeAction, type MobileVerifyState } from "./mobile-actions";

const RESEND_SECONDS = 60;

/** Dashboard card: verify the registered mobile (masked) so "Login with OTP" works on it. */
export function MobileVerify({ masked }: { masked: string }) {
  const [send, setSend] = useState<MobileVerifyState>({});
  const [pending, start] = useTransition();
  const [state, confirm, confirming] = useActionState<MobileVerifyState, FormData>(confirmMobileAction, {});
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  if (state.ok) return <p role="status" className="text-sm text-[var(--color-success)]">{state.ok}</p>;
  const sendCode = () =>
    start(async () => {
      const r = await sendMobileVerifyCodeAction();
      setSend(r);
      if (r.sent) setLeft(RESEND_SECONDS);
    });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>Verify your registered mobile {masked} to enable Login with OTP.</p>
      <div>
        <Button type="button" size="sm" variant="outline" disabled={pending || left > 0} onClick={sendCode}>
          {left > 0 ? `Resend code in ${left}s` : send.sent ? "Resend code" : "Send code"}
        </Button>
      </div>
      {send.error ? <p role="alert" className="text-[var(--color-error)]">{send.error}</p> : null}
      {send.devCode ? <p className="text-xs text-[var(--color-muted-foreground)]">Dev code: {send.devCode}</p> : null}
      {send.sent ? (
        <form action={confirm} className="flex flex-wrap items-center gap-2">
          <Input name="code" aria-label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="w-32" required />
          <Button type="submit" size="sm" disabled={confirming}>{confirming ? "Verifying…" : "Verify"}</Button>
          {state.error ? <p role="alert" className="w-full text-[var(--color-error)]">{state.error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}
