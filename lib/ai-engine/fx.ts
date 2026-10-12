import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * USD → INR for AI cost accounting.
 *
 * Source: Frankfurter (https://frankfurter.dev — free, keyless, European
 * Central Bank reference rates, published on ECB working days). Refreshed
 * lazily: the first cost calculation after the cached rate is 24 h old fetches
 * a new one (one attempt per 15 min across all workers, 5 s timeout) — no cron,
 * no background process. A Master Admin can pin a manual rate instead.
 *
 * Safety: a fetched rate outside 40–250 or moving more than 15 % from the
 * previous one is rejected and the previous validated rate is kept. Older than
 * 3 days → shown as STALE. Older than 14 days (and no manual rate) → no rate,
 * so new paid OpenRouter requests are refused rather than costed with an
 * outdated number.
 */

export const FX_SETTING_KEY = "ai.fx";
const REFRESH_AFTER_MS = 24 * 3600_000;
const RETRY_AFTER_MS = 15 * 60_000;
const STALE_AFTER_MS = 3 * 24 * 3600_000;
const UNUSABLE_AFTER_MS = 14 * 24 * 3600_000;
const FETCH_TIMEOUT_MS = 5_000;

interface StoredFx {
  mode?: "auto" | "manual";
  rate?: number;
  /** ECB publication date of `rate` (YYYY-MM-DD). */
  rateDate?: string;
  fetchedAt?: string;
  lastAttemptAt?: string;
  lastError?: string | null;
  manualRate?: number | null;
  manualSetAt?: string | null;
  updatedAt?: string;
}

export interface FxRate {
  rate: number | null;
  /** When this rate was obtained (fetch time, or when the manual rate was set). */
  at: Date | null;
  rateDate: string | null;
  source: "Frankfurter (ECB)" | "Manual override" | null;
  mode: "auto" | "manual";
  stale: boolean;
  /** Why no rate is available (paid requests are refused while this is set). */
  unavailableReason: string | null;
  lastError: string | null;
  manualRate: number | null;
}

function base(): string {
  const raw = process.env.FX_TEST_BASE_URL ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw) ? raw : "https://api.frankfurter.dev";
}

async function read(): Promise<StoredFx> {
  const row = await prisma.setting.findUnique({ where: { key: FX_SETTING_KEY } });
  return ((row?.value as StoredFx | undefined) ?? {}) as StoredFx;
}

async function patch(set: Partial<StoredFx>): Promise<void> {
  const p = JSON.stringify({ ...set, updatedAt: new Date().toISOString() });
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${FX_SETTING_KEY}, ${p}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = "Setting"."value" || ${p}::jsonb, "updatedAt" = now()`);
}

export function validRate(r: unknown): r is number {
  return typeof r === "number" && Number.isFinite(r) && r >= 40 && r <= 250;
}

function view(s: StoredFx): FxRate {
  const mode = s.mode === "manual" ? "manual" : "auto";
  if (mode === "manual" && validRate(s.manualRate)) {
    return { rate: s.manualRate, at: s.manualSetAt ? new Date(s.manualSetAt) : null, rateDate: null, source: "Manual override", mode, stale: false, unavailableReason: null, lastError: s.lastError ?? null, manualRate: s.manualRate };
  }
  if (!validRate(s.rate) || !s.fetchedAt) {
    return { rate: null, at: null, rateDate: null, source: null, mode, stale: true, unavailableReason: "No USD→INR exchange rate has been fetched yet.", lastError: s.lastError ?? null, manualRate: s.manualRate ?? null };
  }
  const age = Date.now() - Date.parse(s.fetchedAt);
  if (age > UNUSABLE_AFTER_MS) {
    return { rate: null, at: new Date(s.fetchedAt), rateDate: s.rateDate ?? null, source: "Frankfurter (ECB)", mode, stale: true, unavailableReason: "The last USD→INR rate is more than 14 days old. Refresh it or set a manual rate in AI → Budgets.", lastError: s.lastError ?? null, manualRate: s.manualRate ?? null };
  }
  return { rate: s.rate, at: new Date(s.fetchedAt), rateDate: s.rateDate ?? null, source: "Frankfurter (ECB)", mode, stale: age > STALE_AFTER_MS, unavailableReason: null, lastError: s.lastError ?? null, manualRate: s.manualRate ?? null };
}

/** Fetch now (admin "Refresh rate" or lazy refresh). Never throws; returns the resulting view. */
export async function refreshFxRate(): Promise<FxRate> {
  const before = await read();
  await patch({ lastAttemptAt: new Date().toISOString() });
  try {
    const res = await fetch(`${base()}/v1/latest?base=USD&symbols=INR`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) throw new Error(`rate service answered ${res.status}`);
    const body = (await res.json()) as { rates?: { INR?: number }; date?: string };
    const rate = body.rates?.INR;
    if (!validRate(rate)) throw new Error("rate service returned an invalid INR rate");
    if (validRate(before.rate) && Math.abs(rate - before.rate) / before.rate > 0.15) {
      throw new Error(`rejected ${rate} — more than 15% away from the previous rate ${before.rate}`);
    }
    await patch({ rate: Math.round(rate * 10_000) / 10_000, rateDate: typeof body.date === "string" ? body.date.slice(0, 10) : undefined, fetchedAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    await patch({ lastError: `${new Date().toISOString().slice(0, 16)}Z: ${error instanceof Error ? error.message.slice(0, 160) : "fetch failed"}` });
  }
  return view(await read());
}

/** The rate to cost a request with. Refreshes lazily when the cached one is a day old. */
export async function getUsdInr(): Promise<FxRate> {
  const s = await read();
  const v = view(s);
  if (v.mode === "manual" && v.rate !== null) return v;
  const due = !s.fetchedAt || Date.now() - Date.parse(s.fetchedAt) > REFRESH_AFTER_MS;
  const mayTry = !s.lastAttemptAt || Date.now() - Date.parse(s.lastAttemptAt) > RETRY_AFTER_MS;
  if (due && mayTry) return refreshFxRate();
  return v;
}

/** Read-only view for dashboards (never fetches). */
export async function peekUsdInr(): Promise<FxRate> {
  return view(await read());
}

export async function setFxMode(input: { mode: "auto" | "manual"; manualRate?: number | null }): Promise<FxRate> {
  if (input.mode === "manual") {
    if (!validRate(input.manualRate)) throw new Error("Enter a USD→INR rate between 40 and 250.");
    await patch({ mode: "manual", manualRate: Math.round(input.manualRate * 10_000) / 10_000, manualSetAt: new Date().toISOString() });
  } else {
    await patch({ mode: "auto" });
  }
  return getUsdInr();
}
