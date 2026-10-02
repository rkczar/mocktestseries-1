import "server-only";
import type { EmailCategory, EmailTemplateKey } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { escapeHtml } from "@/lib/email/sanitize";

/**
 * Built-in defaults for every template key, the variable allowlist, and
 * the renderer. An EmailTemplate row (Admin → Communications → Email →
 * Templates) overrides a default; deleting it ("Reset to default") brings
 * the default back.
 *
 * Variables are plain `{{name}}` placeholders replaced from a fixed
 * allowlist — no expressions, no helpers, no code. An unknown or missing
 * variable renders as an empty string. Every value is HTML-escaped in the
 * body/heading, CR/LF-stripped in the subject and URL-encoded inside a CTA
 * URL (except the server-built *Url variables, which are full URLs).
 */

export const TEMPLATE_VARIABLES = [
  "studentName",
  "email",
  "studentId",
  "examName",
  "testName",
  "productName",
  "amount",
  "orderNumber",
  "invoiceNumber",
  "paymentId",
  "loginUrl",
  "resetUrl",
  "dashboardUrl",
  "invoiceUrl",
  "siteUrl",
  "supportEmail",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateVars = Partial<Record<TemplateVariable, string>>;

const URL_VARIABLES = new Set<string>(["loginUrl", "resetUrl", "dashboardUrl", "invoiceUrl", "siteUrl"]);

export interface TemplateContent {
  subject: string;
  heading: string;
  bodyHtml: string;
  ctaText: string | null;
  ctaUrl: string | null;
}

export interface TemplateDefinition extends TemplateContent {
  key: EmailTemplateKey;
  label: string;
  description: string;
  category: EmailCategory;
  /** Password/security/payment: sent even to an opted-out student. */
  critical: boolean;
  /** Fired automatically by an app event (vs used by Compose/Campaigns). */
  automatic: boolean;
}

export const TEMPLATE_DEFAULTS: Record<EmailTemplateKey, TemplateDefinition> = {
  WELCOME: {
    key: "WELCOME",
    label: "Welcome",
    description: "Sent once when a student account is created (password, mobile OTP or Google).",
    category: "TRANSACTIONAL",
    critical: false,
    automatic: true,
    subject: "Welcome to MockTestSeries, {{studentName}}",
    heading: "Welcome to MockTestSeries",
    bodyHtml:
      "<p>Hi {{studentName}},</p><p>Your MockTestSeries account is ready. Your User ID is <strong>{{studentId}}</strong>.</p><p>Practise with exam-pattern mock tests, previous year papers and subject tests, and follow your progress on your dashboard.</p>",
    ctaText: "Go to my dashboard",
    ctaUrl: "{{dashboardUrl}}",
  },
  FIRST_LOGIN: {
    key: "FIRST_LOGIN",
    label: "First login",
    description: "Sent only once, after a student's first successful sign-in. Never repeated on later logins.",
    category: "TRANSACTIONAL",
    critical: false,
    automatic: true,
    subject: "Getting started with MockTestSeries",
    heading: "You're all set, {{studentName}}",
    bodyHtml:
      "<p>Thanks for signing in to MockTestSeries. A few tips to get started:</p><ul><li>Pick your exam on the dashboard so we can show the right tests.</li><li>Start with a previous year paper to see where you stand.</li><li>Review every answer after a test, including the explanations.</li></ul><p>If you didn't sign in just now, please reset your password and contact us.</p>",
    ctaText: "Start practising",
    ctaUrl: "{{dashboardUrl}}",
  },
  PAYMENT_SUCCESS: {
    key: "PAYMENT_SUCCESS",
    label: "Payment successful",
    description: "Sent once per order after the payment is verified server-side (checkout signature, Razorpay webhook or reconciliation).",
    category: "TRANSACTIONAL",
    critical: true,
    automatic: true,
    subject: "Payment received: {{productName}}",
    heading: "Payment successful",
    bodyHtml:
      "<p>Hi {{studentName}},</p><p>We have received your payment and your access is now active.</p><ul><li><strong>Product:</strong> {{productName}}</li><li><strong>Amount paid:</strong> {{amount}}</li><li><strong>Order number:</strong> {{orderNumber}}</li><li><strong>Payment ID:</strong> {{paymentId}}</li><li><strong>Invoice number:</strong> {{invoiceNumber}}</li></ul><p>You can download your invoice at any time from Payments &amp; Invoices.</p>",
    ctaText: "View payments & invoices",
    ctaUrl: "{{invoiceUrl}}",
  },
  INVOICE: {
    key: "INVOICE",
    label: "Invoice",
    description: "Sent when an invoice is issued separately from the payment (for example after an admin fulfilment repair).",
    category: "TRANSACTIONAL",
    critical: true,
    automatic: true,
    subject: "Your invoice {{invoiceNumber}}",
    heading: "Your invoice is ready",
    bodyHtml:
      "<p>Hi {{studentName}},</p><p>Invoice <strong>{{invoiceNumber}}</strong> for {{productName}} ({{amount}}) has been issued for order {{orderNumber}}.</p><p>You can download it from Payments &amp; Invoices.</p>",
    ctaText: "Download invoice",
    ctaUrl: "{{invoiceUrl}}",
  },
  PASSWORD_RESET: {
    key: "PASSWORD_RESET",
    label: "Password changed",
    description: "Security notice sent after a password is reset through Forgot Password.",
    category: "TRANSACTIONAL",
    critical: true,
    automatic: true,
    subject: "Your MockTestSeries password was changed",
    heading: "Your password was changed",
    bodyHtml:
      "<p>Hi {{studentName}},</p><p>The password for your MockTestSeries account was just changed, and every device was signed out.</p><p>If you made this change, no action is needed. If you didn't, reset your password straight away and contact us at {{supportEmail}}.</p>",
    ctaText: "Sign in",
    ctaUrl: "{{loginUrl}}",
  },
  FORGOT_PASSWORD: {
    key: "FORGOT_PASSWORD",
    label: "Forgot password requested",
    description: "Security notice sent when a password reset is requested. The reset code itself still goes to the registered mobile by SMS.",
    category: "TRANSACTIONAL",
    critical: true,
    automatic: true,
    subject: "Password reset requested for your account",
    heading: "Password reset requested",
    bodyHtml:
      "<p>Hi {{studentName}},</p><p>We received a request to reset the password for your MockTestSeries account. A verification code has been sent to your registered mobile number.</p><p>If you didn't request this, you can ignore this email. Your password has not changed.</p>",
    ctaText: "Reset password",
    ctaUrl: "{{resetUrl}}",
  },
  TEST_ANNOUNCEMENT: {
    key: "TEST_ANNOUNCEMENT",
    label: "Test announcement",
    description: "Starting point for announcing a new or upcoming test from Compose / Campaigns.",
    category: "PROMOTIONAL",
    critical: false,
    automatic: false,
    subject: "New test available: {{testName}}",
    heading: "{{testName}} is now available",
    bodyHtml: "<p>Hi {{studentName}},</p><p>A new test, <strong>{{testName}}</strong>, is now available on MockTestSeries. Attempt it to check your preparation.</p>",
    ctaText: "Attempt now",
    ctaUrl: "{{dashboardUrl}}",
  },
  GENERAL_ANNOUNCEMENT: {
    key: "GENERAL_ANNOUNCEMENT",
    label: "General announcement",
    description: "Starting point for general news and updates from Compose / Campaigns.",
    category: "PROMOTIONAL",
    critical: false,
    automatic: false,
    subject: "An update from MockTestSeries",
    heading: "An update from MockTestSeries",
    bodyHtml: "<p>Hi {{studentName}},</p><p>Write your announcement here.</p>",
    ctaText: "Open MockTestSeries",
    ctaUrl: "{{dashboardUrl}}",
  },
  CUSTOM: {
    key: "CUSTOM",
    label: "Custom",
    description: "Blank layout for one-off emails from Compose / Campaigns.",
    category: "PROMOTIONAL",
    critical: false,
    automatic: false,
    subject: "",
    heading: "",
    bodyHtml: "<p>Hi {{studentName}},</p>",
    ctaText: null,
    ctaUrl: null,
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATE_DEFAULTS) as EmailTemplateKey[];
/** Compose / Campaign starting points, in dropdown order. */
export const COMPOSE_TEMPLATE_KEYS: EmailTemplateKey[] = ["GENERAL_ANNOUNCEMENT", "TEST_ANNOUNCEMENT", "CUSTOM"];

export interface ResolvedTemplate extends TemplateDefinition {
  enabled: boolean;
  customized: boolean;
  updatedAt: Date | null;
}

export async function getResolvedTemplate(key: EmailTemplateKey): Promise<ResolvedTemplate> {
  const row = await prisma.emailTemplate.findUnique({ where: { key } });
  return mergeTemplate(TEMPLATE_DEFAULTS[key], row);
}

export async function listResolvedTemplates(): Promise<ResolvedTemplate[]> {
  const rows = await prisma.emailTemplate.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return TEMPLATE_KEYS.map((key) => mergeTemplate(TEMPLATE_DEFAULTS[key], byKey.get(key) ?? null));
}

function mergeTemplate(
  def: TemplateDefinition,
  row: { subject: string; heading: string; bodyHtml: string; ctaText: string | null; ctaUrl: string | null; enabled: boolean; updatedAt: Date } | null
): ResolvedTemplate {
  if (!row) return { ...def, enabled: true, customized: false, updatedAt: null };
  return {
    ...def,
    subject: row.subject,
    heading: row.heading,
    bodyHtml: row.bodyHtml,
    ctaText: row.ctaText,
    ctaUrl: row.ctaUrl,
    enabled: row.enabled,
    customized: true,
    updatedAt: row.updatedAt,
  };
}

const VARIABLE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

function lookup(vars: TemplateVars, name: string): string {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(name) ? String(vars[name as TemplateVariable] ?? "") : "";
}

/** Subject line: plain text, single line. */
export function renderText(template: string, vars: TemplateVars): string {
  return template.replace(VARIABLE_RE, (_m, name: string) => lookup(vars, name)).replace(/[\r\n]+/g, " ").trim();
}

/** Heading/body: values are HTML-escaped, the template's own (sanitized) markup is kept. */
export function renderHtml(template: string, vars: TemplateVars): string {
  return template.replace(VARIABLE_RE, (_m, name: string) => escapeHtml(lookup(vars, name)));
}

/** CTA URL: whole-URL variables pass through, others are URL-encoded. Result must be http(s). */
export function renderUrl(template: string | null, vars: TemplateVars): string | null {
  if (!template) return null;
  const url = template
    .replace(VARIABLE_RE, (_m, name: string) => (URL_VARIABLES.has(name) ? lookup(vars, name) : encodeURIComponent(lookup(vars, name))))
    .trim();
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function renderContent(content: TemplateContent, vars: TemplateVars) {
  return {
    subject: renderText(content.subject, vars),
    // Headings are plain text in the editor, so their own characters are escaped too.
    heading: renderHtml(escapeHtml(content.heading), vars),
    bodyHtml: renderHtml(content.bodyHtml, vars),
    ctaText: content.ctaText ? renderText(content.ctaText, vars) : null,
    ctaUrl: renderUrl(content.ctaUrl, vars),
  };
}
