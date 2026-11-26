import { getAdminSession } from "@/lib/rbac";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { OpenRouterCard } from "@/components/admin/ai/openrouter-card";
import { getEngineConfig, getOpenRouterConfig } from "@/lib/ai-engine/settings";

export const metadata = { title: "AI Providers — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Solutions → AI Providers (MASTER_ADMIN). Owner policy 2026-11-26: OpenRouter is the only AI provider.
 * Direct Gemini / OpenAI / Claude calls are disabled in code; their stored keys are kept but never used.
 * Model order and per-feature chains: AI → Features / Models; per-request cost: AI → History.
 */
export default async function AiProvidersPage() {
  const session = await getAdminSession();
  if (session?.user?.role !== "MASTER_ADMIN") return <RestrictedCard title="AI Providers" />;
  const [openRouter, engine] = await Promise.all([getOpenRouterConfig(), getEngineConfig()]);
  return (
    <div className="flex flex-col gap-5">
      <OpenRouterCard config={openRouter} privacy={engine.privacy} canManage />
      <p className="text-xs text-[var(--color-muted-foreground)]">
        All AI features run through OpenRouter only. Direct Gemini, OpenAI and Claude connections are disabled; Gemini,
        OpenAI and Claude models are used through OpenRouter (AI → Models).
      </p>
    </div>
  );
}
