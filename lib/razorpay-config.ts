import "server-only";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/secret-cipher";

/**
 * Razorpay configuration, stored in the existing `Setting` key-value table
 * under the key `api.razorpay` — same storage/encryption pattern as
 * lib/auth-provider-config.ts and lib/gemini-config.ts.
 *
 * UI shell only: no payment flow reads these credentials yet and Test
 * Connection never calls the real Razorpay API — it only checks the key
 * format locally. Wiring this up to an actual checkout is future work; this
 * lets an admin store and label a Razorpay key pair ahead of that.
 */

const SETTING_KEY = "api.razorpay";
const CACHE_TTL_MS = 15_000;

export interface ProviderLastTest {
  ok: boolean;
  message: string;
  at: string;
}

export type RazorpayMode = "test" | "live";

export interface RazorpayPublicConfig {
  enabled: boolean;
  mode: RazorpayMode;
  keyId: string;
  keySecretConfigured: boolean;
  configured: boolean;
  lastTest: ProviderLastTest | null;
  updatedAt: string | null;
}

interface StoredRazorpay {
  enabled?: boolean;
  mode?: RazorpayMode;
  keyId?: string;
  keySecretCipher?: string;
  lastTest?: ProviderLastTest | null;
  updatedAt?: string;
}

let cache: { fetchedAt: number; value: RazorpayPublicConfig } | null = null;

export function bumpRazorpayConfigEpoch() {
  cache = null;
}

async function readStored(): Promise<StoredRazorpay> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return {};
  return (row.value as StoredRazorpay) ?? {};
}

function toPublic(raw: StoredRazorpay): RazorpayPublicConfig {
  const keySecretConfigured = Boolean(decryptSecret(raw.keySecretCipher));
  const keyId = raw.keyId ?? "";
  return {
    enabled: raw.enabled ?? false,
    mode: raw.mode ?? "test",
    keyId,
    keySecretConfigured,
    configured: Boolean(keyId && keySecretConfigured),
    lastTest: raw.lastTest ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

/** Front-end-safe Razorpay config. Cached in-process for 15s. */
export async function getRazorpayConfig(): Promise<RazorpayPublicConfig> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const raw = await readStored();
  const value = toPublic(raw);
  cache = { fetchedAt: Date.now(), value };
  return value;
}

export interface RazorpayConfigUpdate {
  enabled?: boolean;
  mode?: RazorpayMode;
  keyId?: string;
  keySecret?: string;
}

export async function saveRazorpayConfig(update: RazorpayConfigUpdate): Promise<void> {
  const raw = await readStored();
  const next: StoredRazorpay = { ...raw };
  if (update.enabled !== undefined) next.enabled = update.enabled;
  if (update.mode !== undefined) next.mode = update.mode;
  if (update.keyId !== undefined) next.keyId = update.keyId.trim() || undefined;
  if (update.keySecret !== undefined && update.keySecret.trim()) {
    next.keySecretCipher = encryptSecret(update.keySecret.trim());
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
 * Prototype-only check: validates the shape of the stored key pair without
 * calling Razorpay. A real live-mode probe (e.g. GET /v1/payments with Basic
 * Auth) is deliberately not wired up yet — no checkout flow depends on these
 * credentials, so there is nothing real to verify against.
 */
export async function testRazorpayConnection(): Promise<ProviderLastTest> {
  const raw = await readStored();
  const keyId = raw.keyId ?? "";
  const keySecret = decryptSecret(raw.keySecretCipher);

  if (!keyId || !keySecret) {
    const result: ProviderLastTest = { ok: false, message: "Key ID and Key Secret are required.", at: new Date().toISOString() };
    await recordTest(result);
    return result;
  }
  const expectedPrefix = raw.mode === "live" ? "rzp_live_" : "rzp_test_";
  if (!keyId.startsWith(expectedPrefix)) {
    const result: ProviderLastTest = {
      ok: false,
      message: `Key ID doesn't look like a ${raw.mode ?? "test"}-mode key (expected it to start with "${expectedPrefix}").`,
      at: new Date().toISOString(),
    };
    await recordTest(result);
    return result;
  }
  const result: ProviderLastTest = {
    ok: false,
    message: "Key format looks valid, but this prototype does not call the real Razorpay API — no live gateway is connected yet.",
    at: new Date().toISOString(),
  };
  await recordTest(result);
  return result;
}
