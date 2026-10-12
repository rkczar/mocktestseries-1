import "server-only";
import { prisma } from "@/lib/prisma";
import type { AiFeature } from "@/lib/ai-gateway-config";
import { ENGINE_FEATURE_MAP, estimateTokens, type FeatureEngineConfig } from "@/lib/ai-engine/config";
import { EngineConfigError, getEngineConfig, getOpenRouterApiKey, getOpenRouterConfig, patchOpenRouterState, saveFeatureConfig, type OpenRouterTest } from "@/lib/ai-engine/settings";
import { describeCategory, getKeyInfo, OpenRouterError, sanitize } from "@/lib/ai-engine/openrouter";
import { imageCandidates, textCandidates } from "@/lib/ai-engine/router";

/**
 * Admin operations for the AI Engine that need more than a settings write.
 */

const TEST_COOLDOWN_MS = 10_000;

/**
 * Test Connection: GET /api/v1/key — validates the key and reads its spending
 * limit / usage. Costs nothing (no generation). Rate-limited across workers.
 */
export async function testOpenRouterConnection(): Promise<OpenRouterTest> {
  const pub = await getOpenRouterConfig();
  const at = new Date().toISOString();
  if (pub.lastTest?.at && Date.now() - Date.parse(pub.lastTest.at) < TEST_COOLDOWN_MS) throw new EngineConfigError("A connection test just ran — wait a few seconds and try again.");
  const key = await getOpenRouterApiKey();
  if (!key) {
    const r = { ok: false, category: "not_configured", message: "No API key is saved. Install it with the setup script or paste it here first.", at };
    await patchOpenRouterState({ lastTest: r });
    return r;
  }
  await patchOpenRouterState({ lastTest: { ok: false, category: "running", message: "Test in progress…", at } });
  try {
    const info = await getKeyInfo(key);
    const limit = info.limit === null ? "no spending limit set on the key" : `key limit $${info.limit} (remaining $${info.limit_remaining ?? "?"}${info.limit_reset ? `, resets ${info.limit_reset}` : ""})`;
    const r: OpenRouterTest = { ok: true, category: "ok", message: `Connected. The key is valid — ${limit}.${info.is_free_tier ? " This is a free-tier key (no purchased credits)." : ""}`, at };
    await patchOpenRouterState({
      lastTest: r,
      lastError: null,
      keyStatus: {
        label: info.label,
        limitUsd: info.limit,
        limitRemainingUsd: info.limit_remaining,
        limitReset: info.limit_reset,
        usageUsd: info.usage,
        usageDailyUsd: info.usage_daily,
        usageMonthlyUsd: info.usage_monthly,
        isFreeTier: info.is_free_tier,
        at,
      },
    });
    return r;
  } catch (error) {
    const e = error instanceof OpenRouterError ? error : new OpenRouterError("network", "Could not reach OpenRouter.");
    const r: OpenRouterTest = { ok: false, category: e.category, message: `${describeCategory(e.category)} ${e.message !== describeCategory(e.category) ? sanitize(e.message) : ""}`.trim(), at };
    await patchOpenRouterState({ lastTest: r, lastError: { category: e.category, message: r.message, at } });
    return r;
  }
}

/**
 * Saves a feature's engine settings after checking they can actually run:
 * switching a feature to OpenRouter needs OpenRouter enabled and at least one
 * approved model that suits it (medically approved for medical features).
 */
export async function updateFeature(feature: AiFeature, cfg: FeatureEngineConfig): Promise<void> {
  const def = ENGINE_FEATURE_MAP[feature];
  if (!def) throw new EngineConfigError("Unknown feature.");
  if (cfg.provider === "openrouter") {
    const pub = await getOpenRouterConfig();
    if (!pub.enabled) throw new EngineConfigError("Enable OpenRouter (AI → Providers) before switching a feature to it.");
    if (def.kind === "image") {
      const c = await imageCandidates(feature);
      if (!c.length) throw new EngineConfigError(`No approved${def.medical ? ", medically approved" : ""} image model with an estimable price. Approve one in AI → Models first.`);
      if (cfg.mode === "manual" && (!cfg.model || !c.some((x) => x.model.id === cfg.model))) throw new EngineConfigError("Choose an approved image model for Manual routing.");
    } else {
      const maxOut = cfg.maxOutputTokens ?? def.defaultMaxOutputTokens;
      const c = await textCandidates(feature, def.typicalInputTokens, maxOut, Math.round(maxOut / 2));
      if (!c.length) throw new EngineConfigError(`No approved${def.medical ? ", medically approved" : ""} text model suits ${def.label}. Approve one in AI → Models first.`);
      if (cfg.mode === "manual" && (!cfg.model || !c.some((x) => x.model.id === cfg.model))) throw new EngineConfigError("Choose an approved, suitable model for Manual routing.");
      const bad = cfg.fallbacks.filter((f) => !c.some((x) => x.model.id === f));
      if (bad.length) throw new EngineConfigError(`Fallback model(s) not approved / not suitable: ${bad.join(", ")}.`);
    }
  }
  if (cfg.mode === "manual" && cfg.model) {
    const row = await prisma.aiModel.findUnique({ where: { id: cfg.model }, select: { id: true } });
    if (!row) throw new EngineConfigError(`Model "${cfg.model}" is not in the catalog. Sync models first.`);
  }
  await saveFeatureConfig(feature, cfg);
}

export interface FeaturePreview {
  model: string | null;
  /** Suitable approved models for this feature. */
  candidates: string[];
  note: string | null;
  /** USD per request (all calls of one action), on the current pick; null = unknown. */
  typicalUsd: number | null;
  maxUsd: number | null;
}

/** For the Features page: which model each feature would use right now, its estimated cost, and why not when none. */
export async function featurePreview(): Promise<Record<string, FeaturePreview>> {
  const engine = await getEngineConfig();
  const out: Record<string, FeaturePreview> = {};
  for (const [key, def] of Object.entries(ENGINE_FEATURE_MAP)) {
    const cfg = engine.features[key as AiFeature];
    if (def.kind === "image") {
      const c = await imageCandidates(key as AiFeature);
      const pick = cfg.mode === "manual" ? c.find((x) => x.model.id === cfg.model) : c[0];
      out[key] = { model: cfg.mode === "manual" ? cfg.model : (pick?.model.id ?? null), candidates: c.map((x) => x.model.id), note: c.length ? null : "no approved image model", typicalUsd: pick?.maxUsd ?? null, maxUsd: pick?.maxUsd ?? null };
    } else {
      const maxOut = cfg.maxOutputTokens ?? def.defaultMaxOutputTokens;
      const c = await textCandidates(key as AiFeature, def.typicalInputTokens, maxOut, Math.round(maxOut / 2));
      const pick = cfg.mode === "manual" ? c.find((x) => x.model.id === cfg.model) : cfg.mode === "auto" ? c.reduce<(typeof c)[number] | undefined>((a, x) => (!a || x.maxUsd > a.maxUsd ? x : a), undefined) : c[0];
      out[key] = {
        model: cfg.mode === "manual" ? cfg.model : cfg.mode === "auto" ? "openrouter/auto" : (pick?.model.id ?? null),
        candidates: c.map((x) => x.model.id),
        note: c.length ? null : def.medical ? "no approved, medically approved model" : "no approved model",
        typicalUsd: pick ? (cfg.mode === "auto" ? c[0].typicalUsd : pick.typicalUsd) * def.callsPerAction : null,
        maxUsd: pick ? pick.maxUsd * def.callsPerAction : null,
      };
    }
  }
  return out;
}

export { estimateTokens };
