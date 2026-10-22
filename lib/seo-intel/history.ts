import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toIstDateString } from "@/lib/ist-time";
import type { SeoSnapshot } from "@/lib/seo-intel/sync";

/**
 * SEO Intelligence history + settings, in the existing `Setting` key-value
 * table (no new tables):
 *
 *   seo.intel.settings            { autoSyncEnabled, historyDays }
 *   seo.intel.history.YYYY-MM-DD  one compact summary per IST day with a
 *                                 successful sync (the day's latest wins)
 *
 * Keys sort by date, so retention is a single range delete.
 */

export const INTEL_SETTINGS_KEY = "seo.intel.settings";
export const HISTORY_PREFIX = "seo.intel.history.";
export const HISTORY_DAYS_MIN = 30;
export const HISTORY_DAYS_MAX = 1095;
const TOP_KEEP = 10;

export interface IntelSettings {
  /** Daily scheduled sync (cron: ops/seo/mocktestseries-seo-intel.cron). OFF until a Master Admin turns it on. */
  autoSyncEnabled: boolean;
  /** Daily history summaries older than this are deleted after each sync / settings save. */
  historyDays: number;
}

const DEFAULTS: IntelSettings = { autoSyncEnabled: false, historyDays: 400 };

export async function getIntelSettings(): Promise<IntelSettings> {
  const row = await prisma.setting.findUnique({ where: { key: INTEL_SETTINGS_KEY } });
  const raw = (row?.value as Partial<IntelSettings> | null) ?? {};
  return {
    autoSyncEnabled: raw.autoSyncEnabled === true,
    historyDays: clampDays(raw.historyDays ?? DEFAULTS.historyDays),
  };
}

function clampDays(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(HISTORY_DAYS_MAX, Math.max(HISTORY_DAYS_MIN, v)) : DEFAULTS.historyDays;
}

export async function saveIntelSettings(update: Partial<IntelSettings>): Promise<IntelSettings> {
  const next: IntelSettings = { ...(await getIntelSettings()) };
  if (update.autoSyncEnabled !== undefined) next.autoSyncEnabled = update.autoSyncEnabled === true;
  if (update.historyDays !== undefined) next.historyDays = clampDays(update.historyDays);
  const json = next as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: INTEL_SETTINGS_KEY }, create: { key: INTEL_SETTINGS_KEY, value: json }, update: { value: json } });
  return next;
}

export interface HistoryEntry {
  date: string; // IST day of the sync
  at: string;
  gsc: { range: { start: string; end: string }; totals: NonNullable<SeoSnapshot["gsc"]>["totals"]; topQueries: NonNullable<SeoSnapshot["gsc"]>["topQueries"]; topPages: NonNullable<SeoSnapshot["gsc"]>["topPages"] } | null;
  ga4: { range: { start: string; end: string }; totals: NonNullable<SeoSnapshot["ga4"]>["totals"]; channels: NonNullable<SeoSnapshot["ga4"]>["channels"] } | null;
}

/**
 * Records the halves THIS sync fetched successfully as the day's summary. A
 * half that failed keeps whatever an earlier sync that day stored for it.
 */
export async function recordHistory(fresh: { gsc: SeoSnapshot["gsc"]; ga4: SeoSnapshot["ga4"] }, at: Date): Promise<string | null> {
  if (!fresh.gsc && !fresh.ga4) return null;
  const date = toIstDateString(at);
  const key = `${HISTORY_PREFIX}${date}`;
  const existing = (await prisma.setting.findUnique({ where: { key } }))?.value as HistoryEntry | null | undefined;
  const entry: HistoryEntry = {
    date,
    at: at.toISOString(),
    gsc: fresh.gsc
      ? { range: fresh.gsc.range, totals: fresh.gsc.totals, topQueries: fresh.gsc.topQueries.slice(0, TOP_KEEP), topPages: fresh.gsc.topPages.slice(0, TOP_KEEP) }
      : existing?.gsc ?? null,
    ga4: fresh.ga4 ? { range: fresh.ga4.range, totals: fresh.ga4.totals, channels: fresh.ga4.channels.slice(0, TOP_KEEP) } : existing?.ga4 ?? null,
  };
  const json = entry as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
  return date;
}

/** Newest first. */
export async function listHistory(limit = 90): Promise<HistoryEntry[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: HISTORY_PREFIX } },
    orderBy: { key: "desc" },
    take: Math.min(Math.max(limit, 1), HISTORY_DAYS_MAX),
  });
  return rows.map((r) => r.value as unknown as HistoryEntry).filter((e) => e && typeof e.date === "string");
}

/** Deletes daily summaries older than `historyDays` (by IST date). Returns how many were removed. */
export async function pruneHistory(historyDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(`${toIstDateString(now)}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - clampDays(historyDays));
  const res = await prisma.setting.deleteMany({
    where: { AND: [{ key: { startsWith: HISTORY_PREFIX } }, { key: { lt: `${HISTORY_PREFIX}${cutoff.toISOString().slice(0, 10)}` } }] },
  });
  return res.count;
}

/**
 * The comparison point for "change vs. ~a week ago": the newest entry at
 * least 7 days older than `latest`, else the oldest one available.
 */
export function comparisonEntry(history: HistoryEntry[]): HistoryEntry | null {
  if (history.length < 2) return null;
  const latest = new Date(`${history[0].date}T00:00:00Z`).getTime();
  return history.slice(1).find((e) => latest - new Date(`${e.date}T00:00:00Z`).getTime() >= 7 * 86_400_000) ?? history[history.length - 1];
}
