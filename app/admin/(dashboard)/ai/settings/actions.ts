"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { saveGeminiConfig, testGeminiConnection, type ProviderLastTest } from "@/lib/gemini-config";

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
