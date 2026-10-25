import "server-only";
import { prisma } from "@/lib/prisma";
import { BRAND_NAME } from "@/lib/brand";

/**
 * AI Video Studio settings — one JSON document in the existing `Setting`
 * table (key "video.studio"). A missing row means the defaults below.
 * Retention and limits are storage/safety policy, not spending caps: paid
 * work is governed by the AI Engine's existing quote + confirmation flow.
 */

export const VIDEO_SETTINGS_KEY = "video.studio";

export interface VideoStudioSettings {
  /** Hours a delivered (downloaded / published) video's media are kept before cleanup. */
  deliveredRetentionHours: number;
  /** Hours an undelivered finished video is kept (the admin still has time to download it). */
  undeliveredRetentionHours: number;
  /** Hours a draft / unconfirmed job may sit idle before it counts as abandoned. */
  abandonedAfterHours: number;
  /** Hours a FAILED job keeps its media so Retry can resume from the failed step; then they are deleted. */
  failedRetentionHours: number;
  /** Hard cap: whatever its state, a job's media are deleted this many days after the job was created (nothing is kept indefinitely). */
  maxRetentionDays: number;
  /** Largest single upload (MB). */
  maxUploadMb: number;
  /** Media a single job may hold (MB). */
  jobQuotaMb: number;
  /** New jobs are refused while the disk has less free space than this (GB). */
  minFreeDiskGb: number;
  /** Render jobs at the same time (the worker enforces it). */
  maxConcurrentRenders: number;
  /** Per-render wall-clock limit (minutes); the worker kills a render that exceeds it. */
  renderTimeoutMin: number;
  /** CPU cores and memory one render container may use (the web app always wins CPU contention). */
  renderCpus: number;
  renderMemoryMb: number;
  /** Longest recorded video the AI Video Editor accepts (minutes). */
  maxUploadMinutes: number;
  /** Speech-to-text model (OpenRouter transcription catalog) for editor subtitles; null = choose in Voice Studio first. */
  transcriptionModel: string | null;
  /** Background-music level under narration (0–100 %; ducked further while someone speaks). */
  musicVolumePct: number;
  brand: {
    wordmark: string;
    cta: string;
    showBranding: boolean;
  };
  updatedAt: string | null;
}

export const DEFAULT_VIDEO_SETTINGS: VideoStudioSettings = {
  deliveredRetentionHours: 24,
  undeliveredRetentionHours: 72,
  abandonedAfterHours: 48,
  failedRetentionHours: 72,
  maxRetentionDays: 14,
  maxUploadMb: 500,
  jobQuotaMb: 2048,
  minFreeDiskGb: 8,
  maxConcurrentRenders: 1,
  renderTimeoutMin: 20,
  renderCpus: 1,
  renderMemoryMb: 1536,
  maxUploadMinutes: 15,
  transcriptionModel: null,
  musicVolumePct: 12,
  brand: { wordmark: BRAND_NAME, cta: `Practice more on ${BRAND_NAME}`, showBranding: true },
  updatedAt: null,
};

export const SETTING_LIMITS = {
  deliveredRetentionHours: [1, 24 * 14],
  undeliveredRetentionHours: [1, 24 * 30],
  abandonedAfterHours: [1, 24 * 30],
  failedRetentionHours: [1, 24 * 14],
  maxRetentionDays: [1, 30],
  maxUploadMb: [10, 2048],
  jobQuotaMb: [100, 10240],
  minFreeDiskGb: [2, 100],
  maxConcurrentRenders: [1, 2],
  renderTimeoutMin: [2, 60],
  renderCpus: [1, 2],
  renderMemoryMb: [768, 3072],
  maxUploadMinutes: [1, 60],
  musicVolumePct: [0, 60],
} as const;

function num(v: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

function text(v: unknown, max: number, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;
}

export function parseVideoSettings(raw: unknown): VideoStudioSettings {
  const d = DEFAULT_VIDEO_SETTINGS;
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const b = r.brand && typeof r.brand === "object" ? (r.brand as Record<string, unknown>) : {};
  const out = {} as Record<keyof typeof SETTING_LIMITS, number>;
  for (const k of Object.keys(SETTING_LIMITS) as (keyof typeof SETTING_LIMITS)[]) out[k] = num(r[k], SETTING_LIMITS[k], d[k]);
  const tm = typeof r.transcriptionModel === "string" && /^[a-z0-9][a-z0-9._-]{0,60}\/[A-Za-z0-9._:-]{1,100}$/.test(r.transcriptionModel) ? r.transcriptionModel : null;
  return {
    ...out,
    transcriptionModel: tm,
    brand: {
      wordmark: text(b.wordmark, 40, d.brand.wordmark),
      cta: text(b.cta, 80, d.brand.cta),
      showBranding: typeof b.showBranding === "boolean" ? b.showBranding : d.brand.showBranding,
    },
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
  };
}

export async function getVideoSettings(): Promise<VideoStudioSettings> {
  const row = await prisma.setting.findUnique({ where: { key: VIDEO_SETTINGS_KEY } });
  return parseVideoSettings(row?.value);
}

/** Callers own the RBAC check (VIDEO_STUDIO_MANAGE). */
export async function saveVideoSettings(input: unknown): Promise<VideoStudioSettings> {
  const parsed = parseVideoSettings(input);
  const value = { ...parsed, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: VIDEO_SETTINGS_KEY }, update: { value }, create: { key: VIDEO_SETTINGS_KEY, value } });
  return value;
}
