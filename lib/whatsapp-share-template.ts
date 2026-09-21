/**
 * Pure template helpers for the Question WhatsApp Share feature (Section 16)
 * — no Prisma/server-only imports, so both the server-side share-text
 * builder (lib/whatsapp-share-config.ts) and the Admin settings form's
 * client-side live preview can use the exact same substitution logic.
 */

export const WHATSAPP_SHARE_PLACEHOLDERS = ["exam", "subject", "question", "website_url"] as const;

export const DEFAULT_WHATSAPP_SHARE_TEMPLATE =
  "Check out this question from MockTestSeries.in\n\n{{question}}\n\n{{exam}} · {{subject}}\n\n{{website_url}}";

/**
 * Fills `{{placeholder}}` tokens with plain-text values only — never HTML,
 * never a raw student/attempt identifier. Unknown placeholders are left
 * untouched rather than silently dropped, so a typo in the admin template is
 * visible instead of quietly losing text.
 */
export function renderWhatsAppShareText(
  template: string,
  values: { exam: string; subject: string; question: string; website_url: string }
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    return key in values ? values[key as keyof typeof values] : match;
  });
}
