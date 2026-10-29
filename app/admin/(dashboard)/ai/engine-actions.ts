"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { AI_FEATURE_KEYS, type AiFeature } from "@/lib/ai-gateway-config";
import { MIN_IMAGE_TOKENS_PER_IMAGE, MODEL_ID, minUnitsPerImage, normalizeBudgets, normalizeFeatureConfig, normalizePrivacy, type BudgetConfig, type FeatureEngineConfig, type PrivacyConfig } from "@/lib/ai-engine/config";
import {
  EngineConfigError,
  getEngineConfig,
  getOpenRouterConfig,
  removeOpenRouterKey,
  saveBudgets,
  saveOpenRouterKey,
  savePrivacy,
  setOpenRouterEnabled,
  type OpenRouterPublicConfig,
  type OpenRouterTest,
} from "@/lib/ai-engine/settings";
import { CatalogError, refreshImagePrice, syncCatalog, type SyncResult } from "@/lib/ai-engine/catalog";
import { testOpenRouterConnection, updateFeature } from "@/lib/ai-engine/manage";
import { refreshFxRate, setFxMode, type FxRate } from "@/lib/ai-engine/fx";
import { reconcilePending } from "@/lib/ai-engine/analytics";
import { OpenRouterError } from "@/lib/ai-engine/openrouter";
import { consumeQuote } from "@/lib/ai-engine/quote";
import { EVAL_MAX_QUESTIONS, runModelEvaluation, type EvalResult } from "@/lib/ai-engine/eval";
import { AiNotConfiguredError } from "@/lib/ai-provider";

/**
 * Admin → AI Engine Server Actions. Every action is MASTER_ADMIN-only
 * (AI_ENGINE_MANAGE, enforced here — FULL_ADMIN can only view the pages) and
 * writes an AuditLog entry. Nothing secret is ever returned: the OpenRouter
 * key goes in once, encrypted, and only its hint comes back.
 */

export type EngineResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function requireEngine(): Promise<string | null> {
  try {
    const session = await requirePermission(PERMISSIONS.AI_ENGINE_MANAGE);
    return session.user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

async function run<T>(actorId: string | null, fn: (actorId: string) => Promise<T>): Promise<EngineResult<T>> {
  if (!actorId) return { ok: false, error: "Only a Master Admin can change AI settings." };
  try {
    return { ok: true, data: await fn(actorId) };
  } catch (error) {
    if (error instanceof EngineConfigError || error instanceof CatalogError || error instanceof OpenRouterError || error instanceof AiNotConfiguredError) return { ok: false, error: error.message };
    if (error instanceof Error && /USD→INR|rate between/.test(error.message)) return { ok: false, error: error.message };
    console.error("[ai-engine]", error instanceof Error ? error.message.slice(0, 200) : "error");
    return { ok: false, error: "Something went wrong. Nothing was changed." };
  }
}

async function audit(actorId: string, action: string, entityId: string, metadata: object) {
  await prisma.auditLog.create({ data: { actorId, action, entityType: "Setting", entityId, metadata } });
}

function touch() {
  revalidatePath("/admin/ai", "layout");
  revalidatePath("/admin");
}

// ---- OpenRouter provider -------------------------------------------------------------------

export async function saveOpenRouterKeyAction(key: string): Promise<EngineResult<OpenRouterPublicConfig>> {
  return run(await requireEngine(), async (actorId) => {
    const { keyHint } = await saveOpenRouterKey(typeof key === "string" ? key : "", "admin");
    await audit(actorId, "AI_OPENROUTER_KEY_SAVED", "api.openrouter", { keyHint });
    touch();
    return getOpenRouterConfig();
  });
}

export async function removeOpenRouterKeyAction(): Promise<EngineResult<OpenRouterPublicConfig>> {
  return run(await requireEngine(), async (actorId) => {
    await removeOpenRouterKey();
    await audit(actorId, "AI_OPENROUTER_KEY_REMOVED", "api.openrouter", {});
    touch();
    return getOpenRouterConfig();
  });
}

export async function testOpenRouterAction(): Promise<EngineResult<{ test: OpenRouterTest; config: OpenRouterPublicConfig }>> {
  return run(await requireEngine(), async (actorId) => {
    const test = await testOpenRouterConnection();
    await audit(actorId, "AI_OPENROUTER_TESTED", "api.openrouter", { ok: test.ok, category: test.category });
    touch();
    return { test, config: await getOpenRouterConfig() };
  });
}

export async function setOpenRouterEnabledAction(enabled: boolean): Promise<EngineResult<OpenRouterPublicConfig>> {
  return run(await requireEngine(), async (actorId) => {
    const cfg = await setOpenRouterEnabled(enabled === true);
    await audit(actorId, enabled ? "AI_OPENROUTER_ENABLED" : "AI_OPENROUTER_DISABLED", "api.openrouter", {});
    touch();
    return cfg;
  });
}

// ---- Models ----------------------------------------------------------------------------------

export async function syncModelsAction(): Promise<EngineResult<SyncResult>> {
  return run(await requireEngine(), async (actorId) => {
    const r = await syncCatalog();
    await audit(actorId, "AI_MODELS_SYNCED", "AiModel", { ...r });
    touch();
    return r;
  });
}

export async function updateModelAction(input: {
  id: string;
  approved?: boolean;
  medicallyApproved?: boolean;
  disabled?: boolean;
  notes?: string | null;
  imageUnitsPerImage?: number | null;
}): Promise<EngineResult<null>> {
  return run(await requireEngine(), async (actorId) => {
    if (typeof input?.id !== "string" || !MODEL_ID.test(input.id)) throw new EngineConfigError("Invalid model.");
    const row = await prisma.aiModel.findUnique({ where: { id: input.id } });
    if (!row) throw new EngineConfigError("Model not found — sync models first.");
    const data: Record<string, unknown> = {};
    if (typeof input.approved === "boolean") data.approved = input.approved;
    if (typeof input.medicallyApproved === "boolean") {
      if (input.medicallyApproved && !(input.approved ?? row.approved)) throw new EngineConfigError("Approve the model before marking it medically approved.");
      data.medicallyApproved = input.medicallyApproved;
    }
    if (input.approved === false) data.medicallyApproved = false;
    if (typeof input.disabled === "boolean") data.disabled = input.disabled;
    if (input.notes !== undefined) data.notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 300) || null : null;
    if (input.imageUnitsPerImage !== undefined) {
      const n = input.imageUnitsPerImage === null ? null : Number(input.imageUnitsPerImage);
      if (n !== null && (!Number.isFinite(n) || n <= 0 || n > 1_000_000)) throw new EngineConfigError("Units per image must be a positive number.");
      if (n !== null && n < minUnitsPerImage(row.imageUnit)) {
        throw new EngineConfigError(`This model is billed per output-image token: enter how many TOKENS one image uses (a 1K image is about 1,100–1,300), not a price. At least ${MIN_IMAGE_TOKENS_PER_IMAGE}.`);
      }
      data.imageUnitsPerImage = n;
    }
    await prisma.aiModel.update({ where: { id: input.id }, data });
    // An image model needs its endpoint price line to be routable.
    if (row.isImageModel && data.approved === true && row.imageUnitCostUsd === null) {
      try {
        await refreshImagePrice(input.id);
      } catch {
        // shown as "price unknown" on the Models page; the admin can retry
      }
    }
    await audit(actorId, "AI_MODEL_UPDATED", input.id, data);
    touch();
    return null;
  });
}

export async function refreshImagePriceAction(id: string): Promise<EngineResult<null>> {
  return run(await requireEngine(), async (actorId) => {
    if (typeof id !== "string" || !MODEL_ID.test(id)) throw new EngineConfigError("Invalid model.");
    await refreshImagePrice(id);
    await audit(actorId, "AI_MODEL_PRICE_REFRESHED", id, {});
    touch();
    return null;
  });
}

// ---- Features ---------------------------------------------------------------------------------

export async function saveFeatureEngineAction(feature: string, cfg: Partial<FeatureEngineConfig>): Promise<EngineResult<null>> {
  return run(await requireEngine(), async (actorId) => {
    const f = AI_FEATURE_KEYS.find((k) => k === feature) as AiFeature | undefined;
    if (!f) throw new EngineConfigError("Unknown feature.");
    const before = (await getEngineConfig()).features[f];
    const next = normalizeFeatureConfig({ ...before, ...cfg });
    await updateFeature(f, next);
    await audit(actorId, "AI_FEATURE_UPDATED", `ai.engine/${f}`, { before, after: next });
    touch();
    return null;
  });
}

// ---- Budgets, privacy, exchange rate -----------------------------------------------------------

export async function saveBudgetsAction(input: Partial<BudgetConfig>): Promise<EngineResult<BudgetConfig>> {
  return run(await requireEngine(), async (actorId) => {
    const before = (await getEngineConfig()).budgets;
    // Limits only — the emergency stop has its own action and is never changed by the limits form.
    const { emergencyStop: _ignored, ...limits } = input ?? {};
    void _ignored;
    const next = normalizeBudgets({ ...before, ...limits, emergencyStop: before.emergencyStop });
    await saveBudgets(next);
    await audit(actorId, "AI_BUDGETS_UPDATED", "ai.engine/budgets", { before, after: next });
    touch();
    return next;
  });
}

export async function setEmergencyStopAction(stop: boolean): Promise<EngineResult<BudgetConfig>> {
  return run(await requireEngine(), async (actorId) => {
    const before = (await getEngineConfig()).budgets;
    const next = { ...before, emergencyStop: stop === true };
    await saveBudgets(next);
    await audit(actorId, stop ? "AI_EMERGENCY_STOP_ON" : "AI_EMERGENCY_STOP_OFF", "ai.engine/budgets", {});
    touch();
    return next;
  });
}

export async function savePrivacyAction(input: Partial<PrivacyConfig>): Promise<EngineResult<PrivacyConfig>> {
  return run(await requireEngine(), async (actorId) => {
    const before = (await getEngineConfig()).privacy;
    const next = normalizePrivacy({ ...before, ...input });
    await savePrivacy(next);
    await audit(actorId, "AI_PRIVACY_UPDATED", "ai.engine/privacy", { before, after: next });
    touch();
    return next;
  });
}

export async function refreshFxAction(): Promise<EngineResult<FxRate>> {
  return run(await requireEngine(), async (actorId) => {
    const r = await refreshFxRate();
    await audit(actorId, "AI_FX_REFRESHED", "ai.fx", { rate: r.rate, error: r.lastError });
    touch();
    return r;
  });
}

export async function setFxModeAction(input: { mode: "auto" | "manual"; manualRate?: number | null }): Promise<EngineResult<FxRate>> {
  return run(await requireEngine(), async (actorId) => {
    const r = await setFxMode({ mode: input?.mode === "manual" ? "manual" : "auto", manualRate: typeof input?.manualRate === "number" ? input.manualRate : Number(input?.manualRate) });
    await audit(actorId, "AI_FX_MODE_SET", "ai.fx", { mode: r.mode, rate: r.rate });
    touch();
    return r;
  });
}

// ---- Cost reconciliation ------------------------------------------------------------------------

export async function reconcileCostsAction(): Promise<EngineResult<{ checked: number; resolved: number }>> {
  return run(await requireEngine(), async (actorId) => {
    const r = await reconcilePending(30);
    await audit(actorId, "AI_COSTS_RECONCILED", "AiGatewayCall", r);
    touch();
    return r;
  });
}

// ---- Medical model evaluation (paid — needs an approved AI Cost Preview) ---------------------------

export async function runModelEvalAction(input: { quoteId: string; n: number }): Promise<EngineResult<EvalResult>> {
  return run(await requireEngine(), async (actorId) => {
    const n = Math.min(EVAL_MAX_QUESTIONS, Math.max(1, Math.round(Number(input?.n) || 0)));
    const q = await consumeQuote({ quoteId: input?.quoteId, actorId, feature: "explanation_admin", action: "model_eval", context: { evalSize: n } });
    if (!q.model) throw new EngineConfigError("Choose the model to evaluate.");
    const r = await runModelEvaluation({ model: q.model, n, actorId, quoteId: q.id });
    await audit(actorId, "AI_MODEL_EVALUATED", q.model, { n: r.n, correct: r.correct, jsonOk: r.jsonOk, confidentWrong: r.confidentWrong, costInr: r.costInr });
    touch();
    return r;
  });
}
