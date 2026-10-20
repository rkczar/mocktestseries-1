import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JobControls } from "@/components/admin/ai-importer/job-controls";
import { JobsAutoRefresh } from "@/components/admin/ai-importer/jobs-auto-refresh";
import { jobCards } from "@/lib/ai-import/job-view";

export const metadata = { title: "AI Import Jobs — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const inr = (v: number | null) => (v === null ? "—" : `₹${v.toFixed(2)}`);

/**
 * Admin → AI Question Importer → Jobs: one card per import with a plain status, progress, counts,
 * spend, the next action, and the controls that are allowed right now (Cancel, Retry, Start again,
 * Delete). Every action is re-checked on the server.
 */
export default async function AiImportJobsPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Import Jobs" />;
  const [canUse, canManage] = await Promise.all([hasPermission(PERMISSIONS.AI_IMPORTER_USE), hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE)]);
  const jobs = await jobCards({ take: 200 }, canManage);
  const busy = jobs.some((j) => ["ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"].includes(j.status) && !j.stalled);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Imports</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Every import, newest activity first. Start a new one on the <Link className="underline" href="/admin/ai-importer">Import</Link> page.</p>
      </div>
      {busy && <JobsAutoRefresh />}
      <Card>
        <CardHeader>
          <CardTitle>{jobs.length} import(s)</CardTitle>
          {!canManage && <CardDescription>Only a Master Admin can delete imports.</CardDescription>}
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-[var(--color-border)]" data-testid="jobs-list">
            {jobs.map((j) => {
              const remaining = j.maxCostInr === null ? null : Math.max(0, j.maxCostInr - j.spentInr);
              return (
                <li key={j.id} className="flex flex-col gap-2 py-3" data-testid="job-row" data-job-id={j.id} data-status={j.status}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link className="font-medium underline [overflow-wrap:anywhere]" href={`/admin/ai-importer?job=${j.id}`} data-testid="job-open">
                        {j.title}
                      </Link>
                      <div className="text-xs text-[var(--color-muted-foreground)] [overflow-wrap:anywhere]">
                        {j.files.map((f) => `${f.name}${f.role === "ANSWER_KEY" ? " (answer key)" : ""}`).join(", ") || "no files"} · uploaded {j.createdAt}
                      </div>
                    </div>
                    <Badge variant={j.tone} data-testid="job-label">
                      {j.label}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {j.pages.total > 0 && (
                      <span>
                        Pages {j.pages.done}/{j.pages.total}
                        {j.pages.skipped ? ` · ${j.pages.skipped} skipped` : ""}
                        {j.pages.failed ? ` · ${j.pages.failed} failed` : ""}
                      </span>
                    )}
                    {j.counts.extracted > 0 && (
                      <span data-testid="job-counts">
                        {j.counts.extracted} extracted · {j.counts.imported} imported
                        {j.counts.needsReview + j.counts.notImportable ? ` · ${j.counts.needsReview + j.counts.notImportable} need review` : ""}
                      </span>
                    )}
                    <span>
                      AI spend {inr(j.spentInr)}
                      {remaining !== null && remaining > 0 && !["COMPLETED", "COMPLETED_WITH_ISSUES", "CANCELLED"].includes(j.status) ? ` · up to ${inr(remaining)} more` : ""}
                    </span>
                    <span className="text-[var(--color-muted-foreground)]">Updated {j.updatedAt}</span>
                  </div>
                  {j.message && <p className="text-xs text-[var(--color-warning)]">{j.message}</p>}
                  <p className="text-xs">
                    <span className="font-medium">Next: </span>
                    {j.nextAction}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="text-sm underline" href={`/admin/ai-importer/jobs/${j.id}`}>
                      View details
                    </Link>
                    {canUse && <JobControls job={j} size="compact" />}
                  </div>
                </li>
              );
            })}
            {!jobs.length && <li className="py-4 text-sm text-[var(--color-muted-foreground)]">No imports yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
