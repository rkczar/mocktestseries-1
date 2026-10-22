import "server-only";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/secret-cipher";

/**
 * The ONE shared Google connection behind SEO Intelligence (Search Console +
 * GA4, read-only scopes). This is the only module that reads the OAuth client
 * secret, the refresh token or an access token.
 *
 * - Its own OAuth client, stored in Setting "seo.google.oauth" (installed with
 *   ops/seo/set-google-oauth.sh). It never reads the student Google login
 *   (Setting "auth.providers" / GOOGLE_CLIENT_*), and that login never reads this.
 * - The client secret and the refresh token are AES-256-GCM encrypted at rest
 *   (lib/secret-cipher.ts). Access tokens live in memory for one sync only.
 * - Authorization code flow with PKCE (S256), a random state and an OIDC nonce,
 *   all kept in a short-lived encrypted, HttpOnly cookie scoped to the callback path.
 * - Requests go only to the fixed Google endpoints below (or, in tests, to a
 *   loopback mock via SEO_GOOGLE_TEST_BASE_URL=http://127.0.0.1:<port>), and every
 *   error text that leaves this module goes through `redact()`.
 */

export const SEO_SITE_URL = "https://mocktestseries.in";
export const GA4_PROPERTY_ID = "553529096";
export const CONNECTION_SETTING_KEY = "seo.google.oauth";
export const CALLBACK_PATH = "/api/admin/seo-intel/google/callback";
export const STATE_COOKIE = "mts-seo-google-oauth";
export const STATE_COOKIE_PATH = "/api/admin/seo-intel/google";
export const STATE_TTL_SECONDS = 600;

const SCOPE_GSC = "https://www.googleapis.com/auth/webmasters.readonly";
const SCOPE_GA4 = "https://www.googleapis.com/auth/analytics.readonly";
export const REQUESTED_SCOPES = ["openid", "email", SCOPE_GSC, SCOPE_GA4];
export const REQUIRED_SCOPES = [SCOPE_GSC, SCOPE_GA4];

const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  searchConsole: "https://searchconsole.googleapis.com/webmasters/v3",
  analyticsData: "https://analyticsdata.googleapis.com/v1beta",
};
const ID_TOKEN_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const TIMEOUT_MS = 15_000;
const MAX_BODY = 1024 * 1024;

export class SeoIntelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoIntelError";
  }
}

// ---- Config --------------------------------------------------------------------------------

/** Google endpoints — a loopback mock server only when SEO_GOOGLE_TEST_BASE_URL is set to one. */
export function googleEndpoints() {
  const raw = process.env.SEO_GOOGLE_TEST_BASE_URL?.trim() ?? "";
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw)) return { ...GOOGLE, testMode: false };
  return {
    auth: `${raw}/o/oauth2/v2/auth`,
    token: `${raw}/token`,
    revoke: `${raw}/revoke`,
    searchConsole: `${raw}/webmasters/v3`,
    analyticsData: `${raw}/v1beta`,
    testMode: true,
  };
}

/** The admin app's own origin (NEXTAUTH_URL in production = https://mocktestseries.in). */
export function appOrigin(): string {
  try {
    return new URL(process.env.NEXTAUTH_URL || process.env.AUTH_URL || SEO_SITE_URL).origin;
  } catch {
    return SEO_SITE_URL;
  }
}

/** Must match the "Authorized redirect URI" on the Google Cloud OAuth client exactly. */
export function redirectUri(): string {
  return `${appOrigin()}${CALLBACK_PATH}`;
}

interface StoredConnection {
  clientId?: string;
  clientSecretCipher?: string;
  credentialsSetAt?: string;
  refreshTokenCipher?: string;
  accountEmail?: string;
  /** Google's stable account id (ID token `sub`) — decides whether a reconnect is the same grant. */
  accountSub?: string;
  grantedScopes?: string[];
  connectedAt?: string;
  connectedById?: string;
  needsReconnect?: boolean;
  needsReconnectReason?: string;
}

async function readStored(): Promise<StoredConnection> {
  const row = await prisma.setting.findUnique({ where: { key: CONNECTION_SETTING_KEY } });
  return ((row?.value as StoredConnection | null) ?? {}) as StoredConnection;
}

async function writeStored(value: StoredConnection) {
  const json = value as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: CONNECTION_SETTING_KEY }, create: { key: CONNECTION_SETTING_KEY, value: json }, update: { value: json } });
}

function clientCredentials(stored: StoredConnection): { clientId: string; clientSecret: string } | null {
  const clientId = stored.clientId?.trim();
  const clientSecret = decryptSecret(stored.clientSecretCipher);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Removes known secrets and anything token-shaped from text that may be shown or stored. */
export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out
    .replace(/("(?:access_token|refresh_token|id_token|client_secret|code|code_verifier)"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    .replace(/\b(access_token|refresh_token|id_token|client_secret|code|code_verifier|token)=[^&\s"']+/gi, "$1=[redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\b1\/\/[A-Za-z0-9._-]{10,}/g, "[redacted]")
    .replace(/\bGOCSPX-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .slice(0, 300);
}

// ---- Status shown to admins (no network, never a secret) -----------------------------------

export interface ConnectionView {
  credentialsConfigured: boolean;
  clientIdHint: string | null;
  credentialsSetAt: string | null;
  connected: boolean;
  accountEmail: string | null;
  grantedScopes: string[];
  connectedAt: string | null;
  connectedByName: string | null;
  needsReconnect: boolean;
  needsReconnectReason: string | null;
  redirectUri: string;
  siteUrl: string;
  ga4PropertyId: string;
  testMode: boolean;
}

export async function getConnectionView(): Promise<ConnectionView> {
  const stored = await readStored();
  const connected = Boolean(stored.refreshTokenCipher);
  const connectedBy =
    connected && stored.connectedById
      ? await prisma.adminUser.findUnique({ where: { id: stored.connectedById }, select: { name: true } })
      : null;
  const clientId = stored.clientId?.trim() || null;
  return {
    credentialsConfigured: Boolean(clientId && stored.clientSecretCipher),
    // A client ID is public (it appears in the consent URL); show only its project-number prefix anyway.
    clientIdHint: clientId ? `${clientId.split("-")[0]}-…` : null,
    credentialsSetAt: stored.credentialsSetAt ?? null,
    connected,
    accountEmail: connected ? stored.accountEmail ?? null : null,
    grantedScopes: connected ? stored.grantedScopes ?? [] : [],
    connectedAt: connected ? stored.connectedAt ?? null : null,
    connectedByName: connectedBy?.name ?? null,
    needsReconnect: connected && Boolean(stored.needsReconnect),
    needsReconnectReason: connected ? stored.needsReconnectReason ?? null : null,
    redirectUri: redirectUri(),
    siteUrl: SEO_SITE_URL,
    ga4PropertyId: GA4_PROPERTY_ID,
    testMode: googleEndpoints().testMode,
  };
}

// ---- Client credentials (ops script only) --------------------------------------------------

export async function setClientCredentials(clientId: string, clientSecret: string) {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!/^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/.test(id)) throw new SeoIntelError("That is not a Google OAuth Web client ID.");
  if (secret.length < 10 || /\s/.test(secret)) throw new SeoIntelError("That is not a Google OAuth client secret.");
  const stored = await readStored();
  // A new client cannot use a refresh token issued to the old one.
  const clientChanged = stored.clientId && stored.clientId !== id;
  await writeStored({
    ...(clientChanged ? {} : stored),
    clientId: id,
    clientSecretCipher: encryptSecret(secret),
    credentialsSetAt: new Date().toISOString(),
  });
  return { clientChanged: Boolean(clientChanged && stored.refreshTokenCipher) };
}

export async function clearAll() {
  await prisma.setting.deleteMany({ where: { key: CONNECTION_SETTING_KEY } });
}

// ---- HTTP ----------------------------------------------------------------------------------

export interface GoogleResponse {
  status: number;
  json: Record<string, unknown> | null;
}

function allowedUrl(url: string): boolean {
  const ep = googleEndpoints();
  return [ep.token, ep.revoke].includes(url) || url.startsWith(`${ep.searchConsole}/`) || url.startsWith(`${ep.analyticsData}/properties/${GA4_PROPERTY_ID}:`);
}

export async function googleFetch(url: string, init: { method: "GET" | "POST"; accessToken?: string; form?: Record<string, string>; json?: unknown }): Promise<GoogleResponse> {
  if (!allowedUrl(url)) throw new SeoIntelError("Blocked request to a non-allow-listed Google endpoint.");
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (init.accessToken) headers.Authorization = `Bearer ${init.accessToken}`;
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method, headers, body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new SeoIntelError(timedOut ? "Google did not answer in time." : "Could not reach Google.");
  }
  const text = await readCapped(res);
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new SeoIntelError("Google's response was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Google's error text for an API/OAuth error body, redacted. */
export function googleErrorText(r: GoogleResponse, secrets: (string | null | undefined)[] = []): string {
  const err = r.json?.error;
  let msg = "";
  if (typeof err === "string") msg = `${err}${typeof r.json?.error_description === "string" ? `: ${r.json.error_description}` : ""}`;
  else if (err && typeof err === "object") {
    const e = err as { status?: unknown; message?: unknown };
    msg = [typeof e.status === "string" ? e.status : "", typeof e.message === "string" ? e.message : ""].filter(Boolean).join(": ");
  }
  return redact(`HTTP ${r.status}${msg ? ` — ${msg}` : ""}`, secrets);
}

// ---- OAuth: start ---------------------------------------------------------------------------

interface StatePayload {
  s: string; // state
  v: string; // PKCE code_verifier
  n: string; // OIDC nonce
  a: string; // admin id that started the flow
  e: number; // expiry, ms
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** Builds the Google consent URL plus the encrypted state cookie value. MASTER_ADMIN check is the caller's job. */
export async function beginAuthorization(adminId: string): Promise<{ url: string; cookieValue: string; secureCookie: boolean }> {
  const creds = clientCredentials(await readStored());
  if (!creds) throw new SeoIntelError("The SEO Google OAuth client is not installed yet (ops/seo/set-google-oauth.sh).");
  const payload: StatePayload = {
    s: b64url(crypto.randomBytes(32)),
    v: b64url(crypto.randomBytes(48)),
    n: b64url(crypto.randomBytes(16)),
    a: adminId,
    e: Date.now() + STATE_TTL_SECONDS * 1000,
  };
  const url = new URL(googleEndpoints().auth);
  url.search = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: REQUESTED_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: payload.s,
    nonce: payload.n,
    code_challenge: b64url(crypto.createHash("sha256").update(payload.v).digest()),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), cookieValue: encryptSecret(JSON.stringify(payload)), secureCookie: appOrigin().startsWith("https://") };
}

// ---- OAuth: callback ------------------------------------------------------------------------

export type CallbackFailure =
  | "state"
  | "expired"
  | "other-admin"
  | "denied"
  | "bad-request"
  | "not-configured"
  | "exchange"
  | "no-refresh-token"
  | "missing-scopes"
  | "id-token";

export type CallbackResult = { ok: true; email: string; scopes: string[] } | { ok: false; reason: CallbackFailure; detail?: string };

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readState(cookieValue: string | undefined): StatePayload | null {
  const raw = decryptSecret(cookieValue);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StatePayload;
    return typeof p.s === "string" && typeof p.v === "string" && typeof p.n === "string" && typeof p.a === "string" && typeof p.e === "number" ? p : null;
  } catch {
    return null;
  }
}

function decodeIdToken(idToken: string): Record<string, unknown> | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

/**
 * Finishes the code flow for the signed-in MASTER_ADMIN `adminId`. Validates
 * state/expiry/initiator first, then exchanges the code (with the PKCE
 * verifier) and stores only the encrypted refresh token + account identity.
 * The live connection is never revoked before its replacement is stored, and
 * never at all when the replacement is the same Google account (same grant).
 */
export async function completeAuthorization(input: {
  adminId: string;
  cookieValue: string | undefined;
  state: string | null;
  code: string | null;
  error: string | null;
}): Promise<CallbackResult> {
  const saved = readState(input.cookieValue);
  if (!saved || !input.state || !safeEqual(saved.s, input.state)) return { ok: false, reason: "state" };
  if (Date.now() > saved.e) return { ok: false, reason: "expired" };
  if (saved.a !== input.adminId) return { ok: false, reason: "other-admin" };
  if (input.error) return { ok: false, reason: "denied", detail: redact(input.error).slice(0, 60) };
  if (!input.code || !/^[A-Za-z0-9._~/-]{10,1024}$/.test(input.code)) return { ok: false, reason: "bad-request" };

  const stored = await readStored();
  const creds = clientCredentials(stored);
  if (!creds) return { ok: false, reason: "not-configured" };
  const secrets = [creds.clientSecret, input.code, saved.v];

  let r: GoogleResponse;
  try {
    r = await googleFetch(googleEndpoints().token, {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: saved.v,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri(),
      },
    });
  } catch (err) {
    return { ok: false, reason: "exchange", detail: err instanceof SeoIntelError ? err.message : "Token exchange failed." };
  }
  const tok = r.json ?? {};
  const refreshToken = typeof tok.refresh_token === "string" ? tok.refresh_token : null;
  const accessToken = typeof tok.access_token === "string" ? tok.access_token : null;
  const allSecrets = [...secrets, refreshToken, accessToken, typeof tok.id_token === "string" ? tok.id_token : null];
  if (r.status !== 200 || !accessToken) return { ok: false, reason: "exchange", detail: googleErrorText(r, allSecrets) };

  // 1. Who granted this? Checked before anything is kept or revoked.
  const identity = typeof tok.id_token === "string" ? verifiedIdentity(tok.id_token, creds.clientId, saved.n) : null;
  const scopes = typeof tok.scope === "string" ? tok.scope.split(/\s+/).filter(Boolean) : [];
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));

  // 2. Anything unusable is discarded — without ever touching the live connection's grant.
  const failure: { reason: CallbackFailure; detail?: string } | null = !identity
    ? { reason: "id-token" }
    : missing.length
      ? { reason: "missing-scopes", detail: missing.map((s) => s.split("/").pop()).join(", ") }
      : !refreshToken
        ? { reason: "no-refresh-token" }
        : null;
  if (failure) {
    await discardUnusedTokens(refreshToken ?? accessToken, identity);
    return { ok: false, ...failure };
  }

  // 3. Persist the replacement first (re-read just before writing: one shared connection) …
  const previous = await readStored();
  const oldRefresh = decryptSecret(previous.refreshTokenCipher);
  await writeStored({
    ...previous,
    refreshTokenCipher: encryptSecret(refreshToken!),
    accountEmail: identity!.email,
    accountSub: identity!.sub,
    grantedScopes: scopes,
    connectedAt: new Date().toISOString(),
    connectedById: input.adminId,
    needsReconnect: false,
    needsReconnectReason: undefined,
  });
  // 4. … and only then end the old grant — and only when it belongs to a DIFFERENT
  // Google account. Same account = same grant: revoking the old token would also
  // kill the one just stored, so it is simply left to expire unused.
  if (oldRefresh && previous.refreshTokenCipher && !sameAccount(previous, identity!)) await revokeToken(oldRefresh);
  return { ok: true, email: identity!.email, scopes };
}

interface GoogleIdentity {
  sub: string;
  email: string;
}

/**
 * The account behind an ID token, or null if its claims don't check out. The
 * token came straight from Google's token endpoint over TLS (OIDC Core
 * 3.1.3.7), so its claims are checked rather than its signature.
 */
function verifiedIdentity(idToken: string, clientId: string, nonce: string): GoogleIdentity | null {
  const claims = decodeIdToken(idToken);
  if (!claims) return null;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  const sub = typeof claims.sub === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(claims.sub) ? claims.sub : null;
  const ok =
    ID_TOKEN_ISSUERS.has(String(claims.iss)) &&
    claims.aud === clientId &&
    claims.nonce === nonce &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > Date.now() - 60_000 &&
    claims.email_verified === true &&
    sub &&
    email &&
    /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email);
  return ok ? { sub: sub!, email: email! } : null;
}

/** Same Google account as the stored connection (by stable `sub`; email only for a connection stored without one). */
function sameAccount(stored: StoredConnection, identity: GoogleIdentity): boolean {
  return stored.accountSub ? stored.accountSub === identity.sub : stored.accountEmail === identity.email;
}

/**
 * Google revokes the user's WHOLE grant for this Cloud project when any one of
 * its tokens is revoked — every refresh token of that account, including the
 * one the live connection uses. So a token we won't keep is revoked only when
 * there is no live connection, or when it provably belongs to a different
 * account. Same or unverifiable account: left alone (it expires unused; the
 * owner can remove it at myaccount.google.com/permissions).
 */
async function discardUnusedTokens(token: string | null, identity: GoogleIdentity | null): Promise<void> {
  const live = await readStored();
  if (!live.refreshTokenCipher || (identity && !sameAccount(live, identity))) await revokeToken(token);
}

// ---- Disconnect / access token --------------------------------------------------------------

async function revokeToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const r = await googleFetch(googleEndpoints().revoke, { method: "POST", form: { token } });
    return r.status === 200;
  } catch {
    return false;
  }
}

/** Removes the stored refresh token (keeps the client credentials) and revokes it at Google, best effort. */
export async function disconnect(): Promise<{ wasConnected: boolean; revoked: boolean; accountEmail: string | null }> {
  const stored = await readStored();
  const refresh = decryptSecret(stored.refreshTokenCipher);
  await writeStored({
    clientId: stored.clientId,
    clientSecretCipher: stored.clientSecretCipher,
    credentialsSetAt: stored.credentialsSetAt,
  });
  const revoked = await revokeToken(refresh);
  return { wasConnected: Boolean(stored.refreshTokenCipher), revoked, accountEmail: stored.accountEmail ?? null };
}

/**
 * A fresh access token for one sync. The token (and the secrets the caller
 * must redact with) never leave the server. Marks the connection
 * "needs reconnect" when Google says the grant is gone.
 */
export async function getAccessToken(): Promise<{ accessToken: string; secrets: string[] }> {
  const stored = await readStored();
  const creds = clientCredentials(stored);
  if (!creds) throw new SeoIntelError("The SEO Google OAuth client is not installed.");
  const refresh = decryptSecret(stored.refreshTokenCipher);
  if (!refresh) throw new SeoIntelError("Google is not connected.");
  const secrets = [creds.clientSecret, refresh];
  const r = await googleFetch(googleEndpoints().token, {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: refresh, client_id: creds.clientId, client_secret: creds.clientSecret },
  });
  const accessToken = typeof r.json?.access_token === "string" ? r.json.access_token : null;
  if (r.status === 200 && accessToken) return { accessToken, secrets: [...secrets, accessToken] };

  const message = googleErrorText(r, [...secrets, accessToken]);
  if (r.json?.error === "invalid_grant" || r.json?.error === "unauthorized_client") {
    // Only flag the connection that failed — not one an admin replaced meanwhile.
    const now = await readStored();
    if (now.refreshTokenCipher === stored.refreshTokenCipher) {
      await writeStored({ ...now, needsReconnect: true, needsReconnectReason: message });
    }
    throw new SeoIntelError("Google rejected the saved connection. A Master Admin must reconnect Google.");
  }
  throw new SeoIntelError(`Could not refresh the Google access token (${message}).`);
}
