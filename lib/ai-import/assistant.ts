import "server-only";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/ai-engine/config";
import { MAX_IMPORTER_MODELS, PILOT_LIMITS, SELECTION_TASK_LABELS, type ImporterSettings, type SelectionTask } from "@/lib/ai-import/config";
import { importerModelCatalog } from "@/lib/ai-import/models";
import { getRouteSnapshot, isStale, refreshRoutes, type RouteSnapshot } from "@/lib/ai-import/routes";
import { importerModelHealth, rateLimitAvoidance } from "@/lib/ai-import/health";
import { IMPORTER_REQUEST_PARAMS } from "@/lib/ai-import/ai";
import { computeModelPlan } from "@/lib/ai-import/select";
import { saveImporterSettings } from "@/lib/ai-import/settings";
import type { ImporterCatalog, ImporterModelOption } from "@/lib/ai-import/model-options";
import type { ModelHealth } from "@/lib/ai-import/selection-types";
import {
  ASSISTANT_PURPOSES,
  PURPOSE_LABELS,
  PURPOSE_REQUIREMENTS,
  type ApplyResult,
  type AssistantCandidate,
  type AssistantPurpose,
  type AssistantResult,
  type ConfigCheck,
  type ModelTestReport,
  type PurposeRecommendation,
  type RouteState,
} from "@/lib/ai-import/assistant-types";

/**
 * Import Settings → Model Assistant. Deterministic and catalog-based: the
 * recommendations come from the synced OpenRouter catalog (published input
 * modalities, prices and request parameters), the stored provider-route
 * snapshot, the importer's privacy and budget settings and the importer's own
 * request history. No AI request is ever sent from here — AI reasoning for
 * recommendations is not approved, and with Paid AI off it could not run
 * anyway. Capability is never inferred from a model's name or id, and quality
 * is reported as "Not tested" (no benchmark exists for the importer).
 *
 * Applying recommendations changes ONLY the importer's own model list
 * (ai.importer → importerModels), after an explicit confirmation; global
 * AI → Models approvals, student Ask AI and Instagram routing are untouched.
 */

const PURPOSE_TASK: Record<AssistantPurpose, SelectionTask> = { ocr: "extract", mathematics: "extract", chemistry: "extract", diagrams: "extract", answer_key: "key", verification: "verify", classification: "classify" };
const VISION_TASK: Record<SelectionTask, boolean> = { extract: true, verify: true, key: true, classify: false };
const PER_PURPOSE = 3;

const at = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never");

export interface Ctx {
  settings: ImporterSettings;
  catalog: ImporterCatalog;
  snapshot: RouteSnapshot | null;
  health: Record<string, ModelHealth>;
  now: number;
}

function costOf(o: ImporterModelOption, task: SelectionTask) {
  return o.costs?.[task] ?? null;
}

/** ₹0 for input tokens but not output tokens (or the reverse): an incomplete price, never treated as a verified cost. */
export function partlyZero(o: Pick<ImporterModelOption, "promptPerM" | "completionPerM">): boolean {
  return o.promptPerM !== null && o.completionPerM !== null && (o.promptPerM === 0) !== (o.completionPerM === 0);
}

/** OpenRouter publishes a price of exactly 0 for every part (a known zero, not an unknown price). */
export function publishedZero(o: Pick<ImporterModelOption, "promptPerM" | "completionPerM" | "imagePrice" | "requestPrice">): boolean {
  return o.promptPerM === 0 && o.completionPerM === 0 && !o.imagePrice && !o.requestPrice;
}

function routeState(id: string, ctx: Ctx): { state: RouteState; text: string } {
  const s = ctx.snapshot;
  const info = s?.models[id];
  if (!s || !info) return { state: "not_read", text: "Not read yet — the provider routes are read when the model is added (free metadata request, no AI request)." };
  if (!info.ok) return { state: "unavailable", text: `Could not be read (${info.error ?? "error"}) at ${at(s.fetchedAt)}.` };
  const up = info.routes.filter((r) => r.status === 0);
  if (!up.length) return { state: "unavailable", text: `No provider route was serving normally at ${at(s.fetchedAt)}.` };
  // Importer requests use require_parameters: a route must accept every parameter they send (as select.ts checks).
  const serving = up.filter((r) => r.params !== null && IMPORTER_REQUEST_PARAMS.every((x) => r.params!.includes(x)));
  if (!serving.length) return { state: "unavailable", text: `No serving provider route accepts every parameter the importer sends (${IMPORTER_REQUEST_PARAMS.join(", ")}) at ${at(s.fetchedAt)}, so OpenRouter would refuse its requests.` };
  if (ctx.settings.privacy.zdr && !serving.some((r) => r.zdr)) return { state: "no_zdr", text: `No Zero-Data-Retention route at ${at(s.fetchedAt)} (ZDR is required).` };
  const tags = (ctx.settings.privacy.zdr ? serving.filter((r) => r.zdr) : serving).map((r) => r.tag || r.provider).join(", ");
  return isStale(s, ctx.now) ? { state: "stale", text: `Serving at ${at(s.fetchedAt)} (older than 6 h — not verified now): ${tags}.` } : { state: "verified", text: `Verified ${at(s.fetchedAt)}: ${tags}.` };
}

function historyText(h: ModelHealth | undefined): string {
  if (!h || !h.requests) return "No importer request in the last 24 h.";
  return `${h.requests} importer request(s) in 24 h: ${h.ok} answered, ${h.rateLimited} rate-limited${h.lastRateLimitedAt ? ` (latest ${at(h.lastRateLimitedAt)})` : ""}.`;
}

/** Configuration checks of one model for one task, from stored data only (no AI request, no network). */
export function modelConfigChecks(o: ImporterModelOption | undefined, id: string, task: SelectionTask, ctx: Ctx): ConfigCheck[] {
  const vision = VISION_TASK[task];
  const cap = Math.min(ctx.settings.budget.maxRequestInr, PILOT_LIMITS.maxRequestInr);
  if (!o) return [{ label: "In the synced model catalog", ok: false, detail: "Not in the catalog — sync it in AI → Models." }];
  const checks: ConfigCheck[] = [
    { label: "In the synced model catalog", ok: true, detail: `Synced ${o.synced}.` },
    { label: "On the importer's model list", ok: ctx.settings.importerModels.includes(id), detail: ctx.settings.importerModels.includes(id) ? "Listed (importer only)." : "Not listed — the importer cannot use it." },
  ];
  const problem = vision ? o.visionProblem : o.problem;
  checks.push({ label: vision ? "Usable for page images" : "Usable for text", ok: problem === null, detail: problem ?? (vision ? "Reads images (published input modality) and returns text." : "Returns text.") });
  const c = costOf(o, task);
  checks.push(
    c?.maxInr === null || c?.maxInr === undefined
      ? { label: "Fixed published price", ok: false, detail: "No price in rupees — requests would be refused." }
      : { label: "Fixed published price", ok: c.maxInr <= cap, detail: `${publishedZero(o) ? "Published price ₹0 (a known zero, not an unknown price). " : ""}Up to ${formatInr(c.maxInr, 4)} per ${SELECTION_TASK_LABELS[task].toLowerCase()} request; limit ${formatInr(cap)}.` }
  );
  const r = routeState(id, ctx);
  checks.push({ label: "Provider route verified", ok: r.state === "verified", detail: r.text });
  if (partlyZero(o)) checks.push({ label: "Complete price", ok: false, detail: `Published price is ₹0 for ${o.completionPerM === 0 ? "output" : "input"} tokens only — not a verified cost, so the importer does not use it.` });
  const avoid = rateLimitAvoidance(ctx.health[id], ctx.now);
  checks.push({ label: "Recent provider answers", ok: !avoid, detail: avoid ? `Rate-limited: ${avoid}.` : historyText(ctx.health[id]) });
  return checks;
}

function candidateFor(o: ImporterModelOption, purpose: AssistantPurpose, ctx: Ctx): AssistantCandidate {
  const task = PURPOSE_TASK[purpose];
  const c = costOf(o, task);
  const zero = publishedZero(o);
  const h = ctx.health[o.id];
  const route = routeState(o.id, ctx);
  const onList = ctx.settings.importerModels.includes(o.id);
  const limitations: string[] = [];
  if (zero) limitations.push("Published price ₹0: zero-price provider routes have tight, shared rate limits, so requests may be refused (HTTP 429) — cost ₹0 does not mean reliable.");
  if (h?.rateLimited) limitations.push(`${h.rateLimited} of its ${h.requests} importer request(s) in the last 24 h were rate-limited by the provider.`);
  if (route.state === "stale") limitations.push("Provider route data is older than 6 h.");
  if (route.state === "not_read") limitations.push("Provider routes not read yet (read when added).");
  if (!o.params.structuredOutput) limitations.push("Does not publish structured-output (JSON) support; the importer expects JSON answers.");
  limitations.push(`Quality for “${PURPOSE_LABELS[purpose]}”: Not tested — no benchmark has been run for the importer.`);
  const checks = onList ? modelConfigChecks(o, o.id, task, ctx) : null;
  return {
    id: o.id,
    name: o.name,
    vendor: o.vendor,
    onList,
    route,
    price: c?.maxInr === null || c?.maxInr === undefined ? { state: "unknown", maxInr: null, text: "Unknown — not priced" } : zero ? { state: "zero", maxInr: 0, text: "₹0.00 per request — published free price (may be rate-limited)" } : { state: "published", maxInr: c.maxInr, text: `Up to ${formatInr(c.maxInr, 4)} per request (published price)` },
    imageInput: o.vision,
    params: o.params,
    history: { requests: h?.requests ?? 0, ok: h?.ok ?? 0, rateLimited: h?.rateLimited ?? 0, text: historyText(h) },
    limitations,
    test: checks ? { config: checks.every((x) => x.ok) ? "passed" : "failed", configText: checks.filter((x) => !x.ok).map((x) => `${x.label}: ${x.detail}`).join(" ") || "All configuration checks passed.", quality: "not_tested" } : { config: "not_run", configText: "Not on the importer's list yet — checked after it is added.", quality: "not_tested" },
  };
}

/** Pure: recommendations per purpose from the given data (`perPurpose` best candidates each). */
export function recommend(ctx: Ctx, perPurpose = PER_PURPOSE): AssistantResult {
  const cap = Math.min(ctx.settings.budget.maxRequestInr, PILOT_LIMITS.maxRequestInr);
  const zdrModels = ctx.catalog.routes.zdrModels ? new Set(ctx.catalog.routes.zdrModels) : null;
  const purposes: PurposeRecommendation[] = [];
  let ocrPick: AssistantCandidate | null = null;
  for (const purpose of ASSISTANT_PURPOSES) {
    const task = PURPOSE_TASK[purpose];
    const vision = VISION_TASK[task];
    const excluded = new Map<string, number>();
    const out = (reason: string) => excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
    const pool: AssistantCandidate[] = [];
    for (const o of ctx.catalog.options) {
      if (vision && !o.vision) {
        out("cannot read images (published input modality)");
        continue;
      }
      const problem = vision ? o.visionProblem : o.problem;
      if (problem !== null) {
        out(/price/.test(problem) ? "no fixed published price (unknown — never treated as ₹0)" : "disabled, expired or no longer listed by OpenRouter");
        continue;
      }
      const c = costOf(o, task);
      if (c?.maxInr === null || c?.maxInr === undefined) {
        out("no price in rupees (unknown — never treated as ₹0)");
        continue;
      }
      if (c.maxInr > cap) {
        out(`above the ₹${cap} per-request limit`);
        continue;
      }
      if (ctx.settings.privacy.zdr && zdrModels && !zdrModels.has(o.id)) {
        out("no Zero-Data-Retention route (ZDR is required)");
        continue;
      }
      if (partlyZero(o)) {
        out("a partly-zero published price (₹0 for input or output tokens only — not a verified cost)");
        continue;
      }
      if (rateLimitAvoidance(ctx.health[o.id], ctx.now)) {
        out("rate-limited by its provider in its latest importer requests");
        continue;
      }
      const cand = candidateFor(o, purpose, ctx);
      if (cand.route.state === "unavailable" || cand.route.state === "no_zdr") {
        out("its provider routes are unavailable or not ZDR");
        continue;
      }
      if (purpose === "verification" && ocrPick && o.id === ocrPick.id) {
        out("already recommended for page reading (verification needs a different model)");
        continue;
      }
      pool.push(cand);
    }
    const routeRank: Record<RouteState, number> = { verified: 0, stale: 1, not_read: 2, unavailable: 3, no_zdr: 3 };
    pool.sort(
      (a, b) =>
        // Priced models first: a published ₹0 price comes with shared provider rate limits.
        Number(a.price.state === "zero") - Number(b.price.state === "zero") ||
        // Verification: another vendor than the page reader first (a more independent second read).
        (purpose === "verification" && ocrPick ? Number(a.vendor === ocrPick.vendor) - Number(b.vendor === ocrPick.vendor) : 0) ||
        (a.price.maxInr ?? Infinity) - (b.price.maxInr ?? Infinity) ||
        routeRank[a.route.state] - routeRank[b.route.state] ||
        a.id.localeCompare(b.id)
    );
    const privacyUnknown = ctx.settings.privacy.zdr && !zdrModels ? "Zero-Data-Retention is required, but the ZDR route list has not been read — use Refresh provider routes first (free, no AI request)." : null;
    const candidates = privacyUnknown ? [] : pool.slice(0, perPurpose);
    if (purpose === "ocr") ocrPick = candidates[0] ?? null;
    purposes.push({
      purpose,
      label: PURPOSE_LABELS[purpose],
      requirements: PURPOSE_REQUIREMENTS[purpose],
      candidates,
      recommended: candidates[0]?.id ?? null,
      none: candidates.length ? null : (privacyUnknown ?? (ctx.catalog.options.length ? "No synced catalog model meets every requirement within the limits and privacy settings." : "The model catalog is empty — sync it in AI → Models.")),
      excluded: [...excluded.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    });
  }
  const picks = [...new Set(purposes.map((p) => p.recommended).filter((x): x is string => !!x))];
  return {
    computedAt: new Date(ctx.now).toISOString(),
    method: "catalog",
    methodNote: ctx.settings.aiEnabled
      ? "Calculated from the synced catalog, stored provider routes and the importer's own request history. AI reasoning for recommendations is not approved, so no AI request was sent."
      : "Paid AI is OFF: calculated from the synced catalog, stored provider routes and the importer's own request history only. No AI request was sent.",
    paidAiOn: ctx.settings.aiEnabled,
    purposes,
    toAdd: picks.filter((id) => !ctx.settings.importerModels.includes(id)),
    currentList: [...ctx.settings.importerModels],
    notRecommended: ctx.settings.importerModels.filter((id) => !purposes.some((p) => p.candidates.some((c) => c.id === id))),
    catalogSyncedAt: ctx.catalog.catalog.lastSyncAt,
    routesFetchedAt: ctx.snapshot?.fetchedAt ?? null,
  };
}

export async function loadCtx(settings: ImporterSettings): Promise<Ctx> {
  const [catalog, snapshot] = await Promise.all([importerModelCatalog(settings), getRouteSnapshot()]);
  const health = await importerModelHealth(catalog.options.map((o) => o.id));
  return { settings, catalog, snapshot, health, now: Date.now() };
}

/** "Find Best Models": deterministic recommendations (no AI request, no network call). */
export async function modelAssistant(settings: ImporterSettings): Promise<AssistantResult> {
  return recommend(await loadCtx(settings));
}

/** "Test Models": configuration checks of the importer's listed models (no AI request, no network call). */
export async function testImporterModels(settings: ImporterSettings): Promise<ModelTestReport> {
  const ctx = await loadCtx(settings);
  const p = ctx.catalog.provider;
  const global: ConfigCheck[] = [
    { label: "OpenRouter key", ok: p.keyInstalled && p.enabled, detail: !p.keyInstalled ? "Not installed (Admin → AI → Providers)." : p.enabled ? `Installed and enabled${p.lastTestAt ? `; last connection test ${p.lastTestOk ? "passed" : "failed"} ${p.lastTestAt.slice(0, 10)}` : "; connection not tested"}.` : "Installed but switched off." },
    { label: "Shared key credit", ok: p.keyLimitUsd !== null && (p.keyRemainingUsd ?? 0) > Math.max(settings.budget.keyReserveUsd, PILOT_LIMITS.minKeyReserveUsd), detail: p.keyStatusAt ? (p.keyLimitUsd === null ? "No credit limit on the key: importer requests are refused (the Ask AI reserve cannot be guaranteed)." : `$${(p.keyRemainingUsd ?? 0).toFixed(2)} of $${p.keyLimitUsd.toFixed(2)} left as of ${p.keyStatusAt.slice(0, 10)}; $${Math.max(settings.budget.keyReserveUsd, PILOT_LIMITS.minKeyReserveUsd).toFixed(2)} is kept for student Ask AI.`) : "Not read yet (read before every importer request)." },
    { label: "Prices in rupees", ok: ctx.catalog.fx.rate !== null, detail: ctx.catalog.fx.rate === null ? `No USD→INR rate (${ctx.catalog.fx.unavailableReason ?? "unavailable"}).` : `USD→INR ${ctx.catalog.fx.rate.toFixed(2)}${ctx.catalog.fx.stale ? " (stale)" : ""}.` },
    { label: "AI emergency stop", ok: !p.emergencyStop, detail: p.emergencyStop ? "ON — every AI request is refused." : "Off." },
    { label: "Provider routes", ok: !!ctx.snapshot && !isStale(ctx.snapshot, ctx.now), detail: ctx.snapshot ? `Read ${at(ctx.snapshot.fetchedAt)}${isStale(ctx.snapshot, ctx.now) ? " — older than 6 h; use Refresh provider routes" : ""}.` : "Not read yet — use Refresh provider routes." },
    { label: "Paid AI for the importer", ok: settings.aiEnabled, detail: settings.aiEnabled ? "ON (saved)." : "OFF (saved) — scanned pages cannot be read; nothing is sent." },
  ];
  const models = settings.importerModels.map((id) => {
    const o = ctx.catalog.options.find((x) => x.id === id);
    const tasks: SelectionTask[] = o?.vision ? ["extract", "classify"] : ["classify"];
    const checks = tasks.flatMap((t) => modelConfigChecks(o, id, t, ctx).map((c) => ({ ...c, label: tasks.length > 1 ? `${SELECTION_TASK_LABELS[t]}: ${c.label}` : c.label })));
    return { id, checks, passed: checks.every((c) => c.ok) };
  });
  return {
    at: new Date(ctx.now).toISOString(),
    global,
    models,
    quality: { enabled: false, reason: "Real quality tests send paid AI requests (on synthetic test pages), so they stay disabled until the owner approves them separately. Every model's quality is “Not tested”." },
    aiRequestsSent: 0,
  };
}

export class AssistantApplyError extends Error {}

/**
 * "Apply Recommended Models" after the administrator confirmed the preview. Adds only models that the
 * assistant recommends NOW (recomputed here, not trusted from the browser) to the importer's list, and
 * only if the saved list is still what the preview showed. Then re-reads the provider routes (free
 * metadata requests, no AI request) and re-validates route, price, privacy and budget per task.
 */
export async function applyRecommendedModels(input: { settings: ImporterSettings; add: string[]; expectedList: string[]; actorId: string }): Promise<ApplyResult> {
  const { settings } = input;
  if (JSON.stringify([...settings.importerModels].sort()) !== JSON.stringify([...input.expectedList].sort())) throw new AssistantApplyError("The importer's model list changed since the recommendations were shown. Nothing was saved — find the recommendations again.");
  const add = [...new Set(input.add)];
  if (!add.length) throw new AssistantApplyError("Nothing to add — every recommended model is already on the importer's list.");
  const fresh = await modelAssistant(settings);
  const allowed = new Set(fresh.toAdd);
  const refused = add.filter((id) => !allowed.has(id));
  if (refused.length) throw new AssistantApplyError(`Not saved: ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} not recommended now (the catalog, routes or limits changed). Find the recommendations again.`);
  const list = [...settings.importerModels, ...add];
  if (list.length > MAX_IMPORTER_MODELS) throw new AssistantApplyError(`Not saved: the importer's list would have ${list.length} models (at most ${MAX_IMPORTER_MODELS}). Remove some first.`);
  // Only the importer's own list changes; every other saved setting is kept as it is.
  const saved = await saveImporterSettings({ ...settings, importerModels: list }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORTER_MODELS_APPLIED", entityType: "Setting", entityId: "ai.importer", metadata: { added: add, list, method: "catalog" } } });
  let routesError: string | null = null;
  try {
    await refreshRoutes(saved.importerModels);
  } catch (e) {
    routesError = e instanceof Error ? e.message.slice(0, 200) : "the provider routes could not be read or saved";
  }
  const plan = await computeModelPlan(saved, { refresh: false });
  return {
    added: add,
    list: saved.importerModels,
    tasks: Object.values(plan.tasks).map((t) => ({ task: t.task, label: SELECTION_TASK_LABELS[t.task], model: t.model, reason: t.reason, maxInr: t.maxInr })),
    routesError,
  };
}
