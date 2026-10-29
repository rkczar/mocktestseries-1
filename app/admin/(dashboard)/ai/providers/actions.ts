"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  ANTHROPIC_SETTING_KEY,
  ClaudeConfigError,
  getClaudeConfig,
  removeClaudeKey,
  saveClaudeKey,
  saveClaudeSettings,
  testClaudeConnection,
  type ClaudePublicConfig,
  type ClaudeTestResult,
} from "@/lib/anthropic-config";
import { GATEWAY_SETTING_KEY, getGatewayConfig, saveGatewayConfig, type GatewayConfig } from "@/lib/ai-gateway";
import { getEngineConfig } from "@/lib/ai-engine/settings";
import { AI_FEATURE_KEYS, type ModelPrice } from "@/lib/ai-gateway-config";
import type { ClaudeEffort } from "@/lib/anthropic-client";

/**
 * Admin → AI Solutions → AI Providers. Credential management and routing are
 * MASTER_ADMIN only: every action re-checks the permission AND the role
 * server-side (a Server Action is callable on its own; Next.js also rejects
 * cross-origin Server Action posts, which covers CSRF). No action ever returns
 * or logs a key — only the masked hint.
 */

export type ProviderResult<T> = { ok: true; data: T } | { ok: false; error: string };

const NOT_ALLOWED = "Only a Master Admin can manage AI provider credentials.";

async function requireMaster(): Promise<string | null> {
  try {
    const session = await requirePermission(PERMISSIONS.AI_MODEL_POOL_MANAGE);
    return session.user.role === "MASTER_ADMIN" ? (session.user.id ?? null) : null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/** Every action calls `run(await requireMaster(), …)` so the guard is visible in each action body. */
async function run<T>(actorId: string | null, fn: (actorId: string) => Promise<T>): Promise<ProviderResult<T>> {
  if (!actorId) return { ok: false, error: NOT_ALLOWED };
  try {
    return { ok: true, data: await fn(actorId) };
  } catch (error) {
    if (error instanceof ClaudeConfigError) return { ok: false, error: error.message };
    console.error("[ai-providers]", error instanceof Error ? error.name : "error");
    return { ok: false, error: "Something went wrong. Nothing was changed — try again." };
  }
}

function touch() {
  revalidatePath("/admin/ai", "layout");
}

async function audit(actorId: string, action: string, metadata: Record<string, unknown>, entityId = ANTHROPIC_SETTING_KEY) {
  await prisma.auditLog.create({ data: { actorId, action, entityType: "Setting", entityId, metadata: metadata as object } });
}

/** Save or replace the Anthropic key. The key is encrypted before it is stored and is never echoed back. */
export async function saveClaudeKeyAction(input: { apiKey: string }): Promise<ProviderResult<ClaudePublicConfig>> {
  return run(await requireMaster(), async (actorId) => {
    const key = typeof input?.apiKey === "string" ? input.apiKey : "";
    const before = await getClaudeConfig();
    await saveClaudeKey(key);
    await audit(actorId, before.apiKeyConfigured ? "API_ANTHROPIC_KEY_REPLACED" : "API_ANTHROPIC_KEY_SAVED", {});
    touch();
    return getClaudeConfig();
  });
}

export async function removeClaudeKeyAction(input: { confirm: boolean }): Promise<ProviderResult<ClaudePublicConfig>> {
  return run(await requireMaster(), async (actorId) => {
    if (input?.confirm !== true) throw new ClaudeConfigError("Confirm removing the key.");
    await removeClaudeKey();
    await audit(actorId, "API_ANTHROPIC_KEY_REMOVED", {});
    touch();
    return getClaudeConfig();
  });
}

export async function saveClaudeSettingsAction(input: { enabled?: boolean; model?: string; effort?: string }): Promise<ProviderResult<ClaudePublicConfig>> {
  return run(await requireMaster(), async (actorId) => {
    const update: { enabled?: boolean; model?: string; effort?: ClaudeEffort } = {};
    if (typeof input?.enabled === "boolean") update.enabled = input.enabled;
    if (typeof input?.model === "string") update.model = input.model;
    if (typeof input?.effort === "string") update.effort = input.effort as ClaudeEffort;
    const cfg = await saveClaudeSettings(update);
    await audit(actorId, "API_ANTHROPIC_SETTINGS_SAVED", { enabled: cfg.enabled, model: cfg.model, effort: cfg.effort });
    touch();
    return cfg;
  });
}

export async function testClaudeConnectionAction(): Promise<ProviderResult<{ result: ClaudeTestResult; config: ClaudePublicConfig }>> {
  return run(await requireMaster(), async (actorId) => {
    // While direct Claude calls are off (lib/ai-engine/config.ts RuntimeConfig), the test checks the key and model
    // list only and sends no generation request.
    const { runtime } = await getEngineConfig();
    const result = await testClaudeConnection({ skipGeneration: !runtime.directClaudeOpenAi });
    await audit(actorId, "API_ANTHROPIC_TESTED", { ok: result.ok, category: result.category, model: result.model });
    touch();
    return { result, config: await getClaudeConfig() };
  });
}

/** Per-feature routing + model price table. Every route is re-normalized server-side. */
export async function saveGatewayAction(input: { routes: Record<string, unknown>; prices?: Record<string, unknown> }): Promise<ProviderResult<GatewayConfig>> {
  return run(await requireMaster(), async (actorId) => {
    const routes: Record<string, unknown> = {};
    for (const f of AI_FEATURE_KEYS) if (input?.routes && f in input.routes) routes[f] = input.routes[f];
    let prices: Record<string, ModelPrice> | undefined;
    if (input?.prices && typeof input.prices === "object") {
      prices = {};
      for (const [model, p] of Object.entries(input.prices).slice(0, 60)) {
        const v = p as { input?: unknown; output?: unknown };
        const i = Number(v?.input);
        const o = Number(v?.output);
        if (!/^[A-Za-z0-9._:\/-]{2,80}$/.test(model) || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0 || i > 1000 || o > 1000) {
          throw new ClaudeConfigError(`Invalid price for "${model.slice(0, 40)}".`);
        }
        prices[model] = { input: i, output: o };
      }
    }
    const before = await getGatewayConfig();
    const cfg = await saveGatewayConfig({ routes, prices });
    const changed = AI_FEATURE_KEYS.filter((f) => JSON.stringify(before.routes[f]) !== JSON.stringify(cfg.routes[f]));
    await audit(actorId, "AI_GATEWAY_ROUTES_SAVED", { changed, routes: Object.fromEntries(changed.map((f) => [f, cfg.routes[f]])) }, GATEWAY_SETTING_KEY);
    touch();
    return cfg;
  });
}
