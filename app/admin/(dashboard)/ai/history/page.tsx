import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { history } from "@/lib/ai-engine/analytics";
import { parseRange } from "@/lib/ai-engine/range";
import { ENGINE_FEATURES, ENGINE_FEATURE_MAP, formatInr } from "@/lib/ai-engine/config";
import { formatIst } from "@/lib/ist-time";
import { AiFilters } from "@/components/admin/ai/analytics-controls";

export const metadata = { title: "AI Usage History — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const PAGE = 50;

/**
 * Admin → AI → History: one row per provider request. No prompts, answers,
 * student text or keys are stored — only feature, models, tokens, cost,
 * status, timing and the related Instagram post.
 */
export default async function AiHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await hasPermission(PERMISSIONS.AI_ENGINE_VIEW))) return <RestrictedCard title="AI Usage History" />;
  const sp = await searchParams;
  const r = parseRange(sp, 7);
  const page = Math.max(1, Number(sp.page) || 1);
  const [{ rows, total }, models] = await Promise.all([
    history({ from: r.from, to: r.to, feature: r.feature, model: r.model, provider: r.provider, status: r.status, take: PAGE, skip: (page - 1) * PAGE }),
    prisma.aiGatewayCall.groupBy({ by: ["model"], where: { createdAt: { gte: r.from, lt: r.to } }, orderBy: { model: "asc" }, take: 80 }),
  ]);
  const postIds = [...new Set(rows.map((x) => x.instagramPostId).filter((x): x is string => Boolean(x)))];
  const posts = postIds.length ? await prisma.instagramPost.findMany({ where: { id: { in: postIds } }, select: { id: true, questionCode: true, version: true } }) : [];
  const postById = new Map(posts.map((p) => [p.id, p]));
  const qs = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ from: r.fromDay, to: r.toDay, feature: r.feature, model: r.model, provider: r.provider, status: r.status, page: p > 1 ? p : null })) if (v) u.set(k, String(v));
    return `/admin/ai/history?${u}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Usage History</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Every AI provider request, newest first (IST). Costs are provider-reported; legacy providers report none.</p>
      </div>
      <AiFilters range={{ from: r.fromDay, to: r.toDay, feature: r.feature, model: r.model, provider: r.provider, status: r.status }} models={models.map((m) => m.model)} features={ENGINE_FEATURES.map((f) => ({ key: f.key, label: f.label }))} base="/admin/ai/history" />
      <Card>
        <CardHeader>
          <CardTitle>{`${total.toLocaleString("en-IN")} request(s)`}</CardTitle>
          <CardDescription>{`${r.fromDay} → ${r.toDay}`}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs" data-testid="history-table">
            <thead className="text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-2 font-medium">Date / time</th>
                <th className="py-1 pr-2 font-medium">Feature</th>
                <th className="py-1 pr-2 font-medium">Model requested</th>
                <th className="py-1 pr-2 font-medium">Model used</th>
                <th className="py-1 pr-2 font-medium">Input</th>
                <th className="py-1 pr-2 font-medium">Output</th>
                <th className="py-1 pr-2 font-medium">Est. ₹</th>
                <th className="py-1 pr-2 font-medium">Actual ₹</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 pr-2 font-medium">Duration</th>
                <th className="py-1 pr-2 font-medium">Fallback</th>
                <th className="py-1 font-medium">Instagram post</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const post = x.instagramPostId ? postById.get(x.instagramPostId) : null;
                return (
                  <tr key={x.id} className="border-t border-[var(--color-border)] align-top" data-testid="history-row" data-cost-status={x.costStatus ?? ""}>
                    <td className="py-1.5 pr-2 whitespace-nowrap">{formatIst(x.createdAt)}</td>
                    <td className="py-1.5 pr-2">{ENGINE_FEATURE_MAP[x.feature as keyof typeof ENGINE_FEATURE_MAP]?.label ?? x.feature}</td>
                    <td className="py-1.5 pr-2 break-all font-mono">{x.modelRequested ?? (x.provider === "openrouter" ? "—" : x.provider)}</td>
                    <td className="py-1.5 pr-2 break-all font-mono">{`${x.provider === "openrouter" ? "" : `${x.provider} · `}${x.model}`}</td>
                    <td className="py-1.5 pr-2">{x.inputTokens ?? "—"}</td>
                    <td className="py-1.5 pr-2">{x.outputTokens ?? "—"}</td>
                    <td className="py-1.5 pr-2">{x.estCostInr !== null ? formatInr(x.estCostInr, 4) : "—"}</td>
                    <td className="py-1.5 pr-2">
                      {x.actualCostInr !== null ? formatInr(x.actualCostInr, 4) : x.costStatus === "pending" ? "pending" : x.costStatus === "none" ? "not billed" : "not reported"}
                    </td>
                    <td className="py-1.5 pr-2">
                      {x.ok ? (
                        <Badge variant="success">OK</Badge>
                      ) : (
                        <span title={x.errorSummary ?? undefined}>
                          <Badge variant="error">{x.errorCategory ?? "failed"}</Badge>
                        </span>
                      )}
                      {x.attempt > 1 ? <span className="ml-1 text-[var(--color-muted-foreground)]">{`retry ${x.attempt - 1}`}</span> : null}
                    </td>
                    <td className="py-1.5 pr-2">{`${(x.latencyMs / 1000).toFixed(1)} s`}</td>
                    <td className="py-1.5 pr-2">{x.fallbackUsed ? "Yes" : "—"}</td>
                    <td className="py-1.5">{post ? `${post.questionCode} v${post.version}` : x.instagramPostId ? "deleted post" : "—"}</td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-3 text-[var(--color-muted-foreground)]">
                    No requests match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="mt-2 flex justify-between text-xs text-[var(--color-muted-foreground)]">
            <span>{`Page ${page} of ${Math.max(1, Math.ceil(total / PAGE))}`}</span>
            <span className="flex gap-3">
              {page > 1 ? <Link href={qs(page - 1)}>← Newer</Link> : null}
              {page * PAGE < total ? <Link href={qs(page + 1)}>Older →</Link> : null}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
