/**
 * Accepts only a public Telegram channel/group link: https on t.me /
 * telegram.me / telegram.dog, a path, no credentials, no custom port.
 * Anything else (javascript:, data:, http:, tg:, look-alike hosts) is refused.
 * Returns the normalized URL, or null. Pure — usable on client and server.
 */
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog", "www.t.me", "www.telegram.me"]);
export const TELEGRAM_URL_MAX = 200;

export function safeTelegramUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > TELEGRAM_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!/^\/[A-Za-z0-9_+\-/]{2,}$/.test(url.pathname)) return null;
  return url.toString();
}
