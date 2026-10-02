import "server-only";
import { getEmailEnvConfig, resendApiKey } from "@/lib/email/config";

/**
 * Email provider abstraction. Application code never calls a provider: it
 * queues through lib/email/queue.ts, and only the queue worker (and the
 * admin "Send Test Email" path, through the same worker code) reaches
 * `getEmailProvider().send()`. Swapping Resend for another provider means
 * adding one class that implements EmailProvider here — registration,
 * payment and auth code never change.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Provider-side dedupe key: a retried send with the same key is not delivered twice. */
  idempotencyKey: string;
  tags?: { name: string; value: string }[];
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      /** Retrying can succeed (network, 5xx, 429). */
      retryable: boolean;
      /** Seconds the provider asked us to wait (429 Retry-After). */
      retryAfterSeconds?: number;
      /** Safe, short reason for the log. Never contains the API key. */
      reason: string;
    };

export interface EmailProvider {
  readonly name: string;
  readonly configured: boolean;
  send(email: OutgoingEmail): Promise<SendResult>;
  /** Cheap credential check for Settings. */
  checkConnection(): Promise<{ ok: boolean; message: string }>;
}

const RESEND_API = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 15_000;

class ResendProvider implements EmailProvider {
  readonly name = "resend";

  get configured() {
    return resendApiKey() !== null;
  }

  private async request(path: string, init: RequestInit & { headers?: Record<string, string> }) {
    const key = resendApiKey();
    if (!key) throw new Error("Email provider not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${RESEND_API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    if (!this.configured) return { ok: false, retryable: false, reason: "Email provider not configured" };
    const { from, replyTo } = getEmailEnvConfig();
    let res: Response;
    try {
      res = await this.request("/emails", {
        method: "POST",
        headers: { "Idempotency-Key": email.idempotencyKey.slice(0, 256) },
        body: JSON.stringify({
          from,
          to: [email.to],
          reply_to: replyTo,
          subject: email.subject,
          html: email.html,
          text: email.text,
          headers: email.headers,
          tags: email.tags,
        }),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "AbortError";
      return { ok: false, retryable: true, reason: timeout ? "Provider request timed out" : "Network error reaching provider" };
    }

    const body = (await res.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
    if (res.ok && body?.id) return { ok: true, providerMessageId: body.id };

    const reason = `Resend ${res.status}${body?.name ? ` ${body.name}` : ""}${body?.message ? `: ${body.message}` : ""}`.slice(0, 300);
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      return { ok: false, retryable: true, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2, reason };
    }
    // 409 = same idempotency key still in flight / reused with another body.
    const retryable = res.status >= 500 || res.status === 409 || res.status === 408;
    return { ok: false, retryable, reason };
  }

  async checkConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.configured) return { ok: false, message: "Email provider not configured (RESEND_API_KEY is missing)." };
    try {
      const res = await this.request("/domains", { method: "GET" });
      const body = (await res.json().catch(() => null)) as
        | { data?: { name?: string; status?: string }[]; name?: string; message?: string }
        | null;
      if (res.ok) {
        const domains = (body?.data ?? []).map((d) => `${d.name} (${d.status})`).join(", ");
        return { ok: true, message: domains ? `API key accepted. Domains: ${domains}.` : "API key accepted. No domains listed." };
      }
      // A "sending access" key can send but not list domains — that is a valid setup.
      if (res.status === 401 && body?.name === "restricted_api_key") {
        return { ok: true, message: "API key accepted (sending-only key; domain list not visible)." };
      }
      return { ok: false, message: `Resend rejected the API key (${res.status}${body?.name ? ` ${body.name}` : ""}).` };
    } catch {
      return { ok: false, message: "Could not reach Resend. Check the server's network access." };
    }
  }
}

const provider: EmailProvider = new ResendProvider();

export function getEmailProvider(): EmailProvider {
  return provider;
}
