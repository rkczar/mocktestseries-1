"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  saveAuthProviderConfig,
  testGoogleConnection,
  testMsg91Connection,
  type ProviderLastTest,
} from "@/lib/auth-provider-config";

export interface SettingsFormState {
  error?: string;
  success?: boolean;
}

export interface TestConnectionState {
  result?: ProviderLastTest;
  error?: string;
}

function revalidateAuthSurfaces() {
  revalidatePath("/admin/settings/authentication");
  revalidatePath("/login");
}

async function logAudit(
  actorId: string | undefined,
  action: string,
  entityId: string,
  metadata?: Record<string, boolean>
) {
  await prisma.auditLog.create({ data: { actorId, action, entityType: "Setting", entityId, metadata } });
}

export async function saveGoogleConfigAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  const enabled = formData.get("enabled") === "on";
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();

  await saveAuthProviderConfig({ google: { enabled, clientId, clientSecret: clientSecret || undefined } });
  await logAudit(session.user.id, "AUTH_PROVIDER_GOOGLE_SAVED", "auth.providers", { enabled });

  revalidateAuthSurfaces();
  return { success: true };
}

export async function saveMsg91ConfigAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  const enabled = formData.get("enabled") === "on";
  const authKey = String(formData.get("authKey") ?? "").trim();
  const senderId = String(formData.get("senderId") ?? "").trim();
  const flowId = String(formData.get("flowId") ?? "").trim();
  const widgetId = String(formData.get("widgetId") ?? "").trim();

  await saveAuthProviderConfig({
    msg91: { enabled, authKey: authKey || undefined, senderId, flowId, widgetId },
  });
  await logAudit(session.user.id, "AUTH_PROVIDER_MSG91_SAVED", "auth.providers", { enabled });

  revalidateAuthSurfaces();
  return { success: true };
}

export async function saveLoginMethodTogglesAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  await saveAuthProviderConfig({
    toggles: {
      passwordEnabled: formData.get("passwordEnabled") === "on",
      otpEnabled: formData.get("otpEnabled") === "on",
      registerEnabled: formData.get("registerEnabled") === "on",
    },
  });

  await logAudit(session.user.id, "AUTH_LOGIN_METHODS_SAVED", "auth.providers");

  revalidateAuthSurfaces();
  return { success: true };
}

export async function testGoogleConnectionAction(): Promise<TestConnectionState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const result = await testGoogleConnection();
  await logAudit(session.user.id, "AUTH_PROVIDER_GOOGLE_TESTED", "auth.providers", { ok: result.ok });
  revalidateAuthSurfaces();
  return { result };
}

export async function testMsg91ConnectionAction(): Promise<TestConnectionState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const result = await testMsg91Connection();
  await logAudit(session.user.id, "AUTH_PROVIDER_MSG91_TESTED", "auth.providers", { ok: result.ok });
  revalidateAuthSurfaces();
  return { result };
}
