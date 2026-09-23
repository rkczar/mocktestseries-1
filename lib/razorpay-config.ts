import "server-only";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/secret-cipher";

/**
 * Razorpay gateway configuration, stored in the existing `Setting` table
 * under `api.razorpay` with the same AES-256-GCM encryption as every other
 * provider credential (lib/secret-cipher.ts).
 *
 * TEST and LIVE credentials live in separate slots so keys can be rotated or
 * staged without clobbering the other environment; `environment` picks which
 * slot new checkouts use. An order remembers the environment it was created
 * in, and verification/webhooks always use THAT environment's secrets.
 *
 * Secrets (Key Secret, Webhook Secret) are decrypted only inside server code
 * paths that call Razorpay or verify an HMAC — they are never returned by
 * getRazorpayConfig(), never logged, and never sent to the browser. The Key
 * ID is public by design (Checkout needs it) but admin screens still mask it.
 */

const SETTING_KEY = "api.razorpay";
const CACHE_TTL_MS = 15_000;

export interface ProviderLastTest {
  ok: boolean;
  message: string;
  at: string;
}

export type RazorpayEnvironment = "TEST" | "LIVE";
/** Legacy lower-case alias kept for older callers. */
export type RazorpayMode = "test" | "live";

interface StoredSlot {
  keyId?: string;
  keySecretCipher?: string;
  webhookSecretCipher?: string;
}

interface StoredRazorpay {
  enabled?: boolean;
  environment?: RazorpayEnvironment;
  test?: StoredSlot;
  live?: StoredSlot;
  lastTest?: ProviderLastTest | null;
  updatedAt?: string;
  // Legacy single-slot shape (pre-commerce UI shell).
  mode?: RazorpayMode;
  keyId?: string;
  keySecretCipher?: string;
}

export interface RazorpaySlotPublic {
  keyIdMasked: string;
  keyIdConfigured: boolean;
  keySecretConfigured: boolean;
  webhookSecretConfigured: boolean;
  configured: boolean;
}

export interface RazorpayPublicConfig {
  enabled: boolean;
  environment: RazorpayEnvironment;
  test: RazorpaySlotPublic;
  live: RazorpaySlotPublic;
  /** Active environment has Key ID + Key Secret. */
  configured: boolean;
  lastTest: ProviderLastTest | null;
  updatedAt: string | null;
}

let cache: { fetchedAt: number; value: RazorpayPublicConfig } | null = null;

export function bumpRazorpayConfigEpoch() {
  cache = null;
}

async function readStored(): Promise<StoredRazorpay> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const raw = { ...((row?.value as StoredRazorpay) ?? {}) };
  // Fold the legacy single-slot shape into its environment slot.
  if (raw.keyId || raw.keySecretCipher) {
    const env: RazorpayEnvironment = raw.mode === "live" ? "LIVE" : "TEST";
    const slotKey = env === "LIVE" ? "live" : "test";
    raw[slotKey] = { keyId: raw.keyId, keySecretCipher: raw.keySecretCipher, ...(raw[slotKey] ?? {}) };
    raw.environment = raw.environment ?? env;
    delete raw.keyId;
    delete raw.keySecretCipher;
    delete raw.mode;
  }
  return raw;
}

/** "rzp_test_AbCdEfGhIjK" → "rzp_test_****IjK". */
export function maskKeyId(keyId: string): string {
  if (!keyId) return "";
  const m = keyId.match(/^(rzp_(?:test|live)_)(.*)$/);
  const prefix = m ? m[1] : "";
  const rest = m ? m[2] : keyId;
  return `${prefix}****${rest.slice(-3)}`;
}

function slotPublic(slot: StoredSlot | undefined): RazorpaySlotPublic {
  const keyId = slot?.keyId ?? "";
  const keySecretConfigured = Boolean(decryptSecret(slot?.keySecretCipher));
  return {
    keyIdMasked: maskKeyId(keyId),
    keyIdConfigured: Boolean(keyId),
    keySecretConfigured,
    webhookSecretConfigured: Boolean(decryptSecret(slot?.webhookSecretCipher)),
    configured: Boolean(keyId && keySecretConfigured),
  };
}

function toPublic(raw: StoredRazorpay): RazorpayPublicConfig {
  const environment = raw.environment ?? "TEST";
  const test = slotPublic(raw.test);
  const live = slotPublic(raw.live);
  return {
    enabled: raw.enabled ?? false,
    environment,
    test,
    live,
    configured: environment === "LIVE" ? live.configured : test.configured,
    lastTest: raw.lastTest ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

/** Front-end-safe Razorpay config (masked, no secrets). Cached in-process for 15s. */
export async function getRazorpayConfig(): Promise<RazorpayPublicConfig> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const value = toPublic(await readStored());
  cache = { fetchedAt: Date.now(), value };
  return value;
}

export interface RazorpayCredentials {
  environment: RazorpayEnvironment;
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
}

/**
 * SERVER-ONLY decrypted credentials for one environment. Callers must use
 * the result only to call Razorpay / compute an HMAC and must never return,
 * log or serialize it.
 */
export async function getRazorpayCredentials(environment: RazorpayEnvironment): Promise<RazorpayCredentials | null> {
  const raw = await readStored();
  const slot = environment === "LIVE" ? raw.live : raw.test;
  const keyId = slot?.keyId ?? "";
  const keySecret = decryptSecret(slot?.keySecretCipher);
  if (!keyId || !keySecret) return null;
  return { environment, keyId, keySecret, webhookSecret: decryptSecret(slot?.webhookSecretCipher) };
}

/** Webhook secrets for every configured environment (a delivery doesn't say which one sent it). */
export async function getRazorpayWebhookSecrets(): Promise<{ environment: RazorpayEnvironment; secret: string }[]> {
  const raw = await readStored();
  const out: { environment: RazorpayEnvironment; secret: string }[] = [];
  const t = decryptSecret(raw.test?.webhookSecretCipher);
  const l = decryptSecret(raw.live?.webhookSecretCipher);
  if (t) out.push({ environment: "TEST", secret: t });
  if (l) out.push({ environment: "LIVE", secret: l });
  return out;
}

export interface RazorpayConfigUpdate {
  enabled?: boolean;
  environment?: RazorpayEnvironment;
  /** Which slot keyId/keySecret/webhookSecret apply to. */
  slot?: RazorpayEnvironment;
  keyId?: string;
  /** Blank/undefined leaves the stored secret untouched (rotation-friendly). */
  keySecret?: string;
  webhookSecret?: string;
}

export class RazorpayConfigError extends Error {}

export async function saveRazorpayConfig(update: RazorpayConfigUpdate): Promise<void> {
  const next = await readStored();
  if (update.enabled !== undefined) next.enabled = update.enabled;
  if (update.environment !== undefined) next.environment = update.environment;

  if (update.slot) {
    const slotKey = update.slot === "LIVE" ? "live" : "test";
    const slot: StoredSlot = { ...(next[slotKey] ?? {}) };
    const keyId = update.keyId?.trim();
    if (keyId) {
      const expected = update.slot === "LIVE" ? "rzp_live_" : "rzp_test_";
      if (!keyId.startsWith(expected) || !/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/.test(keyId)) {
        throw new RazorpayConfigError(`A ${update.slot} Key ID must look like "${expected}XXXXXXXX".`);
      }
      slot.keyId = keyId;
    }
    if (update.keySecret?.trim()) slot.keySecretCipher = encryptSecret(update.keySecret.trim());
    if (update.webhookSecret?.trim()) slot.webhookSecretCipher = encryptSecret(update.webhookSecret.trim());
    next[slotKey] = slot;
  }
  next.lastTest = null;
  next.updatedAt = new Date().toISOString();

  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
  bumpRazorpayConfigEpoch();
}

async function recordTest(result: ProviderLastTest): Promise<void> {
  const raw = await readStored();
  raw.lastTest = result;
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: raw as unknown as object },
    create: { key: SETTING_KEY, value: raw as unknown as object },
  });
  bumpRazorpayConfigEpoch();
}

/**
 * Real connectivity probe: an authenticated GET /v1/orders?count=1 against
 * Razorpay with the ACTIVE environment's key pair. Only the HTTP outcome is
 * recorded — never the credentials or the response body.
 */
export async function testRazorpayConnection(): Promise<ProviderLastTest> {
  const raw = await readStored();
  const environment = raw.environment ?? "TEST";
  const creds = await getRazorpayCredentials(environment);
  const at = new Date().toISOString();
  let result: ProviderLastTest;
  if (!creds) {
    result = { ok: false, message: `${environment} Key ID and Key Secret are required.`, at };
  } else {
    try {
      const res = await fetch("https://api.razorpay.com/v1/orders?count=1", {
        headers: { Authorization: "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64") },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      result =
        res.status === 200
          ? { ok: true, message: `Connected to Razorpay (${environment} mode).`, at }
          : res.status === 401
            ? { ok: false, message: `Razorpay rejected the ${environment} credentials (401). Re-enter the Key ID/Secret.`, at }
            : { ok: false, message: `Razorpay responded with HTTP ${res.status}.`, at };
    } catch {
      result = { ok: false, message: "Could not reach Razorpay (network/timeout).", at };
    }
  }
  await recordTest(result);
  return result;
}
