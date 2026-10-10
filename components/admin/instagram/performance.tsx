"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import type { GroupStat, PublishedPerformance } from "@/lib/instagram/metrics";
import { refreshAllMetricsAction, refreshMetricsAction } from "@/app/admin/(dashboard)/instagram/studio-actions";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("en-IN"));

/** Published History → Performance: Instagram metrics per post + comparisons. Missing metrics stay "—" with the reason. */
export function Performance({ rows, compare, dims }: { rows: PublishedPerformance[]; compare: Record<string, GroupStat[]>; dims: { key: string; label: string }[] }) {
  const router = useRouter();
  const [dim, setDim] = useState(dims[0]?.key ?? "examKey");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-4" data-testid="performance">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || rows.length === 0}
          data-testid="refresh-all-metrics"
          onClick={() =>
            start(async () => {
              const r = await refreshAllMetricsAction();
              setMsg(r.ok ? `Refreshed ${r.data.refreshed}, skipped ${r.data.skipped} (refreshed < 10 min ago)${r.data.errors.length ? `; problems: ${r.data.errors.join("; ")}` : ""}.` : r.error);
              router.refresh();
            })
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Refresh metrics from Instagram
        </Button>
        {msg ? <span className="text-xs" role="status">{msg}</span> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="metrics-table">
          <thead className="text-left text-[var(--color-muted-foreground)]">
            <tr>
              {["Post", "Exam · topic", "Design", "Views", "Reach", "Likes", "Comments", "Saves", "Shares", "Engagement", ""].map((h) => (
                <th key={h} className="py-1.5 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = r.metrics;
              const why = (k: string) => m?.unavailable[k];
              const cell = (k: "views" | "reach" | "likes" | "comments" | "saves" | "shares") => (
                <td className="py-1.5 pr-3 tabular-nums" title={why(k) ?? undefined}>
                  {m ? n(m[k]) : "—"}
                </td>
              );
              return (
                <tr key={r.postId} className="border-t border-[var(--color-border)]" data-post={r.questionCode}>
                  <td className="py-1.5 pr-3">
                    <span className="font-mono">{r.questionCode}</span>
                    {r.igPermalink ? (
                      <a href={r.igPermalink} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center underline">
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3">{`${r.examKey} · ${r.topic ?? r.subject}`}</td>
                  <td className="py-1.5 pr-3">{`${r.designMode} · ${r.template} · ${r.slides} slides · ${r.captionStyle}`}</td>
                  {cell("views")}
                  {cell("reach")}
                  {cell("likes")}
                  {cell("comments")}
                  {cell("saves")}
                  {cell("shares")}
                  <td className="py-1.5 pr-3 tabular-nums">{r.engagement === null ? "—" : `${r.engagement}%`}</td>
                  <td className="py-1.5 pr-3">
                    <Button size="compact" variant="ghost" disabled={pending} onClick={() => start(async () => { const x = await refreshMetricsAction(r.postId); setMsg(x.ok ? `Refreshed ${r.questionCode}.` : x.error); router.refresh(); })}>
                      Refresh
                    </Button>
                    <div className="text-[10px] text-[var(--color-muted-foreground)]">{m ? `as of ${new Date(m.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : "not fetched"}</div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-6 text-center text-[var(--color-muted-foreground)]">
                  No published posts yet — metrics appear here after publishing.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-[var(--color-muted-foreground)]">Engagement = (likes + comments + saves + shares) ÷ reach. A “—” means Instagram did not return that metric (hover for the reason); nothing is estimated.</p>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          Compare by
          <SelectNative className="h-8 w-auto" value={dim} onChange={(e) => setDim(e.target.value)} data-testid="compare-dim">
            {dims.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </SelectNative>
        </label>
        <table className="w-full text-xs" data-testid="compare-table">
          <thead className="text-left text-[var(--color-muted-foreground)]">
            <tr>
              {["Group", "Posts", "With metrics", "Avg reach", "Avg engagement", "Avg saves"].map((h) => (
                <th key={h} className="py-1.5 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(compare[dim] ?? []).map((g) => (
              <tr key={g.key} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 pr-3">{g.key}</td>
                <td className="py-1.5 pr-3">{g.posts}</td>
                <td className="py-1.5 pr-3">{g.withMetrics}</td>
                <td className="py-1.5 pr-3">{n(g.avgReach)}</td>
                <td className="py-1.5 pr-3">{g.avgEngagement === null ? "—" : `${g.avgEngagement}%`}</td>
                <td className="py-1.5 pr-3">{n(g.avgSaves)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
