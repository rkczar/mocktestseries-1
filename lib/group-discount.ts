import "server-only";
import { prisma } from "@/lib/prisma";
import { buildWhatsAppSupportHref, getWhatsAppSupportConfig } from "@/lib/whatsapp-support";

/**
 * "Show Group Discount Offer" switch (Admin → Payments → Products & Pricing).
 * Display-only: it shows a promo card under the plan cards on
 * /plans-and-pricing that sends students to WhatsApp for a coupon. It never
 * touches prices, coupons, orders or Razorpay. Default OFF.
 */

const SETTING_KEY = "payments.group_discount";

export const GROUP_DISCOUNT_WHATSAPP_MESSAGE =
  "Hello MockTestSeries Team! We are interested in the RUHS MO 2026 Group Discount Offer. Please share the coupon code and details.";

export async function getGroupDiscountEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

export async function setGroupDiscountEnabled(enabled: boolean): Promise<void> {
  const value = { enabled, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: SETTING_KEY }, update: { value }, create: { key: SETTING_KEY, value } });
}

/**
 * The wa.me link for the public card, or null (card hidden) when the switch
 * is OFF or no official WhatsApp number is saved under Admin → Website →
 * Footer → WhatsApp Support. The floating support button's own on/off does
 * not matter here — only its saved number is reused.
 */
export async function getPublicGroupDiscountHref(): Promise<string | null> {
  try {
    const [enabled, support] = await Promise.all([getGroupDiscountEnabled(), getWhatsAppSupportConfig()]);
    if (!enabled || !support.number) return null;
    return buildWhatsAppSupportHref(support.number, GROUP_DISCOUNT_WHATSAPP_MESSAGE);
  } catch {
    // A promo card must never take the pricing page down with it.
    return null;
  }
}
