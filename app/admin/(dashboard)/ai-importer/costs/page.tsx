import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TASK_LABELS, type ImporterTask } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";

export const metadata = { title: "AI Cost Center — AI Question Importer" };
export const dynamic = "force-dynamic";

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);

/**
 * Admin → AI Question Importer → AI Cost Center: the importer's own monthly
 * budget (separate from student Ask AI), provider-reported costs per job,
 * task and model, and every call with tokens, retries and fallbacks.
 * "Held" = cost not reported by the provider: the worst case is counted.
 */
export default async function CostsPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Cost Center" />;
  const settings = await getImporterSettings();
  const { istMonth } = istDayMonth();
  const [month, byTask, byModel, jobs, calls] = await Promise.all([
    prisma.$queryRaw<{ spent: number; held: number }[]>`
      SELECT COALESCE(SUM(COALESCE("settledInr", "reservedInr")), 0)::float8 AS spent,
             COALESCE(SUM(CASE WHEN "status" = 'RESERVED' OR ("status" = 'SETTLED' AND NOT "costKnown") THEN COALESCE("settledInr", "reservedInr") ELSE 0 END), 0)::float8 AS held
      FROM "AiBudgetReservation" WHERE "istMonth" = ${istMonth} AND "status" <> 'RELEASED' AND left("feature", 8) = 'qimport_'`,
    prisma.aiImportAiCall.groupBy({ by: ["task"], _sum: { costInr: true, inputTokens: true, outputTokens: true }, _count: { _all: true } }),
    prisma.aiImportAiCall.groupBy({ by: ["model"], _sum: { costInr: true, inputTokens: true, outputTokens: true }, _count: { _all: true } }),
    prisma.aiImportJob.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { id: true, title: true, estCostInr: true, spentInr: true, budgetInr: true, _count: { select: { questions: true, pages: true } } } }),
    prisma.aiImportAiCall.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const retries = calls.filter((c) => c.attempt > 1).length;
  const fallbacks = calls.filter((c) => c.fallbackUsed).length;
  const m = month[0] ?? { spent: 0, held: 0 };
  const pagesByJob = await prisma.aiImportAiCall.groupBy({ by: ["jobId"], where: { task: "extract", ok: true }, _count: { _all: true } });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Cost Center</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">Actual costs are what OpenRouter reported per call. When a provider reports no cost (for example after a timeout) the worst case is counted and marked as held. Local parsing costs nothing.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-[var(--color-muted-foreground)]">Importer budget this month ({istMonth}, IST)</div>
            <div className="text-lg font-semibold" data-testid="month-spend">
              {inr(m.spent)} of {inr(settings.budget.monthlyInr)}
            </div>
            <div className="text-xs text-[var(--color-muted-foreground)]">{inr(m.held)} held (cost not reported)</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-[var(--color-muted-foreground)]">Paid AI</div>
            <div className="text-lg font-semibold">{settings.aiEnabled ? "On" : "Off"}</div>
            <div className="text-xs text-[var(--color-muted-foreground)]">Per-request limit {inr(settings.budget.maxRequestInr)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-[var(--color-muted-foreground)]">Retries / fallbacks (last 100 calls)</div>
            <div className="text-lg font-semibold">
              {retries} / {fallbacks}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-[var(--color-muted-foreground)]">Privacy for importer calls</div>
            <div className="text-lg font-semibold">{settings.privacy.dataCollection === "deny" ? "No data collection" : "Data collection allowed"}</div>
            <div className="text-xs text-[var(--color-muted-foreground)]">{settings.privacy.zdr ? "Zero-data-retention endpoints only" : "ZDR not required"}</div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Per job</CardTitle>
          <CardDescription>Estimated before processing vs recorded; per AI page and per extracted question.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm" data-testid="cost-jobs">
            <thead className="text-xs text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-2 font-medium">Import</th>
                <th className="py-1 pr-2 font-medium">Estimate</th>
                <th className="py-1 pr-2 font-medium">Recorded</th>
                <th className="py-1 pr-2 font-medium">Budget</th>
                <th className="py-1 pr-2 font-medium">Per AI page</th>
                <th className="py-1 pr-2 font-medium">Per question</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const aiPages = pagesByJob.find((p) => p.jobId === j.id)?._count._all ?? 0;
                return (
                  <tr key={j.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-2">
                      <Link className="underline" href={`/admin/ai-importer/jobs/${j.id}`}>
                        {j.title}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-2">{inr(j.estCostInr)}</td>
                    <td className="py-1.5 pr-2">{inr(j.spentInr)}</td>
                    <td className="py-1.5 pr-2">{inr(j.budgetInr)}</td>
                    <td className="py-1.5 pr-2">{aiPages ? inr(j.spentInr / aiPages) : "—"}</td>
                    <td className="py-1.5 pr-2">{j._count.questions ? inr(j.spentInr / j._count.questions) : "—"}</td>
                  </tr>
                );
              })}
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
                  {TASK_LABELS[t.task as ImporterTask] ?? t.task}: {t._count._all} call(s) · {(t._sum.inputTokens ?? 0).toLocaleString("en-IN")} in / {(t._sum.outputTokens ?? 0).toLocaleString("en-IN")} out · {inr(t._sum.costInr)}
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
            <ul className="text-sm">
              {byModel.map((t) => (
                <li key={t.model}>
                  {t.model}: {t._count._all} call(s) · {inr(t._sum.costInr)}
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
          <CardDescription>No prompts or document text are stored here — only model, tokens, cost and status.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs" data-testid="cost-calls">
            <thead className="text-[var(--color-muted-foreground)]">
              <tr>
                {["Time", "Task", "Model", "Attempt", "Tokens in / out", "Estimate", "Cost", "Cost status", "Result"].map((h) => (
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
                  <td className="py-1 pr-2">{inr(c.costInr)}</td>
                  <td className="py-1 pr-2">{c.costStatus === "actual" ? "reported" : c.costStatus === "unknown" ? "held (worst case)" : c.costStatus}</td>
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
