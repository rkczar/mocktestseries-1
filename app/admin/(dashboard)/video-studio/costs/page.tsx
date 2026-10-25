import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInr } from "@/lib/ai-engine/config";

export const dynamic = "force-dynamic";

/**
 * Cost Center: provider-reported costs of AI Video Studio requests (from the
 * AI Engine ledger, AiGatewayCall) next to each job's pre-confirmation
 * estimate. A request whose cost was not reported is counted separately and
 * never shown as ₹0.
 */
/** Kept outside the component: computing "now" is an impure call components must not make during render. */
async function loadCosts() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  return Promise.all([
    prisma.aiGatewayCall.findMany({
      where: { feature: "video_script", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, createdAt: true, model: true, ok: true, actualCostInr: true, estCostInr: true, costStatus: true, provider: true },
    }),
    prisma.videoJob.findMany({ where: { confirmedAt: { not: null } }, orderBy: { confirmedAt: "desc" }, take: 50, select: { id: true, title: true, estTotalInr: true, actualInr: true, unknownCostCalls: true } }),
  ]);
}

export default async function CostsPage() {
  const [calls, jobs] = await loadCosts();
  const known = calls.filter((c) => c.actualCostInr !== null);
  const total = known.reduce((a, c) => a + (c.actualCostInr ?? 0), 0);
  const unknown = calls.length - known.length;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Actual AI cost · last 30 days</CardDescription>
            <CardTitle data-testid="cost-total">{formatInr(total, 2)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Requests (incl. failed)</CardDescription>
            <CardTitle>{calls.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Requests without a reported cost</CardDescription>
            <CardTitle>{unknown}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[var(--color-muted-foreground)]">Not included in the total and never counted as ₹0.</CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Estimate vs actual, per video</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No confirmed video jobs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--color-muted-foreground)]">
                  <th className="py-1 font-medium">Video</th>
                  <th className="py-1 text-right font-medium">Estimate</th>
                  <th className="py-1 text-right font-medium">Actual</th>
                  <th className="py-1 text-right font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="py-2">{j.title}</td>
                    <td className="py-2 text-right tabular-nums">{j.estTotalInr === null ? "Unknown" : formatInr(j.estTotalInr, 2)}</td>
                    <td className="py-2 text-right tabular-nums">{formatInr(j.actualInr, 4)}{j.unknownCostCalls ? ` + ${j.unknownCostCalls} unknown` : ""}</td>
                    <td className="py-2 text-right tabular-nums">{j.estTotalInr === null || j.unknownCostCalls ? "—" : formatInr(j.actualInr - j.estTotalInr, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
          <CardDescription>Every script request, including failures (from AI → History).</CardDescription>
        </CardHeader>
        <CardContent>
          {calls.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No requests in the last 30 days.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] text-sm">
              {calls.map((c) => (
                <li key={c.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{c.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} · {c.model} {c.ok ? "" : "· failed"}</span>
                  <span className="tabular-nums">{c.actualCostInr !== null ? formatInr(c.actualCostInr, 4) : `cost ${c.costStatus ?? "unknown"}`}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
