import Link from "next/link";
import { CheckCircle2, AlertTriangle, CircleDashed } from "lucide-react";
import { FINAL_STATE_LABELS, getLaunchReadiness, type ReadinessGroup, type ReadinessStatus } from "@/lib/payments/launch-readiness";
import { getLegalReadiness } from "@/lib/legal-readiness";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionForm } from "./action-form";
import { markLegalReviewedAction } from "../actions";

const STATUS_LABEL: Record<ReadinessStatus, string> = { PASS: "PASS", ACTION_REQUIRED: "ACTION REQUIRED", NOT_CONFIGURED: "NOT CONFIGURED" };

function StatusIcon({ status }: { status: ReadinessStatus }) {
  if (status === "PASS") return <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />;
  if (status === "ACTION_REQUIRED") return <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />;
  return <CircleDashed className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />;
}

function StatusBadge({ status }: { status: ReadinessStatus }) {
  return <Badge variant={status === "PASS" ? "success" : status === "ACTION_REQUIRED" ? "warning" : "neutral"}>{STATUS_LABEL[status]}</Badge>;
}

function GroupCard({ group }: { group: ReadinessGroup }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {group.title} <StatusBadge status={group.status} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-sm">
          {group.items.map((i) => (
            <li key={i.label} className="flex items-start gap-2">
              <span className="mt-0.5">
                <StatusIcon status={i.status} />
              </span>
              <span className="min-w-0">
                <span className="font-medium text-[var(--color-foreground)]">{i.label}</span>
                <span className="block break-words text-xs text-[var(--color-muted-foreground)]">{i.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Live Launch Readiness — every status is computed from real configuration
 * and records by lib/payments/launch-readiness.ts; nothing here is a manual
 * "PASS". MASTER_ADMIN can record owner review of the legal pages; FULL_ADMIN
 * sees the same page read-only.
 */
export async function ReadinessPanel({ canManage }: { canManage: boolean }) {
  const [r, legal] = await Promise.all([getLaunchReadiness(), getLegalReadiness()]);
  const finalTone =
    r.finalState === "PRODUCTION_VERIFIED" ? "success" : r.finalState === "READY_FOR_CONTROLLED_LIVE_TEST" ? "primary" : "warning";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Live Launch Readiness <Badge variant={finalTone}>{FINAL_STATE_LABELS[r.finalState]}</Badge>
          </CardTitle>
          <CardDescription>
            Computed from real gateway configuration, webhook events, payments, entitlements, invoices, products, legal pages and Test Series coverage.
            The gateway is <strong>{r.environment}</strong> and payment mode is <strong>{r.mode}</strong>. Nothing here switches the gateway — that stays a
            separate, guarded action under Gateway Settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {r.groups.map((g) => (
              <div key={g.key} className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2 text-sm">
                <StatusIcon status={g.status} />
                <span className="truncate text-[var(--color-foreground)]">{g.title.replace(" Gateway", "")}</span>
              </div>
            ))}
          </div>
          {r.liveBlockers.length ? (
            <div className="rounded-[var(--radius-button)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 px-3 py-2 text-sm">
              <p className="font-medium text-[var(--color-foreground)]">LIVE activation is blocked until:</p>
              <ul className="mt-1 list-disc pl-5 text-[var(--color-muted-foreground)]">
                {r.liveBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {r.acknowledgementsRequired.length ? (
            <details className="rounded-[var(--radius-button)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium text-[var(--color-foreground)]">
                {r.acknowledgementsRequired.length} business / legal / coverage item(s) need action or an explicit Master Admin acknowledgement before LIVE
              </summary>
              <ul className="mt-1 list-disc pl-5 text-[var(--color-muted-foreground)]">
                {r.acknowledgementsRequired.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {r.groups.map((g) => (
          <GroupCard key={g.key} group={g} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Legal pages — owner review</CardTitle>
          <CardDescription>
            Text is edited in{" "}
            <Link href="/admin/website/homepage" className="text-[var(--color-primary)] hover:underline">
              Admin → Website → Homepage → Contact / About / Legal
            </Link>{" "}
            (publish to apply). A review is tied to the exact published text — editing it later puts the page back to &ldquo;Owner review required&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {legal.docs.map((d) => (
            <div key={d.key} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium text-[var(--color-foreground)]">
                  {d.title}
                  {d.contentIssue ? (
                    <Badge variant="warning">ACTION REQUIRED</Badge>
                  ) : d.reviewed ? (
                    <Badge variant="success">Owner reviewed</Badge>
                  ) : (
                    <Badge variant="warning">Owner review required</Badge>
                  )}
                  {!d.visible ? <Badge>Hidden</Badge> : null}
                </p>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {d.contentIssue ?? (d.reviewedAt ? `Reviewed ${new Date(d.reviewedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : "Published text not yet reviewed by the owner.")}{" "}
                  <Link href={d.path} target="_blank" className="text-[var(--color-primary)] hover:underline">
                    View {d.path} ↗
                  </Link>
                </p>
              </div>
              {canManage && d.hasContent && !d.reviewed ? (
                <ActionForm action={markLegalReviewedAction} submitLabel="Mark reviewed" variant="outline" className="flex items-end gap-2">
                  <input type="hidden" name="doc" value={d.key} />
                  <Input name="confirm" placeholder="Type REVIEWED" aria-label={`Confirm review of ${d.title}`} autoComplete="off" className="w-36" />
                </ActionForm>
              ) : null}
            </div>
          ))}
          {!canManage ? <p className="text-xs text-[var(--color-muted-foreground)]">View only — only a Master Admin can record owner review.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Controlled first LIVE payment — checklist</CardTitle>
          <CardDescription>
            For the future first real transaction. Each step is ticked only from real evidence (configuration, webhook events, payment, entitlement and
            invoice records) — never manually. Not executed now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-1.5 text-sm">
            {r.checklist.map((c) => (
              <li key={c.n} className="flex items-start gap-2">
                {c.done ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                ) : (
                  <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="text-[var(--color-foreground)]">
                    {c.n}. {c.label}
                  </span>
                  <span className="block break-words text-xs text-[var(--color-muted-foreground)]">{c.evidence}</span>
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
