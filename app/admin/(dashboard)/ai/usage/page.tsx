import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "AI Usage — Mock Test Series.in Admin" };

/**
 * Every number here is a real, live DB aggregate — no fake/demo values
 * (Step 7.4). Cache-hit-rate is intentionally omitted: nothing in the
 * current schema records read-vs-generate per request, so it can't be
 * measured accurately yet without adding tracking, and Step 7.4 explicitly
 * says only show it "if accurately measurable."
 */
export default async function AiUsagePage() {
  const [explanationCounts, variantCounts, variantTypeCounts, recentExplanations, recentVariants, geminiConfigured] = await Promise.all([
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
  ]);

  const explanationByStatus = Object.fromEntries(explanationCounts.map((c) => [c.status, c._count._all]));
  const variantByStatus = Object.fromEntries(variantCounts.map((c) => [c.aiGenerationStatus, c._count._all]));
  const variantByType = Object.fromEntries(variantTypeCounts.filter((c) => c.aiVariantType).map((c) => [c.aiVariantType, c._count._all]));
  const explanationTotal = explanationCounts.reduce((s, c) => s + c._count._all, 0);
  const variantTotal = variantCounts.reduce((s, c) => s + c._count._all, 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Usage</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Live counts from the database — never demo data.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Ask AI Explanations</CardTitle>
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

      <Card>
        <CardHeader>
          <CardTitle>Provider</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Badge variant={geminiConfigured ? "success" : "warning"}>{geminiConfigured ? "Gemini configured" : "Gemini not configured"}</Badge>
            <p className="text-xs text-[var(--color-muted-foreground)]">Manage the API key under Settings → Authentication.</p>
          </div>
        </CardContent>
      </Card>

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
