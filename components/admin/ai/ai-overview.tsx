import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAiSettings } from "@/lib/ai-settings";
import { getGeminiConfig } from "@/lib/gemini-config";
import { getOpenAiConfig } from "@/lib/openai-config";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * The former /admin/ai/solution-manager stub duplicated Solutions, Usage,
 * Variants and Settings (spec §21: "do not build another duplicate
 * subsystem"). This is the reframed AI overview it asked for instead — a
 * single live snapshot plus quick links into those real pages, shared by
 * both the "Overview" tab on /admin/ai and the standalone
 * /admin/ai/solution-manager route so there is exactly one implementation.
 */
export async function AiOverview() {
  const [settings, gemini, openai, cachedSolutions, questionsWithoutAi, viewedRows] = await Promise.all([
    getAiSettings(),
    getGeminiConfig(),
    getOpenAiConfig(),
    prisma.aIExplanation.count({ where: { status: "COMPLETED" } }),
    prisma.question.count({ where: { parentQuestionId: null, status: "PUBLISHED", aiExplanation: null } }),
    prisma.studentActivity.findMany({
      where: { activity: "AI_EXPLANATION_VIEWED" },
      select: { metadata: true },
    }),
  ]);

  const totalViews = viewedRows.length;
  const cacheHits = viewedRows.filter((r) => (r.metadata as { cacheHit?: boolean } | null)?.cacheHit).length;
  const providerCalls = totalViews - cacheHits;
  const cacheHitRate = totalViews > 0 ? Math.round((cacheHits / totalViews) * 100) : null;
  const failedCalls = await prisma.aIExplanation.count({ where: { status: "FAILED" } });

  const activeConfig = settings.activeProvider === "gemini" ? gemini : openai;
  const activeHealthy = activeConfig.configured && activeConfig.lastTest?.ok === true;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>AI Overview</CardTitle>
          <CardDescription>Live status across the whole Ask AI system — provider, cache, and usage in one place.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <OverviewTile label="Ask AI" value={settings.askAiEnabled ? "Enabled" : "Disabled"} variant={settings.askAiEnabled ? "success" : "warning"} />
          <OverviewTile label="Active Provider" value={settings.activeProvider === "gemini" ? "Gemini" : "OpenAI"} variant="neutral" />
          <OverviewTile
            label="Provider Health"
            value={!activeConfig.configured ? "Not configured" : activeConfig.lastTest ? (activeHealthy ? "Connected" : "Failing") : "Untested"}
            variant={!activeConfig.configured ? "warning" : activeHealthy ? "success" : activeConfig.lastTest ? "error" : "neutral"}
          />
          <OverviewTile label="Cached Solutions" value={cachedSolutions} variant="success" />
          <OverviewTile label="Published Questions Without AI" value={questionsWithoutAi} variant="neutral" />
          <OverviewTile label="Student AI Views" value={totalViews} variant="info" />
          <OverviewTile label="Cache Hit Rate" value={cacheHitRate === null ? "—" : `${cacheHitRate}%`} variant="success" />
          <OverviewTile label="Actual Provider Calls" value={providerCalls} variant="neutral" />
          <OverviewTile label="Failed Calls" value={failedCalls} variant={failedCalls > 0 ? "error" : "success"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <QuickLink href="/admin/ai?tab=solutions" label="Solutions" />
          <QuickLink href="/admin/ai?tab=variants" label="Variants" />
          <QuickLink href="/admin/ai?tab=usage" label="Usage" />
          <QuickLink href="/admin/ai?tab=settings" label="Settings" />
        </CardContent>
      </Card>
    </div>
  );
}

function OverviewTile({ label, value, variant }: { label: string; value: string | number; variant: "success" | "info" | "error" | "neutral" | "warning" }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
      <p className="text-xl font-semibold text-[var(--color-foreground)]">{value}</p>
      <Badge variant={variant} className="w-fit">
        {label}
      </Badge>
    </div>
  );
}

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-surface)]"
    >
      {label}
    </Link>
  );
}
