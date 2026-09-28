import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Admin-controlled commerce settings, stored in the existing `Setting`
 * key-value table so they change without a deploy:
 *
 *   payments.mode     FREE | PAID | MAINTENANCE (global switch)
 *   payments.invoice  seller/legal/tax details printed on invoices
 *   payments.policy   refund access policy + invoice rules
 *
 * Nothing here is secret — gateway credentials live in lib/razorpay-config.ts.
 */

export type PaymentMode = "FREE" | "PAID" | "MAINTENANCE";
export const PAYMENT_MODES: PaymentMode[] = ["FREE", "PAID", "MAINTENANCE"];

const MODE_KEY = "payments.mode";
const INVOICE_KEY = "payments.invoice";
const POLICY_KEY = "payments.policy";
const CACHE_TTL_MS = 5_000;

let modeCache: { at: number; value: PaymentMode } | null = null;

export function bumpPaymentSettingsCache() {
  modeCache = null;
}

/**
 * Current global payment mode. Defaults to FREE when never configured, which
 * preserves the site's existing free behavior exactly. Cached for 5s per
 * worker; every PM2 worker converges within that window after a change.
 */
export async function getPaymentMode(): Promise<PaymentMode> {
  if (modeCache && Date.now() - modeCache.at < CACHE_TTL_MS) return modeCache.value;
  const row = await prisma.setting.findUnique({ where: { key: MODE_KEY } });
  const raw = (row?.value as { mode?: string } | null)?.mode;
  const value: PaymentMode = raw === "PAID" || raw === "MAINTENANCE" ? raw : "FREE";
  modeCache = { at: Date.now(), value };
  return value;
}

export async function setPaymentMode(mode: PaymentMode, actorId: string | undefined): Promise<void> {
  const value = { mode, updatedAt: new Date().toISOString(), updatedBy: actorId ?? null };
  await prisma.setting.upsert({ where: { key: MODE_KEY }, update: { value }, create: { key: MODE_KEY, value } });
  bumpPaymentSettingsCache();
}

export interface InvoiceSettings {
  legalName: string;
  tradeName: string;
  /** Legacy free-text address; used only while the structured fields below are empty. */
  billingAddress: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pinCode: string;
  country: string;
  /**
   * The owner's explicit answer to "is the business GST-registered?".
   * null = not answered yet (nothing is assumed — invoices keep today's
   * behavior). false forces no GSTIN and no tax lines on new invoices.
   */
  gstRegistered: boolean | null;
  supportEmail: string;
  supportPhone: string;
  gstin: string;
  invoicePrefix: string;
  /**
   * Explicit tax treatment. NONE prints no tax lines. INCLUSIVE splits the
   * configured rate out of the (tax-inclusive) paid amount as IGST or
   * CGST+SGST. Nothing is assumed — the merchant sets this deliberately.
   */
  taxMode: "NONE" | "INCLUSIVE";
  taxRatePercent: number;
  taxSplit: "IGST" | "CGST_SGST";
  sacCode: string;
  footerNote: string;
}

export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = {
  legalName: "",
  tradeName: "MockTestSeries.in",
  billingAddress: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  pinCode: "",
  // Invoices already assume India (INR, GSTIN, IGST/CGST+SGST); editable.
  country: "India",
  gstRegistered: null,
  supportEmail: "",
  supportPhone: "",
  gstin: "",
  invoicePrefix: "MTS",
  taxMode: "NONE",
  taxRatePercent: 0,
  taxSplit: "IGST",
  sacCode: "",
  footerNote: "This is a computer-generated invoice.",
};

export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  const row = await prisma.setting.findUnique({ where: { key: INVOICE_KEY } });
  return { ...DEFAULT_INVOICE_SETTINGS, ...((row?.value as Partial<InvoiceSettings>) ?? {}) };
}

/** Seller address lines for new invoices: the structured fields when set, else the legacy free-text address. */
export function composeSellerAddress(s: InvoiceSettings): string {
  const cityLine = [[s.city, s.state].filter(Boolean).join(", "), s.pinCode].filter(Boolean).join(" - ");
  const lines = [s.addressLine1, s.addressLine2, cityLine, s.country].map((l) => (l ?? "").trim()).filter(Boolean);
  const structured = [s.addressLine1, s.addressLine2, s.city, s.state, s.pinCode].some((v) => (v ?? "").trim());
  return structured ? lines.join("\n") : s.billingAddress;
}

export async function saveInvoiceSettings(next: InvoiceSettings): Promise<void> {
  const value = next as unknown as object;
  await prisma.setting.upsert({ where: { key: INVOICE_KEY }, update: { value }, create: { key: INVOICE_KEY, value } });
}

export interface PaymentPolicy {
  /** What happens to the entitlement when a payment is FULLY refunded. */
  refundAccessPolicy: "REVOKE_IMMEDIATELY" | "RETAIN";
  /** Issue invoices for ₹0 coupon redemptions too (default: paid orders only). */
  invoiceZeroValueOrders: boolean;
  /** Minutes an unpaid gateway order stays reusable before it expires. */
  orderTtlMinutes: number;
}

export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = {
  refundAccessPolicy: "RETAIN",
  invoiceZeroValueOrders: false,
  orderTtlMinutes: 30,
};

export async function getPaymentPolicy(): Promise<PaymentPolicy> {
  const row = await prisma.setting.findUnique({ where: { key: POLICY_KEY } });
  return { ...DEFAULT_PAYMENT_POLICY, ...((row?.value as Partial<PaymentPolicy>) ?? {}) };
}

export async function savePaymentPolicy(next: PaymentPolicy): Promise<void> {
  const value = next as unknown as object;
  await prisma.setting.upsert({ where: { key: POLICY_KEY }, update: { value }, create: { key: POLICY_KEY, value } });
}

/** Standard 15-character GSTIN: state code, PAN, entity number, "Z", checksum. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9 -]{6,18}[0-9]$/;

/**
 * Validates the MASTER_ADMIN Invoice & Business Details form. Never infers
 * anything: GST registration stays "not answered" until chosen, and a "No"
 * answer can't be combined with a GSTIN or tax lines.
 */
export function parseInvoiceSettingsInput(get: (k: string) => string): { ok: true; value: InvoiceSettings } | { ok: false; error: string } {
  const t = (k: string, max: number) => get(k).trim().slice(0, max);
  const reg = get("gstRegistered");
  const gstRegistered = reg === "YES" ? true : reg === "NO" ? false : null;
  const taxMode = get("taxMode") === "INCLUSIVE" ? "INCLUSIVE" : "NONE";
  const rate = taxMode === "INCLUSIVE" ? Number(get("taxRatePercent")) : 0;
  const gstin = get("gstin").trim().toUpperCase();
  const supportEmail = t("supportEmail", 150);
  const supportPhone = t("supportPhone", 30);
  const country = t("country", 60) || "India";
  const pinCode = t("pinCode", 10);

  if (supportEmail && !EMAIL_RE.test(supportEmail)) return { ok: false, error: "Support email doesn't look valid." };
  if (supportPhone && !PHONE_RE.test(supportPhone)) return { ok: false, error: "Support phone: digits, spaces, dashes and an optional leading + only." };
  if (pinCode && /^india$/i.test(country) && !/^[1-9][0-9]{5}$/.test(pinCode)) return { ok: false, error: "PIN code must be 6 digits." };
  if (gstRegistered === false && gstin) return { ok: false, error: "GST Registered is No — clear the GSTIN, or change the answer to Yes." };
  if (gstRegistered === false && taxMode === "INCLUSIVE") return { ok: false, error: "GST Registered is No — tax mode must be None." };
  if (gstRegistered === true && !gstin) return { ok: false, error: "GST Registered is Yes — enter the GSTIN." };
  if (gstin && !(gstRegistered === true ? GSTIN_RE : /^[0-9]{2}[A-Z0-9]{13}$/).test(gstin)) return { ok: false, error: "GSTIN must be a valid 15-character GSTIN." };
  if (taxMode === "INCLUSIVE" && (!Number.isFinite(rate) || rate <= 0 || rate > 50)) return { ok: false, error: "Tax rate must be between 0 and 50%." };
  if (taxMode === "INCLUSIVE" && !gstin) return { ok: false, error: "Tax lines need a GSTIN — configure it or set tax mode to None." };

  return {
    ok: true,
    value: {
      legalName: t("legalName", 150),
      tradeName: t("tradeName", 150),
      billingAddress: t("billingAddress", 500),
      addressLine1: t("addressLine1", 150),
      addressLine2: t("addressLine2", 150),
      city: t("city", 80),
      state: t("state", 80),
      pinCode,
      country,
      gstRegistered,
      supportEmail,
      supportPhone,
      gstin,
      invoicePrefix: get("invoicePrefix").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "MTS",
      taxMode,
      taxRatePercent: rate,
      taxSplit: get("taxSplit") === "CGST_SGST" ? "CGST_SGST" : "IGST",
      sacCode: get("sacCode").replace(/[^0-9]/g, "").slice(0, 8),
      footerNote: t("footerNote", 300),
    },
  };
}
