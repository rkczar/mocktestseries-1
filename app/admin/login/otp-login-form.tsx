"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { otpLoginAction, requestAdminMobileOtpAction, requestAdminMobileOtpWhatsAppAction, requestAdminOtpAction, type LoginFormState } from "./actions";

function VerifyButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending} data-testid="admin-otp-verify">
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {pending ? "Signing in…" : "Verify & Login"}
    </Button>
  );
}

/** Optional Login with OTP: a code to the verified email, or by SMS to the verified mobile (password login stays as it is). */
export function OtpLoginForm({ callbackUrl, channel = "email", whatsapp = false }: { callbackUrl: string; channel?: "email" | "mobile"; whatsapp?: boolean }) {
  const mobile = channel === "mobile";
  const [state, formAction] = useActionState<LoginFormState, FormData>(otpLoginAction, {});
  const [identifier, setIdentifier] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [sending, start] = useTransition();

  const send = () =>
    start(async () => {
      const r = await (mobile ? requestAdminMobileOtpAction : requestAdminOtpAction)(identifier);
      if (!r.ok) {
        setSent(null);
        setSendError(r.message);
        return;
      }
      setSendError(null);
      setSent(r.message);
      setCooldown(60);
      const t = setInterval(() => setCooldown((c) => (c <= 1 ? (clearInterval(t), 0) : c - 1)), 1000);
    });
  const sendWhatsApp = () =>
    start(async () => {
      const r = await requestAdminMobileOtpWhatsAppAction(identifier);
      setSendError(r.ok ? null : r.message);
      if (r.ok) setSent(r.message);
    });

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate data-testid="admin-otp-form">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <input type="hidden" name="channel" value={channel} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="otp-identifier">{mobile ? "Registered mobile number (+91)" : "Admin ID / Username or registered email"}</Label>
        <Input id="otp-identifier" name="identifier" type={mobile ? "tel" : "text"} inputMode={mobile ? "tel" : undefined} autoComplete={mobile ? "tel" : "username"} required value={identifier}
          onChange={(e) => setIdentifier(e.target.value)} placeholder={mobile ? "+91 98765 43210" : "admin"} maxLength={mobile ? 20 : 200} />
      </div>
      <Button type="button" variant="outline" disabled={!identifier.trim() || sending || cooldown > 0} onClick={send} data-testid="admin-otp-send">
        {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        {cooldown > 0 ? `Resend code in ${cooldown}s` : sent ? "Resend code" : "Send code"}
      </Button>
      {sendError ? (
        <p role="alert" className="rounded-[var(--radius-button)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]" data-testid="admin-otp-send-error">
          {sendError}
        </p>
      ) : null}
      {mobile && whatsapp && sent ? (
        <Button type="button" variant="ghost" size="sm" disabled={sending || cooldown > 0} onClick={sendWhatsApp} data-testid="admin-otp-whatsapp">
          {cooldown > 0 ? `Get the code on WhatsApp in ${cooldown}s` : "Get the code on WhatsApp instead"}
        </Button>
      ) : null}
      {sent ? (
        <p role="status" className="text-sm text-[var(--color-muted-foreground)]" data-testid="admin-otp-sent">
          {sent}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="otp-code">6-digit code</Label>
        <Input id="otp-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required placeholder="123456" />
      </div>
      {state.error ? (
        <p role="alert" className="rounded-[var(--radius-button)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {state.error}
        </p>
      ) : null}
      <VerifyButton />
    </form>
  );
}

/** Password (default, unchanged) or the optional OTP methods the Master Admin turned on. */
export function AdminLoginOptions({ callbackUrl, passwordForm, emailOtp = true, mobileOtp = false, whatsapp = false }: {
  callbackUrl: string; passwordForm: React.ReactNode; emailOtp?: boolean; mobileOtp?: boolean; whatsapp?: boolean;
}) {
  type Mode = "password" | "otp" | "mobile";
  const [mode, setMode] = useState<Mode>("password");
  const tab = (m: Mode, label: string) => (
    <button type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} data-testid={`admin-login-tab-${m}`}
      className={`flex-1 rounded-[var(--radius-button)] px-2 py-2 text-sm font-medium ${mode === m ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]" : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"}`}>
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="Login method" className="flex gap-1 rounded-[var(--radius-button)] border border-[var(--color-border)] p-1">
        {tab("password", "Password")}
        {emailOtp ? tab("otp", mobileOtp ? "Email OTP" : "Login with OTP") : null}
        {mobileOtp ? tab("mobile", "Mobile OTP") : null}
      </div>
      {mode === "password" ? passwordForm : <OtpLoginForm key={mode} callbackUrl={callbackUrl} channel={mode === "mobile" ? "mobile" : "email"} whatsapp={whatsapp} />}
    </div>
  );
}
