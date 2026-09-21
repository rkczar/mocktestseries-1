import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Non-secret Ask AI configuration (provider selection, generation toggles,
 * student access limits, homepage demo) — stored in the existing `Setting`
 * key-value table under `ai.settings`. Provider *credentials* live in their
 * own per-provider modules (lib/gemini-config.ts, lib/openai-config.ts);
 * this only stores which of those configured providers is active/fallback
 * and everything else that isn't a secret.
 */

const SETTING_KEY = "ai.settings";
const CACHE_TTL_MS = 15_000;

export type AiProviderName = "gemini" | "openai";
export type AiProviderChoice = AiProviderName | "none";

export interface AiSettings {
  askAiEnabled: boolean;
  activeProvider: AiProviderName;
  fallbackProvider: AiProviderChoice;

  /** Daily count of DISTINCT questions a FREE-plan student may Ask AI on. Admin-editable, never hardcoded elsewhere. */
  freeDailyLimit: number;
  /** null = unlimited. No real payment/subscription system exists yet (see getStudentAiEntitlement) — this is the ceiling a future paid plan would use. */
  paidDailyLimit: number | null;

  generateOptionAnalysis: boolean;
  generateMemoryTrick: boolean;
  generateExaminerTraps: boolean;
  generatePointsToRemember: boolean;
  maxRelatedQuestions: number;

  homepageDemoEnabled: boolean;
  homepageDemoMaxQuestions: number;
}

interface StoredAiSettings extends Partial<AiSettings> {
  updatedAt?: string;
}

const DEFAULTS: AiSettings = {
  askAiEnabled: true,
  activeProvider: "gemini",
  fallbackProvider: "none",
  freeDailyLimit: 10,
  paidDailyLimit: null,
  generateOptionAnalysis: true,
  generateMemoryTrick: true,
  generateExaminerTraps: true,
  generatePointsToRemember: true,
  maxRelatedQuestions: 5,
  homepageDemoEnabled: false,
  homepageDemoMaxQuestions: 12,
};

let cache: { fetchedAt: number; value: AiSettings } | null = null;

export function bumpAiSettingsEpoch() {
  cache = null;
}

async function readStored(): Promise<StoredAiSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return {};
  return (row.value as StoredAiSettings) ?? {};
}

export async function getAiSettings(): Promise<AiSettings> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const raw = await readStored();
  const value: AiSettings = { ...DEFAULTS, ...raw };
  cache = { fetchedAt: Date.now(), value };
  return value;
}

export type AiSettingsUpdate = Partial<AiSettings>;

export async function saveAiSettings(update: AiSettingsUpdate): Promise<void> {
  const raw = await readStored();
  const next: StoredAiSettings = { ...raw, ...update, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
  bumpAiSettingsEpoch();
}
