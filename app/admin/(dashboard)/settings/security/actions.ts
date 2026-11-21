"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStudentDeviceSettings, saveStudentDeviceSettings } from "@/lib/student-device-settings";
import { ADMIN_OTP_SETTING_KEY, clearAdminOtpLoginCache, getAdminOtpMethods, saveAdminOtpMethods } from "@/lib/admin-otp-settings";

export interface DeviceSettingsFormState {
  error?: string;
  success?: boolean;
}

export async function saveStudentDeviceSettingsAction(
  _prev: DeviceSettingsFormState,
  formData: FormData
): Promise<DeviceSettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const maxDevices = Number(formData.get("maxDevices"));
  const cooldown = Number(formData.get("selfRemoveCooldownDays"));
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) {
    return { error: "Maximum registered devices must be a whole number from 1 to 10." };
  }
  if (!Number.isInteger(cooldown) || cooldown < 1 || cooldown > 365) {
    return { error: "Self-removal cooldown must be 1 to 365 days." };
  }

  const before = await getStudentDeviceSettings();
  const after = await saveStudentDeviceSettings({
    enabled: formData.get("enabled") === "on",
    maxDevices,
    blockNewDevice: formData.get("blockNewDevice") === "on",
    trackSessions: formData.get("trackSessions") === "on",
    allowAdminReset: formData.get("allowAdminReset") === "on",
    studentSelfRemove: formData.get("studentSelfRemove") === "on",
    selfRemoveCooldownDays: cooldown,
    oneActiveTestDevice: formData.get("oneActiveTestDevice") === "on",
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "STUDENT_DEVICE_SETTINGS_SAVED",
      entityType: "Setting",
      entityId: "security.student_devices",
      metadata: { before: { ...before }, after: { ...after } },
    },
  });
  revalidatePath("/admin/settings/security");
  revalidatePath("/admin/security");
  return { success: true };
}

/** Admin "Login with OTP" switches (Email OTP, Mobile OTP — independent): Master Admin only (permission AND role, re-read per call). Audited. */
export async function saveAdminOtpLoginAction(_prev: DeviceSettingsFormState, formData: FormData): Promise<DeviceSettingsFormState> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (session.user.role !== "MASTER_ADMIN") return { error: "Only the Master Admin can change this setting." };
  clearAdminOtpLoginCache();
  const before = await getAdminOtpMethods();
  const after = { email: formData.get("enabled") === "on", mobile: formData.get("mobileEnabled") === "on" };
  if ((after.email && !before.email) || (after.mobile && !before.mobile)) {
    const me = await prisma.adminUser.findUnique({ where: { id: session.user.id }, select: { email: true, emailVerifiedAt: true, mobile: true, mobileVerifiedAt: true } });
    if (after.email && !before.email && !(me?.email && me.emailVerifiedAt)) {
      return { error: "Add and verify your own email first (Admin Users & Access → Edit Admin), then turn Email OTP on." };
    }
    if (after.mobile && !before.mobile && !(me?.mobile && me.mobileVerifiedAt)) {
      return { error: "Add and verify your own mobile number first (Admin Users & Access → Edit Admin), then turn Mobile OTP on." };
    }
  }
  await saveAdminOtpMethods(after);
  if (before.email !== after.email || before.mobile !== after.mobile) {
    await prisma.auditLog.create({
      data: { actorId: session.user.id, action: "ADMIN_OTP_LOGIN_SETTING_CHANGED", entityType: "Setting", entityId: ADMIN_OTP_SETTING_KEY, metadata: { before: { enabled: before.email, mobileEnabled: before.mobile }, after: { enabled: after.email, mobileEnabled: after.mobile } } },
    });
  }
  revalidatePath("/admin/settings/security");
  return { success: true };
}
