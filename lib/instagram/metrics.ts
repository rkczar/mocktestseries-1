import "server-only";
import { prisma } from "@/lib/prisma";
import { insightsApi, isPermissionError, isRateLimit, type GraphFail, type InsightsApi } from "@/lib/instagram/meta";
import { StudioError } from "@/lib/instagram/posts";
import { examProfile } from "@/lib/instagram/exam-scope";
import { modeOfTemplate, normalizeContent, normalizeDesign, type SourceSnapshot } from "@/lib/instagram/types";
import { themeFor } from "@/lib/instagram/templates";

/**
 * Instagram post analytics. Metrics are read from the Instagram API (media
 * object counts + /insights) for posts this studio published, and stored as
 * InstagramPostMetric snapshots. A metric the API does not return (missing
 * permission, not supported for the media type, too new) stays null and the
 * reason is stored — nothing is ever estimated or guessed.
 */

export const INSIGHT_METRICS = ["reach", "saved", "shares", "views"] as const;
const REFRESH_COOLDOWN_MS = 10 * 60_000;

export interface MetricValues {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
}

/** (likes + comments + saves + shares) / reach — null when reach or every interaction is unknown. */
export function engagementRate(m: MetricValues): number | null {
  if (!m.reach) return null;
  const parts = [m.likes, m.comments, m.saves, m.shares].filter((x): x is number => x !== null);
  if (!parts.length) return null;
  return Math.round((parts.reduce((a, b) => a + b, 0) / m.reach) * 10000) / 100;
}

function failText(f: GraphFail): string {
  if (isPermissionError(f)) return "permission missing (instagram_business_manage_insights)";
  if (isRateLimit(f)) return "Instagram rate limit";
  return f.message.slice(0, 120);
}

function readInsightValue(body: Record<string, unknown>, name: string): number | null {
  const data = Array.isArray(body.data) ? (body.data as { name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[]) : [];
  const row = data.find((d) => d.name === name);
  const v = row?.values?.[0]?.value ?? row?.total_value?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Reads metrics for one published post and stores a snapshot. */
export async function refreshPostMetrics(postId: string, apiOverride?: InsightsApi | null, opts: { force?: boolean } = {}) {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId }, select: { id: true, status: true, igMediaId: true } });
  if (!post) throw new StudioError("Post not found.");
  if (post.status !== "PUBLISHED" || !post.igMediaId) throw new StudioError("Only published posts have Instagram metrics.");
  if (!opts.force) {
    const last = await prisma.instagramPostMetric.findFirst({ where: { postId }, orderBy: { fetchedAt: "desc" }, select: { fetchedAt: true } });
    if (last && Date.now() - last.fetchedAt.getTime() < REFRESH_COOLDOWN_MS) throw new StudioError("Metrics were refreshed less than 10 minutes ago.");
  }
  const api = apiOverride === undefined ? insightsApi() : apiOverride;
  if (!api) throw new StudioError("Instagram is not connected (no access token installed), so metrics can't be read.");

  const unavailable: Record<string, string> = {};
  const values: MetricValues = { views: null, reach: null, likes: null, comments: null, saves: null, shares: null };
  const counts = await api.mediaCounts(post.igMediaId);
  if (counts.ok) {
    values.likes = typeof counts.body.like_count === "number" ? counts.body.like_count : null;
    values.comments = typeof counts.body.comments_count === "number" ? counts.body.comments_count : null;
    if (values.likes === null) unavailable.likes = "not returned by the API (likes may be hidden)";
    if (values.comments === null) unavailable.comments = "not returned by the API";
  } else {
    unavailable.likes = unavailable.comments = failText(counts);
  }
  const map: Record<(typeof INSIGHT_METRICS)[number], keyof MetricValues> = { reach: "reach", saved: "saves", shares: "shares", views: "views" };
  const all = await api.mediaInsights(post.igMediaId, [...INSIGHT_METRICS]);
  if (all.ok) {
    for (const m of INSIGHT_METRICS) {
      values[map[m]] = readInsightValue(all.body, m);
      if (values[map[m]] === null) unavailable[map[m]] = "not returned by the API";
    }
  } else {
    // One unsupported metric fails the whole request — retry one at a time so the others still load.
    for (const m of INSIGHT_METRICS) {
      const one = await api.mediaInsights(post.igMediaId, [m]);
      if (one.ok) values[map[m]] = readInsightValue(one.body, m);
      if (!one.ok) unavailable[map[m]] = failText(one);
      else if (values[map[m]] === null) unavailable[map[m]] = "not returned by the API";
    }
  }
  return prisma.instagramPostMetric.create({
    data: { postId, igMediaId: post.igMediaId, ...values, unavailable: Object.keys(unavailable).length ? unavailable : undefined },
  });
}

// ---- Analytics (Published History + comparisons) -------------------------------------------

export interface PublishedPerformance {
  postId: string;
  questionCode: string;
  publishedAt: string | null;
  igPermalink: string | null;
  exam: string;
  examKey: string;
  subject: string;
  topic: string | null;
  designMode: string;
  template: string;
  captionStyle: string;
  slides: number;
  metrics: (MetricValues & { fetchedAt: string; unavailable: Record<string, string> }) | null;
  engagement: number | null;
}

export async function listPublishedPerformance(): Promise<PublishedPerformance[]> {
  const posts = await prisma.instagramPost.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    take: 500,
    select: { id: true, questionCode: true, publishedAt: true, igPermalink: true, sourceSnapshot: true, design: true, content: true },
  });
  const metrics = posts.length
    ? await prisma.instagramPostMetric.findMany({ where: { postId: { in: posts.map((p) => p.id) } }, orderBy: { fetchedAt: "desc" } })
    : [];
  const latest = new Map<string, (typeof metrics)[number]>();
  for (const m of metrics) if (!latest.has(m.postId)) latest.set(m.postId, m);
  return posts.map((p) => {
    const s = p.sourceSnapshot as unknown as SourceSnapshot;
    const d = normalizeDesign(p.design);
    const c = normalizeContent(p.content);
    const m = latest.get(p.id);
    const values: MetricValues | null = m ? { views: m.views, reach: m.reach, likes: m.likes, comments: m.comments, saves: m.saves, shares: m.shares } : null;
    return {
      postId: p.id,
      questionCode: p.questionCode,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      igPermalink: p.igPermalink,
      exam: s.examName,
      examKey: examProfile(s.examName, s.examCode).label,
      subject: s.subjectName,
      topic: s.topicName,
      designMode: modeOfTemplate(d.template) === "handwritten" ? "Handwritten" : "Professional",
      template: themeFor(d.template).name,
      captionStyle: c.captionStyle ?? "custom",
      slides: d.modules.length,
      metrics: m && values ? { ...values, fetchedAt: m.fetchedAt.toISOString(), unavailable: (m.unavailable as Record<string, string> | null) ?? {} } : null,
      engagement: values ? engagementRate(values) : null,
    };
  });
}

export interface GroupStat {
  key: string;
  posts: number;
  withMetrics: number;
  avgReach: number | null;
  avgEngagement: number | null;
  avgSaves: number | null;
}

export const COMPARE_DIMENSIONS = [
  { key: "examKey", label: "Exam" },
  { key: "subject", label: "Subject" },
  { key: "topic", label: "Topic" },
  { key: "designMode", label: "Design Mode" },
  { key: "template", label: "Template" },
  { key: "captionStyle", label: "Caption Style" },
  { key: "slides", label: "Carousel Length" },
] as const;

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
};

export function compareBy(rows: PublishedPerformance[], dim: (typeof COMPARE_DIMENSIONS)[number]["key"]): GroupStat[] {
  const groups = new Map<string, PublishedPerformance[]>();
  for (const r of rows) {
    const k = String(r[dim] ?? "—");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      posts: list.length,
      withMetrics: list.filter((r) => r.metrics).length,
      avgReach: avg(list.map((r) => r.metrics?.reach ?? null)),
      avgEngagement: avg(list.map((r) => r.engagement)),
      avgSaves: avg(list.map((r) => r.metrics?.saves ?? null)),
    }))
    .sort((a, b) => (b.avgEngagement ?? -1) - (a.avgEngagement ?? -1));
}
