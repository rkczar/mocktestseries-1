import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * DB-backed sliding-window rate limit for the commerce endpoints. In-memory
 * counters would be per-PM2-worker, so the shared table is the source of
 * truth. Old hits are pruned opportunistically.
 */

export const PAYMENT_RATE_LIMITS = {
  "create-order": { max: 10, windowMs: 10 * 60_000 },
  coupon: { max: 20, windowMs: 10 * 60_000 },
  verify: { max: 20, windowMs: 10 * 60_000 },
  status: { max: 60, windowMs: 10 * 60_000 },
  webhook: { max: 600, windowMs: 60_000 },
} as const;

export type PaymentRateBucket = keyof typeof PAYMENT_RATE_LIMITS;

export class PaymentRateLimitError extends Error {
  constructor() {
    super("Too many attempts. Please wait a few minutes and try again.");
    this.name = "PaymentRateLimitError";
  }
}

/** Records a hit and throws PaymentRateLimitError when the bucket is over its limit. */
export async function enforcePaymentRateLimit(bucket: PaymentRateBucket, key: string): Promise<void> {
  const { max, windowMs } = PAYMENT_RATE_LIMITS[bucket];
  const since = new Date(Date.now() - windowMs);
  const count = await prisma.paymentRateLimitHit.count({ where: { bucket, key, createdAt: { gte: since } } });
  if (count >= max) throw new PaymentRateLimitError();
  await prisma.paymentRateLimitHit.create({ data: { bucket, key } });
  if (Math.random() < 0.02) {
    await prisma.paymentRateLimitHit.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
  }
}
