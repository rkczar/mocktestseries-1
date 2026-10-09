import Link from "next/link";
import type { EmailStatus, EmailTemplateKey } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Button } from "@/components/ui/button";
import { senderAddress } from "@/lib/email/config";
import { COMPOSE_TEMPLATE_KEYS, listResolvedTemplates, TEMPLATE_DEFAULTS, TEMPLATE_KEYS } from "@/lib/email/templates";
import { getEmailOverview, listCampaigns, listEmailLogs } from "@/lib/email/admin";
import { ComposeForm, type ComposeDraft } from "./compose-form";
import { TemplatesPanel } from "./templates-panel";
import { SettingsPanel } from "./settings-panel";
import { SecurityCodesCard } from "./security-codes-card";
import { getEmailOtpSettings, getSecurityCodeDeliverySummary } from "@/lib/email-otp";
import { CampaignRowActions, RetryEmailButton } from "./campaign-actions";

/**
 * Admin → Communications → Email: Compose · Templates · Campaigns · Email
 * Logs · Settings, as a nested tab set (`?etab=`) inside the existing
 * Communications page. Readable with COMMUNICATIONS_VIEW; every control
 * that changes something needs EMAIL_MANAGE (enforced again server-side in
 * ./actions.ts).
 */

export interface EmailTabParams {
  etab?: string;
  campaign?: string;
  lstatus?: string;
  ltemplate?: string;
  lq?: string;
  lpage?: string;
}

const STATUSES: EmailStatus[] = ["QUEUED", "SENDING", "SENT", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED", "SKIPPED", "CANCELLED"];

const STATUS_VARIANT: Record<EmailStatus, "neutral" | "primary" | "success" | "error" | "warning" | "info"> = {
  QUEUED: "info",
  SENDING: "info",
  SENT: "primary",
  DELIVERED: "success",
  FAILED: "error",
  BOUNCED: "error",
  COMPLAINED: "error",
  SKIPPED: "neutral",
  CANCELLED: "neutral",
};

function fmt(d: Date | null | undefined): string {
  return d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "—";
}

export async function EmailTab({ params, canManage }: { params: EmailTabParams; canManage: boolean }) {
  const overview = await getEmailOverview();
  const sendingReady = overview.env.providerConfigured && overview.settings.sendingEnabled;
  const sendingProblem = !overview.env.providerConfigured
    ? "Email provider not configured (RESEND_API_KEY is missing)."
    : !overview.settings.sendingEnabled
      ? "Production sending is off (Email → Settings)."
      : null;

  return (
    <div className="flex flex-col gap-4">
      {!overview.env.providerConfigured ? (
        <p className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm text-[var(--color-warning)]">
          Email provider not configured. Templates, drafts and logs work; nothing is delivered until RESEND_API_KEY is added.
        </p>
      ) : null}
      <ControlCenterTabs
        param="etab"
        defaultValue="compose"
        tabs={[
          {
            value: "compose",
            label: "Compose",
            content: <ComposeTab params={params} canManage={canManage} sendingReady={sendingReady} sendingProblem={sendingProblem} from={overview.env.from} replyTo={overview.env.replyTo} />,
          },
          { value: "templates", label: "Templates", content: <TemplatesTab canManage={canManage} /> },
          { value: "campaigns", label: "Campaigns", content: <CampaignsTab canManage={canManage} /> },
          { value: "logs", label: "Email Logs", content: <LogsTab params={params} canManage={canManage} /> },
          { value: "settings", label: "Settings", content: <SettingsTab canManage={canManage} overview={overview} /> },
        ]}
      />
    </div>
  );
}

async function ComposeTab({
  params,
  canManage,
  sendingReady,
  sendingProblem,
  from,
  replyTo,
}: {
  params: EmailTabParams;
  canManage: boolean;
  sendingReady: boolean;
  sendingProblem: string | null;
  from: string;
  replyTo: string;
}) {
  const [templates, exams, campaign] = await Promise.all([
    listResolvedTemplates(),
    prisma.exam.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    params.etab === "compose" && params.campaign ? prisma.emailCampaign.findFirst({ where: { id: params.campaign, status: "DRAFT" } }) : null,
  ]);
  let draft: ComposeDraft | null = null;
  if (campaign) {
    const students = campaign.studentIds.length
      ? await prisma.student.findMany({ where: { id: { in: campaign.studentIds } }, select: { id: true, name: true, email: true, mobile: true, studentId: true } })
      : [];
    draft = { ...campaign, students };
  }
  const composeTemplates = COMPOSE_TEMPLATE_KEYS.map((key) => templates.find((t) => t.key === key)!).map((t) => ({ key: t.key, label: t.label, subject: t.subject, heading: t.heading, bodyHtml: t.bodyHtml, ctaText: t.ctaText, ctaUrl: t.ctaUrl }));
  return (
    <ComposeForm
      key={draft?.id ?? "new"}
      templates={composeTemplates}
      exams={exams}
      draft={draft}
      from={from}
      replyTo={replyTo}
      sendingReady={sendingReady}
      sendingProblem={sendingProblem}
      canManage={canManage}
    />
  );
}

async function TemplatesTab({ canManage }: { canManage: boolean }) {
  const templates = await listResolvedTemplates();
  return (
    <TemplatesPanel
      canManage={canManage}
      templates={templates.map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
        category: t.category,
        critical: t.critical,
        automatic: t.automatic,
        enabled: t.enabled,
        customized: t.customized,
        updatedAt: t.updatedAt?.toISOString() ?? null,
        subject: t.subject,
        heading: t.heading,
        bodyHtml: t.bodyHtml,
        ctaText: t.ctaText,
        ctaUrl: t.ctaUrl,
      }))}
    />
  );
}

const AUDIENCE_LABEL: Record<string, string> = {
  INDIVIDUAL: "Individual",
  SELECTED: "Selected",
  ALL: "All students",
  PAID: "Paid",
  FREE: "Free",
  EXAM: "Exam",
};

async function CampaignsTab({ canManage }: { canManage: boolean }) {
  const campaigns = await listCampaigns();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Campaigns</CardTitle>
        <CardDescription>Drafts and sent bulk emails. Counts come live from the delivery logs.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {campaigns.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No campaigns yet. Write one under Compose.</p>
        ) : (
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4 font-medium">Name / Subject</th>
                <th className="py-2 pr-4 font-medium">Audience</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Recipients</th>
                <th className="py-2 pr-4 font-medium">Queued</th>
                <th className="py-2 pr-4 font-medium">Sent</th>
                <th className="py-2 pr-4 font-medium">Delivered</th>
                <th className="py-2 pr-4 font-medium">Failed</th>
                <th className="py-2 pr-4 font-medium">Created</th>
                <th className="py-2 pr-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                  <td className="max-w-[260px] py-2.5 pr-4">
                    <p className="font-medium">{c.name}</p>
                    <p className="truncate text-xs text-[var(--color-muted-foreground)]">{c.subject}</p>
                  </td>
                  <td className="py-2.5 pr-4 text-xs">
                    {AUDIENCE_LABEL[c.audience]}
                    {c.exam ? `: ${c.exam.name}` : ""}
                    {c.studentIds.length ? ` (${c.studentIds.length})` : ""}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge variant={c.status === "COMPLETED" ? "success" : c.status === "SENDING" ? "info" : c.status === "CANCELLED" ? "error" : "neutral"}>{c.status}</Badge>
                  </td>
                  <td className="py-2.5 pr-4">{c.status === "DRAFT" ? "—" : c.recipientCount}</td>
                  <td className="py-2.5 pr-4">{c.stats.queued}</td>
                  <td className="py-2.5 pr-4">{c.stats.sent}</td>
                  <td className="py-2.5 pr-4">{c.stats.delivered}</td>
                  <td className="py-2.5 pr-4">{c.stats.failed}</td>
                  <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-[var(--color-muted-foreground)]">
                    {fmt(c.createdAt)}
                    <br />
                    by {c.createdByAdmin?.name ?? "—"}
                  </td>
                  <td className="py-2.5 pr-4">{canManage ? <CampaignRowActions id={c.id} status={c.status} /> : <Link className="text-xs text-[var(--color-primary)] hover:underline" href={`/admin/communications?tab=email&etab=logs&campaign=${c.id}`}>Logs</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

async function LogsTab({ params, canManage }: { params: EmailTabParams; canManage: boolean }) {
  const status = STATUSES.includes(params.lstatus as EmailStatus) ? (params.lstatus as EmailStatus) : null;
  const templateKey = TEMPLATE_KEYS.includes(params.ltemplate as EmailTemplateKey) ? (params.ltemplate as EmailTemplateKey) : null;
  const campaignId = params.etab === "logs" && params.campaign ? params.campaign : null;
  const page = Number(params.lpage) || 1;
  const { rows, total, pageCount } = await listEmailLogs({ status, templateKey, campaignId, q: params.lq?.slice(0, 100), page });
  const qs = (p: number) => {
    const sp = new URLSearchParams({ tab: "email", etab: "logs", lpage: String(p) });
    if (status) sp.set("lstatus", status);
    if (templateKey) sp.set("ltemplate", templateKey);
    if (params.lq) sp.set("lq", params.lq);
    if (campaignId) sp.set("campaign", campaignId);
    return `/admin/communications?${sp}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email Logs</CardTitle>
        <CardDescription>
          Every email the system queued: automatic, campaign and test. {total} matching.
          {campaignId ? (
            <>
              {" "}
              Filtered to one campaign. <Link href="/admin/communications?tab=email&etab=logs" className="text-[var(--color-primary)] hover:underline">Show all</Link>
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 overflow-x-auto">
        <form method="get" action="/admin/communications" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="email" />
          <input type="hidden" name="etab" value="logs" />
          {campaignId ? <input type="hidden" name="campaign" value={campaignId} /> : null}
          <Input name="lq" defaultValue={params.lq ?? ""} placeholder="Email, name, User ID or subject" className="w-64" aria-label="Search logs" />
          <SelectNative name="lstatus" defaultValue={status ?? ""} className="w-40" aria-label="Status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </SelectNative>
          <SelectNative name="ltemplate" defaultValue={templateKey ?? ""} className="w-48" aria-label="Template">
            <option value="">All types</option>
            {TEMPLATE_KEYS.map((k) => (
              <option key={k} value={k}>
                {TEMPLATE_DEFAULTS[k].label}
              </option>
            ))}
          </SelectNative>
          <Button type="submit" size="sm" variant="outline">
            Filter
          </Button>
        </form>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No emails yet.</p>
        ) : (
          <table className="w-full min-w-[1150px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-3 font-medium">Recipient</th>
                <th className="py-2 pr-3 font-medium">Student</th>
                <th className="py-2 pr-3 font-medium">Subject</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 font-medium">Campaign</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2 pr-3 font-medium">Sent</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Provider ID / Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                  <td className="py-2 pr-3 text-xs">{r.toEmail ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs">
                    {r.student ? (
                      <>
                        {r.student.name}
                        <br />
                        <span className="text-[var(--color-muted-foreground)]">{r.student.studentId}</span>
                      </>
                    ) : r.isTest ? (
                      <Badge>Test</Badge>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="max-w-[220px] py-2 pr-3 text-xs">{r.subject ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs">{TEMPLATE_DEFAULTS[r.templateKey].label}</td>
                  <td className="max-w-[140px] py-2 pr-3 text-xs">{r.campaign?.name ?? "—"}</td>
                  <td className="py-2 pr-3 whitespace-nowrap text-xs text-[var(--color-muted-foreground)]">{fmt(r.createdAt)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap text-xs text-[var(--color-muted-foreground)]">{fmt(r.sentAt)}</td>
                  <td className="py-2 pr-3">
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                    {r.attempts > 1 ? <span className="ml-1 text-xs text-[var(--color-muted-foreground)]">×{r.attempts}</span> : null}
                  </td>
                  <td className="max-w-[260px] py-2 pr-3 text-xs">
                    {r.providerMessageId ? <span className="font-mono">{r.providerMessageId}</span> : null}
                    {r.failureReason ? <p className="text-[var(--color-muted-foreground)]">{r.failureReason}</p> : null}
                    {r.status === "FAILED" && canManage ? <RetryEmailButton id={r.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pageCount > 1 ? (
          <div className="flex items-center gap-3 text-sm">
            {page > 1 ? <Link href={qs(page - 1)} className="text-[var(--color-primary)] hover:underline">← Newer</Link> : null}
            <span className="text-[var(--color-muted-foreground)]">
              Page {page} of {pageCount}
            </span>
            {page < pageCount ? <Link href={qs(page + 1)} className="text-[var(--color-primary)] hover:underline">Older →</Link> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

async function SettingsTab({ canManage, overview }: { canManage: boolean; overview: Awaited<ReturnType<typeof getEmailOverview>> }) {
  const siteUrl = await getSiteUrl();
  const [otp, delivery] = await Promise.all([getEmailOtpSettings(), getSecurityCodeDeliverySummary()]);
  return (
    <div className="flex flex-col gap-6">
      <SecurityCodesCard
        canManage={canManage}
        view={{ enabled: otp.enabled, providerConfigured: overview.env.providerConfigured, lastTest: otp.lastTest, updatedAt: otp.updatedAt, updatedBy: otp.updatedBy, delivery }}
      />
      <SettingsPanel
        canManage={canManage}
        templates={TEMPLATE_KEYS.map((k) => ({ key: k, label: TEMPLATE_DEFAULTS[k].label }))}
        view={{
          provider: overview.env.provider,
          from: overview.env.from,
          replyTo: overview.env.replyTo,
          senderAddress: senderAddress(overview.env.from),
          providerConfigured: overview.env.providerConfigured,
          providerProblem: overview.env.providerProblem,
          webhookConfigured: overview.env.webhookConfigured,
          webhookUrl: `${siteUrl}/api/webhooks/resend`,
          sendingEnabled: overview.settings.sendingEnabled,
          ratePerSecond: overview.settings.ratePerSecond,
          testEmailSucceeded: overview.testEmailSucceeded,
          settingsUpdatedAt: overview.settings.updatedAt,
          settingsUpdatedBy: overview.settings.updatedBy,
          workerLastRunAt: overview.workerLastRunAt?.toISOString() ?? null,
          workerAlive: overview.workerAlive,
          queued: overview.queued,
          sending: overview.sending,
          sent24: overview.sent24,
          failed24: overview.failed24,
          skipped24: overview.skipped24,
        }}
      />
    </div>
  );
}
