import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * Read-only connection to the Instagram API with Instagram Login
 * (graph.instagram.com). This is the ONLY module that reads the access token.
 *
 * - The token comes from the server environment (shared .env, installed with
 *   ops/instagram/set-instagram-token.sh) — never from the DB, never from the
 *   browser, never in source.
 * - It is sent in the Authorization header only (never in a URL), and every
 *   error text that leaves this module goes through `redact()`.
 * - Only GET requests to an allow-list of read endpoints are possible here.
 *   Nothing in this module can publish, schedule or delete; publishing stays
 *   off in code (INSTAGRAM_PUBLISHING_AVAILABLE in lib/instagram/types.ts).
 *
 * Environment:
 *   INSTAGRAM_ACCESS_TOKEN   secret — Instagram User access token (long-lived, ~60 days)
 *   INSTAGRAM_USER_ID        the numeric Instagram professional account ID the token must belong to
 *   INSTAGRAM_TOKEN_SET_AT   ISO date the token was installed (written by the install script)
 *   INSTAGRAM_APP_SECRET     optional secret — adds appsecret_proof when "Require App Secret" is on
 *   INSTAGRAM_GRAPH_API_VERSION  optional, default v25.0
 *   INSTAGRAM_GRAPH_API_BASE optional, testing only — accepted only for http://127.0.0.1:<port>
 */

export const EXPECTED_INSTAGRAM_USERNAME = "mocktestseries.in";
export const TOKEN_LIFETIME_DAYS = 60;
export const TOKEN_WARN_DAYS = 14;
export const CONNECTION_SETTING_KEY = "instagram.connection";

const GRAPH_BASE = "https://graph.instagram.com";
const DEFAULT_VERSION = "v25.0";
const TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;
const PROFESSIONAL_TYPES = new Set(["BUSINESS", "MEDIA_CREATOR", "CREATOR"]);
/** The only requests this module can make (all GET). */
const ALLOWED_PATH = /^\/v\d{1,3}\.\d\/(me|\d{5,25}\/content_publishing_limit)$/;

// ---- Config --------------------------------------------------------------------------------

interface MetaConfig {
  token: string | null;
  userId: string | null;
  appSecret: string | null;
  tokenSetAt: Date | null;
  base: string;
  version: string;
  warnings: string[];
}

function env(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

function readConfig(): MetaConfig {
  const warnings: string[] = [];
  const rawUserId = env("INSTAGRAM_USER_ID");
  const userId = rawUserId && /^\d{5,25}$/.test(rawUserId) ? rawUserId : null;
  if (rawUserId && !userId) warnings.push("INSTAGRAM_USER_ID is not a numeric ID and is ignored.");

  const rawSetAt = env("INSTAGRAM_TOKEN_SET_AT");
  const setAt = rawSetAt ? new Date(rawSetAt) : null;
  const tokenSetAt = setAt && !Number.isNaN(setAt.getTime()) ? setAt : null;
  if (rawSetAt && !tokenSetAt) warnings.push("INSTAGRAM_TOKEN_SET_AT is not a valid date and is ignored.");

  const rawVersion = env("INSTAGRAM_GRAPH_API_VERSION");
  const version = rawVersion && /^v\d{1,3}\.\d$/.test(rawVersion) ? rawVersion : DEFAULT_VERSION;
  if (rawVersion && version !== rawVersion) warnings.push(`INSTAGRAM_GRAPH_API_VERSION is invalid; using ${DEFAULT_VERSION}.`);

  // The token may only ever be sent to Meta, or to a loopback mock server in tests.
  const rawBase = env("INSTAGRAM_GRAPH_API_BASE");
  const base = rawBase && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(rawBase) ? rawBase : GRAPH_BASE;
  if (rawBase && base !== rawBase) warnings.push("INSTAGRAM_GRAPH_API_BASE is not allowed and is ignored.");
  if (base !== GRAPH_BASE) warnings.push(`Test mode: requests go to a local mock server (${base}), not Meta.`);

  return { token: env("INSTAGRAM_ACCESS_TOKEN"), userId, appSecret: env("INSTAGRAM_APP_SECRET"), tokenSetAt, base, version, warnings };
}

/** Short one-way fingerprint so admins can tell which token is installed without seeing it. */
function fingerprint(token: string | null): string | null {
  return token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 8) : null;
}

/** Removes the token, the app secret and anything token-shaped from text that may be shown or stored. */
function redact(text: string, cfg: Pick<MetaConfig, "token" | "appSecret">): string {
  let out = text;
  for (const s of [cfg.token, cfg.appSecret]) if (s) out = out.split(s).join("[redacted]");
  return out
    .replace(/access_token=[^&\s"']+/gi, "access_token=[redacted]")
    .replace(/appsecret_proof=[^&\s"']+/gi, "appsecret_proof=[redacted]")
    .replace(/\b(IG[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9_-]{20,})/g, "[redacted]")
    .slice(0, 300);
}

// ---- Status shown on the Settings page (no network) ---------------------------------------

export type TokenExpiryState = "unknown" | "ok" | "soon" | "expired";

export interface ConnectionConfigView {
  tokenConfigured: boolean;
  tokenFingerprint: string | null;
  userIdConfigured: string | null;
  appSecretConfigured: boolean;
  tokenSetAt: string | null;
  expiry: { state: TokenExpiryState; estimatedExpiresAt: string | null; daysLeft: number | null };
  apiVersion: string;
  expectedUsername: string;
  warnings: string[];
}

export function tokenExpiry(setAt: Date | null, now = new Date()): ConnectionConfigView["expiry"] {
  if (!setAt) return { state: "unknown", estimatedExpiresAt: null, daysLeft: null };
  const expires = new Date(setAt.getTime() + TOKEN_LIFETIME_DAYS * 86_400_000);
  const daysLeft = Math.floor((expires.getTime() - now.getTime()) / 86_400_000);
  const state: TokenExpiryState = expires <= now ? "expired" : daysLeft < TOKEN_WARN_DAYS ? "soon" : "ok";
  return { state, estimatedExpiresAt: expires.toISOString(), daysLeft: Math.max(daysLeft, 0) };
}

export function getConnectionConfigView(): ConnectionConfigView {
  const cfg = readConfig();
  return {
    tokenConfigured: !!cfg.token,
    tokenFingerprint: fingerprint(cfg.token),
    userIdConfigured: cfg.userId,
    appSecretConfigured: !!cfg.appSecret,
    tokenSetAt: cfg.tokenSetAt?.toISOString() ?? null,
    expiry: tokenExpiry(cfg.tokenSetAt),
    apiVersion: cfg.version,
    expectedUsername: EXPECTED_INSTAGRAM_USERNAME,
    warnings: cfg.warnings,
  };
}

// ---- Read-only connection test -------------------------------------------------------------

export type ConnectionStatus =
  | "CONNECTED"
  | "CONNECTED_NO_PUBLISH_PERMISSION"
  | "NOT_CONFIGURED"
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  | "WRONG_ACCOUNT"
  | "NOT_PROFESSIONAL"
  | "PERMISSION_MISSING"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "API_ERROR";

export type CheckState = "pass" | "fail" | "warn" | "skip";
export type PublishPermission = "GRANTED" | "MISSING" | "UNKNOWN";

export interface ConnectionCheck {
  key: "config" | "token" | "username" | "userId" | "accountType" | "publishPermission";
  label: string;
  state: CheckState;
  detail: string;
}

export interface ConnectionTestResult {
  testedAt: string;
  durationMs: number;
  status: ConnectionStatus;
  ok: boolean;
  summary: string;
  account: { username: string; userId: string; accountType: string | null; name: string | null; mediaCount: number | null } | null;
  publishPermission: PublishPermission;
  publishingQuota: { usage: number; total: number | null; durationSeconds: number | null } | null;
  tokenFingerprint: string | null;
  apiVersion: string;
  checks: ConnectionCheck[];
  /** Sanitized Meta error of the failing call, if any. */
  error: { code: number | null; subcode: number | null; message: string } | null;
}

type GraphOk = { ok: true; body: Record<string, unknown> };
type GraphFail = { ok: false; kind: "timeout" | "network" | "http"; httpStatus: number | null; code: number | null; subcode: number | null; message: string };

async function graphGet(cfg: MetaConfig, path: string, fields: string): Promise<GraphOk | GraphFail> {
  if (!ALLOWED_PATH.test(path)) throw new Error("Instagram request not allowed.");
  const url = new URL(cfg.base + path);
  url.searchParams.set("fields", fields);
  if (cfg.appSecret && cfg.token) url.searchParams.set("appsecret_proof", crypto.createHmac("sha256", cfg.appSecret).update(cfg.token).digest("hex"));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { ok: false, kind: timeout ? "timeout" : "network", httpStatus: null, code: null, subcode: null, message: timeout ? `No answer from Instagram within ${TIMEOUT_MS / 1000} s.` : "Could not reach Instagram (network error)." };
  }
  let text = "";
  try {
    text = (await res.text()).slice(0, MAX_BODY);
  } catch {
    return { ok: false, kind: "network", httpStatus: res.status, code: null, subcode: null, message: "Instagram's answer could not be read." };
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {}
  const err = body?.error as { code?: unknown; error_subcode?: unknown; message?: unknown } | undefined;
  if (!res.ok || err || !body) {
    return {
      ok: false,
      kind: "http",
      httpStatus: res.status,
      code: typeof err?.code === "number" ? err.code : null,
      subcode: typeof err?.error_subcode === "number" ? err.error_subcode : null,
      message: redact(typeof err?.message === "string" ? err.message : `Unexpected answer from Instagram (HTTP ${res.status}).`, cfg),
    };
  }
  return { ok: true, body };
}

const isPermissionError = (f: GraphFail) => f.code === 10 || (f.code !== null && f.code >= 200 && f.code <= 299);
const isRateLimit = (f: GraphFail) => f.code === 4 || f.code === 17 || f.code === 32 || f.code === 613;
const isTokenError = (f: GraphFail) => f.code === 190 || f.code === 102;
const isExpired = (f: GraphFail) => isTokenError(f) && (f.subcode === 463 || /expired/i.test(f.message));

function classifyFailure(f: GraphFail): { status: ConnectionStatus; summary: string } {
  if (f.kind === "timeout") return { status: "TIMEOUT", summary: "Instagram did not answer in time. Try again in a minute." };
  if (f.kind === "network") return { status: "NETWORK_ERROR", summary: "The server could not reach Instagram." };
  if (isExpired(f)) return { status: "TOKEN_EXPIRED", summary: "The access token has expired. Generate a new token and install it with the install script." };
  if (isTokenError(f)) return { status: "TOKEN_INVALID", summary: "Instagram rejected the access token (invalid or revoked). Install a new token." };
  if (isPermissionError(f)) return { status: "PERMISSION_MISSING", summary: "The token lacks the instagram_business_basic permission, so the account can't be read." };
  if (isRateLimit(f)) return { status: "RATE_LIMITED", summary: "Instagram's API rate limit was reached. Try again later." };
  return { status: "API_ERROR", summary: "Instagram returned an unexpected error." };
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Runs the read-only connection test: GET /me (identity) and
 * GET /<user_id>/content_publishing_limit (only readable when the token has
 * instagram_business_content_publish — so it proves the permission without
 * publishing anything). Never throws for API problems; returns a result.
 */
export async function runConnectionTest(): Promise<ConnectionTestResult> {
  const started = Date.now();
  const cfg = readConfig();
  const checks: ConnectionCheck[] = [];
  const result = (r: Pick<ConnectionTestResult, "status" | "summary"> & Partial<ConnectionTestResult>): ConnectionTestResult => ({
    testedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    ok: r.status === "CONNECTED" || r.status === "CONNECTED_NO_PUBLISH_PERMISSION",
    account: null,
    publishPermission: "UNKNOWN",
    publishingQuota: null,
    tokenFingerprint: fingerprint(cfg.token),
    apiVersion: cfg.version,
    checks,
    error: null,
    ...r,
  });
  const skipRest = (from: ConnectionCheck["key"][]) => {
    const labels: Record<string, string> = { username: "Username", userId: "Instagram User ID", accountType: "Account type", publishPermission: "Publishing permission" };
    for (const key of from) checks.push({ key, label: labels[key], state: "skip", detail: "Not checked." });
  };

  if (!cfg.token) {
    checks.push({ key: "config", label: "Token configured", state: "fail", detail: "INSTAGRAM_ACCESS_TOKEN is not set on the server." });
    skipRest(["username", "userId", "accountType", "publishPermission"]);
    return result({ status: "NOT_CONFIGURED", summary: "No access token is installed on the server." });
  }
  checks.push({ key: "config", label: "Token configured", state: "pass", detail: `Yes (fingerprint ${fingerprint(cfg.token)}).` });

  // 1. Identity + token validity.
  const me = await graphGet(cfg, `/${cfg.version}/me`, "user_id,username,account_type,name,media_count");
  if (!me.ok) {
    const c = classifyFailure(me);
    checks.push({ key: "token", label: "Token valid", state: "fail", detail: me.message });
    skipRest(["username", "userId", "accountType", "publishPermission"]);
    return result({ ...c, error: { code: me.code, subcode: me.subcode, message: me.message } });
  }
  const username = str(me.body.username)?.toLowerCase() ?? "";
  const userId = str(me.body.user_id) ?? "";
  const accountType = str(me.body.account_type)?.toUpperCase() ?? null;
  const account = { username, userId, accountType, name: str(me.body.name), mediaCount: num(me.body.media_count) };
  checks.push({ key: "token", label: "Token valid", state: "pass", detail: "Instagram accepted the token." });

  if (!username || !/^\d{5,25}$/.test(userId)) {
    skipRest(["username", "userId", "accountType", "publishPermission"]);
    return result({ status: "API_ERROR", summary: "Instagram's answer had no username or numeric user ID.", account: null });
  }

  // 2. Is it the right account?
  const usernameOk = username === EXPECTED_INSTAGRAM_USERNAME;
  checks.push({ key: "username", label: "Username", state: usernameOk ? "pass" : "fail", detail: usernameOk ? `@${username}` : `Token belongs to @${username}, expected @${EXPECTED_INSTAGRAM_USERNAME}.` });
  let idState: CheckState = "pass";
  let idDetail = `${userId} matches INSTAGRAM_USER_ID.`;
  if (!cfg.userId) {
    idState = "warn";
    idDetail = `${userId} (retrieved). INSTAGRAM_USER_ID is not set — pin this ID with the install script.`;
  } else if (cfg.userId !== userId) {
    idState = "fail";
    idDetail = `Token belongs to ${userId}, but INSTAGRAM_USER_ID is ${cfg.userId}.`;
  }
  checks.push({ key: "userId", label: "Instagram User ID", state: idState, detail: idDetail });
  if (!usernameOk || idState === "fail") {
    skipRest(["accountType", "publishPermission"]);
    return result({ status: "WRONG_ACCOUNT", summary: "The token belongs to a different Instagram account. Nothing else was checked.", account });
  }

  const professional = !!accountType && PROFESSIONAL_TYPES.has(accountType);
  checks.push({ key: "accountType", label: "Account type", state: professional ? "pass" : "fail", detail: accountType ? (professional ? accountType : `${accountType} — publishing needs a Business or Creator account.`) : "Not returned." });
  if (!professional) {
    skipRest(["publishPermission"]);
    return result({ status: "NOT_PROFESSIONAL", summary: "The account is not a Business/Creator (professional) account.", account });
  }

  // 3. Publishing permission — verified by a read, never assumed.
  const limit = await graphGet(cfg, `/${cfg.version}/${userId}/content_publishing_limit`, "quota_usage,config");
  if (limit.ok) {
    const row = (Array.isArray(limit.body.data) ? limit.body.data[0] : null) as { quota_usage?: unknown; config?: { quota_total?: unknown; quota_duration?: unknown } } | null;
    const quota = { usage: num(row?.quota_usage) ?? 0, total: num(row?.config?.quota_total), durationSeconds: num(row?.config?.quota_duration) };
    checks.push({ key: "publishPermission", label: "Publishing permission", state: "pass", detail: `instagram_business_content_publish granted (quota ${quota.usage}/${quota.total ?? "?"} per 24 h). Publishing stays OFF in the app.` });
    return result({ status: "CONNECTED", summary: "Connected to @" + username + ". Publishing permission is granted; publishing stays turned off in the app.", account, publishPermission: "GRANTED", publishingQuota: quota });
  }
  if (limit.kind === "http" && isPermissionError(limit)) {
    checks.push({ key: "publishPermission", label: "Publishing permission", state: "warn", detail: `Missing: instagram_business_content_publish is not granted to this token. (${limit.message})` });
    return result({ status: "CONNECTED_NO_PUBLISH_PERMISSION", summary: `Connected to @${username}, but the token does NOT have publishing permission (instagram_business_content_publish).`, account, publishPermission: "MISSING", error: { code: limit.code, subcode: limit.subcode, message: limit.message } });
  }
  const c = classifyFailure(limit);
  checks.push({ key: "publishPermission", label: "Publishing permission", state: "warn", detail: `Could not be verified: ${limit.message}` });
  return result({ status: "CONNECTED", summary: `Connected to @${username}. Publishing permission could not be verified (${c.status.toLowerCase().replace(/_/g, " ")}).`, account, publishPermission: "UNKNOWN", error: { code: limit.code, subcode: limit.subcode, message: limit.message } });
}

// ---- Last result (Setting `instagram.connection`; contains no secrets) ---------------------

export async function getLastConnectionResult(): Promise<ConnectionTestResult | null> {
  const row = await prisma.setting.findUnique({ where: { key: CONNECTION_SETTING_KEY } });
  const v = row?.value as { last?: ConnectionTestResult } | null | undefined;
  return v?.last ?? null;
}

export async function saveConnectionResult(last: ConnectionTestResult, testedById: string): Promise<void> {
  const value = { last: { ...last, testedById } } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: CONNECTION_SETTING_KEY }, update: { value }, create: { key: CONNECTION_SETTING_KEY, value } });
}
