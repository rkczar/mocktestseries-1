"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Eye, EyeOff, Loader2, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  loginWithPasswordAction,
  registerWithPasswordAction,
  sendMobileOtpAction,
  verifyMobileOtpAction,
  googleSignInAction,
  type AuthFormState,
} from "./actions";

function SubmitButton({ children, pendingLabel }: { children: React.ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {pending ? pendingLabel : children}
    </Button>
  );
}

function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-button)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]"
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

function PasswordLoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(loginWithPasswordAction, {});
  const [show, setShow] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="identifier">Email or Mobile Number</Label>
        <Input id="identifier" name="identifier" type="text" autoComplete="username" required placeholder="you@example.com" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <span className="text-xs text-[var(--color-muted-foreground)]" title="Password reset via email will be available once an email provider is configured.">
            Forgot password?
          </span>
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
      <SubmitButton pendingLabel="Signing in…">Login</SubmitButton>
    </form>
  );
}

function PasswordRegisterForm({ callbackUrl }: { callbackUrl: string }) {
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
      <SubmitButton pendingLabel="Creating account…">Create Account</SubmitButton>
    </form>
  );
}

function MobileOtpForm({ callbackUrl }: { callbackUrl: string }) {
  const [sendState, sendAction] = useActionState<AuthFormState, FormData>(sendMobileOtpAction, {});
  const [verifyState, verifyAction] = useActionState<AuthFormState, FormData>(verifyMobileOtpAction, {});
  const [resendState, resendAction] = useActionState<AuthFormState, FormData>(sendMobileOtpAction, {});

  const active = resendState.sent ? resendState : sendState;

  if (!active.sent) {
    return (
      <form action={sendAction} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="otp-mobile">Mobile Number</Label>
          <Input id="otp-mobile" name="mobile" type="tel" autoComplete="tel" required placeholder="+91XXXXXXXXXX" />
        </div>
        <ErrorBanner message={sendState.error} />
        <SubmitButton pendingLabel="Sending code…">Send OTP</SubmitButton>
      </form>
    );
  }

  return (
    <form action={verifyAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <input type="hidden" name="mobile" value={active.mobile} />
      <input type="hidden" name="existing" value={String(active.existing)} />

      <p className="text-sm text-[var(--color-muted-foreground)]">
        {active.existing ? "Welcome back — " : "New number — let's set up your account. "}
        We sent a verification code to <span className="font-medium text-[var(--color-foreground)]">{active.mobile}</span>.
      </p>
      {active.devCode ? (
        <p className="rounded-[var(--radius-button)] border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
          Dev mode — no SMS provider configured. Your code is <span className="font-mono font-semibold">{active.devCode}</span>.
        </p>
      ) : null}

      {!active.existing ? (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="otp-name">Full Name</Label>
            <Input id="otp-name" name="name" type="text" autoComplete="name" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="otp-email">Email (optional)</Label>
            <Input id="otp-email" name="email" type="email" autoComplete="email" />
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="otp-code">Verification Code</Label>
        <Input id="otp-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} />
      </div>

      <ErrorBanner message={verifyState.error} />

      <div className="flex items-center justify-between">
        <form action={resendAction}>
          <input type="hidden" name="mobile" value={active.mobile} />
          <button type="submit" className="text-sm text-[var(--color-primary)] hover:underline">
            Resend code
          </button>
        </form>
      </div>

      <SubmitButton pendingLabel="Verifying…">Verify &amp; Continue</SubmitButton>
    </form>
  );
}

export function LoginScreen({ callbackUrl, googleEnabled, defaultTab }: { callbackUrl: string; googleEnabled: boolean; defaultTab: string }) {
  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary)] text-white shadow-[var(--shadow-card)]">
          <GraduationCap className="h-6 w-6" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Mock Test Series.in</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Student Login</p>
        </div>
      </div>

      <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-[var(--shadow-card)]">
        <Tabs defaultValue={defaultTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="login">Login</TabsTrigger>
            <TabsTrigger value="register">Create Account</TabsTrigger>
            <TabsTrigger value="otp">Mobile OTP</TabsTrigger>
          </TabsList>

          <TabsContent value="login" className="flex flex-col gap-4">
            <PasswordLoginForm callbackUrl={callbackUrl} />
            {googleEnabled ? (
              <>
                <Divider />
                <GoogleButton callbackUrl={callbackUrl} />
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="register" className="flex flex-col gap-4">
            <PasswordRegisterForm callbackUrl={callbackUrl} />
            {googleEnabled ? (
              <>
                <Divider />
                <GoogleButton callbackUrl={callbackUrl} />
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="otp">
            <MobileOtpForm callbackUrl={callbackUrl} />
          </TabsContent>
        </Tabs>
      </div>

      <p className="mt-6 text-center text-xs text-[var(--color-muted-foreground)]">
        By continuing you agree to our Terms &amp; Conditions and Privacy Policy.
      </p>
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-[var(--color-border)]" />
      <span className="text-xs text-[var(--color-muted-foreground)]">or</span>
      <span className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  );
}
