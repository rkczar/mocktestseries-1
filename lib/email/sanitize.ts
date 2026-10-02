import "server-only";
import sanitizeHtml from "sanitize-html";

/**
 * Server-side sanitizer for admin-authored email bodies (Compose, Templates,
 * Campaigns). The browser's rich-text editor is a convenience only — every
 * body is re-sanitized here before it is stored and again before it is sent.
 * Allows simple formatting, lists, links and headings; drops scripts,
 * styles, iframes, event handlers, forms and any non-http(s)/mailto URL.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "hr", "span", "div"],
  // target/rel are set by transformTags below, never taken from input.
  allowedAttributes: { a: ["href", "title", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
  },
};

export const MAX_BODY_HTML_LENGTH = 50_000;

/** Callers reject results longer than MAX_BODY_HTML_LENGTH (never truncated mid-tag). */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(String(html ?? "").slice(0, MAX_BODY_HTML_LENGTH * 4), OPTIONS).trim();
}

/** Plain text from sanitized HTML, for the text/plain part. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h2|h3|h4|li|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, text: string) => (text && text !== href ? `${text} (${href})` : href));
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * CTA / link URL check: absolute https (or http) URL, or a site-relative path
 * that gets resolved against the site origin. Returns null for anything else
 * (javascript:, data:, protocol-relative, garbage).
 */
export function normalizeEmailUrl(raw: string | null | undefined, siteUrl: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return `${siteUrl}${value}`;
  if (/^\{\{\s*\w+\s*\}\}$/.test(value)) return value; // a whole-URL variable such as {{loginUrl}}, resolved at render time
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
