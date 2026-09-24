import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Backup Center retention policy (Setting key `backup.retention`).
 *
 * Releases: the CURRENT production release is always protected and is never
 * counted here — `rollbackReleasesToKeep` is the number of newest previous
 * successful releases protected in addition to it (default 1 → Current + 1
 * = 2 protected releases).
 *
 * Backups: the newest N VERIFIED backups of each category are protected.
 * Unknown / unverified / legacy / uploaded files are never retention
 * candidates regardless of these numbers.
 *
 * `autoCleanup` is OFF by default; when a MASTER_ADMIN enables it, the daily
 * retention runner (scripts/backup-auto-retention.ts) deletes only artifacts
 * the same plans already classify as cleanup-eligible.
 */

export interface RetentionSettings {
  rollbackReleasesToKeep: number;
  dbBackupsToKeep: number;
  fullBackupsToKeep: number;
  cleanBackupsToKeep: number;
  autoCleanup: boolean;
}

export const RETENTION_DEFAULTS: RetentionSettings = {
  rollbackReleasesToKeep: 1,
  dbBackupsToKeep: 1,
  fullBackupsToKeep: 1,
  cleanBackupsToKeep: 1,
  autoCleanup: false,
};

export const RETENTION_MIN = 1;
export const RETENTION_MAX = 5;

const SETTING_KEY = "backup.retention";

function clampCount(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, Math.floor(n)));
}

/** Normalizes any stored/submitted value into a valid policy (never below 1 of anything). */
export function normalizeRetention(raw: unknown): RetentionSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    rollbackReleasesToKeep: clampCount(r.rollbackReleasesToKeep, RETENTION_DEFAULTS.rollbackReleasesToKeep),
    dbBackupsToKeep: clampCount(r.dbBackupsToKeep, RETENTION_DEFAULTS.dbBackupsToKeep),
    fullBackupsToKeep: clampCount(r.fullBackupsToKeep, RETENTION_DEFAULTS.fullBackupsToKeep),
    cleanBackupsToKeep: clampCount(r.cleanBackupsToKeep, RETENTION_DEFAULTS.cleanBackupsToKeep),
    autoCleanup: r.autoCleanup === true,
  };
}

export async function getRetentionSettings(): Promise<RetentionSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null);
  return normalizeRetention(row?.value);
}

export async function saveRetentionSettings(input: unknown): Promise<RetentionSettings> {
  const value = normalizeRetention(input);
  const stored = { ...value, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: SETTING_KEY }, update: { value: stored }, create: { key: SETTING_KEY, value: stored } });
  return value;
}
