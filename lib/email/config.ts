import "server-only";

/**
 * Email environment configuration — the only place that reads the email
 * env vars. RESEND_API_KEY is read server-side only, never logged and never
 * returned to a client: callers get `providerConfigured` (a boolean) and,
 * at most, a masked hint for Admin → Communications → Email → Settings.
 *
 *   RESEND_API_KEY          Resend API key (blank/missing = provider NOT CONFIGURED)
 *   EMAIL_FROM              "MockTestSeries <support@mocktestseries.in>"
 *   EMAIL_REPLY_TO          "support@mocktestseries.in"
 *   RESEND_WEBHOOK_SECRET   "whsec_…" signing secret (blank = webhook disabled)
 *
 * The app builds and runs with none of them set: nothing is sent, the queue
 * and admin UI keep working, and Settings shows "Email provider not configured".
 */

export const DEFAULT_EMAIL_FROM = "MockTestSeries <support@mocktestseries.in>";
export const DEFAULT_EMAIL_REPLY_TO = "support@mocktestseries.in";
export const SUPPORT_EMAIL = "support@mocktestseries.in";

export type EmailProviderName = "resend";

export interface EmailEnvConfig {
  provider: EmailProviderName;
  from: string;
  replyTo: string;
  /** True only when an API key of the right shape is present. */
  providerConfigured: boolean;
  /** Why the provider counts as not configured, when it doesn't. Never contains the key. */
  providerProblem: string | null;
  webhookConfigured: boolean;
}

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

/** The raw key, for the provider module only. */
export function resendApiKey(): string | null {
  const key = clean(process.env.RESEND_API_KEY);
  return key.startsWith("re_") && key.length >= 10 ? key : null;
}

export function resendWebhookSecret(): string | null {
  const secret = clean(process.env.RESEND_WEBHOOK_SECRET);
  return secret.startsWith("whsec_") && secret.length > 10 ? secret : null;
}

export function getEmailEnvConfig(): EmailEnvConfig {
  const rawKey = clean(process.env.RESEND_API_KEY);
  const key = resendApiKey();
  return {
    provider: "resend",
    from: clean(process.env.EMAIL_FROM) || DEFAULT_EMAIL_FROM,
    replyTo: clean(process.env.EMAIL_REPLY_TO) || DEFAULT_EMAIL_REPLY_TO,
    providerConfigured: key !== null,
    providerProblem: key ? null : rawKey ? "RESEND_API_KEY is set but is not a valid Resend key (it should start with re_)." : "RESEND_API_KEY is not set.",
    webhookConfigured: resendWebhookSecret() !== null,
  };
}

/** Bare address from a "Name <addr>" sender, for display. */
export function senderAddress(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return (match ? match[1] : from).trim();
}
