import { getAdminSession } from "@/lib/rbac";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { getClaudeConfig } from "@/lib/anthropic-config";
import { getGeminiConfig } from "@/lib/gemini-config";
import { getOpenAiConfig } from "@/lib/openai-config";
import { getAiSettings } from "@/lib/ai-settings";
import { getGatewayConfig, usageSince } from "@/lib/ai-gateway";
import { istStartOfDay } from "@/lib/ist-time";
import { prisma } from "@/lib/prisma";
import { ProvidersView, type ProviderSummary } from "@/components/admin/ai/providers-view";
import { OpenRouterCard } from "@/components/admin/ai/openrouter-card";
import { getEngineConfig, getOpenRouterConfig } from "@/lib/ai-engine/settings";

export const metadata = { title: "AI Providers — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * Admin → AI Solutions → AI Providers (MASTER_ADMIN). Three provider cards —
 * Gemini, OpenAI, Claude — with status, model, last test, last error and
 * usage/estimated cost from the AI Gateway log, the Claude key manager, and
 * per-feature routing. Nothing secret is passed to the client components.
 */
export default async function AiProvidersPage() {
  const session = await getAdminSession();
  if (session?.user?.role !== "MASTER_ADMIN") return <RestrictedCard title="AI Providers" />;

  const since30 = daysAgo(30);
  const [claude, gemini, openai, aiSettings, gateway, usage30, todayRows, lastErrors] = await Promise.all([
    getClaudeConfig(),
    getGeminiConfig(),
    getOpenAiConfig(),
    getAiSettings(),
    getGatewayConfig(),
    usageSince(since30),
    prisma.aiGatewayCall.groupBy({ by: ["feature"], where: { ok: true, createdAt: { gte: istStartOfDay(new Date()) } }, _count: { _all: true } }),
    prisma.aiGatewayCall.findMany({
      where: { ok: false, provider: { in: ["gemini", "openai"] } },
      orderBy: { createdAt: "desc" },
      distinct: ["provider"],
      select: { provider: true, errorCategory: true, errorSummary: true, createdAt: true },
    }),
  ]);

  const usageFor = (p: string) => usage30.byProvider.find((u) => u.provider === p) ?? null;
  const lastErr = (p: string) => {
    const e = lastErrors.find((x) => x.provider === p);
    return e ? { category: e.errorCategory ?? "error", message: e.errorSummary ?? "", at: e.createdAt.toISOString() } : null;
  };

  const legacy: ProviderSummary[] = [
    {
      key: "gemini",
      name: "Google Gemini",
      configured: gemini.configured,
      enabled: gemini.enabled,
      model: `${gemini.primaryModel}${gemini.fallbackModels.length ? ` (+${gemini.fallbackModels.length} fallback model${gemini.fallbackModels.length > 1 ? "s" : ""})` : ""}`,
      lastTest: gemini.lastTest,
      lastError: lastErr("gemini"),
      usage: usageFor("gemini"),
      role: aiSettings.activeProvider === "gemini" ? "Default active provider" : aiSettings.fallbackProvider === "gemini" ? "Default fallback provider" : null,
    },
    {
      key: "openai",
      name: "OpenAI",
      configured: openai.configured,
      enabled: openai.enabled,
      model: openai.model,
      lastTest: openai.lastTest,
      lastError: lastErr("openai"),
      usage: usageFor("openai"),
      role: aiSettings.activeProvider === "openai" ? "Default active provider" : aiSettings.fallbackProvider === "openai" ? "Default fallback provider" : null,
    },
  ];

  const [openRouter, engine] = await Promise.all([getOpenRouterConfig(), getEngineConfig()]);
  return (
    <div className="flex flex-col gap-5">
    <OpenRouterCard config={openRouter} privacy={engine.privacy} canManage />
    <div>
      <h2 className="text-sm font-semibold text-[var(--color-foreground)]">Legacy providers (kept, recoverable)</h2>
      <p className="text-xs text-[var(--color-muted-foreground)]">Gemini, OpenAI and Claude stay configured as before. A feature uses them while it is set to “Legacy route” in AI → Features.</p>
    </div>
    <ProvidersView
      legacy={legacy}
      claude={claude}
      claudeUsage={usageFor("anthropic")}
      gateway={gateway}
      defaultRouting={{ active: aiSettings.activeProvider, fallback: aiSettings.fallbackProvider }}
      todayByFeature={Object.fromEntries(todayRows.map((r) => [r.feature, r._count._all]))}
      usage30={usage30}
    />
    </div>
  );
}
