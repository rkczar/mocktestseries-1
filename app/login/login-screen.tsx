"use client";

import { useActionState, useState, useRef, useEffect, type ReactNode, type CSSProperties } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { ArrowLeft, Eye, EyeOff, Loader2, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo } from "@/components/brand/BrandLogo";
import type { LoginPageConfig } from "@/lib/login-page";
import type { AuthProviderPublicConfig } from "@/lib/auth-provider-config";
import {
  loginWithPasswordAction,
  registerWithPasswordAction,
  sendMobileOtpAction,
  sendMobileOtpWhatsAppAction,
  verifyMobileOtpAction,
  sendRegisterOtpAction,
  sendRegisterOtpWhatsAppAction,
  verifyRegisterOtpAction,
  googleSignInAction,
  requestPasswordResetAction,
  requestPasswordResetWhatsAppAction,
  verifyPasswordResetCodeAction,
  resetPasswordAction,
  type AuthFormState,
  type ResetFormState,
} from "./actions";
import { INDIAN_MOBILE_ERROR, INDIAN_MOBILE_PATTERN, formatIndianMobile } from "@/lib/indian-mobile";

export function SubmitButton({
  children,
  pendingLabel,
  style,
}: {
  children: ReactNode;
  pendingLabel: string;
  style?: CSSProperties;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" style={style} disabled={pending}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {pending ? pendingLabel : children}
    </Button>
  );
}

export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="whitespace-pre-line rounded-[var(--radius-button)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]"
    >
      {message}
    </p>
  );
}

function GoogleButton({ callbackUrl }: { callbackUrl: string }) {
  return (
    <form action={googleSignInAction}>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <Button type="submit" variant="outline" size="lg" className="w-full">
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
          <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" />
          <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z" />
          <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29A11.96 11.96 0 0 0 0 12c0 1.93.46 3.76 1.29 5.38l3.98-3.09Z" />
          <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.94 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
        </svg>
        Continue with Google
      </Button>
    </form>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-[var(--color-border)]" />
      <span className="text-xs text-[var(--color-muted-foreground)]">OR</span>
      <span className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}

function PasswordLoginForm({
  callbackUrl,
  buttonStyle,
  onForgot,
}: {
  callbackUrl: string;
  buttonStyle?: CSSProperties;
  onForgot: () => void;
}) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(loginWithPasswordAction, {});
  const [show, setShow] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="identifier">User ID or Email</Label>
        <Input id="identifier" name="identifier" type="text" autoComplete="username" required placeholder="you@example.com" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <button type="button" onClick={onForgot} className="text-xs text-indigo-400 hover:underline">
            Forgot Password?
          </button>
        </div>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            className="pr-10"
          />
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
      <ErrorBanner message={state.error} />
      <SubmitButton pendingLabel="Signing in…" style={buttonStyle}>
        Sign In
      </SubmitButton>
    </form>
  );
}

function PasswordRegisterForm({ callbackUrl, buttonStyle }: { callbackUrl: string; buttonStyle?: CSSProperties }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(registerWithPasswordAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Full Name</Label>
        <Input id="name" name="name" type="text" autoComplete="name" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="mobile">Mobile Number</Label>
        <Input id="mobile" name="mobile" type="tel" autoComplete="tel" required placeholder="+91XXXXXXXXXX" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="reg-password">Password</Label>
        <Input id="reg-password" name="password" type="password" autoComplete="new-password" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required />
      </div>
      <label className="flex items-start gap-2 text-sm text-[var(--color-muted-foreground)]">
        <input type="checkbox" name="acceptTerms" className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)]" />
        I accept the Terms &amp; Conditions and Privacy Policy.
      </label>
      <ErrorBanner message={state.error} />
      <SubmitButton pendingLabel="Creating account…" style={buttonStyle}>
        Create Account
      </SubmitButton>
    </form>
  );
}

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Six single-digit boxes backing one hidden `code` field, so the server
 * action (which expects a plain `code` form value) needs no changes.
 * Auto-advances on entry, moves back on backspace/left-arrow, and fills all
 * boxes from a single pasted code.
 */
export function OtpBoxInput({ autoSubmit }: { autoSubmit: () => void }) {
  const [digits, setDigits] = useState<string[]>(() => Array(OTP_LENGTH).fill(""));
  const boxRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    boxRefs.current[0]?.focus();
  }, []);

  /** Fills the boxes from `index` with a multi-digit string (paste, or an OS one-time-code autofill). */
  function fillFrom(index: number, value: string) {
    const next = [...digits];
    value
      .slice(0, OTP_LENGTH - index)
      .split("")
      .forEach((ch, k) => {
        next[index + k] = ch;
      });
    setDigits(next);
    boxRefs.current[Math.min(index + value.length, OTP_LENGTH - 1)]?.focus();
    if (next.every((d) => d.length === 1)) setTimeout(autoSubmit, 0);
  }

  function setDigit(index: number, value: string) {
    // Side effect kept out of the state updater: updaters may run twice
    // (StrictMode), which would submit the code twice.
    const next = [...digits];
    next[index] = value;
    setDigits(next);
    if (next.every((d) => d.length === 1)) {
      // Let the DOM update (hidden input value) before submitting.
      setTimeout(autoSubmit, 0);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="otp-box-0">OTP</Label>
      <div className="flex justify-between gap-2">
        {digits.map((digit, i) => (
          <input
            key={i}
            id={`otp-box-${i}`}
            aria-label={`OTP digit ${i + 1} of ${OTP_LENGTH}`}
            ref={(el) => {
              boxRefs.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            value={digit}
            onChange={(e) => {
              const typed = e.target.value.replace(/\D/g, "");
              // iOS/Android SMS autofill inserts the whole code into one box
              // (two characters is just a new digit typed over an old one).
              if (typed.length > 2) {
                fillFrom(i, typed.slice(0, OTP_LENGTH));
                return;
              }
              const val = typed.slice(-1);
              setDigit(i, val);
              if (val && i < OTP_LENGTH - 1) boxRefs.current[i + 1]?.focus();
            }}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !digits[i] && i > 0) {
                boxRefs.current[i - 1]?.focus();
                setDigit(i - 1, "");
              } else if (e.key === "ArrowLeft" && i > 0) {
                boxRefs.current[i - 1]?.focus();
              } else if (e.key === "ArrowRight" && i < OTP_LENGTH - 1) {
                boxRefs.current[i + 1]?.focus();
              }
            }}
            onPaste={(e) => {
              e.preventDefault();
              const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
              if (!pasted) return;
              const next = Array(OTP_LENGTH).fill("");
              pasted.split("").forEach((ch, idx) => {
                next[idx] = ch;
              });
              setDigits(next);
              const focusIndex = Math.min(pasted.length, OTP_LENGTH - 1);
              boxRefs.current[focusIndex]?.focus();
              if (pasted.length === OTP_LENGTH) setTimeout(autoSubmit, 0);
            }}
            className="h-12 w-11 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-center font-mono text-xl font-bold text-[var(--color-foreground)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          />
        ))}
      </div>
      <input type="hidden" name="code" value={digits.join("")} />
    </div>
  );
}

export function ResendCountdown({ onResend, onWhatsApp }: { onResend: () => void; onWhatsApp?: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  if (secondsLeft > 0) {
    return <span className="text-sm text-[var(--color-muted-foreground)]">Resend code in {secondsLeft}s</span>;
  }

  const resend = (
    <button
      type="button"
      onClick={() => {
        setSecondsLeft(RESEND_COOLDOWN_SECONDS);
        onResend();
      }}
      className="text-sm text-[var(--color-primary)] hover:underline"
    >
      Resend code
    </button>
  );
  if (!onWhatsApp) return resend;

  // Same 60 s server-side cooldown for both channels, so either restarts the countdown.
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {resend}
      <button
        type="button"
        onClick={() => {
          setSecondsLeft(RESEND_COOLDOWN_SECONDS);
          onWhatsApp();
        }}
        className="text-sm text-[var(--color-primary)] hover:underline"
      >
        Get OTP on WhatsApp
      </button>
    </div>
  );
}

/** Confirmation after "Get OTP on WhatsApp" (the code itself is never shown). */
export function WhatsAppSentNotice({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="status" className="text-sm text-[var(--color-success)]">
      {message}
    </p>
  );
}

/**
 * The fixed 🇮🇳 +91 prefix and a 10-digit national number. Only Indian mobile
 * numbers are accepted; the server re-validates (lib/indian-mobile.ts).
 */
export function IndianMobileInput({
  id,
  defaultValue,
  autoFocus,
}: {
  id: string;
  defaultValue?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const invalid = value.length === 10 && !INDIAN_MOBILE_PATTERN.test(value);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Mobile Number</Label>
      <div className="flex h-11 items-stretch overflow-hidden rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--color-primary)]">
        <span
          className="flex select-none items-center gap-1.5 border-r border-[var(--color-border)] px-3 text-sm font-medium text-[var(--color-foreground)]"
          aria-label="Country code India plus 91"
        >
          <span aria-hidden>🇮🇳</span> +91
        </span>
        <input
          id={id}
          name="mobile"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          required
          autoFocus={autoFocus}
          maxLength={10}
          pattern="[6-9][0-9]{9}"
          placeholder="Mobile Number"
          value={value}
          onChange={(e) => {
            // Accept a pasted "+91 98765 43210" / "098…" by keeping the last 10 digits.
            const digits = e.target.value.replace(/\D/g, "");
            setValue(digits.length > 10 ? digits.slice(-10) : digits);
          }}
          aria-invalid={invalid || undefined}
          className="min-w-0 flex-1 bg-transparent px-3 text-base tracking-wide text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-muted-foreground)]"
        />
      </div>
      {invalid ? <p className="text-xs text-[var(--color-error)]">{INDIAN_MOBILE_ERROR}</p> : null}
    </div>
  );
}

function DevCodeNotice({ code }: { code?: string }) {
  if (!code) return null;
  return (
    <p className="rounded-[var(--radius-button)] border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
      Dev mode — no SMS provider configured. Your code is <span className="font-mono font-semibold">{code}</span>.
    </p>
  );
}

/** Phone OTP sign-in for an existing account. New accounts use Create Account. */
function MobileOtpForm({ callbackUrl, buttonStyle, whatsapp }: { callbackUrl: string; buttonStyle?: CSSProperties; whatsapp?: boolean }) {
  const [sendState, sendAction] = useActionState<AuthFormState, FormData>(sendMobileOtpAction, {});
  const [verifyState, verifyAction, verifying] = useActionState<AuthFormState, FormData>(verifyMobileOtpAction, {});
  const [resendState, resendAction] = useActionState<AuthFormState, FormData>(sendMobileOtpAction, {});
  const [whatsappState, whatsappAction] = useActionState<AuthFormState, FormData>(sendMobileOtpWhatsAppAction, {});
  const verifyFormRef = useRef<HTMLFormElement>(null);
  const resendFormRef = useRef<HTMLFormElement>(null);
  const whatsappFormRef = useRef<HTMLFormElement>(null);
  const verifyingRef = useRef(false);
  useEffect(() => {
    verifyingRef.current = verifying;
  }, [verifying]);

  const active = resendState.sent ? resendState : sendState;

  if (!active.sent) {
    return (
      <form action={sendAction} className="flex flex-col gap-4" noValidate>
        <IndianMobileInput id="otp-mobile" />
        <ErrorBanner message={sendState.error} />
        <SubmitButton pendingLabel="Sending code…" style={buttonStyle}>
          Send OTP
        </SubmitButton>
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
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <input type="hidden" name="mobile" value={active.mobile} />
        <p className="text-sm text-[var(--color-muted-foreground)]">
          If this number is registered, you&apos;ll receive a 6-digit code at{" "}
          <span className="font-medium text-[var(--color-foreground)]">{formatIndianMobile(active.mobile)}</span>.
        </p>
        <DevCodeNotice code={active.devCode} />
        <OtpBoxInput autoSubmit={() => !verifyingRef.current && verifyFormRef.current?.requestSubmit()} />
        <WhatsAppSentNotice message={whatsappState.info} />
        <ErrorBanner message={verifyState.error ?? whatsappState.error ?? resendState.error} />
        <ResendCountdown
          onResend={() => resendFormRef.current?.requestSubmit()}
          onWhatsApp={whatsapp ? () => whatsappFormRef.current?.requestSubmit() : undefined}
        />
        <SubmitButton pendingLabel="Verifying…" style={buttonStyle}>
          Verify &amp; Sign In
        </SubmitButton>
      </form>
    </>
  );
}

/**
 * Create Account (mobile-first, used while "Require mobile verification" is
 * ON): Full Name + 🇮🇳 +91 mobile → "Verify Your Mobile Number" → the account
 * is created by the server only after the OTP is verified, then signed in.
 */
function RegisterMobileForm({ callbackUrl, buttonStyle, whatsapp }: { callbackUrl: string; buttonStyle?: CSSProperties; whatsapp?: boolean }) {
  // "Change" remounts the steps (fresh action states) with the typed values kept.
  const [restart, setRestart] = useState<{ key: number; name?: string; mobile?: string }>({ key: 0 });
  return (
    <RegisterMobileSteps
      key={restart.key}
      callbackUrl={callbackUrl}
      buttonStyle={buttonStyle}
      whatsapp={whatsapp}
      initialName={restart.name}
      initialMobile={restart.mobile}
      onChangeNumber={(name, mobile) => setRestart((r) => ({ key: r.key + 1, name, mobile }))}
    />
  );
}

function RegisterMobileSteps({
  callbackUrl,
  buttonStyle,
  whatsapp,
  initialName,
  initialMobile,
  onChangeNumber,
}: {
  callbackUrl: string;
  buttonStyle?: CSSProperties;
  whatsapp?: boolean;
  initialName?: string;
  initialMobile?: string;
  onChangeNumber: (name?: string, mobile?: string) => void;
}) {
  const [sendState, sendAction] = useActionState<AuthFormState, FormData>(sendRegisterOtpAction, {});
  const [verifyState, verifyAction, verifying] = useActionState<AuthFormState, FormData>(verifyRegisterOtpAction, {});
  const [resendState, resendAction] = useActionState<AuthFormState, FormData>(sendRegisterOtpAction, {});
  const [whatsappState, whatsappAction] = useActionState<AuthFormState, FormData>(sendRegisterOtpWhatsAppAction, {});
  const whatsappFormRef = useRef<HTMLFormElement>(null);
  // Controlled, so a refused send (React resets uncontrolled fields after a form action) keeps what was typed.
  const [name, setName] = useState(initialName ?? "");
  const verifyFormRef = useRef<HTMLFormElement>(null);
  const resendFormRef = useRef<HTMLFormElement>(null);
  const verifyingRef = useRef(false);
  useEffect(() => {
    verifyingRef.current = verifying;
  }, [verifying]);

  const active = resendState.sent ? resendState : sendState;

  if (!active.sent) {
    return (
      <form action={sendAction} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reg-name">Full Name</Label>
          <Input
            id="reg-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            minLength={2}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <IndianMobileInput id="reg-mobile" defaultValue={initialMobile} />
        <ErrorBanner message={sendState.error} />
        <SubmitButton pendingLabel="Sending OTP…" style={buttonStyle}>
          Send OTP
        </SubmitButton>
      </form>
    );
  }

  return (
    <>
      <form ref={resendFormRef} action={resendAction} className="hidden">
        <input type="hidden" name="name" value={active.name} />
        <input type="hidden" name="mobile" value={active.mobile} />
      </form>
      <form ref={whatsappFormRef} action={whatsappAction} className="hidden">
        <input type="hidden" name="name" value={active.name} />
        <input type="hidden" name="mobile" value={active.mobile} />
      </form>
      <form ref={verifyFormRef} action={verifyAction} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <input type="hidden" name="name" value={active.name} />
        <input type="hidden" name="mobile" value={active.mobile} />
        <div className="flex flex-col gap-1">
          <p className="text-base font-semibold text-[var(--color-foreground)]">Verify Your Mobile Number</p>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Enter the 6-digit code sent to{" "}
            <span className="font-medium text-[var(--color-foreground)]">{formatIndianMobile(active.mobile)}</span>.{" "}
            <button
              type="button"
              onClick={() => onChangeNumber(active.name, active.mobile?.slice(-10))}
              className="text-indigo-400 hover:underline"
            >
              Change
            </button>
          </p>
        </div>
        <DevCodeNotice code={active.devCode} />
        <OtpBoxInput autoSubmit={() => !verifyingRef.current && verifyFormRef.current?.requestSubmit()} />
        <WhatsAppSentNotice message={whatsappState.info} />
        <ErrorBanner message={verifyState.error ?? whatsappState.error ?? resendState.error} />
        <ResendCountdown
          onResend={() => resendFormRef.current?.requestSubmit()}
          onWhatsApp={whatsapp ? () => whatsappFormRef.current?.requestSubmit() : undefined}
        />
        <SubmitButton pendingLabel="Verifying…" style={buttonStyle}>
          Verify &amp; Create Account
        </SubmitButton>
      </form>
    </>
  );
}

/**
 * Forgot Password — identifier → code sent to the account's registered mobile
 * (existing phone OTP infrastructure) → New / Confirm password → back to Sign In.
 * The step-1 answer is identical whether or not the identifier has an account.
 */
function ForgotPasswordFlow({
  buttonStyle,
  whatsapp,
  onBack,
  onRestart,
}: {
  buttonStyle?: CSSProperties;
  whatsapp?: boolean;
  onBack: () => void;
  onRestart: () => void;
}) {
  const [requestState, requestAction] = useActionState<ResetFormState, FormData>(requestPasswordResetAction, {});
  const [resendState, resendAction] = useActionState<ResetFormState, FormData>(requestPasswordResetAction, {});
  const [whatsappState, whatsappAction] = useActionState<ResetFormState, FormData>(requestPasswordResetWhatsAppAction, {});
  const whatsappFormRef = useRef<HTMLFormElement>(null);
  const [verifyState, verifyAction] = useActionState<ResetFormState, FormData>(verifyPasswordResetCodeAction, {});
  const [resetState, resetAction] = useActionState<ResetFormState, FormData>(resetPasswordAction, {});
  const [show, setShow] = useState(false);
  // Once verification issues a token it sticks: a late duplicate verify
  // response ("code already used") must not bounce the student back a step.
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  if (verifyState.token && verifyState.token !== issuedToken) setIssuedToken(verifyState.token);
  const verifyFormRef = useRef<HTMLFormElement>(null);
  const resendFormRef = useRef<HTMLFormElement>(null);

  const backLink = (
    <button type="button" onClick={onBack} className="text-center text-sm text-indigo-400 hover:underline">
      Back to Sign In
    </button>
  );

  if (resetState.step === "done") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium text-white">Password reset successful</p>
        <p className="text-sm text-white/60">You can now sign in with your new password.</p>
        <Button type="button" size="lg" className="w-full" style={buttonStyle} onClick={onBack}>
          Return to Login
        </Button>
      </div>
    );
  }

  const token = resetState.token ?? issuedToken;
  if (token && resetState.error && resetState.step === undefined) {
    // Token expired / already used — the only way forward is a fresh code.
    return (
      <div className="flex flex-col gap-4">
        <ErrorBanner message={resetState.error} />
        <Button type="button" size="lg" className="w-full" style={buttonStyle} onClick={onRestart}>
          Start Again
        </Button>
        {backLink}
      </div>
    );
  }

  if (token) {
    return (
      <form action={resetAction} className="flex flex-col gap-4" noValidate>
        <p className="text-sm font-medium text-white">Set a new password</p>
        <input type="hidden" name="token" value={token} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="reset-password">New Password</Label>
          <div className="relative">
            <Input
              id="reset-password"
              name="password"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={8}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
            </button>
          </div>
          <p className="text-xs text-white/40">At least 8 characters.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reset-confirm">Confirm New Password</Label>
          <Input id="reset-confirm" name="confirmPassword" type={show ? "text" : "password"} autoComplete="new-password" required />
        </div>
        <ErrorBanner message={resetState.error} />
        <SubmitButton pendingLabel="Saving…" style={buttonStyle}>
          Reset Password
        </SubmitButton>
        {backLink}
      </form>
    );
  }

  const sent = resendState.step === "code" ? resendState : requestState;
  if (sent.step === "code" && sent.identifier) {
    return (
      <>
        <form ref={resendFormRef} action={resendAction} className="hidden">
          <input type="hidden" name="identifier" value={sent.identifier} />
        </form>
        <form ref={whatsappFormRef} action={whatsappAction} className="hidden">
          <input type="hidden" name="identifier" value={sent.identifier} />
        </form>
        <form ref={verifyFormRef} action={verifyAction} className="flex flex-col gap-4" noValidate>
          <p className="text-sm font-medium text-white">Verify it&apos;s you</p>
          <input type="hidden" name="identifier" value={sent.identifier} />
          <p className="text-sm text-white/60">
            If an account matches <span className="font-medium text-white">{sent.identifier}</span> and has a registered mobile
            number, we&apos;ve sent a verification code to that number.
          </p>
          {sent.devCode ? (
            <p className="rounded-[var(--radius-button)] border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
              Dev mode — no SMS provider configured. Your code is <span className="font-mono font-semibold">{sent.devCode}</span>.
            </p>
          ) : null}
          <OtpBoxInput autoSubmit={() => verifyFormRef.current?.requestSubmit()} />
          <WhatsAppSentNotice message={whatsappState.info} />
          <ErrorBanner message={verifyState.error ?? whatsappState.error ?? resendState.error} />
          <ResendCountdown
            onResend={() => resendFormRef.current?.requestSubmit()}
            onWhatsApp={whatsapp ? () => whatsappFormRef.current?.requestSubmit() : undefined}
          />
          <SubmitButton pendingLabel="Verifying…" style={buttonStyle}>
            Verify Code
          </SubmitButton>
          {backLink}
        </form>
      </>
    );
  }

  return (
    <form action={requestAction} className="flex flex-col gap-4" noValidate>
      <p className="text-sm font-medium text-white">Forgot Password</p>
      <p className="text-sm text-white/60">
        Enter your User ID, email or mobile number. We&apos;ll send a verification code to the mobile number registered on your
        account.
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="reset-identifier">User ID, Email or Mobile</Label>
        <Input id="reset-identifier" name="identifier" type="text" autoComplete="username" required />
      </div>
      <ErrorBanner message={requestState.error} />
      <SubmitButton pendingLabel="Sending code…" style={buttonStyle}>
        Send Verification Code
      </SubmitButton>
      {backLink}
    </form>
  );
}

export function LoginScreen({
  callbackUrl,
  defaultMode,
  defaultMethod,
  pageConfig,
  providerConfig,
  notice,
}: {
  callbackUrl: string;
  defaultMode: "signin" | "register" | "forgot";
  defaultMethod: "password" | "otp";
  pageConfig: LoginPageConfig;
  providerConfig: AuthProviderPublicConfig;
  /** Server-side sign-in rejection carried back in the URL (e.g. Google + device limit). */
  notice?: string;
}) {
  const showGoogle = providerConfig.google.enabled && providerConfig.google.configured;
  const showPassword = providerConfig.passwordEnabled;
  const showOtp = providerConfig.otpEnabled;
  const showRegister = providerConfig.registerEnabled;
  // Same rule as lib/auth-provider-config.ts isWhatsAppOtpAvailable() (enforced again server-side).
  const whatsappOtp =
    providerConfig.msg91.enabled && providerConfig.msg91.configured && providerConfig.msg91.whatsappRetryEnabled && Boolean(providerConfig.msg91.widgetId);

  const [mode, setMode] = useState<"signin" | "register" | "forgot">(defaultMode);
  const [forgotKey, setForgotKey] = useState(0);
  const [method, setMethod] = useState<"password" | "otp">(showPassword ? defaultMethod : "otp");

  const buttonStyle: CSSProperties = {};
  if (pageConfig.buttons.radius) buttonStyle.borderRadius = pageConfig.buttons.radius;
  if (pageConfig.buttons.height) buttonStyle.height = pageConfig.buttons.height;

  return (
    <div className="relative z-10 w-full" style={{ maxWidth: pageConfig.cardWidth }}>
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-white/60 transition-colors hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Home
      </Link>

      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        {pageConfig.branding.showLogo ? (
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500 text-white shadow-lg">
            <GraduationCap className="h-6 w-6" aria-hidden />
          </div>
        ) : null}
        <div>
          <BrandLogo size="lg" href="/" className="justify-center text-white" />
          <p className="mt-1 text-base font-medium text-white/90">{pageConfig.branding.loginTitle}</p>
          {pageConfig.branding.subtitle ? <p className="text-sm text-white/50">{pageConfig.branding.subtitle}</p> : null}
        </div>
      </div>

      <div
        className="border p-6 shadow-2xl"
        style={{ borderColor: pageConfig.background.border, borderRadius: pageConfig.cardRadius, background: "rgba(255,255,255,0.03)" }}
      >
        {notice ? (
          <div className="mb-4">
            <ErrorBanner message={notice} />
          </div>
        ) : null}
        {mode === "forgot" ? (
          <ForgotPasswordFlow
            key={forgotKey}
            buttonStyle={buttonStyle}
            whatsapp={whatsappOtp}
            onBack={() => setMode("signin")}
            onRestart={() => setForgotKey((k) => k + 1)}
          />
        ) : mode === "register" ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm font-medium text-white">Create Account</p>
            {providerConfig.mobileVerificationRequired ? (
              <RegisterMobileForm callbackUrl={callbackUrl} buttonStyle={buttonStyle} whatsapp={whatsappOtp} />
            ) : (
              <PasswordRegisterForm callbackUrl={callbackUrl} buttonStyle={buttonStyle} />
            )}
            {showGoogle ? (
              <>
                <Divider />
                <GoogleButton callbackUrl={callbackUrl} />
              </>
            ) : null}
            <button type="button" onClick={() => setMode("signin")} className="text-center text-sm text-indigo-400 hover:underline">
              Already have an account? Sign in
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {showGoogle ? (
              <>
                <GoogleButton callbackUrl={callbackUrl} />
                {showPassword || showOtp ? <Divider /> : null}
              </>
            ) : null}

            {showPassword && showOtp ? (
              <div className="grid grid-cols-2 gap-1 rounded-[var(--radius-button)] bg-white/5 p-1 text-sm">
                <button
                  type="button"
                  onClick={() => setMethod("password")}
                  className={`rounded-[calc(var(--radius-button)-2px)] py-1.5 font-medium transition-colors ${
                    method === "password" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
                  }`}
                >
                  User ID / Password
                </button>
                <button
                  type="button"
                  onClick={() => setMethod("otp")}
                  className={`rounded-[calc(var(--radius-button)-2px)] py-1.5 font-medium transition-colors ${
                    method === "otp" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
                  }`}
                >
                  Phone OTP
                </button>
              </div>
            ) : null}

            {showPassword && method === "password" ? <PasswordLoginForm callbackUrl={callbackUrl} buttonStyle={buttonStyle} onForgot={() => setMode("forgot")} /> : null}
            {showOtp && method === "otp" ? <MobileOtpForm callbackUrl={callbackUrl} buttonStyle={buttonStyle} whatsapp={whatsappOtp} /> : null}
            {!showPassword && !showOtp && !showGoogle ? (
              <p className="text-center text-sm text-white/50">
                Sign-in is temporarily unavailable. Please contact support.
              </p>
            ) : null}

            {showRegister ? (
              <p className="text-center text-sm text-white/50">
                New User?{" "}
                <button type="button" onClick={() => setMode("register")} className="font-medium text-indigo-400 hover:underline">
                  Create Account
                </button>
              </p>
            ) : null}
          </div>
        )}
      </div>

      <p className="mt-6 text-center text-xs text-white/30">
        By continuing you agree to our Terms &amp; Conditions and Privacy Policy.
      </p>
    </div>
  );
}
