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
  billingAddress: string;
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
