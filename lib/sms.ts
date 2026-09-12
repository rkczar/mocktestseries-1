import "server-only";

/**
 * Pluggable OTP delivery. Defaults to a "console" dev provider that logs the
 * code to the server log — a real, working channel for local/dev testing,
 * not a fake success. Set SMS_PROVIDER=twilio (and the matching TWILIO_*
 * env vars) to switch to a real provider once credentials are available.
 */
export async function sendSms(mobile: string, message: string): Promise<void> {
  const provider = process.env.SMS_PROVIDER ?? "console";

  if (provider === "console") {
    console.log(`[SMS:DEV] to ${mobile}: ${message}`);
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

  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}
