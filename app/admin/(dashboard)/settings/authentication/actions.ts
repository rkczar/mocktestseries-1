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

export async function saveGoogleConfigAction(
  _prev: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);

  const enabled = formData.get("enabled") === "on";
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();

  await saveAuthProviderConfig({ google: { enabled, clientId, clientSecret: clientSecret || undefined } });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "AUTH_PROVIDER_GOOGLE_SAVED", entityType: "Setting", entityId: "auth.providers" },
  });

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

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "AUTH_PROVIDER_MSG91_SAVED", entityType: "Setting", entityId: "auth.providers" },
  });

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

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "AUTH_LOGIN_METHODS_SAVED", entityType: "Setting", entityId: "auth.providers" },
  });

  revalidateAuthSurfaces();
  return { success: true };
}

export async function testGoogleConnectionAction(): Promise<TestConnectionState> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const result = await testGoogleConnection();
  revalidateAuthSurfaces();
  return { result };
}

export async function testMsg91ConnectionAction(): Promise<TestConnectionState> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const result = await testMsg91Connection();
  revalidateAuthSurfaces();
  return { result };
}
