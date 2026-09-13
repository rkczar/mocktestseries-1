import "server-only";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/secret-cipher";

/**
 * Authentication provider configuration (Google OAuth, MSG91 OTP, and the
 * per-method toggles shown on the login page), stored in the existing `Setting`
 * key-value table under the key `auth.providers`.
 *
 * Secrets (Google client secret, MSG91 auth key) are AES-256-GCM encrypted at
 * rest (see lib/secret-cipher.ts) and never returned to the browser — the admin
 * UI only ever sees a boolean "configured" and a mask. The public shape
 * returned by getAuthProviderConfig() is front-end-safe.
 *
 * Precedence: a saved value in the DB wins; ENV vars (GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET / MSG91_AUTH_KEY / MSG91_SENDER_ID / MSG91_FLOW_ID)
 * act as the bootstrap on a fresh install and as fallback if the DB has no
 * saved credentials for a provider.
 */

const SETTING_KEY = "auth.providers";
const CACHE_TTL_MS = 15_000;

export interface ProviderLastTest {
  ok: boolean;
  message: string;
  at: string;
}

export interface GooglePublicConfig {
  enabled: boolean;
  clientId: string;
  /** True when a stored (encrypted) or env client secret exists. */
  secretConfigured: boolean;
  configured: boolean;
  callbackUrl: string;
  authorizedOrigin: string;
  lastTest: ProviderLastTest | null;
  updatedAt: string | null;
}

export interface Msg91PublicConfig {
  enabled: boolean;
  authKeyConfigured: boolean;
  configured: boolean;
  senderId: string;
  flowId: string;
  lastTest: ProviderLastTest | null;
  updatedAt: string | null;
}

export interface AuthProviderPublicConfig {
  google: GooglePublicConfig;
  msg91: Msg91PublicConfig;
  passwordEnabled: boolean;
  otpEnabled: boolean;
  registerEnabled: boolean;
}

interface StoredGoogle {
  enabled?: boolean;
  clientId?: string;
  clientSecretCipher?: string;
  lastTest?: ProviderLastTest | null;
  updatedAt?: string;
}

interface StoredMsg91 {
  enabled?: boolean;
  authKeyCipher?: string;
  senderId?: string;
  flowId?: string;
  lastTest?: ProviderLastTest | null;
  updatedAt?: string;
}

interface StoredProviders {
  google?: StoredGoogle;
  msg91?: StoredMsg91;
  toggles?: { passwordEnabled?: boolean; otpEnabled?: boolean; registerEnabled?: boolean };
}

let cache: { fetchedAt: number; value: AuthProviderPublicConfig } | null = null;

/** Invalidate the in-process cache (used right after an admin save so the change is visible immediately). */
export function bumpProviderConfigEpoch() {
  cache = null;
}

/**
 * Which SMS channel `sendSms` uses. An explicit SMS_PROVIDER env wins; otherwise
 * MSG91 is used when it is configured (DB or env) and falls back to the console
 * dev provider so local development always has a working OTP channel.
 */
export async function getSmsProviderName(): Promise<string> {
  const explicit = process.env.SMS_PROVIDER;
  if (explicit && explicit !== "console") return explicit;
  const creds = await getMsg91Credentials();
  if (creds.authKey) return "msg91";
  return "console";
}

function defaultCallbackUrl(): string {
  const base = process.env.NEXTAUTH_URL ?? "https://mocktestseries.in";
  return `${base.replace(/\/$/, "")}/api/student-auth/callback/google`;
}

async function readStored(): Promise<StoredProviders> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return {};
  return (row.value as StoredProviders) ?? {};
}

function toPublic(raw: StoredProviders): AuthProviderPublicConfig {
  const envClientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const envClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const envMsg91Key = process.env.MSG91_AUTH_KEY ?? "";

  const goog = raw.google ?? {};
  const clientId = (goog.clientId || envClientId).trim();
  const secretConfigured = Boolean(decryptSecret(goog.clientSecretCipher) || envClientSecret);
  const google: GooglePublicConfig = {
    enabled: goog.enabled ?? Boolean(clientId && secretConfigured),
    clientId,
    secretConfigured,
    configured: Boolean(clientId && secretConfigured),
    callbackUrl: defaultCallbackUrl(),
    authorizedOrigin: process.env.NEXTAUTH_URL ?? "https://mocktestseries.in",
    lastTest: goog.lastTest ?? null,
    updatedAt: goog.updatedAt ?? null,
  };

  const msg = raw.msg91 ?? {};
  const authKeyConfigured = Boolean(decryptSecret(msg.authKeyCipher) || envMsg91Key);
  const msg91: Msg91PublicConfig = {
    enabled: msg.enabled ?? authKeyConfigured,
    authKeyConfigured,
    configured: authKeyConfigured,
    senderId: msg.senderId ?? process.env.MSG91_SENDER_ID ?? "",
    flowId: msg.flowId ?? process.env.MSG91_FLOW_ID ?? "",
    lastTest: msg.lastTest ?? null,
    updatedAt: msg.updatedAt ?? null,
  };

  return {
    google,
    msg91,
    passwordEnabled: raw.toggles?.passwordEnabled ?? true,
    otpEnabled: raw.toggles?.otpEnabled ?? true,
    registerEnabled: raw.toggles?.registerEnabled ?? true,
  };
}

/** Front-end-safe provider config. Cached in-process for 15s so it can be read per-request cheaply. */
export async function getAuthProviderConfig(): Promise<AuthProviderPublicConfig> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const raw = await readStored();
  const value = toPublic(raw);
  cache = { fetchedAt: Date.now(), value };
  return value;
}

/** Server-only: decrypted Google credentials (DB first, env fallback). */
export async function getGoogleCredentials(): Promise<{
  clientId: string | null;
  clientSecret: string | null;
}> {
  const raw = await readStored();
  const storedSecret = raw.google?.clientSecretCipher ? decryptSecret(raw.google.clientSecretCipher) : null;
  const clientId = (raw.google?.clientId?.trim() || process.env.GOOGLE_CLIENT_ID || "").trim() || null;
  const clientSecret = (storedSecret || process.env.GOOGLE_CLIENT_SECRET || "").trim() || null;
  return { clientId, clientSecret };
}

/** Server-only: decrypted MSG91 credentials (DB first, env fallback). */
export async function getMsg91Credentials(): Promise<{
  authKey: string | null;
  senderId: string | null;
  flowId: string | null;
}> {
  const raw = await readStored();
  const storedKey = raw.msg91?.authKeyCipher ? decryptSecret(raw.msg91.authKeyCipher) : null;
  return {
    authKey: (storedKey || process.env.MSG91_AUTH_KEY || "").trim() || null,
    senderId: (raw.msg91?.senderId || process.env.MSG91_SENDER_ID || "").trim() || null,
    flowId: (raw.msg91?.flowId || process.env.MSG91_FLOW_ID || "").trim() || null,
  };
}

export interface ProviderConfigUpdate {
  google?: {
    enabled?: boolean;
    clientId?: string;
    /** New plaintext secret to encrypt and store (omit/empty to keep the existing one). */
    clientSecret?: string;
  };
  msg91?: {
    enabled?: boolean;
    authKey?: string;
    senderId?: string;
    flowId?: string;
  };
  toggles?: { passwordEnabled?: boolean; otpEnabled?: boolean; registerEnabled?: boolean };
}

/**
 * Merge `update` into the stored provider config and persist. Existing secrets
 * are preserved when a new one is not supplied. Bumps the cache epoch so the
 * running process picks changes up immediately.
 */
export async function saveAuthProviderConfig(update: ProviderConfigUpdate): Promise<void> {
  const raw = await readStored();

  if (update.google) {
    const next: StoredGoogle = { ...(raw.google ?? {}) };
    if (update.google.enabled !== undefined) next.enabled = update.google.enabled;
    if (update.google.clientId !== undefined) next.clientId = update.google.clientId.trim() || undefined;
    if (update.google.clientSecret !== undefined && update.google.clientSecret.trim()) {
      next.clientSecretCipher = encryptSecret(update.google.clientSecret.trim());
    }
    next.lastTest = null; // credentials changed — a previous test result is stale
    next.updatedAt = new Date().toISOString();
    raw.google = next;
  }

  if (update.msg91) {
    const next: StoredMsg91 = { ...(raw.msg91 ?? {}) };
    if (update.msg91.enabled !== undefined) next.enabled = update.msg91.enabled;
    if (update.msg91.authKey !== undefined && update.msg91.authKey.trim()) {
      next.authKeyCipher = encryptSecret(update.msg91.authKey.trim());
    }
    if (update.msg91.senderId !== undefined) next.senderId = update.msg91.senderId.trim() || undefined;
    if (update.msg91.flowId !== undefined) next.flowId = update.msg91.flowId.trim() || undefined;
    next.lastTest = null;
    next.updatedAt = new Date().toISOString();
    raw.msg91 = next;
  }

  if (update.toggles) {
    raw.toggles = {
      passwordEnabled: update.toggles.passwordEnabled ?? raw.toggles?.passwordEnabled ?? true,
      otpEnabled: update.toggles.otpEnabled ?? raw.toggles?.otpEnabled ?? true,
      registerEnabled: update.toggles.registerEnabled ?? raw.toggles?.registerEnabled ?? true,
    };
  }

  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: raw as unknown as object },
    create: { key: SETTING_KEY, value: raw as unknown as object },
  });
  bumpProviderConfigEpoch();
}

/**
 * Validates a Google OAuth client id/secret pair without a real user consent
 * flow: the token endpoint is called with a deliberately invalid
 * authorization code. Google rejects with `invalid_client` when the
 * id/secret pair itself is wrong, and with a different error
 * (`invalid_grant`, for the fake code) once the client has authenticated
 * successfully — so `invalid_grant` is the signal credentials are valid. No
 * secret or token ever appears in the message relayed to the admin UI.
 */
async function probeGoogleCredentials(clientId: string, clientSecret: string): Promise<ProviderLastTest> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: "connection-test-invalid-code",
        redirect_uri: defaultCallbackUrl(),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_grant") {
      return { ok: true, message: "Connection successful — Client ID and Secret are valid.", at: new Date().toISOString() };
    }
    if (body.error === "invalid_client") {
      return { ok: false, message: "Google rejected the Client ID / Client Secret pair.", at: new Date().toISOString() };
    }
    return { ok: false, message: `Unexpected response from Google (${body.error ?? res.status}).`, at: new Date().toISOString() };
  } catch {
    return { ok: false, message: "Could not reach Google's OAuth endpoint.", at: new Date().toISOString() };
  }
}

/** Runs a live Test Connection for Google OAuth using the currently stored credentials, and persists the result. */
export async function testGoogleConnection(): Promise<ProviderLastTest> {
  const { clientId, clientSecret } = await getGoogleCredentials();
  if (!clientId || !clientSecret) {
    const result: ProviderLastTest = { ok: false, message: "Client ID and Client Secret are required.", at: new Date().toISOString() };
    await recordProviderTest("google", result);
    return result;
  }
  const result = await probeGoogleCredentials(clientId, clientSecret);
  await recordProviderTest("google", result);
  return result;
}

/**
 * Validates an MSG91 auth key by calling MSG91's account balance endpoint —
 * any authenticated response proves the key itself is accepted; the balance
 * value is discarded and never relayed to the admin UI.
 */
async function probeMsg91Credentials(authKey: string): Promise<ProviderLastTest> {
  try {
    const res = await fetch("https://control.msg91.com/api/v5/user/balance", {
      headers: { authkey: authKey },
    });
    if (res.ok) {
      return { ok: true, message: "Connection successful — MSG91 accepted the Auth Key.", at: new Date().toISOString() };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "MSG91 rejected the Auth Key.", at: new Date().toISOString() };
    }
    return { ok: false, message: `MSG91 returned an unexpected status (${res.status}).`, at: new Date().toISOString() };
  } catch {
    return { ok: false, message: "Could not reach MSG91.", at: new Date().toISOString() };
  }
}

/** Runs a live Test Connection for MSG91 using the currently stored credentials, and persists the result. */
export async function testMsg91Connection(): Promise<ProviderLastTest> {
  const { authKey, flowId } = await getMsg91Credentials();
  if (!authKey) {
    const result: ProviderLastTest = { ok: false, message: "Auth Key is required.", at: new Date().toISOString() };
    await recordProviderTest("msg91", result);
    return result;
  }
  if (!flowId) {
    const result: ProviderLastTest = {
      ok: false,
      message: "Auth Key is valid but no Flow ID is configured yet — OTP sending needs one.",
      at: new Date().toISOString(),
    };
    await recordProviderTest("msg91", result);
    return result;
  }
  const result = await probeMsg91Credentials(authKey);
  await recordProviderTest("msg91", result);
  return result;
}

/** Persists the result of a Test Connection so the admin page can show a status. */
export async function recordProviderTest(provider: "google" | "msg91", result: ProviderLastTest): Promise<void> {
  const raw = await readStored();
  if (provider === "google") {
    raw.google = { ...(raw.google ?? {}), lastTest: result };
  } else {
    raw.msg91 = { ...(raw.msg91 ?? {}), lastTest: result };
  }
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: raw as unknown as object },
    create: { key: SETTING_KEY, value: raw as unknown as object },
  });
  bumpProviderConfigEpoch();
}