/**
 * Client-safe shapes of the Import Settings model catalog (built server-side
 * in lib/ai-import/models.ts). Prices are OpenRouter's published USD prices;
 * request costs are ESTIMATES (typical) and conservative MAXIMA (what the
 * runtime reserves before a call).
 */

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
  approved: boolean;
  /** Why the model cannot be used for text tasks (null = usable). */
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
  catalog: { models: number; approved: number; usableVision: number; usableText: number; lastSyncAt: string | null };
  fx: { rate: number | null; rateDate: string | null; source: string | null; stale: boolean; unavailableReason: string | null };
  imageTokens: number;
  priceMargin: number;
  options: ImporterModelOption[];
}
