import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TASK_LABELS, type ImporterTask } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { actualState, importerLedger } from "@/lib/ai-import/ledger";

export const metadata = { title: "AI Cost Center — AI Question Importer" };
export const dynamic = "force-dynamic";

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v > 0 && v < 0.01 ? `₹${v.toFixed(4)}` : `₹${v.toFixed(2)}`);

/**
 * Actual spend, never mixed with estimates: a cost OpenRouter did not report is named as unknown
 * (with the maximum held for it) and never shown as ₹0; requests still in flight are "pending".
 */
function actualText(p: { actualInr: number; actualRequests: number; unknownRequests: number; heldInr: number; inflightRequests?: number; inflightInr?: number }) {
  const unknown = `${p.unknownRequests} request(s) with unknown cost (up to ${inr(p.heldInr)} held)`;
  switch (actualState(p)) {
    case "none":
      return "₹0.00 (no AI request)";
    case "pending":
      return `Pending — ${p.inflightRequests} request(s) in flight (up to ${inr(p.inflightInr)} held)`;
    case "unknown":
      return `Unknown — ${unknown}`;
    case "mixed":
      return `${inr(p.actualInr)} reported + ${unknown}`;
    default:
      return inr(p.actualInr);
  }
}
const periodActual = (p: { actualInr: number; actualRequests: number; unknownRequests: number; unknownHeldInr: number; inflightRequests: number; inflightInr: number }) => actualText({ ...p, heldInr: p.unknownHeldInr });

function Stat({ label, value, sub, id }: { label: string; value: string; sub?: string; id: string }) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs text-[var(--color-muted-foreground)]">{label}</div>
        <div className="text-lg font-semibold [overflow-wrap:anywhere]" data-testid={id}>
          {value}
        </div>
        {sub && <div className="text-xs text-[var(--color-muted-foreground)]">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * Admin → AI Question Importer → AI Cost Center: the importer's own spend and limits (separate from
 * student Ask AI and every other AI feature), from the importer's ledger (lib/ai-import/ledger.ts).
 * Estimates and actual costs are always shown apart; a cost OpenRouter did not report is "unknown",
 * never zero, and its reserved maximum is shown as held.
 */
export default async function CostsPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Cost Center" />;
  const settings = await getImporterSettings();
  const [ledger, byTask, byModel, calls] = await Promise.all([
    importerLedger(settings),
    prisma.$queryRaw<{ task: string; n: number; inTok: number; outTok: number; actual: number | null; unknown: number }[]>`
      SELECT "task", COUNT(*)::int AS n, COALESCE(SUM("inputTokens"), 0)::int AS "inTok", COALESCE(SUM("outputTokens"), 0)::int AS "outTok",
             SUM("costInr") FILTER (WHERE "costStatus" = 'actual')::float8 AS actual, COUNT(*) FILTER (WHERE "costStatus" IN ('unknown', 'pending'))::int AS unknown
      FROM "AiImportAiCall" GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ model: string; n: number; actual: number | null; unknown: number }[]>`
      SELECT "model", COUNT(*)::int AS n, SUM("costInr") FILTER (WHERE "costStatus" = 'actual')::float8 AS actual,
             COUNT(*) FILTER (WHERE "costStatus" IN ('unknown', 'pending'))::int AS unknown
      FROM "AiImportAiCall" GROUP BY 1 ORDER BY 2 DESC`,
    prisma.aiImportAiCall.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const { today, month, all } = ledger.periods;
  const pagesByJob = await prisma.aiImportAiCall.groupBy({ by: ["jobId"], where: { task: "extract", ok: true }, _count: { _all: true } });
  const est = ledger.estimates;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Cost Center</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          The AI Question Importer only — student Ask AI, Instagram and the other AI features are not included. <strong>Actual</strong> is what OpenRouter reported per request. <strong>Estimates</strong> are calculated before a request and are never counted as spend. When OpenRouter does not report a cost (for example after a timeout) it is shown as unknown and the request&apos;s maximum is shown as held. Local parsing costs nothing.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="cost-summary">
        <Stat id="cost-est-today" label={`Estimated cost today (${ledger.istDay}, IST)`} value={est.todayCalls ? inr(est.todayInr) : est.todayUnestimated ? "No estimate" : "No requests"} sub={`Typical estimate of ${est.todayCalls} call(s) today${est.todayUnestimated ? `; ${est.todayUnestimated} more call(s) had no estimate and are not included` : ""} — an estimate, not spend. The maximum reserved for today's requests was ${inr(today.reservedMaxInr)}.`} />
        <Stat id="cost-actual-today" label="Actual spend today" value={periodActual(today)} sub={today.inflightRequests && today.actualRequests + today.unknownRequests ? `${today.inflightRequests} more in flight (up to ${inr(today.inflightInr)} held)` : undefined} />
        <Stat id="cost-actual-total" label="Total actual importer spend (all time)" value={periodActual(all)} sub={`${all.actualRequests} request(s) with a reported cost`} />
        <Stat id="cost-actual-month" label={`Actual importer spend this month (${ledger.istMonth})`} value={periodActual(month)} sub={month.inflightRequests ? `${month.inflightRequests} more in flight (up to ${inr(month.inflightInr)} held)` : `${month.actualRequests} request(s) with a reported cost`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Limits</CardTitle>
            <CardDescription>There is no importer job, monthly or all-time cap: each job&apos;s cost is shown and confirmed before processing. These are checked by the server immediately before every AI request.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm" data-testid="cost-limits">
              <dt>Paid AI for the importer</dt>
              <dd className="font-medium" data-testid="cost-paid">{settings.aiEnabled ? "On" : "Off"}</dd>
              <dt>Per request (maximum)</dt>
              <dd>{inr(ledger.limits.maxRequestInr)}</dd>
              <dt>Kept on the shared OpenRouter key for student Ask AI</dt>
              <dd>${settings.budget.keyReserveUsd.toFixed(2)}</dd>
              <dt>Automatic retries</dt>
              <dd>{settings.budget.retryTransient ? "On" : "Off"}</dd>
              <dt>Pricier fallback model</dt>
              <dd>{settings.budget.allowPricierFallback ? "Allowed" : "Never"}</dd>
              <dt>Privacy for importer requests</dt>
              <dd>
                {settings.privacy.dataCollection === "deny" ? "No data collection" : "Data collection allowed"}; {settings.privacy.zdr ? "Zero-Data-Retention routes only" : "ZDR not required"}
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Estimated vs actual</CardTitle>
            <CardDescription>Only requests with both a typical estimate and a reported cost are compared.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm" data-testid="cost-est-vs-actual">
            {est.comparedRequests ? (
              <>
                <div>
                  {est.comparedRequests} request(s): estimated {inr(est.comparedEstimateInr)}, actual {inr(est.comparedActualInr)}
                  {est.comparedEstimateInr ? ` (${Math.round(((est.comparedActualInr ?? 0) / est.comparedEstimateInr) * 100)} % of the estimate)` : ""}.
                </div>
              </>
            ) : (
              <div className="text-[var(--color-muted-foreground)]">No request with a reported cost yet.</div>
            )}
            <div className="text-[var(--color-muted-foreground)]">All requests ever: typical estimate {est.allInr === null ? "—" : inr(est.allInr)}; maximum reserved {inr(all.reservedMaxInr)}; {all.releasedRequests} refused or failed before any charge (not counted).</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Providers</CardTitle>
            <CardDescription>The importer sends requests through OpenRouter only. The direct Gemini API is not used by the importer (see Import Settings); Gemini models run through OpenRouter.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="text-sm" data-testid="cost-providers">
              {ledger.usage.byProvider.map((p) => (
                <li key={`${p.provider}|${p.family}`}>
                  {p.provider} — {p.family}: {p.calls} call(s), {p.failed} failed · actual {p.actualInr === null ? "—" : inr(p.actualInr)}
                  {p.unknownCost ? ` + ${p.unknownCost} with unknown cost` : ""}
                </li>
              ))}
              <li data-testid="cost-gemini-direct">Gemini (direct API): {ledger.usage.geminiDirectCalls} calls — not used by the importer.</li>
            </ul>
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]" data-testid="cost-usage">
              {ledger.usage.calls} call(s): {ledger.usage.ok} succeeded, {ledger.usage.failed} failed, {ledger.usage.retries} retr{ledger.usage.retries === 1 ? "y" : "ies"}, {ledger.usage.fallbacks} fallback(s).
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Last 14 days (IST)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {ledger.history.length ? (
              <table className="w-full text-left text-xs" data-testid="cost-history">
                <thead className="text-[var(--color-muted-foreground)]">
                  <tr>
                    {["Day", "Requests", "Actual", "Unknown cost", "Maximum reserved"].map((h) => (
                      <th key={h} className="py-1 pr-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ledger.history.map((d) => (
                    <tr key={d.day} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-2">{d.day}</td>
                      <td className="py-1 pr-2">{d.requests}</td>
                      <td className="py-1 pr-2" data-testid="cost-history-actual">{d.actualRequests ? inr(d.actualInr) : d.unknownRequests ? "unknown" : d.inflightRequests ? "pending" : "—"}</td>
                      <td className="py-1 pr-2">{d.unknownRequests ? `${d.unknownRequests} (up to ${inr(d.heldInr)} held)` : "—"}</td>
                      <td className="py-1 pr-2">{inr(d.reservedMaxInr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="cost-history-empty">No importer AI request in the last 14 days.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Per job</CardTitle>
          <CardDescription>Every import that sent an AI request, including deleted ones (their spend stays in the ledger). Job estimate = before processing; per AI page and per question use actual cost only.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm" data-testid="cost-jobs">
            <thead className="text-xs text-[var(--color-muted-foreground)]">
              <tr>
                {["Import", "Job estimate", "Actual", "Unknown cost", "Estimated maximum", "Requests", "Per AI page", "Per question"].map((h) => (
                  <th key={h} className="py-1 pr-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ledger.jobs.map((j) => {
                const aiPages = pagesByJob.find((p) => p.jobId === j.jobId)?._count._all ?? 0;
                // Per-unit costs only when every request's cost is known (an unknown or pending cost would read as ₹0).
                const costComplete = actualState(j) === "known" && !j.inflightRequests;
                return (
                  <tr key={j.jobId} className="border-t border-[var(--color-border)]" data-testid="cost-job" data-job-id={j.jobId}>
                    <td className="py-1.5 pr-2">
                      {j.deleted ? (
                        <span className="text-[var(--color-muted-foreground)]">Deleted import ({j.jobId.slice(-6)})</span>
                      ) : (
                        <Link className="underline" href={`/admin/ai-importer/jobs/${j.jobId}`}>
                          {j.title}
                        </Link>
                      )}
                    </td>
                    <td className="py-1.5 pr-2">{inr(j.jobEstimateInr)}</td>
                    <td className="py-1.5 pr-2" data-testid="cost-job-actual">{j.actualRequests ? inr(j.actualInr) : j.unknownRequests ? "unknown" : j.inflightRequests ? "pending" : "—"}</td>
                    <td className="py-1.5 pr-2">{j.unknownRequests ? `${j.unknownRequests} (up to ${inr(j.heldInr)} held)` : "—"}</td>
                    <td className="py-1.5 pr-2">{inr(j.jobMaxInr)}</td>
                    <td className="py-1.5 pr-2">{j.requests}</td>
                    <td className="py-1.5 pr-2">{aiPages && costComplete ? inr(j.actualInr / aiPages) : "—"}</td>
                    <td className="py-1.5 pr-2">{j.questions && costComplete ? inr(j.actualInr / j.questions) : "—"}</td>
                  </tr>
                );
              })}
              {!ledger.jobs.length && (
                <tr>
                  <td colSpan={8} className="py-2 text-[var(--color-muted-foreground)]">
                    No import has sent an AI request yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By task</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm" data-testid="cost-tasks">
              {byTask.map((t) => (
                <li key={t.task}>
                  {TASK_LABELS[t.task as ImporterTask] ?? t.task}: {t.n} call(s) · {t.inTok.toLocaleString("en-IN")} in / {t.outTok.toLocaleString("en-IN")} out · actual {inr(t.actual)}
                  {t.unknown ? ` + ${t.unknown} with unknown cost` : ""}
                </li>
              ))}
              {!byTask.length && <li className="text-[var(--color-muted-foreground)]">No AI calls yet.</li>}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By model</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm" data-testid="cost-models">
              {byModel.map((t) => (
                <li key={t.model}>
                  {t.model}: {t.n} call(s) · actual {inr(t.actual)}
                  {t.unknown ? ` + ${t.unknown} with unknown cost` : ""}
                </li>
              ))}
              {!byModel.length && <li className="text-[var(--color-muted-foreground)]">No AI calls yet.</li>}
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent calls</CardTitle>
          <CardDescription>No prompts or document text are stored here — only model, tokens, cost and status. Calls of deleted imports are removed with them; their spend stays in the totals above.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs" data-testid="cost-calls">
            <thead className="text-[var(--color-muted-foreground)]">
              <tr>
                {["Time", "Task", "Model", "Attempt", "Tokens in / out", "Estimate", "Actual cost", "Result"].map((h) => (
                  <th key={h} className="py-1 pr-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-t border-[var(--color-border)]">
                  <td className="py-1 pr-2">{formatIst(c.createdAt)}</td>
                  <td className="py-1 pr-2">{TASK_LABELS[c.task as ImporterTask] ?? c.task}</td>
                  <td className="py-1 pr-2">
                    {c.model}
                    {c.fallbackUsed ? " (fallback)" : ""}
                  </td>
                  <td className="py-1 pr-2">{c.attempt}</td>
                  <td className="py-1 pr-2">
                    {c.inputTokens ?? "—"} / {c.outputTokens ?? "—"}
                  </td>
                  <td className="py-1 pr-2">{inr(c.estCostInr)}</td>
                  <td className="py-1 pr-2">{c.costStatus === "actual" ? inr(c.costInr) : c.costStatus === "unknown" || c.costStatus === "pending" ? `unknown (up to ${inr(c.costInr)} held)` : "no charge"}</td>
                  <td className={`py-1 pr-2 ${c.ok ? "" : "text-[var(--color-error)]"}`}>{c.ok ? "ok" : c.errorSummary ?? "failed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
