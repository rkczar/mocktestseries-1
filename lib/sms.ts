import "server-only";
import { getSmsProviderName, getMsg91Credentials } from "@/lib/auth-provider-config";

/**
 * Pluggable OTP delivery.
 *
 * - "console"  → logs the code to the server log. A real, working channel for
 *   local/dev testing (and the fallback until MSG91 is configured), not a fake
 *   success.
 * - "twilio"   → Twilio Programmable SMS (requires TWILIO_* env).
 * - "msg91"    → MSG91 flow-based SMS/OTP, configured from Admin →
 *   Settings → Authentication. Credentials are read server-side (encrypted in
 *   the DB, env fallback) and never reach the browser.
 *
 * The provider is chosen by SMS_PROVIDER (env) or, when unset, MSG91 if its
 * auth key is configured, else console.
 */
export async function sendSms(mobile: string, message: string): Promise<void> {
  const provider = await getSmsProviderName();

  if (provider === "console") {
    console.log(`[SMS:DEV] to ${mobile}: ${message}`);
    // In production this fallback reaches no real phone — throwing here (instead
    // of a silent "success") is what lets the OTP UI show an honest error
    // rather than telling a student a code was sent when nothing went out.
    if (process.env.NODE_ENV === "production") {
      throw new Error("No SMS provider is configured. Set up MSG91 in Admin > Settings > Authentication.");
    }
    return;
  }

  if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) {
      throw new Error(
        "SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER are not set."
      );
    }
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: mobile, From: from, Body: message }),
    });
    if (!res.ok) {
      throw new Error(`Twilio SMS send failed: ${res.status} ${await res.text()}`);
    }
    return;
  }

  if (provider === "msg91") {
    const { authKey, senderId, flowId } = await getMsg91Credentials();
    if (!authKey) {
      throw new Error("MSG91 is the SMS provider but no Auth Key is configured. See Admin > Settings > Authentication.");
    }
    if (!flowId) {
      throw new Error("MSG91 OTP delivery needs a Flow ID. Configure it in Admin > Settings > Authentication.");
    }
    const digits = mobile.replace(/\D/g, "");
    const mobiles = digits.startsWith("91") ? digits : `91${digits}`;
    const res = await fetch("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: {
        authkey: authKey,
        "Content-Type": "application/json",
      },
      // VAR1 is the placeholder the MSG91 flow template renders as the message body.
      body: JSON.stringify({ flow_id: flowId, sender: senderId ?? undefined, mobiles, VAR1: message }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const kind = res.status >= 500 ? "MSG91 server error" : "MSG91 rejected the request";
      throw new Error(`${kind} (${res.status})${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    return;
  }

  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}