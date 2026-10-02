import "server-only";
import { escapeHtml, htmlToText } from "@/lib/email/sanitize";
import { SUPPORT_EMAIL } from "@/lib/email/config";

/**
 * The one MockTestSeries email layout: a 600px single-column table, inline
 * styles only (email clients ignore <style> unevenly), no images, readable
 * on a phone. Header "MockTestSeries", optional heading, the sanitized body,
 * an optional CTA button, then a footer with the website, support address
 * and — for promotional mail — the unsubscribe / preferences link.
 */

export interface LayoutInput {
  /** Already-escaped heading HTML (from renderContent). */
  heading: string;
  /** Sanitized, variable-rendered body HTML. */
  bodyHtml: string;
  ctaText: string | null;
  ctaUrl: string | null;
  siteUrl: string;
  /** Present for promotional mail (and shown as "Email preferences" otherwise). */
  preferencesUrl: string | null;
  promotional: boolean;
  /** Hidden inbox preview line. */
  preheader?: string;
}

const COLORS = {
  page: "#f4f5f7",
  card: "#ffffff",
  text: "#1f2937",
  muted: "#6b7280",
  border: "#e5e7eb",
  brand: "#1d4ed8",
};

export function renderEmailLayout(input: LayoutInput): { html: string; text: string } {
  const host = input.siteUrl.replace(/^https?:\/\//, "");
  const cta =
    input.ctaText && input.ctaUrl
      ? `<tr><td style="padding:8px 32px 24px 32px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:6px;background:${COLORS.brand};">
<a href="${escapeHtml(input.ctaUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(input.ctaText)}</a>
</td></tr></table></td></tr>`
      : "";
  const heading = input.heading
    ? `<tr><td style="padding:28px 32px 4px 32px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:30px;font-weight:bold;color:${COLORS.text};">${input.heading}</td></tr>`
    : "";
  const footerLinks = [
    `<a href="${escapeHtml(input.siteUrl)}" style="color:${COLORS.muted};">${escapeHtml(host)}</a>`,
    `<a href="mailto:${SUPPORT_EMAIL}" style="color:${COLORS.muted};">${SUPPORT_EMAIL}</a>`,
  ].join(" &middot; ");
  const preferences = input.preferencesUrl
    ? input.promotional
      ? `<p style="margin:8px 0 0 0;">You are receiving this because you have a MockTestSeries account. <a href="${escapeHtml(input.preferencesUrl)}" style="color:${COLORS.muted};">Unsubscribe or manage email preferences</a>.</p>`
      : `<p style="margin:8px 0 0 0;">This is a service email about your MockTestSeries account. <a href="${escapeHtml(input.preferencesUrl)}" style="color:${COLORS.muted};">Email preferences</a>.</p>`
    : `<p style="margin:8px 0 0 0;">This is a service email from MockTestSeries.</p>`;
  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>MockTestSeries</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
${preheader}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;">
<tr><td style="padding:20px 32px;border-bottom:1px solid ${COLORS.border};font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:${COLORS.brand};">MockTestSeries</td></tr>
${heading}
<tr><td style="padding:12px 32px 16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${COLORS.text};">${input.bodyHtml}</td></tr>
${cta}
<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid ${COLORS.border};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${COLORS.muted};">
<p style="margin:0;">${footerLinks}</p>
${preferences}
</td></tr>
</table></td></tr></table>
</body></html>`;

  const textParts = [
    "MockTestSeries",
    "",
    input.heading ? htmlToText(input.heading) : "",
    htmlToText(input.bodyHtml),
    input.ctaText && input.ctaUrl ? `${input.ctaText}: ${input.ctaUrl}` : "",
    "",
    "--",
    `${host} | ${SUPPORT_EMAIL}`,
    input.preferencesUrl ? `${input.promotional ? "Unsubscribe or manage email preferences" : "Email preferences"}: ${input.preferencesUrl}` : "",
  ];
  return { html, text: textParts.filter((p, i, a) => p !== "" || a[i - 1] !== "").join("\n").trim() };
}
