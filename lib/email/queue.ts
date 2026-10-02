import "server-only";
import { Prisma, type EmailCategory, type EmailDeliveryLog, type EmailTemplateKey } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { getEmailEnvConfig, SUPPORT_EMAIL } from "@/lib/email/config";
import { getEmailProvider } from "@/lib/email/provider";
import { getEmailSettings } from "@/lib/email/settings";
import { renderEmailLayout } from "@/lib/email/layout";
import { sanitizeEmailHtml } from "@/lib/email/sanitize";
import { getResolvedTemplate, renderContent, TEMPLATE_DEFAULTS, type TemplateContent, type TemplateVars } from "@/lib/email/templates";
import { preferencesUrl, unsubscribeUrl } from "@/lib/email/preferences";

/**
 * The email queue — PostgreSQL only, no Redis. Every email is one
 * EmailDeliveryLog row:
 *
 *   enqueue  → QUEUED (UNIQUE idempotencyKey: a repeated event inserts nothing)
 *   claim    → SENDING  (UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED),
 *                        so two workers can never take the same row)
 *   send     → SENT     (provider message id stored)
 *            → QUEUED again with backoff on a retryable error, FAILED after
 *              MAX_ATTEMPTS or on a permanent error
 *   gates    → SKIPPED  (sending off, template disabled, no address,
 *                        opted out, suppressed, expired) — never sent
 *
 * Crash/restart safety: a row left in SENDING by a killed worker is returned
 * to QUEUED after STALE_LOCK_MS. The provider call carries Idempotency-Key =
 * row id, so re-sending such a row within the provider's 24h idempotency
 * window does not deliver a second email.
 *
 * Producers (registration, login, payments, password reset, admin) only
 * insert rows; scripts/email-worker.ts (cron, flock-guarded, one instance)
 * drains them at the configured rate. Admin requests never wait on bulk sends.
 */

export const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 10 * 60 * 1000;
/** Automatic (non-campaign) email older than this is skipped instead of sent late. */
const AUTOMATIC_EXPIRY_MS = 24 * 60 * 60 * 1000;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];

type Db = Prisma.TransactionClient | typeof prisma;

export interface EnqueueInput {
  idempotencyKey: string;
  templateKey: EmailTemplateKey;
  category?: EmailCategory;
  studentId?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  variables?: TemplateVars;
  campaignId?: string | null;
  isTest?: boolean;
  createdByAdminId?: string | null;
  /** Earliest send time (default now). */
  notBefore?: Date;
}

function toRow(input: EnqueueInput): Prisma.EmailDeliveryLogCreateManyInput {
  return {
    idempotencyKey: input.idempotencyKey.slice(0, 200),
    templateKey: input.templateKey,
    category: input.category ?? TEMPLATE_DEFAULTS[input.templateKey].category,
    studentId: input.studentId ?? null,
    toEmail: input.toEmail?.trim().toLowerCase() || null,
    subject: input.subject ?? null,
    variables: (input.variables ?? undefined) as Prisma.InputJsonValue | undefined,
    campaignId: input.campaignId ?? null,
    isTest: input.isTest ?? false,
    createdByAdminId: input.createdByAdminId ?? null,
    nextAttemptAt: input.notBefore ?? new Date(),
  };
}

/**
 * Queues one email. Safe inside a caller's transaction (pass `tx`): it is a
 * single INSERT … ON CONFLICT DO NOTHING, so it commits or rolls back with
 * the business change that caused it (transactional outbox). Returns false
 * when the idempotency key already exists.
 */
export async function enqueueEmail(input: EnqueueInput, db: Db = prisma): Promise<boolean> {
  const result = await db.emailDeliveryLog.createMany({ data: [toRow(input)], skipDuplicates: true });
  return result.count === 1;
}

export async function enqueueEmails(inputs: EnqueueInput[], db: Db = prisma): Promise<number> {
  if (inputs.length === 0) return 0;
  const result = await db.emailDeliveryLog.createMany({ data: inputs.map(toRow), skipDuplicates: true });
  return result.count;
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/** Returns rows stuck in SENDING (killed worker) to the queue. */
export async function releaseStaleLocks(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  const exhausted = await prisma.emailDeliveryLog.updateMany({
    where: { status: "SENDING", lockedAt: { lt: staleBefore }, attempts: { gte: MAX_ATTEMPTS } },
    data: { status: "FAILED", lockedAt: null, failureReason: "Worker stopped while sending; retry limit reached" },
  });
  const released = await prisma.emailDeliveryLog.updateMany({
    where: { status: "SENDING", lockedAt: { lt: staleBefore } },
    data: { status: "QUEUED", lockedAt: null, nextAttemptAt: now },
  });
  return exhausted.count + released.count;
}

/**
 * Atomically claims up to `limit` due rows. Transactional mail goes first.
 * Campaign rows are only claimed while production sending is live, so
 * turning sending off pauses a running campaign instead of skipping it.
 */
export async function claimDueEmails(limit: number, opts: { includeCampaigns: boolean; onlyId?: string }): Promise<string[]> {
  const campaignFilter = opts.includeCampaigns ? Prisma.sql`` : Prisma.sql`AND "campaignId" IS NULL`;
  const idFilter = opts.onlyId ? Prisma.sql`AND id = ${opts.onlyId}` : Prisma.sql``;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "EmailDeliveryLog"
       SET status = 'SENDING'::"EmailStatus", "lockedAt" = NOW(), attempts = attempts + 1, "updatedAt" = NOW()
     WHERE id IN (
       SELECT id FROM "EmailDeliveryLog"
        WHERE status = 'QUEUED'::"EmailStatus" AND "nextAttemptAt" <= NOW() ${campaignFilter} ${idFilter}
        ORDER BY (category = 'PROMOTIONAL'::"EmailCategory"), "nextAttemptAt", "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return rows.map((r) => r.id);
}

export type ProcessOutcome = "SENT" | "RETRY" | "FAILED" | "SKIPPED" | "PAUSED";

interface Finish {
  outcome: ProcessOutcome;
  retryAfterSeconds?: number;
}

async function finish(id: string, data: Prisma.EmailDeliveryLogUpdateInput, outcome: ProcessOutcome, retryAfterSeconds?: number): Promise<Finish> {
  // Only the claimant (row still SENDING) may finish it.
  await prisma.emailDeliveryLog.updateMany({ where: { id, status: "SENDING" }, data: { ...(data as object), lockedAt: null } });
  return { outcome, retryAfterSeconds };
}

function skip(id: string, reason: string) {
  return finish(id, { status: "SKIPPED", failureReason: reason.slice(0, 300) }, "SKIPPED");
}

/** Renders and sends one claimed (SENDING) row. Never throws for per-email problems. */
export async function processClaimedEmail(id: string): Promise<Finish> {
  const row = await prisma.emailDeliveryLog.findUnique({
    where: { id },
    include: {
      student: { select: { id: true, name: true, email: true, studentId: true, status: true, emailPreference: true } },
      campaign: true,
    },
  });
  if (!row || row.status !== "SENDING") return { outcome: "SKIPPED" };

  const env = getEmailEnvConfig();
  const provider = getEmailProvider();
  const settings = await getEmailSettings();
  const def = TEMPLATE_DEFAULTS[row.templateKey];

  if (!env.providerConfigured || !provider.configured) {
    if (row.isTest) return finish(id, { status: "FAILED", failureReason: "Email provider not configured" }, "FAILED");
    if (row.campaignId) return pause(row);
    return skip(id, "Email provider not configured");
  }
  if (!row.isTest && !settings.sendingEnabled) {
    if (row.campaignId) return pause(row);
    return skip(id, "Production sending is off");
  }
  if (!row.isTest && !row.campaignId && Date.now() - row.createdAt.getTime() > AUTOMATIC_EXPIRY_MS) {
    return skip(id, "Expired: not sent within 24 hours of the event");
  }
  if (row.campaign && row.campaign.status === "CANCELLED") return skip(id, "Campaign cancelled");

  const student = row.student;
  const to = (row.toEmail || student?.email || "").trim().toLowerCase();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return skip(id, "No valid email address");

  if (student && !row.isTest) {
    const critical = def.critical;
    if (student.status === "DELETED" || student.status === "DELETION_REQUESTED") return skip(id, "Student account deleted or pending deletion");
    if (!critical && student.status !== "ACTIVE") return skip(id, "Student account not active");
    const pref = student.emailPreference;
    if (pref?.suppressedAt) {
      const hardBounce = /bounce/i.test(pref.suppressionReason ?? "");
      if (hardBounce || !critical) return skip(id, `Address suppressed (${pref.suppressionReason ?? "provider event"})`);
    }
    if (row.category === "PROMOTIONAL" && pref?.promotionalOptOut) return skip(id, "Student unsubscribed from promotional email");
  }

  // Content: a campaign's frozen copy, else the (admin-editable) template.
  let content: TemplateContent;
  if (row.campaign) {
    content = row.campaign;
  } else {
    const template = await getResolvedTemplate(row.templateKey);
    if (!template.enabled && !row.isTest) return skip(id, `Template ${row.templateKey} is disabled`);
    content = template;
  }

  const siteUrl = await getSiteUrl();
  const vars: TemplateVars = {
    siteUrl,
    supportEmail: SUPPORT_EMAIL,
    loginUrl: `${siteUrl}/login`,
    resetUrl: `${siteUrl}/login?tab=forgot`,
    dashboardUrl: `${siteUrl}/student/dashboard`,
    invoiceUrl: `${siteUrl}/student/payments`,
    studentName: student?.name ?? "Student",
    email: to,
    studentId: student?.studentId ?? "",
    ...((row.variables as TemplateVars | null) ?? {}),
  };
  const rendered = renderContent({ ...content, bodyHtml: sanitizeEmailHtml(content.bodyHtml) }, vars);
  if (!rendered.subject) return finish(id, { status: "FAILED", failureReason: "Subject is empty after rendering" }, "FAILED");

  const promotional = row.category === "PROMOTIONAL";
  const prefsUrl = student ? preferencesUrl(siteUrl, student.id) : null;
  const { html, text } = renderEmailLayout({
    heading: rendered.heading,
    bodyHtml: rendered.bodyHtml,
    ctaText: rendered.ctaText,
    ctaUrl: rendered.ctaUrl,
    siteUrl,
    preferencesUrl: prefsUrl,
    promotional,
  });
  const headers: Record<string, string> = {};
  if (promotional && student) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl(siteUrl, student.id)}>, <mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const result = await provider.send({
    to,
    subject: rendered.subject.slice(0, 250),
    html,
    text,
    headers,
    idempotencyKey: row.id,
    tags: [
      { name: "template", value: row.templateKey },
      { name: "category", value: row.category },
      ...(row.campaignId ? [{ name: "campaign", value: row.campaignId }] : []),
    ],
  });

  const base = { toEmail: to, subject: rendered.subject.slice(0, 250), provider: provider.name };
  if (result.ok) {
    return finish(id, { ...base, status: "SENT", sentAt: new Date(), providerMessageId: result.providerMessageId, failureReason: null }, "SENT");
  }
  if (result.retryable && row.attempts < MAX_ATTEMPTS) {
    const wait = result.retryAfterSeconds ?? BACKOFF_SECONDS[Math.min(row.attempts - 1, BACKOFF_SECONDS.length - 1)];
    return finish(
      id,
      { ...base, status: "QUEUED", nextAttemptAt: new Date(Date.now() + wait * 1000), failureReason: `Retrying: ${result.reason}` },
      "RETRY",
      result.retryAfterSeconds
    );
  }
  return finish(id, { ...base, status: "FAILED", failureReason: result.reason }, "FAILED");
}

/** Campaign row while sending is off/unconfigured: back to the queue without using up an attempt. */
function pause(row: EmailDeliveryLog) {
  return finish(
    row.id,
    { status: "QUEUED", attempts: Math.max(0, row.attempts - 1), nextAttemptAt: new Date(Date.now() + 60_000), failureReason: "Paused: production sending is off" },
    "PAUSED"
  );
}

/** Marks SENDING campaigns whose rows are all finished as COMPLETED. */
export async function completeFinishedCampaigns(): Promise<number> {
  const open = await prisma.emailCampaign.findMany({ where: { status: "SENDING" }, select: { id: true } });
  let done = 0;
  for (const c of open) {
    const pending = await prisma.emailDeliveryLog.count({ where: { campaignId: c.id, status: { in: ["QUEUED", "SENDING"] } } });
    if (pending === 0) {
      const r = await prisma.emailCampaign.updateMany({ where: { id: c.id, status: "SENDING" }, data: { status: "COMPLETED", completedAt: new Date() } });
      done += r.count;
    }
  }
  return done;
}

export interface WorkerTickResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
  paused: number;
}

/**
 * One batch: claim → send sequentially at `ratePerSecond` → finish.
 * Stops early on a 429 so the caller can back off.
 */
export async function runEmailWorkerBatch(opts: { batchSize?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<WorkerTickResult & { rateLimitedFor?: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const settings = await getEmailSettings();
  const live = settings.sendingEnabled && getEmailEnvConfig().providerConfigured;
  const ids = await claimDueEmails(opts.batchSize ?? Math.max(5, settings.ratePerSecond * 5), { includeCampaigns: live });
  const result: WorkerTickResult & { rateLimitedFor?: number } = { claimed: ids.length, sent: 0, retried: 0, failed: 0, skipped: 0, paused: 0 };
  const gap = Math.ceil(1000 / settings.ratePerSecond);

  for (let i = 0; i < ids.length; i++) {
    const started = Date.now();
    let outcome: Finish;
    try {
      outcome = await processClaimedEmail(ids[i]);
    } catch (error) {
      // Unexpected (DB/render) error: give the row back with backoff, keep the batch going.
      const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "Unexpected worker error";
      await prisma.emailDeliveryLog.updateMany({
        where: { id: ids[i], status: "SENDING" },
        data: { status: "QUEUED", lockedAt: null, nextAttemptAt: new Date(Date.now() + 60_000), failureReason: `Retrying: ${reason}` },
      });
      outcome = { outcome: "RETRY" };
    }
    if (outcome.outcome === "SENT") result.sent++;
    else if (outcome.outcome === "RETRY") result.retried++;
    else if (outcome.outcome === "FAILED") result.failed++;
    else if (outcome.outcome === "PAUSED") result.paused++;
    else result.skipped++;

    if (outcome.retryAfterSeconds) {
      // Provider rate limit: release the rest of the batch untouched and back off.
      const rest = ids.slice(i + 1);
      if (rest.length) {
        await prisma.emailDeliveryLog.updateMany({
          where: { id: { in: rest }, status: "SENDING" },
          data: { status: "QUEUED", lockedAt: null, attempts: { decrement: 1 } },
        });
      }
      result.rateLimitedFor = outcome.retryAfterSeconds;
      break;
    }
    // Only real sends consume provider rate.
    if (outcome.outcome === "SENT" || outcome.outcome === "RETRY" || outcome.outcome === "FAILED") {
      const elapsed = Date.now() - started;
      if (elapsed < gap) await sleep(gap - elapsed);
    }
  }
  if (ids.length) await completeFinishedCampaigns();
  return result;
}
