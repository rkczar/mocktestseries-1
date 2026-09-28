/**
 * Student device identity cookie — Edge- and Node-safe (Web Crypto only), so
 * the same code mints the cookie in middleware and verifies it in the
 * Node-runtime auth callbacks.
 *
 * A device is a browser profile holding a random 128-bit id in the
 * first-party, httpOnly `mts-device` cookie, HMAC-signed so a tampered or
 * made-up value is rejected. The server only ever stores SHA-256(id)
 * (StudentDevice.deviceHash), never the id itself. No fingerprinting: IP
 * and User-Agent are supporting signals only and never decide identity, so
 * an IP change (Wi-Fi <-> mobile data, VPN, hostel network) or a browser
 * update never consumes a device slot, and every tab of a browser shares
 * the one cookie. Clearing site data or a private window is a new device —
 * there is no reliable, non-invasive way to tell it apart.
 *
 * Signing key: DEVICE_ID_SECRET, else AUTH_SECRET. Rotating that key makes
 * every existing cookie invalid (each browser becomes a new device), so
 * keep DEVICE_ID_SECRET stable if AUTH_SECRET is ever rotated.
 */

export const DEVICE_COOKIE_NAME = "mts-device";
/** ~400 days: the maximum lifetime Chromium honours for a cookie. */
export const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const VERSION = "v1";
const encoder = new TextEncoder();

function secret(): string {
  const value = process.env.DEVICE_ID_SECRET || process.env.AUTH_SECRET;
  if (!value) throw new Error("DEVICE_ID_SECRET or AUTH_SECRET must be set");
  return value;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(id: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`mts-device.${VERSION}.${id}`));
  return toBase64Url(mac);
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A fresh signed cookie value for a new browser. */
export async function mintDeviceCookieValue(): Promise<string> {
  const id = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return `${VERSION}.${id}.${await sign(id)}`;
}

/** The raw device id when the cookie value is well-formed and correctly signed, else null. */
export async function verifyDeviceCookieValue(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !/^[0-9a-f]{32}$/.test(parts[1])) return null;
  const expected = await sign(parts[1]);
  return safeEqual(expected, parts[2]) ? parts[1] : null;
}

/** What StudentDevice.deviceHash stores for a device id. */
export async function hashDeviceId(id: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(`device:${id}`)));
}

/** SHA-256 of an opaque token (session secret) — only the hash is stored. */
export async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

/** A random opaque token (hex), e.g. the per-session secret carried in the JWT. */
export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export const deviceCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: DEVICE_COOKIE_MAX_AGE,
};
