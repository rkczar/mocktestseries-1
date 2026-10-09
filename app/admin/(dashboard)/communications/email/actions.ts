"use server";

import { revalidatePath } from "next/cache";
import type { EmailAudience, EmailTemplateKey } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { getClientIp } from "@/lib/client-ip";
import { sendEmailOtp, recordEmailOtpTest, getEmailOtpSettings, setEmailOtpEnabled, EmailOtpError } from "@/lib/email-otp";
import { PERMISSIONS } from "@/lib/permissions";
import { getEmailEnvConfig } from "@/lib/email/config";
import { getEmailProvider } from "@/lib/email/provider";
import { getEmailSettings, hasSuccessfulTestEmail, saveEmailSettings } from "@/lib/email/settings";
import { countAudience, searchStudents } from "@/lib/email/audience";
import { TEMPLATE_DEFAULTS, TEMPLATE_KEYS } from "@/lib/email/templates";
import {
  EmailAdminError,
  cancelCampaign,
  campaignAudienceCount,
  cleanContent,
  deleteDraftCampaign,
  queueCampaign,
  renderPreview,
  retryFailedEmail,
  saveCampaignDraft,
  sendTestEmail,
  type CampaignInput,
  type ContentInput,
} from "@/lib/email/admin";

/**
 * Admin → Communications → Email Server Actions. Every mutation requires
 * EMAIL_MANAGE (MASTER_ADMIN only) server-side; recipients are always
 * resolved here from the audience, never trusted from the browser.
 */

type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string };

/** EMAIL_MANAGE — MASTER_ADMIN only. Called first in every action below. */
async function requireEmailManager() {
  return requirePermission(PERMISSIONS.EMAIL_MANAGE);
}

function adminOf(session: Awaited<ReturnType<typeof requireEmailManager>>) {
  return { adminId: session.user.id as string, adminName: session.user.name ?? "Admin" };
}

/** Turns thrown errors into a readable result; never leaks internals. */
async function guard<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    if (error instanceof EmailAdminError) return { ok: false, error: error.message };
    if (error instanceof UnauthorizedError) return { ok: false, error: "Only a Master Admin can manage email." };
    console.error("[email] admin action failed", { name: error instanceof Error ? error.name : "UNKNOWN" });
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

const revalidate = () => revalidatePath("/admin/communications");

export async function searchStudentsAction(query: string) {
  return guard(async () => {
    await requireEmailManager();
    return { students: await searchStudents(String(query ?? "").slice(0, 100)) };
  });
}

export async function previewEmailAction(content: ContentInput, opts: { promotional: boolean; studentId?: string | null }) {
  return guard(async () => {
    await requireEmailManager();
    const clean = await cleanContent(content, { allowEmptySubject: true });
    return renderPreview(clean, { promotional: Boolean(opts?.promotional), studentId: opts?.studentId ?? null });
  });
}

/** Saves the draft and returns the server-side recipient count for the confirmation step. */
export async function saveCampaignDraftAction(input: CampaignInput, campaignId: string | null) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    const campaign = await saveCampaignDraft(input, adminId, campaignId);
    const counts = await campaignAudienceCount(campaign);
    const preview = await renderPreview(campaign, {
      promotional: true,
      studentId: campaign.audience === "INDIVIDUAL" || campaign.audience === "SELECTED" ? campaign.studentIds[0] : null,
    });
    revalidate();
    return { campaignId: campaign.id, counts, preview, status: campaign.status };
  });
}

export async function queueCampaignAction(campaignId: string, expectedRecipients: number) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    const { queued } = await queueCampaign(String(campaignId), adminId, Number(expectedRecipients));
    revalidate();
    return { queued };
  });
}

export async function cancelCampaignAction(campaignId: string) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    const r = await cancelCampaign(String(campaignId), adminId);
    revalidate();
    return r;
  });
}

export async function deleteDraftCampaignAction(campaignId: string) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    await deleteDraftCampaign(String(campaignId));
    await prisma.auditLog.create({ data: { actorId: adminId, action: "EMAIL_CAMPAIGN_DRAFT_DELETED", entityType: "EmailCampaign", entityId: String(campaignId) } });
    revalidate();
    return {};
  });
}

export async function audienceCountAction(spec: { audience: EmailAudience; examId?: string | null; studentIds?: string[] }) {
  return guard(async () => {
    await requireEmailManager();
    return { counts: await countAudience({ audience: spec.audience, examId: spec.examId ?? null, studentIds: (spec.studentIds ?? []).slice(0, 500) }) };
  });
}

export async function saveTemplateAction(key: EmailTemplateKey, content: ContentInput, enabled: boolean) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    if (!TEMPLATE_KEYS.includes(key)) throw new EmailAdminError("Unknown template.");
    const clean = await cleanContent(content, { allowEmptySubject: false });
    await prisma.emailTemplate.upsert({
      where: { key },
      create: { key, ...clean, enabled: Boolean(enabled), updatedByAdminId: adminId },
      update: { ...clean, enabled: Boolean(enabled), updatedByAdminId: adminId },
    });
    await prisma.auditLog.create({ data: { actorId: adminId, action: "EMAIL_TEMPLATE_UPDATED", entityType: "EmailTemplate", entityId: key, metadata: { enabled: Boolean(enabled) } } });
    revalidate();
    return {};
  });
}

export async function setTemplateEnabledAction(key: EmailTemplateKey, enabled: boolean) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    if (!TEMPLATE_KEYS.includes(key)) throw new EmailAdminError("Unknown template.");
    const def = TEMPLATE_DEFAULTS[key];
    await prisma.emailTemplate.upsert({
      where: { key },
      create: { key, subject: def.subject, heading: def.heading, bodyHtml: def.bodyHtml, ctaText: def.ctaText, ctaUrl: def.ctaUrl, enabled: Boolean(enabled), updatedByAdminId: adminId },
      update: { enabled: Boolean(enabled), updatedByAdminId: adminId },
    });
    await prisma.auditLog.create({ data: { actorId: adminId, action: enabled ? "EMAIL_TEMPLATE_ENABLED" : "EMAIL_TEMPLATE_DISABLED", entityType: "EmailTemplate", entityId: key } });
    revalidate();
    return {};
  });
}

export async function resetTemplateAction(key: EmailTemplateKey) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    if (!TEMPLATE_KEYS.includes(key)) throw new EmailAdminError("Unknown template.");
    await prisma.emailTemplate.deleteMany({ where: { key } });
    await prisma.auditLog.create({ data: { actorId: adminId, action: "EMAIL_TEMPLATE_RESET", entityType: "EmailTemplate", entityId: key } });
    revalidate();
    return {};
  });
}

export async function sendTestEmailAction(to: string, templateKey: EmailTemplateKey) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    const result = await sendTestEmail(String(to ?? ""), templateKey, adminId);
    revalidate();
    return { status: result.status, failureReason: result.failureReason, providerMessageId: result.providerMessageId };
  });
}

export async function checkProviderAction() {
  return guard(async () => {
    await requireEmailManager();
    return { check: await getEmailProvider().checkConnection() };
  });
}

export async function saveEmailSettingsAction(input: { sendingEnabled: boolean; ratePerSecond: number }) {
  return guard(async () => {
    const { adminId, adminName } = adminOf(await requireEmailManager());
    const sendingEnabled = Boolean(input.sendingEnabled);
    const current = await getEmailSettings();
    if (sendingEnabled && !current.sendingEnabled) {
      if (!getEmailEnvConfig().providerConfigured) throw new EmailAdminError("Email provider not configured. Production sending can't be turned on yet.");
      if (!(await hasSuccessfulTestEmail())) throw new EmailAdminError("Send one successful test email first, then turn on production sending.");
    }
    const rate = Number(input.ratePerSecond);
    await saveEmailSettings({ sendingEnabled, ratePerSecond: Number.isFinite(rate) ? rate : current.ratePerSecond }, adminName);
    await prisma.auditLog.create({
      data: { actorId: adminId, action: "EMAIL_SETTINGS_UPDATED", entityType: "Setting", entityId: "email.settings", metadata: { sendingEnabled, ratePerSecond: rate } },
    });
    revalidate();
    return {};
  });
}

export async function retryFailedEmailAction(logId: string) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    await retryFailedEmail(String(logId), adminId);
    revalidate();
    return {};
  });
}

// ------------------------------------------------------ Security code emails
// Email OTP (lib/email-otp.ts) has its own switch, independent of production
// sending: codes go straight to the provider, never through the queue.

export async function sendTestSecurityCodeAction(to: string) {
  return guard(async () => {
    const { adminId } = adminOf(await requireEmailManager());
    let ok = true;
    let message = "Test code sent. Check the inbox.";
    try {
      await sendEmailOtp({ email: String(to ?? ""), purpose: "ADMIN_TEST", studentId: null, ipAddress: await getClientIp(), ignoreSwitch: true });
    } catch (error) {
      if (!(error instanceof EmailOtpError)) throw error;
      ok = false;
      message = error.message;
    }
    await recordEmailOtpTest({ ok, message });
    await prisma.auditLog.create({
      data: { actorId: adminId, action: "EMAIL_OTP_TEST_SENT", entityType: "Setting", entityId: "email.otp", metadata: { ok } },
    });
    revalidate();
    if (!ok) throw new EmailAdminError(message);
    return { message };
  });
}

export async function setSecurityCodeEmailsAction(enabled: boolean) {
  return guard(async () => {
    const { adminId, adminName } = adminOf(await requireEmailManager());
    const next = Boolean(enabled);
    if (next) {
      if (!getEmailEnvConfig().providerConfigured) throw new EmailAdminError("Email provider not configured.");
      if (!(await getEmailOtpSettings()).lastTest?.ok) throw new EmailAdminError("Send a test security code and confirm it arrives first.");
    }
    await setEmailOtpEnabled(next, adminName);
    await prisma.auditLog.create({
      data: { actorId: adminId, action: "EMAIL_OTP_SETTINGS_UPDATED", entityType: "Setting", entityId: "email.otp", metadata: { enabled: next } },
    });
    revalidate();
    return {};
  });
}
