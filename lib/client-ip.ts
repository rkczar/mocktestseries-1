import { isIP } from "node:net";
import { headers } from "next/headers";

/**
 * The one client-IP resolver for every security rate limit (admin/student
 * login, OTP send/verify, password reset, contact forms).
 *
 * Trust boundary: nginx is the only public entry point (Next listens on
 * 127.0.0.1:3002). nginx OVERWRITES `X-Real-IP` and `X-Forwarded-For` with
 * `$remote_addr` (the TCP peer it actually accepted), so neither header can
 * carry a browser-chosen value by the time it reaches the app. Never read the
 * FIRST X-Forwarded-For entry — behind an appending proxy that is exactly the
 * part the client controls.
 *
 * Without nginx (local dev) there is no trusted header; the LAST
 * X-Forwarded-For hop (the one added nearest to us) is used, else "unknown".
 */
export const UNKNOWN_IP = "unknown";

function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]")); // [v6]:port
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip); // IPv4-mapped IPv6
  if (mapped) ip = mapped[1];
  return isIP(ip) ? ip.toLowerCase() : null;
}

export function clientIpFromHeaders(h: { get(name: string): string | null }): string {
  const real = normalizeIp(h.get("x-real-ip"));
  if (real) return real;
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const nearest = normalizeIp(xff.split(",").pop());
    if (nearest) return nearest;
  }
  return UNKNOWN_IP;
}

/** For Server Actions / Server Components / callbacks without a Request object. */
export async function getClientIp(): Promise<string> {
  try {
    return clientIpFromHeaders(await headers());
  } catch {
    return UNKNOWN_IP;
  }
}
