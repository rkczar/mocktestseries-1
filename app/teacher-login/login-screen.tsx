"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendTeacherOtpAction, teacherOtpLoginAction, teacherPasswordLoginAction, type TeacherLoginState } from "./actions";

const RESEND_SECONDS = 60;

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {pending ? busy : idle}
    </Button>
  );
}

function Notice({ state }: { state: TeacherLoginState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-[var(--radius-button)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
        {state.error}
      </p>
    );
  }
  if (state.info) return <p role="status" className="text-sm text-[var(--color-muted-foreground)]">{state.info}</p>;
  return null;
}

function PasswordForm() {
  const [state, action] = useActionState<TeacherLoginState, FormData>(teacherPasswordLoginAction, {});
  const [show, setShow] = useState(false);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="teacher-username">Username</Label>
        <Input id="teacher-username" name="username" type="text" autoComplete="username" autoCapitalize="none" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="teacher-password">Password</Label>
        <div className="relative">
          <Input id="teacher-password" name="password" type={show ? "text" : "password"} autoComplete="current-password" required className="pr-10" />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </div>
      <Notice state={state} />
      <Submit idle="Login" busy="Signing in…" />
    </form>
  );
}

function OtpForm() {
  const [left, setLeft] = useState(0);
  // Every send answer (sent or not) restarts the countdown, so the screen never hints whether the number is registered.
  const [sendState, sendAction] = useActionState<TeacherLoginState, FormData>(async (prev, fd) => {
    const r = await sendTeacherOtpAction(prev, fd);
    if (r.sent) setLeft(RESEND_SECONDS);
    return r;
  }, {});
  const [verifyState, verifyAction] = useActionState<TeacherLoginState, FormData>(teacherOtpLoginAction, {});
  const [mobile, setMobile] = useState("");
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const codeStep = Boolean(sendState.sent);
  return (
    <div className="flex flex-col gap-5">
      <form action={sendAction} className="flex flex-col gap-3" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="teacher-mobile">Registered mobile number</Label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--color-muted-foreground)]">+91</span>
            <Input
              id="teacher-mobile"
              name="mobile"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={14}
              placeholder="10-digit mobile"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              required
            />
          </div>
        </div>
        {!codeStep ? <Notice state={sendState} /> : null}
        {codeStep ? (
          <Button type="submit" variant="outline" disabled={left > 0}>
            {left > 0 ? `Resend OTP in ${left}s` : "Resend OTP"}
          </Button>
        ) : (
          <Submit idle="Send OTP" busy="Sending…" />
        )}
      </form>

      {codeStep ? (
        <form action={verifyAction} className="flex flex-col gap-3" noValidate>
          <input type="hidden" name="mobile" value={mobile} />
          <p role="status" className="text-sm text-[var(--color-muted-foreground)]">{sendState.error ?? sendState.info}</p>
          {sendState.devCode ? <p className="text-xs text-[var(--color-muted-foreground)]">Dev code: {sendState.devCode}</p> : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="teacher-otp">6-digit OTP</Label>
            <Input id="teacher-otp" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" required />
            <p className="text-xs text-[var(--color-muted-foreground)]">The code is valid for 5 minutes.</p>
          </div>
          <Notice state={{ error: verifyState.error }} />
          <Submit idle="Verify & Login" busy="Verifying…" />
        </form>
      ) : null}
    </div>
  );
}

export function TeacherLoginScreen() {
  const [tab, setTab] = useState<"password" | "otp">("password");
  const tabClass = (on: boolean) =>
    `flex-1 rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium transition-colors ${
      on ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
    }`;
  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="Login method" className="flex gap-1 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        <button type="button" role="tab" id="tab-password" aria-selected={tab === "password"} aria-controls="panel-password" className={tabClass(tab === "password")} onClick={() => setTab("password")}>
          Username &amp; Password
        </button>
        <button type="button" role="tab" id="tab-otp" aria-selected={tab === "otp"} aria-controls="panel-otp" className={tabClass(tab === "otp")} onClick={() => setTab("otp")}>
          Login with OTP
        </button>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "password" ? <PasswordForm /> : <OtpForm />}
      </div>
    </div>
  );
}
