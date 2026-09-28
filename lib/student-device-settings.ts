import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Admin → Security → Security Settings → Student Device Security, stored in
 * the `Setting` table under `security.student_devices`. Read per request
 * through a 15s in-process cache (same pattern as lib/auth-provider-config.ts);
 * each PM2 worker holds its own cache, so a save is visible on every worker
 * within 15s and immediately on the worker that saved it.
 */

const SETTING_KEY = "security.student_devices";
const CACHE_TTL_MS = 15_000;
export const MAX_DEVICE_LIMIT = 10;
export const MAX_SELF_REMOVE_COOLDOWN_DAYS = 365;

export interface StudentDeviceSettings {
  /** Enforce the device limit at sign-in. Off = devices are still recorded, never blocked. */
  enabled: boolean;
  /** Maximum active (slot-holding) devices per student. */
  maxDevices: number;
  /** When the limit is reached: block the new device (on) or allow it and record a warning (off). */
  blockNewDevice: boolean;
  /** Keep a StudentSession row per sign-in (per-session logout, active-session counts). */
  trackSessions: boolean;
  /** Admins may run "Reset Device Limit". */
  allowAdminReset: boolean;
  /** Students may remove one of their own registered devices (frees a slot), rate-limited. */
  studentSelfRemove: boolean;
  /** Minimum days between two self-removals by the same student. */
  selfRemoveCooldownDays: number;
  /** One device at a time may run a student's in-progress test. */
  oneActiveTestDevice: boolean;
}

export const DEFAULT_STUDENT_DEVICE_SETTINGS: StudentDeviceSettings = {
  enabled: true,
  maxDevices: 2,
  blockNewDevice: true,
  trackSessions: true,
  allowAdminReset: true,
  studentSelfRemove: false,
  selfRemoveCooldownDays: 30,
  oneActiveTestDevice: true,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeStudentDeviceSettings(raw: unknown): StudentDeviceSettings {
  const d = DEFAULT_STUDENT_DEVICE_SETTINGS;
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (key: keyof StudentDeviceSettings) => (typeof v[key] === "boolean" ? (v[key] as boolean) : (d[key] as boolean));
  return {
    enabled: bool("enabled"),
    maxDevices: clampInt(v.maxDevices, 1, MAX_DEVICE_LIMIT, d.maxDevices),
    blockNewDevice: bool("blockNewDevice"),
    trackSessions: bool("trackSessions"),
    allowAdminReset: bool("allowAdminReset"),
    studentSelfRemove: bool("studentSelfRemove"),
    selfRemoveCooldownDays: clampInt(v.selfRemoveCooldownDays, 1, MAX_SELF_REMOVE_COOLDOWN_DAYS, d.selfRemoveCooldownDays),
    oneActiveTestDevice: bool("oneActiveTestDevice"),
  };
}

let cache: { fetchedAt: number; value: StudentDeviceSettings } | null = null;

export async function getStudentDeviceSettings(): Promise<StudentDeviceSettings> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const value = normalizeStudentDeviceSettings(row?.value);
  cache = { fetchedAt: Date.now(), value };
  return value;
}

export async function saveStudentDeviceSettings(input: StudentDeviceSettings): Promise<StudentDeviceSettings> {
  const value = normalizeStudentDeviceSettings(input);
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: { ...value } },
    update: { value: { ...value } },
  });
  cache = { fetchedAt: Date.now(), value };
  return value;
}

/** Test hook: drop the in-process cache. */
export function clearStudentDeviceSettingsCache() {
  cache = null;
}
