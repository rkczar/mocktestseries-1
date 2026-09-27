import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  CUSTOM_ROW_PREFIX,
  DEFAULT_OFFER_DISPLAY,
  LOCKED_ROW_KEYS,
  MAX_OFFER_ROWS,
  type OfferDisplayConfig,
} from "@/lib/payments/offer-display-shared";

/**
 * Storage for the per-Test-Series offer display config, in the existing
 * `Setting` key-value table (no schema change). See offer-display-shared.ts
 * for what it may and may not control.
 */

const keyFor = (testSeriesId: string) => `payments.offer_display.${testSeriesId}`;

const cellSchema = z.object({
  mode: z.enum(["AUTO", "TEXT", "CHECK", "CROSS"]),
  text: z.string().trim().max(120).optional(),
});

const rowSchema = z.object({
  key: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/),
  feature: z.string().trim().max(80).optional(),
  free: cellSchema,
  paid: cellSchema,
  visible: z.boolean(),
  highlight: z.boolean(),
});

export const offerDisplaySchema = z
  .object({
    promoVisible: z.boolean(),
    heading: z.string().trim().min(1, "Heading is required.").max(80),
    description: z.string().trim().max(300),
    ctaLabel: z.string().trim().min(1, "CTA label is required.").max(40),
    rows: z.array(rowSchema).max(MAX_OFFER_ROWS),
  })
  .superRefine((v, ctx) => {
    const keys = new Set<string>();
    for (const r of v.rows) {
      if (keys.has(r.key)) ctx.addIssue({ code: "custom", message: `Duplicate row "${r.key}".` });
      keys.add(r.key);
      if (r.key.startsWith(CUSTOM_ROW_PREFIX) && !r.feature) ctx.addIssue({ code: "custom", message: "Every custom row needs a feature name." });
      if (r.key.startsWith(CUSTOM_ROW_PREFIX) && (r.free.mode === "AUTO" || r.paid.mode === "AUTO"))
        ctx.addIssue({ code: "custom", message: `Custom row "${r.feature ?? r.key}" can't use AUTO — pick text, included or not included.` });
    }
  })
  // The price row is canonical Product data: only its position and visibility persist.
  .transform((v) => ({
    ...v,
    rows: v.rows.map((r) => (LOCKED_ROW_KEYS.has(r.key) ? { key: r.key, visible: r.visible, highlight: r.highlight, free: { mode: "AUTO" as const }, paid: { mode: "AUTO" as const } } : r)),
  }));

export function parseOfferDisplay(raw: unknown): OfferDisplayConfig {
  const parsed = offerDisplaySchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_OFFER_DISPLAY;
}

export async function getOfferDisplay(testSeriesId: string): Promise<OfferDisplayConfig> {
  const row = await prisma.setting.findUnique({ where: { key: keyFor(testSeriesId) } });
  return row ? parseOfferDisplay(row.value) : DEFAULT_OFFER_DISPLAY;
}

export async function saveOfferDisplay(testSeriesId: string, config: OfferDisplayConfig): Promise<void> {
  const value = config as unknown as object;
  await prisma.setting.upsert({ where: { key: keyFor(testSeriesId) }, update: { value }, create: { key: keyFor(testSeriesId), value } });
}

export async function resetOfferDisplay(testSeriesId: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: keyFor(testSeriesId) } });
}
