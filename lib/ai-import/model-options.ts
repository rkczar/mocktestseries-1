/**
 * Client-safe shapes of the Import Settings model catalog (built server-side
 * in lib/ai-import/models.ts). Prices are OpenRouter's published USD prices;
 * request costs are ESTIMATES (typical) and conservative MAXIMA (what the
 * runtime reserves before a call).
 */
import type { ModelPlan, RouteStatus } from "@/lib/ai-import/selection-types";

export interface RequestCost {
  inputTokens: number;
  maxOutputTokens: number;
  /** Conservative maximum of one request (the amount reserved before the call), incl. the price margin. */
  maxUsd: number;
  maxInr: number | null;
  /** Typical request (40 % of the output limit). */
  typicalUsd: number;
  typicalInr: number | null;
}

export interface ImporterModelOption {
  id: string;
  name: string;
  vision: boolean;
  /** On the importer's own list (Import Settings → Importer models). */
  approved: boolean;
  /** Approved in Admin → AI → Models for the other AI features (information only; the importer ignores it). */
  globallyApproved: boolean;
  /** Why the model cannot be used for text tasks, apart from list membership (null = usable once on the list). */
  problem: string | null;
  /** Why the model cannot read pages (null = usable for vision tasks). */
  visionProblem: string | null;
  /** USD per million tokens. */
  promptPerM: number | null;
  completionPerM: number | null;
  /** OpenRouter `pricing.image` (USD; null = published but unreadable). */
  imagePrice: number | null;
  requestPrice: number | null;
  context: number | null;
  synced: string;
  costs: { extract: RequestCost | null; verify: RequestCost | null; solve: RequestCost; classify: RequestCost; key: RequestCost | null } | null;
}

export interface ImporterCatalog {
  provider: {
    status: "NOT_CONFIGURED" | "DISABLED" | "UNTESTED" | "CONNECTED" | "ERROR";
    keyInstalled: boolean;
    enabled: boolean;
    lastTestOk: boolean | null;
    lastTestAt: string | null;
    lastTestMessage: string | null;
    keyLimitUsd: number | null;
    keyRemainingUsd: number | null;
    keyStatusAt: string | null;
    emergencyStop: boolean;
  };
  /**
   * The direct Gemini API (Admin → AI → Providers, used by student Ask AI and other features). Shown so the
   * administrator knows its state; the importer never sends a request through it (see GEMINI_DIRECT_REASONS).
   */
  gemini: { configured: boolean; enabled: boolean };
  catalog: { models: number; approved: number; usableVision: number; usableText: number; lastSyncAt: string | null };
  fx: { rate: number | null; rateDate: string | null; source: string | null; stale: boolean; unavailableReason: string | null };
  imageTokens: number;
  priceMargin: number;
  options: ImporterModelOption[];
  /** The automatic (or manual) choice per task for the settings shown, with reasons. */
  plan: ModelPlan;
  routes: RouteStatus;
  /** Hard pilot ceilings fixed in code (lib/ai-import/config.ts PILOT_LIMITS). */
  pilot: { totalInr: number; monthlyInr: number; maxJobInr: number; maxRequestInr: number; minKeyReserveUsd: number };
}

/** Why the importer does not use the direct Gemini API (Gemini models remain usable through OpenRouter). */
export const GEMINI_DIRECT_REASONS = [
  "it has no published per-token price in this system and reports no cost per request, so the importer could not reserve a maximum before a request or record the actual cost after it",
  "its model pool tries further models automatically when one fails, which the importer does not allow (no silent fallback)",
  "its models and keys are shared with student Ask AI, so importer settings could change what students use",
  "its privacy terms (data retention) cannot be checked per request the way OpenRouter's Zero-Data-Retention routes are",
] as const;

export interface ModelSuggestions {
  /** Not yet on the importer's list, able to read page images, priced, within the per-request limit and the privacy setting; cheapest page first. */
  suggested: ImporterModelOption[];
  excluded: { notVision: number; unusable: number; noPrice: number; overCap: number; noZdr: number };
  /** null = privacy can be judged; otherwise why it cannot yet (ZDR required but the ZDR list was not read). */
  privacyUnknown: string | null;
}

/**
 * Catalog models an administrator could add to the importer's list for page reading. Uses only data
 * already loaded (catalog prices, the stored Zero-Data-Retention list); never adds or approves anything.
 * The maximum is the catalog price; the provider routes are checked after the model is added.
 */
export function suggestModels(options: readonly ImporterModelOption[], opts: { listed: readonly string[]; capInr: number; zdrRequired: boolean; zdrModels: readonly string[] | null; limit?: number }): ModelSuggestions {
  const excluded = { notVision: 0, unusable: 0, noPrice: 0, overCap: 0, noZdr: 0 };
  const privacyUnknown = opts.zdrRequired && !opts.zdrModels ? "Zero-Data-Retention is required, but the list of ZDR routes has not been read yet — use Refresh provider routes (free, no AI request)." : null;
  const zdr = new Set(opts.zdrModels ?? []);
  const ok: { o: ImporterModelOption; max: number }[] = [];
  for (const o of options) {
    if (opts.listed.includes(o.id)) continue;
    if (!o.vision) excluded.notVision++;
    else if (o.visionProblem) excluded.unusable++;
    else if (o.costs?.extract?.maxInr === null || o.costs?.extract?.maxInr === undefined) excluded.noPrice++;
    else if (o.costs.extract.maxInr > opts.capInr) excluded.overCap++;
    else if (opts.zdrRequired && !zdr.has(o.id)) excluded.noZdr++;
    else ok.push({ o, max: o.costs.extract.maxInr });
  }
  ok.sort((a, b) => a.max - b.max || a.o.id.localeCompare(b.o.id));
  return { suggested: privacyUnknown ? [] : ok.slice(0, opts.limit ?? 8).map((x) => x.o), excluded, privacyUnknown };
}
