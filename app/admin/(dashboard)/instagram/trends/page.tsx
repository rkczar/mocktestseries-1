import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BUSINESS_DISCOVERY_STATUS, getCompetitorStats, getTrendEvidence, type TrendReportResult } from "@/lib/instagram/trends";
import { eligibleExamIds } from "@/lib/instagram/scope";
import { TrendsClient } from "@/components/admin/instagram/trends-client";
import type { TrendEvidence } from "@/lib/instagram/ai-studio-core";

export const metadata = { title: "Trends & Competitors — Instagram — Mock Test Series.in Admin" };

const fmt = (d: Date | string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d));

function TrendList({ title, items, evidence }: { title: string; items: TrendReportResult["evidenceBacked"]; evidence: Map<string, TrendEvidence> }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">{title}</h4>
      {items.length === 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">None supported by the evidence.</p> : null}
      <ul className="flex flex-col gap-1.5 text-sm">
        {items.map((t, i) => (
          <li key={i}>
            <span className="font-medium">{t.topic}</span>
            {t.why ? <span className="text-[var(--color-muted-foreground)]">{` — ${t.why}`}</span> : null}
            <ul className="ml-4 list-disc text-xs text-[var(--color-muted-foreground)]">
              {t.evidence.map((id) => {
                const e = evidence.get(id);
                return <li key={id}>{e ? `${e.summary} [${e.source}, ${e.observedAt ? fmt(e.observedAt) : "no date"}, ${e.quality} quality]` : id}</li>;
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Admin → Instagram → Trends & Competitors. Evidence only: our own post
 * metrics, our platform data, and reference posts entered by an admin. No
 * scraping; automatic competitor reads are NOT CONFIGURED (needs Meta
 * Business Discovery). Every AI finding cites the evidence it rests on.
 */
export default async function TrendsPage() {
  const scope = await eligibleExamIds();
  const [exams, refs, stats, evidence, reports] = await Promise.all([
    prisma.exam.findMany({ where: { id: { in: [...scope] } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.instagramReference.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "desc" }], take: 200 }),
    getCompetitorStats(),
    getTrendEvidence({ limit: 40 }),
    prisma.instagramInsightReport.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
  ]);
  const latestTrend = reports.find((r) => r.kind === "TREND");
  const latestComp = reports.find((r) => r.kind === "COMPETITOR");
  const trendEvidence = new Map(((latestTrend?.evidence as unknown as TrendEvidence[] | undefined) ?? []).map((e) => [e.id, e]));
  const trend = latestTrend?.result as unknown as (TrendReportResult & { examName?: string | null }) | undefined;
  const comp = latestComp?.result as unknown as { patterns: { observation: string; evidence: string[] }[]; contentGaps: { idea: string; evidence: string[] }[]; captionStyles: { style: string; evidence: string[] }[]; note: string } | undefined;
  const refById = new Map(refs.map((r) => [`ref:${r.id}`, r]));

  return (
    <div className="flex flex-col gap-4">
      <Card data-testid="business-discovery">
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Automatic competitor reading <Badge variant="warning">NOT CONFIGURED</Badge>
          </CardTitle>
          <CardDescription>{BUSINESS_DISCOVERY_STATUS.message}</CardDescription>
        </CardHeader>
      </Card>

      <TrendsClient
        exams={exams}
        references={refs.map((r) => ({
          id: r.id,
          kind: r.kind,
          handle: r.handle,
          url: r.url,
          topic: r.topic,
          format: r.format,
          captionStyle: r.captionStyle,
          keywords: r.keywords,
          examTags: r.examTags,
          likes: r.likes,
          comments: r.comments,
          views: r.views,
          observedAt: r.observedAt?.toISOString() ?? null,
          active: r.active,
          createdAt: r.createdAt.toISOString(),
        }))}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Evidence available now</CardTitle>
          <CardDescription>{`${evidence.length} items. Each shows its source, time and quality. Only these are ever given to the AI.`}</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <ul className="flex flex-col gap-1 text-xs" data-testid="evidence-list">
            {evidence.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-1.5">
                <Badge variant={e.kind === "OWN_PERFORMANCE" ? "success" : e.kind === "PLATFORM" ? "info" : "neutral"}>{e.kind.replace("_", " ").toLowerCase()}</Badge>
                <span>{e.summary}</span>
                <span className="text-[var(--color-muted-foreground)]">{`${e.source} · ${e.observedAt ? fmt(e.observedAt) : "no date"} · ${e.quality} quality`}</span>
              </li>
            ))}
            {evidence.length === 0 ? <li className="text-[var(--color-muted-foreground)]">No evidence yet — publish posts and refresh their metrics, or add reference posts.</li> : null}
          </ul>
        </CardContent>
      </Card>

      <Card data-testid="competitor-stats">
        <CardHeader className="pb-2">
          <CardTitle>Reference posts — computed patterns</CardTitle>
          <CardDescription>{`Counted directly from the ${stats.totalPosts} reference post(s) you entered (no AI).`}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 px-5 pb-5 text-sm md:grid-cols-2">
          <div>
            <h4 className="mb-1 font-semibold">By handle</h4>
            {stats.handles.map((h) => (
              <p key={h.handle} className="text-xs">{`@${h.handle}: ${h.posts} posts · avg likes ${h.avgLikes ?? "?"} · avg comments ${h.avgComments ?? "?"} · avg views ${h.avgViews ?? "?"}`}</p>
            ))}
          </div>
          <div>
            <h4 className="mb-1 font-semibold">Formats</h4>
            {stats.formats.map((f) => (
              <p key={f.format} className="text-xs">{`${f.format}: ${f.posts} posts · avg likes ${f.avgLikes ?? "?"}`}</p>
            ))}
          </div>
          <div>
            <h4 className="mb-1 font-semibold">Posting days (IST)</h4>
            <p className="text-xs">{stats.weekdays.map((d) => `${d.day} ${d.posts}`).join(" · ")}</p>
          </div>
          <div>
            <h4 className="mb-1 font-semibold">Topics and keywords</h4>
            <p className="text-xs">{stats.topics.map((t) => `${t.topic} (${t.posts})`).join(", ") || "—"}</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">{stats.keywords.map((k) => `${k.keyword} (${k.posts})`).join(", ")}</p>
          </div>
        </CardContent>
      </Card>

      {trend ? (
        <Card data-testid="trend-report">
          <CardHeader className="pb-2">
            <CardTitle>{`Latest trend analysis${trend.examName ? ` — ${trend.examName}` : ""}`}</CardTitle>
            <CardDescription>{`${fmt(latestTrend!.createdAt)} · ${latestTrend!.provider ?? ""} ${latestTrend!.model ?? ""} · ${trend.dropped} AI item(s) dropped for citing no valid evidence. ${trend.note}`}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 px-5 pb-5 md:grid-cols-2">
            <TrendList title="Evidence-backed trends" items={trend.evidenceBacked} evidence={trendEvidence} />
            <TrendList title="Emerging topics" items={trend.emerging} evidence={trendEvidence} />
            <TrendList title="Evergreen high-yield topics" items={trend.evergreen} evidence={trendEvidence} />
            <TrendList title="Exam-season topics" items={trend.examSeason} evidence={trendEvidence} />
          </CardContent>
        </Card>
      ) : null}

      {comp ? (
        <Card data-testid="competitor-report">
          <CardHeader className="pb-2">
            <CardTitle>Latest competitor content analysis</CardTitle>
            <CardDescription>{`${fmt(latestComp!.createdAt)} · ${latestComp!.provider ?? ""} ${latestComp!.model ?? ""}. ${comp.note}`}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 px-5 pb-5 text-sm md:grid-cols-3">
            {([
              ["Patterns", comp.patterns.map((p) => ({ text: p.observation, ev: p.evidence }))],
              ["Content gaps for us", comp.contentGaps.map((p) => ({ text: p.idea, ev: p.evidence }))],
              ["Caption styles", comp.captionStyles.map((p) => ({ text: p.style, ev: p.evidence }))],
            ] as const).map(([title, list]) => (
              <div key={title}>
                <h4 className="mb-1 font-semibold">{title}</h4>
                {list.length === 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">Nothing supported by the references.</p> : null}
                <ul className="flex flex-col gap-1 text-xs">
                  {list.map((x, i) => (
                    <li key={i}>
                      {x.text}
                      <span className="text-[var(--color-muted-foreground)]">{` — ${x.ev.map((id) => (refById.get(id) ? `@${refById.get(id)!.handle}` : id)).join(", ")}`}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
