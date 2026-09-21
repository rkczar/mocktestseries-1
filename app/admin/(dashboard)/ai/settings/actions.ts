"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { saveGeminiConfig, testGeminiConnection, type ProviderLastTest } from "@/lib/gemini-config";
import { saveOpenAiConfig, testOpenAiConnection } from "@/lib/openai-config";
import { saveAiSettings, type AiSettingsUpdate, HOMEPAGE_DEMO_MAX } from "@/lib/ai-settings";

export interface SettingsFormState {
  error?: string;
  success?: boolean;
}

export interface TestConnectionState {
  result?: ProviderLastTest;
  error?: string;
}

function revalidateAiSurfaces() {
  revalidatePath("/admin/ai/settings");
  revalidatePath("/admin/ai");
  revalidatePath("/admin/settings/authentication");
}

export async function saveGeminiConfigAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  const enabled = formData.get("enabled") === "on";
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const model = String(formData.get("model") ?? "").trim();

  await saveGeminiConfig({ enabled, apiKey: apiKey || undefined, model });
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "API_GEMINI_SAVED", entityType: "Setting", entityId: "api.gemini", metadata: { enabled } } });

  revalidateAiSurfaces();
  return { success: true };
}

export async function testGeminiConnectionAction(): Promise<TestConnectionState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const result = await testGeminiConnection();
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "API_GEMINI_TESTED", entityType: "Setting", entityId: "api.gemini", metadata: { ok: result.ok } } });
  revalidateAiSurfaces();
  return { result };
}

export async function saveOpenAiConfigAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  const enabled = formData.get("enabled") === "on";
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const model = String(formData.get("model") ?? "").trim();

  await saveOpenAiConfig({ enabled, apiKey: apiKey || undefined, model });
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "API_OPENAI_SAVED", entityType: "Setting", entityId: "api.openai", metadata: { enabled } } });

  revalidateAiSurfaces();
  return { success: true };
}

export async function testOpenAiConnectionAction(): Promise<TestConnectionState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const result = await testOpenAiConnection();
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "API_OPENAI_TESTED", entityType: "Setting", entityId: "api.openai", metadata: { ok: result.ok } } });
  revalidateAiSurfaces();
  return { result };
}

export async function saveAiSettingsAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  const freeDailyLimitRaw = Number(formData.get("freeDailyLimit"));
  const paidUnlimited = formData.get("paidUnlimited") === "on";
  const paidDailyLimitRaw = Number(formData.get("paidDailyLimit"));
  const maxRelatedRaw = Number(formData.get("maxRelatedQuestions"));
  const homepageDemoMaxRaw = Number(formData.get("homepageDemoMaxQuestions"));

  const update: AiSettingsUpdate = {
    askAiEnabled: formData.get("askAiEnabled") === "on",
    activeProvider: formData.get("activeProvider") === "openai" ? "openai" : "gemini",
    fallbackProvider:
      formData.get("fallbackProvider") === "gemini" || formData.get("fallbackProvider") === "openai"
        ? (formData.get("fallbackProvider") as "gemini" | "openai")
        : "none",
    freeDailyLimit: Number.isFinite(freeDailyLimitRaw) && freeDailyLimitRaw > 0 ? Math.floor(freeDailyLimitRaw) : 10,
    paidDailyLimit: paidUnlimited ? null : Number.isFinite(paidDailyLimitRaw) && paidDailyLimitRaw > 0 ? Math.floor(paidDailyLimitRaw) : 10,
    generateOptionAnalysis: formData.get("generateOptionAnalysis") === "on",
    generateMemoryTrick: formData.get("generateMemoryTrick") === "on",
    generateExaminerTraps: formData.get("generateExaminerTraps") === "on",
    generatePointsToRemember: formData.get("generatePointsToRemember") === "on",
    maxRelatedQuestions: Number.isFinite(maxRelatedRaw) ? Math.min(5, Math.max(0, Math.floor(maxRelatedRaw))) : 5,
    homepageDemoEnabled: formData.get("homepageDemoEnabled") === "on",
    homepageDemoMaxQuestions:
      Number.isFinite(homepageDemoMaxRaw) && homepageDemoMaxRaw > 0 ? Math.min(HOMEPAGE_DEMO_MAX, Math.floor(homepageDemoMaxRaw)) : HOMEPAGE_DEMO_MAX,
  };

  await saveAiSettings(update);
  await prisma.auditLog.create({ data: { actorId: session.user.id, action: "AI_SETTINGS_SAVED", entityType: "Setting", entityId: "ai.settings", metadata: update } });

  revalidateAiSurfaces();
  revalidatePath("/");
  return { success: true };
}

/**
 * Admin-curated homepage "Ask AI in Action" question selection (Section on
 * public exam SEO hub). Separate action from saveAiSettingsAction so the
 * question picker can save independently of the general settings form.
 * Server-side max-10 enforcement — never trust the client checkbox count.
 */
export async function saveHomepageDemoSelectionAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  const ids = formData.getAll("questionId").map(String).filter(Boolean).slice(0, HOMEPAGE_DEMO_MAX);

  if (ids.length > 0) {
    const validCount = await prisma.aIExplanation.count({
      where: { questionId: { in: ids }, status: "COMPLETED", adminReviewedAt: { not: null }, isStale: false },
    });
    if (validCount !== ids.length) {
      return { error: "One or more selected questions no longer have an approved, reviewed AI explanation." };
    }
  }

  await saveAiSettings({ homepageDemoQuestionIds: ids });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "HOMEPAGE_AI_DEMO_SELECTION_SAVED", entityType: "Setting", entityId: "ai.settings", metadata: { ids } },
  });

  revalidateAiSurfaces();
  revalidatePath("/");
  return { success: true };
}
