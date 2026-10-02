import "server-only";
import crypto from "node:crypto";
import type { EmailAudience, EmailCampaign, EmailStatus, EmailTemplateKey, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { getEmailEnvConfig } from "@/lib/email/config";
import { renderEmailLayout } from "@/lib/email/layout";
import { MAX_BODY_HTML_LENGTH, normalizeEmailUrl, sanitizeEmailHtml } from "@/lib/email/sanitize";
import { COMPOSE_TEMPLATE_KEYS, renderContent, TEMPLATE_DEFAULTS, type TemplateContent, type TemplateVars } from "@/lib/email/templates";
import { countAudience, iterateSendable, MAX_SELECTED_STUDENTS, type AudienceSpec } from "@/lib/email/audience";
import { claimDueEmails, enqueueEmail, processClaimedEmail } from "@/lib/email/queue";
import { getEmailSettings, hasSuccessfulTestEmail } from "@/lib/email/settings";

/**
 * Admin → Communications → Email: everything the admin UI reads or
 * changes, behind the Server Actions in
 * app/admin/(dashboard)/communications/email/actions.ts (which enforce RBAC).
 */

export class EmailAdminError extends Error {}

// ---------------------------------------------------------------------------
// Content validation (Compose, Campaigns, Templates)
// ---------------------------------------------------------------------------

export interface ContentInput {
  subject: string;
  heading: string;
  bodyHtml: string;
  ctaText?: string | null;
  ctaUrl?: string | null;
}

/** Trims, sanitizes and validates admin-authored content. Throws EmailAdminError with a readable message. */
export async function cleanContent(input: ContentInput, opts: { allowEmptySubject?: boolean } = {}): Promise<TemplateContent> {
  const subject = String(input.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  const heading = String(input.heading ?? "").replace(/[\r\n]+/g, " ").trim();
  const bodyHtml = sanitizeEmailHtml(String(input.bodyHtml ?? ""));
  const ctaText = String(input.ctaText ?? "").trim() || null;
  const rawCtaUrl = String(input.ctaUrl ?? "").trim() || null;

  if (!opts.allowEmptySubject && !subject) throw new EmailAdminError("Subject is required.");
  if (subject.length > 200) throw new EmailAdminError("Subject must be 200 characters or fewer.");
  if (heading.length > 200) throw new EmailAdminError("Heading must be 200 characters or fewer.");
  if (!bodyHtml.replace(/<[^>]*>/g, "").trim()) throw new EmailAdminError("Email body is required.");
  if (bodyHtml.length > MAX_BODY_HTML_LENGTH) throw new EmailAdminError("Email body is too long.");
  if (ctaText && ctaText.length > 60) throw new EmailAdminError("Button text must be 60 characters or fewer.");
  if (Boolean(ctaText) !== Boolean(rawCtaUrl)) throw new EmailAdminError("Fill in both the button text and the button URL, or leave both empty.");

  let ctaUrl: string | null = null;
  if (rawCtaUrl) {
    ctaUrl = normalizeEmailUrl(rawCtaUrl, await getSiteUrl());
    if (!ctaUrl) throw new EmailAdminError("Button URL must be an https:// link, a site path such as /student/dashboard, or a URL variable such as {{dashboardUrl}}.");
  }
  return { subject, heading, bodyHtml, ctaText, ctaUrl };
}

const SAMPLE_VARS: TemplateVars = {
  studentName: "Priya Sharma",
  email: "student@example.com",
  studentId: "MTS-000123",
  examName: "Rajasthan Medical Officer",
  testName: "RUHS MO Mock Test 1",
  productName: "RUHS MO Complete Test Series",
  amount: "₹499.00",
  orderNumber: "MTS-ORD-000045",
  invoiceNumber: "MTS/2026-27/00045",
  paymentId: "pay_SAMPLE123",
};

/** Full HTML preview with sample (or a real student's) values. */
export async function renderPreview(content: TemplateContent, opts: { promotional: boolean; studentId?: string | null }) {
  const siteUrl = await getSiteUrl();
  let vars: TemplateVars = { ...SAMPLE_VARS };
  if (opts.studentId) {
    const s = await prisma.student.findUnique({ where: { id: opts.studentId }, select: { name: true, email: true, studentId: true } });
    if (s) vars = { ...vars, studentName: s.name, email: s.email ?? "", studentId: s.studentId };
  }
  vars = {
    ...vars,
    siteUrl,
    supportEmail: "support@mocktestseries.in",
    loginUrl: `${siteUrl}/login`,
    resetUrl: `${siteUrl}/login?tab=forgot`,
    dashboardUrl: `${siteUrl}/student/dashboard`,
    invoiceUrl: `${siteUrl}/student/payments`,
  };
  const rendered = renderContent({ ...content, bodyHtml: sanitizeEmailHtml(content.bodyHtml) }, vars);
  const { html } = renderEmailLayout({
    heading: rendered.heading,
    bodyHtml: rendered.bodyHtml,
    ctaText: rendered.ctaText,
    ctaUrl: rendered.ctaUrl,
    siteUrl,
    preferencesUrl: `${siteUrl}/email/preferences`,
    promotional: opts.promotional,
  });
  return { subject: rendered.subject, html };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface CampaignInput extends ContentInput {
  name: string;
  templateKey: EmailTemplateKey;
  audience: EmailAudience;
  examId?: string | null;
  studentIds?: string[];
}

async function cleanAudience(input: { audience: EmailAudience; examId?: string | null; studentIds?: string[] }): Promise<AudienceSpec> {
  const audiences: EmailAudience[] = ["INDIVIDUAL", "SELECTED", "ALL", "PAID", "FREE", "EXAM"];
  if (!audiences.includes(input.audience)) throw new EmailAdminError("Choose an audience.");
  if (input.audience === "EXAM") {
    if (!input.examId) throw new EmailAdminError("Choose an exam.");
    const exam = await prisma.exam.findUnique({ where: { id: input.examId }, select: { id: true } });
    if (!exam) throw new EmailAdminError("That exam no longer exists.");
    return { audience: "EXAM", examId: exam.id };
  }
  if (input.audience === "INDIVIDUAL" || input.audience === "SELECTED") {
    const ids = [...new Set((input.studentIds ?? []).filter((id) => typeof id === "string" && /^[a-z0-9]{10,40}$/i.test(id)))];
    if (ids.length === 0) throw new EmailAdminError("Choose at least one student.");
    if (input.audience === "INDIVIDUAL" && ids.length !== 1) throw new EmailAdminError("Individual email goes to exactly one student.");
    if (ids.length > MAX_SELECTED_STUDENTS) throw new EmailAdminError(`Select at most ${MAX_SELECTED_STUDENTS} students, or use an audience filter.`);
    return { audience: input.audience, studentIds: ids };
  }
  return { audience: input.audience };
}

/** Creates or updates a DRAFT campaign. Only drafts are editable. */
export async function saveCampaignDraft(input: CampaignInput, adminId: string, campaignId?: string | null): Promise<EmailCampaign> {
  if (!COMPOSE_TEMPLATE_KEYS.includes(input.templateKey)) throw new EmailAdminError("Choose a compose template.");
  const content = await cleanContent(input);
  const spec = await cleanAudience(input);
  const name = (String(input.name ?? "").trim() || content.subject).slice(0, 120);
  const data = {
    name,
    templateKey: input.templateKey,
    ...content,
    audience: spec.audience,
    examId: spec.examId ?? null,
    studentIds: spec.studentIds ?? [],
  };
  if (campaignId) {
    const updated = await prisma.emailCampaign.updateMany({ where: { id: campaignId, status: "DRAFT" }, data });
    if (updated.count !== 1) throw new EmailAdminError("Only draft campaigns can be edited.");
    return prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  }
  return prisma.emailCampaign.create({ data: { ...data, createdByAdminId: adminId } });
}

export async function campaignAudienceCount(campaign: Pick<EmailCampaign, "audience" | "examId" | "studentIds">) {
  return countAudience({ audience: campaign.audience, examId: campaign.examId, studentIds: campaign.studentIds });
}

/**
 * Queues a DRAFT campaign: one EmailDeliveryLog row per sendable student.
 * The DRAFT → SENDING flip is a conditional UPDATE inside the same
 * transaction as the inserts, so a double click, a second tab or a retried
 * request can never queue the campaign twice, and a failure leaves it a
 * draft. Row keys `campaign:<id>:<studentId>` are UNIQUE as a second guard.
 * Sending itself happens in the worker, never in this request.
 */
export async function queueCampaign(campaignId: string, adminId: string, expectedRecipients: number) {
  const env = getEmailEnvConfig();
  if (!env.providerConfigured) throw new EmailAdminError("Email provider not configured. Add RESEND_API_KEY first.");
  const settings = await getEmailSettings();
  if (!settings.sendingEnabled) throw new EmailAdminError("Production sending is off. Turn it on in Email → Settings after a successful test email.");

  const campaign = await prisma.emailCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new EmailAdminError("Campaign not found.");
  if (campaign.status !== "DRAFT") throw new EmailAdminError("This campaign has already been queued.");
  // Content is re-validated at queue time (it may predate a rule change).
  await cleanContent(campaign);
  const counts = await campaignAudienceCount(campaign);
  if (counts.sendable === 0) throw new EmailAdminError("No students match this audience.");
  if (counts.sendable !== expectedRecipients) {
    throw new EmailAdminError(`The audience changed to ${counts.sendable} recipients since you reviewed it. Review and confirm again.`);
  }

  const spec: AudienceSpec = { audience: campaign.audience, examId: campaign.examId, studentIds: campaign.studentIds };
  return prisma.$transaction(
    async (tx) => {
      const flipped = await tx.emailCampaign.updateMany({
        where: { id: campaignId, status: "DRAFT" },
        data: { status: "SENDING", queuedAt: new Date(), queuedByAdminId: adminId },
      });
      if (flipped.count !== 1) throw new EmailAdminError("This campaign has already been queued.");
      let queued = 0;
      for await (const page of iterateSendable(spec)) {
        queued += await tx.emailDeliveryLog
          .createMany({
            data: page.map((s) => ({
              idempotencyKey: `campaign:${campaignId}:${s.id}`,
              templateKey: campaign.templateKey,
              category: "PROMOTIONAL" as const,
              campaignId,
              studentId: s.id,
              toEmail: s.email,
              subject: campaign.subject,
              createdByAdminId: adminId,
            })),
            skipDuplicates: true,
          })
          .then((r) => r.count);
      }
      await tx.emailCampaign.update({ where: { id: campaignId }, data: { recipientCount: queued } });
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: "EMAIL_CAMPAIGN_QUEUED",
          entityType: "EmailCampaign",
          entityId: campaignId,
          metadata: { name: campaign.name, audience: campaign.audience, examId: campaign.examId, recipients: queued },
        },
      });
      return { queued };
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
}

export async function cancelCampaign(campaignId: string, adminId: string) {
  return prisma.$transaction(async (tx) => {
    const flipped = await tx.emailCampaign.updateMany({
      where: { id: campaignId, status: { in: ["DRAFT", "SENDING"] } },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    if (flipped.count !== 1) throw new EmailAdminError("Only draft or sending campaigns can be cancelled.");
    const cancelled = await tx.emailDeliveryLog.updateMany({
      where: { campaignId, status: "QUEUED" },
      data: { status: "CANCELLED", failureReason: "Campaign cancelled by admin" },
    });
    await tx.auditLog.create({
      data: { actorId: adminId, action: "EMAIL_CAMPAIGN_CANCELLED", entityType: "EmailCampaign", entityId: campaignId, metadata: { cancelledRows: cancelled.count } },
    });
    return { cancelledRows: cancelled.count };
  });
}

export async function deleteDraftCampaign(campaignId: string) {
  const deleted = await prisma.emailCampaign.deleteMany({ where: { id: campaignId, status: "DRAFT" } });
  if (deleted.count !== 1) throw new EmailAdminError("Only drafts can be deleted.");
}

export async function listCampaigns(limit = 50) {
  const campaigns = await prisma.emailCampaign.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { createdByAdmin: { select: { name: true } }, exam: { select: { name: true } } },
  });
  const ids = campaigns.map((c) => c.id);
  const grouped = ids.length
    ? await prisma.emailDeliveryLog.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: ids } }, _count: { _all: true } })
    : [];
  const counts = new Map<string, Partial<Record<EmailStatus, number>>>();
  for (const g of grouped) {
    if (!g.campaignId) continue;
    const c = counts.get(g.campaignId) ?? {};
    c[g.status] = g._count._all;
    counts.set(g.campaignId, c);
  }
  return campaigns.map((c) => {
    const s = counts.get(c.id) ?? {};
    const n = (k: EmailStatus) => s[k] ?? 0;
    return {
      ...c,
      stats: {
        total: Object.values(s).reduce((a, b) => a + (b ?? 0), 0),
        queued: n("QUEUED") + n("SENDING"),
        sent: n("SENT") + n("DELIVERED") + n("BOUNCED") + n("COMPLAINED"),
        delivered: n("DELIVERED"),
        failed: n("FAILED") + n("BOUNCED") + n("COMPLAINED"),
        skipped: n("SKIPPED") + n("CANCELLED"),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export const LOG_PAGE_SIZE = 50;

export interface LogFilters {
  status?: EmailStatus | null;
  templateKey?: EmailTemplateKey | null;
  campaignId?: string | null;
  q?: string | null;
  page?: number;
}

export async function listEmailLogs(filters: LogFilters) {
  const where: Prisma.EmailDeliveryLogWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.templateKey) where.templateKey = filters.templateKey;
  if (filters.campaignId) where.campaignId = filters.campaignId;
  const q = filters.q?.trim();
  if (q) {
    where.OR = [
      { toEmail: { contains: q.toLowerCase() } },
      { student: { name: { contains: q, mode: "insensitive" } } },
      { student: { studentId: { contains: q.toUpperCase() } } },
      { subject: { contains: q, mode: "insensitive" } },
    ];
  }
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const [total, rows] = await Promise.all([
    prisma.emailDeliveryLog.count({ where }),
    prisma.emailDeliveryLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * LOG_PAGE_SIZE,
      take: LOG_PAGE_SIZE,
      include: { student: { select: { name: true, studentId: true } }, campaign: { select: { name: true } } },
    }),
  ]);
  return { total, page, pageCount: Math.max(1, Math.ceil(total / LOG_PAGE_SIZE)), rows };
}

/** Puts a FAILED row back in the queue (fresh attempts). */
export async function retryFailedEmail(logId: string, adminId: string) {
  const updated = await prisma.emailDeliveryLog.updateMany({
    where: { id: logId, status: "FAILED" },
    data: { status: "QUEUED", attempts: 0, nextAttemptAt: new Date(), failureReason: null, lockedAt: null },
  });
  if (updated.count !== 1) throw new EmailAdminError("Only failed emails can be retried.");
  await prisma.auditLog.create({ data: { actorId: adminId, action: "EMAIL_RETRIED", entityType: "EmailDeliveryLog", entityId: logId } });
}

// ---------------------------------------------------------------------------
// Overview / settings
// ---------------------------------------------------------------------------

const WORKER_HEARTBEAT_KEY = "email.worker_heartbeat";

export async function recordWorkerHeartbeat() {
  const value = { at: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: WORKER_HEARTBEAT_KEY }, create: { key: WORKER_HEARTBEAT_KEY, value }, update: { value } });
}

export async function getEmailOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [queued, sending, sent24, failed24, skipped24, heartbeat, testOk, settings] = await Promise.all([
    prisma.emailDeliveryLog.count({ where: { status: "QUEUED" } }),
    prisma.emailDeliveryLog.count({ where: { status: "SENDING" } }),
    prisma.emailDeliveryLog.count({ where: { status: { in: ["SENT", "DELIVERED"] }, sentAt: { gte: since } } }),
    prisma.emailDeliveryLog.count({ where: { status: { in: ["FAILED", "BOUNCED", "COMPLAINED"] }, updatedAt: { gte: since } } }),
    prisma.emailDeliveryLog.count({ where: { status: "SKIPPED", updatedAt: { gte: since } } }),
    prisma.setting.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } }),
    hasSuccessfulTestEmail(),
    getEmailSettings(),
  ]);
  const at = (heartbeat?.value as { at?: string } | null)?.at ?? null;
  const workerLastRunAt = at ? new Date(at) : null;
  // The cron worker runs every minute; 5 minutes of silence means it isn't installed or is failing.
  const workerAlive = workerLastRunAt !== null && Date.now() - workerLastRunAt.getTime() < 5 * 60 * 1000;
  return { queued, sending, sent24, failed24, skipped24, workerLastRunAt, workerAlive, testEmailSucceeded: testOk, settings, env: getEmailEnvConfig() };
}

// ---------------------------------------------------------------------------
// Test email
// ---------------------------------------------------------------------------

/**
 * Sends ONE test email right away (in this request) through the exact same
 * queue + worker code path as real email, so a success proves the whole
 * pipeline. Works while production sending is off; needs the provider key.
 */
export async function sendTestEmail(to: string, templateKey: EmailTemplateKey, adminId: string) {
  if (!getEmailEnvConfig().providerConfigured) throw new EmailAdminError("Email provider not configured. Add RESEND_API_KEY to the production environment and reload the app.");
  const address = to.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 200) throw new EmailAdminError("Enter a valid email address.");
  if (!TEMPLATE_DEFAULTS[templateKey]) throw new EmailAdminError("Choose a template.");

  const recent = await prisma.emailDeliveryLog.count({ where: { isTest: true, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } });
  if (recent >= 20) throw new EmailAdminError("Test email limit reached (20 per hour). Please try again later.");

  const id = crypto.randomUUID();
  await enqueueEmail({
    idempotencyKey: `test:${id}`,
    templateKey,
    category: "TRANSACTIONAL",
    toEmail: address,
    variables: { ...SAMPLE_VARS, studentName: "Test Recipient", email: address },
    isTest: true,
    createdByAdminId: adminId,
  });
  const row = await prisma.emailDeliveryLog.findUniqueOrThrow({ where: { idempotencyKey: `test:${id}` }, select: { id: true } });
  const [claimed] = await claimDueEmails(1, { includeCampaigns: false, onlyId: row.id });
  if (claimed) await processClaimedEmail(claimed);
  await prisma.auditLog.create({ data: { actorId: adminId, action: "EMAIL_TEST_SENT", entityType: "EmailDeliveryLog", entityId: row.id, metadata: { templateKey } } });
  return prisma.emailDeliveryLog.findUniqueOrThrow({ where: { id: row.id }, select: { status: true, failureReason: true, providerMessageId: true } });
}
