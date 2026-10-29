import "server-only";
import { prisma } from "@/lib/prisma";
import { generateForFeature } from "@/lib/ai-gateway";
import type { GatewayProvider } from "@/lib/ai-gateway-config";
import { getMostMissed, parseMostMissedFilters } from "@/lib/instagram/most-missed";
import { listPublishedPerformance } from "@/lib/instagram/metrics";
import { EXCLUDED_TERMS } from "@/lib/instagram/exam-scope";
import { StudioError } from "@/lib/instagram/posts";
import type { TrendEvidence } from "@/lib/instagram/ai-studio-core";
import { extractJsonObject } from "@/lib/ai-engine/structured";

/**
 * Trends & Competitors — evidence only.
 *
 * Sources (each evidence row names its source, timestamp and quality):
 *  - OWN_PERFORMANCE: metrics of our own published posts (Instagram API).
 *  - PLATFORM: MockTestSeries data — topics students answered wrong most in
 *    the last 7 days (Question Insights), and how many previous-year-paper
 *    questions each topic has in our Question Bank.
 *  - REFERENCE: competitor / reference posts a Master Admin entered by hand
 *    from what they observed (public numbers as seen, with the date).
 *
 * Nothing is scraped. Reading other accounts automatically needs Meta's
 * Business Discovery API (a Facebook-Login token with business discovery
 * access), which this installation does not have — that source is reported as
 * NOT CONFIGURED, not faked. The AI only summarises the evidence it is given
 * and must cite evidence ids; any trend it can't tie to evidence is dropped.
 */

export const BUSINESS_DISCOVERY_STATUS = {
  configured: false,
  message:
    "NOT CONFIGURED — automatic reading of other accounts needs Meta's Business Discovery API (Instagram Graph API with Facebook Login, a linked Facebook Page and business discovery access). The installed token uses Instagram Login, which can only read our own account. Add reference posts manually below instead.",
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function getTrendEvidence(params: { examId?: string | null; subjectName?: string | null; topicName?: string | null; limit?: number } = {}): Promise<TrendEvidence[]> {
  const out: TrendEvidence[] = [];
  const limit = params.limit ?? 30;

  // Own performance.
  const perf = (await listPublishedPerformance()).filter((p) => p.metrics && p.engagement !== null);
  for (const p of perf.slice(0, 40)) {
    out.push({
      id: `own:${p.postId}`,
      kind: "OWN_PERFORMANCE",
      summary: `Our post on ${p.topic ?? p.subject} (${p.examKey}, ${p.designMode}, ${p.slides} slides) reached ${p.metrics!.reach ?? "?"} accounts with ${p.engagement}% engagement and ${p.metrics!.saves ?? "?"} saves.`,
      source: "Instagram API (our account)",
      observedAt: p.metrics!.fetchedAt,
      quality: "high",
    });
  }

  // Platform: most-missed topics, last 7 days.
  try {
    const mm = await getMostMissed(parseMostMissedFilters({ range: "7d", examId: params.examId ?? undefined, min: "10" }));
    const byTopic = new Map<string, { attempts: number; wrong: number; exam: string }>();
    for (const r of mm.rows) {
      const k = r.topic ?? r.subject;
      const cur = byTopic.get(k) ?? { attempts: 0, wrong: 0, exam: r.examName };
      cur.attempts += r.attempts;
      cur.wrong += r.wrong;
      byTopic.set(k, cur);
    }
    [...byTopic.entries()]
      .filter(([, v]) => v.attempts >= 20)
      .sort((a, b) => b[1].wrong / b[1].attempts - a[1].wrong / a[1].attempts)
      .slice(0, 8)
      .forEach(([topic, v], i) =>
        out.push({
          id: `missed:${i}`,
          kind: "PLATFORM",
          summary: `On MockTestSeries (not Instagram), ${topic} questions (${v.exam}) were answered wrong ${Math.round((v.wrong / v.attempts) * 100)}% of the time (${v.attempts} answers, last 7 days).`,
          source: "MockTestSeries Question Insights",
          observedAt: new Date().toISOString(),
          quality: "medium",
        })
      );
  } catch {
    // Insights unavailable — no evidence from this source.
  }

  // Platform: PYQ topic coverage in our Question Bank.
  const pyqTopics = await prisma.question.groupBy({
    by: ["topicId"],
    where: { previousYearPaperId: { not: null }, status: "PUBLISHED", topicId: { not: null }, ...(params.examId ? { examId: params.examId } : {}) },
    _count: { _all: true },
    orderBy: { _count: { topicId: "desc" } },
    take: 8,
  });
  if (pyqTopics.length) {
    const topics = await prisma.topic.findMany({ where: { id: { in: pyqTopics.map((t) => t.topicId!) } }, select: { id: true, name: true } });
    const name = new Map(topics.map((t) => [t.id, t.name]));
    pyqTopics.forEach((t, i) =>
      out.push({
        id: `pyq:${i}`,
        kind: "PLATFORM",
        summary: `Our Question Bank has ${t._count._all} previous-year-paper questions on ${name.get(t.topicId!) ?? "a topic"}${params.examId ? " for this exam" : ""} (a count of stored questions, not a prediction).`,
        source: "MockTestSeries Question Bank",
        observedAt: new Date().toISOString(),
        quality: "medium",
      })
    );
  }

  // Manual references (last 120 days).
  const refs = await prisma.instagramReference.findMany({
    where: { kind: "POST", active: true, OR: [{ observedAt: null }, { observedAt: { gte: new Date(Date.now() - 120 * 86_400_000) } }] },
    orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
    take: 40,
  });
  for (const r of refs) {
    if (r.topic && EXCLUDED_TERMS.test(r.topic)) continue;
    const eng = [r.likes !== null ? `${r.likes} likes` : null, r.comments !== null ? `${r.comments} comments` : null, r.views !== null ? `${r.views} views` : null].filter(Boolean).join(", ");
    out.push({
      id: `ref:${r.id}`,
      kind: "REFERENCE",
      summary: `@${r.handle} posted ${r.format ? `a ${r.format}` : "a post"} on ${r.topic ?? "an unspecified topic"}${r.captionStyle ? ` (caption style: ${r.captionStyle})` : ""}${eng ? `; observed ${eng}` : ""}${r.examTags.length ? ` [${r.examTags.join(", ")}]` : ""}.`,
      source: `Manually entered${r.url ? ` from ${r.url}` : ""}`,
      observedAt: iso(r.observedAt ?? r.createdAt),
      quality: r.likes !== null || r.views !== null ? "medium" : "low",
    });
  }

  // Prefer evidence about the post's own subject/topic first.
  const needle = [params.topicName, params.subjectName].filter(Boolean).map((x) => x!.toLowerCase());
  const score = (e: TrendEvidence) => (needle.some((n) => e.summary.toLowerCase().includes(n)) ? 0 : 1);
  return out.sort((a, b) => score(a) - score(b)).slice(0, limit);
}

// ---- Deterministic competitor statistics ------------------------------------------------------

export interface CompetitorStats {
  handles: { handle: string; posts: number; avgLikes: number | null; avgComments: number | null; avgViews: number | null; formats: Record<string, number> }[];
  formats: { format: string; posts: number; avgLikes: number | null }[];
  weekdays: { day: string; posts: number }[];
  topics: { topic: string; posts: number }[];
  keywords: { keyword: string; posts: number }[];
  totalPosts: number;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

export async function getCompetitorStats(): Promise<CompetitorStats> {
  const refs = await prisma.instagramReference.findMany({ where: { kind: "POST", active: true }, orderBy: { observedAt: "desc" }, take: 500 });
  const byHandle = new Map<string, typeof refs>();
  for (const r of refs) byHandle.set(r.handle, [...(byHandle.get(r.handle) ?? []), r]);
  const count = <T,>(xs: T[], key: (x: T) => string | null) => {
    const m = new Map<string, number>();
    for (const x of xs) {
      const k = key(x);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const formats = new Map<string, typeof refs>();
  for (const r of refs) if (r.format) formats.set(r.format, [...(formats.get(r.format) ?? []), r]);
  const weekdays = count(refs.filter((r) => r.observedAt), (r) => DAYS[new Date(r.observedAt!.getTime() + 5.5 * 3_600_000).getUTCDay()]);
  return {
    totalPosts: refs.length,
    handles: [...byHandle.entries()].map(([handle, list]) => ({
      handle,
      posts: list.length,
      avgLikes: mean(list.map((r) => r.likes)),
      avgComments: mean(list.map((r) => r.comments)),
      avgViews: mean(list.map((r) => r.views)),
      formats: Object.fromEntries(count(list, (r) => r.format)),
    })),
    formats: [...formats.entries()].map(([format, list]) => ({ format, posts: list.length, avgLikes: mean(list.map((r) => r.likes)) })).sort((a, b) => b.posts - a.posts),
    weekdays: DAYS.map((day) => ({ day, posts: weekdays.get(day) ?? 0 })),
    topics: [...count(refs, (r) => r.topic?.trim() || null).entries()].map(([topic, posts]) => ({ topic, posts })).sort((a, b) => b.posts - a.posts).slice(0, 15),
    keywords: [...count(refs.flatMap((r) => r.keywords.map((k) => ({ k }))), (x) => x.k.toLowerCase()).entries()].map(([keyword, posts]) => ({ keyword, posts })).sort((a, b) => b.posts - a.posts).slice(0, 20),
  };
}

// ---- AI analyses (evidence-bound) -------------------------------------------------------------

export interface TrendItem {
  topic: string;
  why: string;
  evidence: string[];
}

export interface TrendReportResult {
  evidenceBacked: TrendItem[];
  emerging: TrendItem[];
  evergreen: TrendItem[];
  examSeason: TrendItem[];
  dropped: number;
  note: string;
}

function extractJson(text: string): Record<string, unknown> | null {
  // Shared structural reader (lib/ai-engine/structured.ts): one object, fences/chatter tolerated, never two objects glued.
  const r = extractJsonObject(text);
  return r.ok ? r.value : null;
}

/** Keeps only items that cite at least one real evidence id. */
export function parseTrendReport(text: string, evidence: TrendEvidence[]): TrendReportResult | null {
  const d = extractJson(text);
  if (!d) return null;
  const ids = new Set(evidence.map((e) => e.id));
  let dropped = 0;
  const list = (k: string): TrendItem[] =>
    (Array.isArray(d[k]) ? (d[k] as unknown[]) : []).flatMap((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const ev = (Array.isArray(o.evidence) ? o.evidence : []).filter((e): e is string => typeof e === "string" && ids.has(e));
      const topic = typeof o.topic === "string" ? o.topic.trim().slice(0, 80) : "";
      if (!topic || !ev.length || EXCLUDED_TERMS.test(topic)) {
        dropped++;
        return [];
      }
      return [{ topic, why: typeof o.why === "string" ? o.why.trim().slice(0, 240) : "", evidence: ev.slice(0, 5) }];
    });
  return { evidenceBacked: list("evidenceBacked"), emerging: list("emerging"), evergreen: list("evergreen"), examSeason: list("examSeason"), dropped, note: typeof d.note === "string" ? d.note.slice(0, 300) : "" };
}

export async function runTrendAnalysis(params: { actorId: string; examId: string | null; examName: string | null; provider?: GatewayProvider | null; quoteId?: string | null; modelOverride?: string | null }) {
  const evidence = await getTrendEvidence({ examId: params.examId, limit: 40 });
  if (!evidence.length) throw new StudioError("There is no evidence yet — publish posts and refresh their metrics, or add reference posts, then run the analysis.");
  const prompt = [
    "You analyse Instagram content opportunities for MockTestSeries.in (MBBS-level and post-MBBS medical exams: FMGE, NEET PG, INI-CET, AIIMS recruitment, UPSC CMS, State Medical Officer exams). Never NEET UG or school level.",
    params.examName ? `Focus exam: ${params.examName}.` : "All in-scope exams.",
    "Use ONLY the evidence below. Every item you return must cite evidence ids that support it. If the evidence does not support a category, return an empty list for it. Never invent numbers, accounts or trends.",
    "",
    ...evidence.map((e) => `[${e.id}] (${e.kind}, ${e.quality}, ${e.source}${e.observedAt ? `, ${e.observedAt.slice(0, 10)}` : ""}) ${e.summary}`),
    "",
    'Return ONLY JSON: {"evidenceBacked": [{"topic":"...","why":"...","evidence":["id"]}], "emerging": [...], "evergreen": [...], "examSeason": [...], "note": "one sentence on evidence limits"}',
    "Definitions: evidenceBacked = topics with strong current evidence; emerging = rising in recent evidence; evergreen = consistently high-yield (e.g. many stored PYQs); examSeason = tied to an upcoming exam only if the evidence says so.",
  ].join("\n");
  const r = await generateForFeature("ig_trends", prompt, { temperature: 0.2, maxOutputTokens: 2000, json: true, check: (t) => (parseTrendReport(t, evidence) ? { ok: true } : { ok: false, category: "schema_invalid", message: "The trend report had no usable items citing the evidence." }) }, { actorId: params.actorId, providerOverride: params.provider ?? null, quoteId: params.quoteId, modelOverride: params.modelOverride });
  const parsed = parseTrendReport(r.text, evidence);
  if (!parsed) throw new StudioError("The AI response was not valid JSON. Nothing was saved.");
  return prisma.instagramInsightReport.create({
    data: { kind: "TREND", provider: r.provider, model: r.model, evidence: evidence as unknown as object, result: { ...parsed, examId: params.examId, examName: params.examName } as unknown as object, createdById: params.actorId },
  });
}

export async function runCompetitorAnalysis(params: { actorId: string; provider?: GatewayProvider | null; quoteId?: string | null; modelOverride?: string | null }) {
  const stats = await getCompetitorStats();
  if (stats.totalPosts === 0) throw new StudioError("Add reference posts first — the analysis only uses posts you entered.");
  const refs = await prisma.instagramReference.findMany({ where: { kind: "POST", active: true }, orderBy: { observedAt: "desc" }, take: 60 });
  const lines = refs.map(
    (r) =>
      `[ref:${r.id}] @${r.handle} · ${r.format ?? "format ?"} · topic: ${r.topic ?? "?"} · caption style: ${r.captionStyle ?? "?"} · keywords: ${r.keywords.join(", ") || "-"} · likes ${r.likes ?? "?"}, comments ${r.comments ?? "?"}, views ${r.views ?? "?"} · observed ${r.observedAt?.toISOString().slice(0, 10) ?? "?"}`
  );
  const prompt = [
    "You analyse competitor/reference Instagram content for a medical exam preparation brand. Use ONLY the reference posts below (entered manually by an admin) and the computed statistics. Cite ref ids for every observation. Do not copy captions; describe patterns. Never invent numbers.",
    "",
    ...lines,
    "",
    `Computed statistics: ${JSON.stringify({ formats: stats.formats, weekdays: stats.weekdays, topics: stats.topics.slice(0, 8) })}`,
    "",
    'Return ONLY JSON: {"patterns": [{"observation":"...","evidence":["ref:..."]}], "contentGaps": [{"idea":"...","evidence":["ref:..."]}], "captionStyles": [{"style":"...","evidence":["ref:..."]}], "note": "limits of this evidence"}',
  ].join("\n");
  const r = await generateForFeature("ig_competitors", prompt, { temperature: 0.2, maxOutputTokens: 2000, json: true }, { actorId: params.actorId, providerOverride: params.provider ?? null, quoteId: params.quoteId, modelOverride: params.modelOverride });
  const d = extractJson(r.text);
  if (!d) throw new StudioError("The AI response was not valid JSON. Nothing was saved.");
  const ids = new Set(refs.map((x) => `ref:${x.id}`));
  const keep = (k: string, field: string) =>
    (Array.isArray(d[k]) ? (d[k] as Record<string, unknown>[]) : []).flatMap((o) => {
      const ev = (Array.isArray(o?.evidence) ? o.evidence : []).filter((e): e is string => typeof e === "string" && ids.has(e));
      const text = typeof o?.[field] === "string" ? (o[field] as string).slice(0, 240) : "";
      return text && ev.length ? [{ [field]: text, evidence: ev.slice(0, 5) }] : [];
    });
  const result = { patterns: keep("patterns", "observation"), contentGaps: keep("contentGaps", "idea"), captionStyles: keep("captionStyles", "style"), note: typeof d.note === "string" ? d.note.slice(0, 300) : "", stats };
  return prisma.instagramInsightReport.create({
    data: { kind: "COMPETITOR", provider: r.provider, model: r.model, evidence: refs.map((x) => x.id) as unknown as object, result: result as unknown as object, createdById: params.actorId },
  });
}
