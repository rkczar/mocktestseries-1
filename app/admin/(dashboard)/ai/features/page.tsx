import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getEngineConfig, getOpenRouterConfig } from "@/lib/ai-engine/settings";
import { featurePreview } from "@/lib/ai-engine/manage";
import { budgetUsage } from "@/lib/ai-engine/budget";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { ENGINE_FEATURES, FUTURE_FEATURES } from "@/lib/ai-engine/config";
import { FeatureEditor } from "@/components/admin/ai/feature-editor";
import { EXPLANATION_PROMPT_VERSION } from "@/lib/ai-explanation";
import { VARIANT_PROMPT_VERSION } from "@/lib/ai-variant";
import { IMAGE_PROMPT_VERSION } from "@/lib/instagram/medical-image-core";
import { TRAP_PROMPT_VERSION } from "@/lib/instagram/trap";
import { IG_PROMPT_VERSION } from "@/lib/instagram/ai-core";
import { CAPTION_PROMPT_VERSION, DIAGRAM_PROMPT_VERSION } from "@/lib/instagram/ai-studio-core";
import { prisma } from "@/lib/prisma";
import { featureUsage30 } from "@/lib/ai-engine/analytics";

export const metadata = { title: "AI Features — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const PROMPTS: Record<string, string> = {
  explanation: EXPLANATION_PROMPT_VERSION,
  explanation_admin: EXPLANATION_PROMPT_VERSION,
  variant: VARIANT_PROMPT_VERSION,
  variant_admin: VARIANT_PROMPT_VERSION,
  ig_carousel: IG_PROMPT_VERSION,
  ig_trap: TRAP_PROMPT_VERSION,
  ig_diagram: DIAGRAM_PROMPT_VERSION,
  ig_caption: CAPTION_PROMPT_VERSION,
  ig_image: IMAGE_PROMPT_VERSION,
};

/**
 * Admin → AI → Features: per-feature engine settings. "Legacy route" keeps
 * the feature on the existing Gemini / OpenAI / Claude gateway route
 * (unchanged behaviour); "OpenRouter" runs it through the AI Engine with
 * routing, fallbacks, limits and cost tracking. Switch one feature at a time.
 */
export default async function AiFeaturesPage() {
  if (!(await hasPermission(PERMISSIONS.AI_ENGINE_VIEW))) return <RestrictedCard title="AI Features" />;
  const canManage = await hasPermission(PERMISSIONS.AI_ENGINE_MANAGE);
  const [engine, preview, or, usage, fx, approved, usage30] = await Promise.all([
    getEngineConfig(),
    featurePreview(),
    getOpenRouterConfig(),
    budgetUsage(),
    getUsdInr(),
    prisma.aiModel.findMany({ where: { approved: true, disabled: false, missingSince: null }, select: { id: true, isImageModel: true, medicallyApproved: true }, orderBy: { id: "asc" } }),
    featureUsage30(),
  ]);
  const used = usage30;
  const groups = ["Student AI", "Admin AI", "Instagram"] as const;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Features</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Choose the provider, routing and limits for every AI feature. Switch features to OpenRouter one at a time and check AI → History after each switch. A feature that is turned off makes no new AI
          request; cached explanations are still served.
        </p>
        {!or.enabled ? (
          <p className="mt-2 rounded-md bg-[var(--color-warning)]/10 px-3 py-2 text-sm" data-testid="features-openrouter-off">
            OpenRouter is not enabled yet (AI → Providers), so every feature stays on its legacy route.
          </p>
        ) : null}
      </div>
      {groups.map((g) => (
        <Card key={g}>
          <CardHeader>
            <CardTitle>{g}</CardTitle>
            <CardDescription>
              {g === "Student AI"
                ? "Triggered by students: no per-click approval — preapproved models, per-request limit, daily student limits (AI → Settings) and the platform budgets apply automatically."
                : "Triggered by admins: every request shows the AI Cost Preview first."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 xl:grid-cols-2">
            {ENGINE_FEATURES.filter((f) => f.group === g).map((f) => (
              <FeatureEditor
                key={f.key}
                def={f}
                cfg={engine.features[f.key]}
                preview={preview[f.key]}
                models={approved.filter((m) => (f.kind === "image" ? m.isImageModel : !m.isImageModel)).map((m) => ({ id: m.id, medical: m.medicallyApproved }))}
                openRouterEnabled={or.enabled}
                canManage={canManage}
                fxRate={fx.rate}
                spentTodayInr={usage.byFeatureToday[f.key] ?? 0}
                last30={used[f.key] ?? { requests: 0, costInr: null }}
                promptVersion={PROMPTS[f.key] ?? null}
                globalCapInr={f.kind === "image" ? engine.budgets.maxImageRequestInr : engine.budgets.maxTextRequestInr}
              />
            ))}
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>Future AI features</CardTitle>
          <CardDescription>Configuration placeholders only — these engines are not built. They will appear above with the same controls when they exist.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm" data-testid="future-features">
          {FUTURE_FEATURES.map((f) => (
            <span key={f} className="rounded-[var(--radius-button)] border border-dashed border-[var(--color-border)] px-3 py-1 text-[var(--color-muted-foreground)]">
              {`${f} · not available yet`}
            </span>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
