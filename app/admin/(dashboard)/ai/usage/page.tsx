import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "AI Usage — Mock Test Series.in Admin" };

interface ViewedMetadata {
  questionId?: string;
  cacheHit?: boolean;
  provider?: string;
  model?: string;
}

/**
 * Every number here is a real, live DB aggregate — no fake/demo values
 * (spec §17: "STUDENT AI VIEW ≠ PROVIDER API CALL"). The distinction comes
 * from StudentActivity rows logged by lib/student-data.ts#logAiAccess on
 * every Ask AI access: `AI_EXPLANATION_VIEWED` carries `cacheHit` +
 * `provider` for exactly this purpose. Explanation/variant generation
 * status counts are kept below as a second, complementary view (what's in
 * the cache right now, vs. how it's actually being used).
 */
export default async function AiUsagePage() {
  const [explanationCounts, variantCounts, variantTypeCounts, recentExplanations, recentVariants, geminiConfigured, openAiConfigured, viewedRows, generatedCount] =
    await Promise.all([
      prisma.aIExplanation.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.question.groupBy({ by: ["aiGenerationStatus"], where: { parentQuestionId: { not: null } }, _count: { _all: true } }),
      prisma.question.groupBy({ by: ["aiVariantType"], where: { parentQuestionId: { not: null } }, _count: { _all: true } }),
      prisma.aIExplanation.findMany({
        where: { status: "COMPLETED" },
        orderBy: { generatedAt: "desc" },
        take: 5,
        select: { generatedAt: true, model: true, question: { select: { code: true } } },
      }),
      prisma.question.findMany({
        where: { parentQuestionId: { not: null }, aiGenerationStatus: "COMPLETED" },
        orderBy: { aiGeneratedAt: "desc" },
        take: 5,
        select: { code: true, aiGeneratedAt: true, aiModel: true, aiVariantType: true },
      }),
      prisma.setting.findUnique({ where: { key: "api.gemini" } }).then((row) => Boolean(row)),
      prisma.setting.findUnique({ where: { key: "api.openai" } }).then((row) => Boolean(row)),
      prisma.studentActivity.findMany({
        where: { activity: "AI_EXPLANATION_VIEWED" },
        select: { studentId: true, metadata: true },
      }),
      prisma.studentActivity.count({ where: { activity: "AI_EXPLANATION_GENERATED" } }),
    ]);

  const explanationByStatus = Object.fromEntries(explanationCounts.map((c) => [c.status, c._count._all]));
  const variantByStatus = Object.fromEntries(variantCounts.map((c) => [c.aiGenerationStatus, c._count._all]));
  const variantByType = Object.fromEntries(variantTypeCounts.filter((c) => c.aiVariantType).map((c) => [c.aiVariantType, c._count._all]));
  const explanationTotal = explanationCounts.reduce((s, c) => s + c._count._all, 0);
  const variantTotal = variantCounts.reduce((s, c) => s + c._count._all, 0);

  // Derived purely from real StudentActivity rows — see logAiAccess.
  const studentViews = viewedRows.length;
  const uniqueQuestionViews = new Set(
    viewedRows.map((r) => `${r.studentId}:${(r.metadata as ViewedMetadata | null)?.questionId ?? ""}`)
  ).size;
  let cacheHits = 0;
  let cacheMisses = 0;
  const providerCalls: Record<string, number> = {};
  for (const row of viewedRows) {
    const meta = row.metadata as ViewedMetadata | null;
    if (meta?.cacheHit) {
      cacheHits += 1;
    } else {
      cacheMisses += 1;
      const provider = meta?.provider || "unknown";
      providerCalls[provider] = (providerCalls[provider] ?? 0) + 1;
    }
  }
  const cacheHitRate = studentViews > 0 ? Math.round((cacheHits / studentViews) * 100) : null;
  // A successful provider call always logs a COMPLETED cache-miss VIEWED row;
  // a call that FAILED never reaches logAiAccess at all, so the current
  // FAILED explanation/variant counts above are the real "provider failures"
  // signal — there's no per-attempt failure log to count distinct attempts,
  // only the current terminal state, so this is a floor, not a full total.
  const providerFailures = (explanationByStatus.FAILED ?? 0) + (variantByStatus.FAILED ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Usage</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Live counts from the database — never demo data.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Student Ask AI Activity</CardTitle>
          <CardDescription>Student view ≠ provider API call — a view can be served entirely from cache.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Student AI Views" value={studentViews} variant="info" />
          <StatTile label="Unique Student × Question" value={uniqueQuestionViews} variant="info" />
          <StatTile label="Cache Hits" value={cacheHits} variant="success" />
          <StatTile label="Cache Misses" value={cacheMisses} variant="neutral" />
        </CardContent>
        {cacheHitRate !== null ? (
          <CardContent className="pt-0 text-xs text-[var(--color-muted-foreground)]">Cache hit rate: {cacheHitRate}%</CardContent>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Actual Provider Calls</CardTitle>
            <CardDescription>Cache misses that reached a provider — never fabricated.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Gemini Calls" value={providerCalls.gemini ?? 0} variant="success" />
            <StatTile label="OpenAI Calls" value={providerCalls.openai ?? 0} variant="success" />
            <StatTile label="Provider Failures" value={providerFailures} variant="error" />
            <StatTile label="New Generations Triggered" value={generatedCount} variant="neutral" />
          </CardContent>
          <CardContent className="pt-0 text-xs text-[var(--color-muted-foreground)]">
            Latency and token/cost figures aren&apos;t tracked in the current schema — shown only if reliably derivable, never estimated.
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider Configuration</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={geminiConfigured ? "success" : "warning"}>{geminiConfigured ? "Gemini configured" : "Gemini not configured"}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={openAiConfigured ? "success" : "neutral"}>{openAiConfigured ? "OpenAI configured" : "OpenAI not configured"}</Badge>
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">Manage credentials under AI → Settings.</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Ask AI Explanations (Cache)</CardTitle>
            <CardDescription>{explanationTotal} total</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Ready" value={explanationByStatus.COMPLETED ?? 0} variant="success" />
            <StatTile label="Generating" value={explanationByStatus.GENERATING ?? 0} variant="info" />
            <StatTile label="Failed" value={explanationByStatus.FAILED ?? 0} variant="error" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI Question Variants</CardTitle>
            <CardDescription>{variantTotal} total</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Ready" value={variantByStatus.COMPLETED ?? 0} variant="success" />
            <StatTile label="Generating" value={variantByStatus.GENERATING ?? 0} variant="info" />
            <StatTile label="Failed" value={variantByStatus.FAILED ?? 0} variant="error" />
            <StatTile label="Similar (AI_SIMILAR)" value={variantByType.AI_SIMILAR ?? 0} variant="neutral" />
            <StatTile label="Trap (AI_TRAP)" value={variantByType.AI_TRAP ?? 0} variant="neutral" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Explanations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-[var(--color-border)]">
            {recentExplanations.length === 0 ? (
              <p className="py-4 text-sm text-[var(--color-muted-foreground)]">None yet.</p>
            ) : (
              recentExplanations.map((e, i) => (
                <div key={i} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="font-medium text-[var(--color-foreground)]">{e.question.code}</span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    {e.model} · {e.generatedAt?.toLocaleString() ?? "—"}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Variants</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-[var(--color-border)]">
            {recentVariants.length === 0 ? (
              <p className="py-4 text-sm text-[var(--color-muted-foreground)]">None yet.</p>
            ) : (
              recentVariants.map((v, i) => (
                <div key={i} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="font-medium text-[var(--color-foreground)]">{v.code}</span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    {v.aiVariantType} · {v.aiModel} · {v.aiGeneratedAt?.toLocaleString() ?? "—"}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatTile({ label, value, variant }: { label: string; value: number; variant: "success" | "info" | "error" | "neutral" }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
      <p className="text-2xl font-semibold text-[var(--color-foreground)]">{value}</p>
      <Badge variant={variant} className="w-fit">
        {label}
      </Badge>
    </div>
  );
}
