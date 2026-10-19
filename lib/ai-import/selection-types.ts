/**
 * Client-safe shapes of the automatic model selection (lib/ai-import/select.ts).
 * A ModelPlan is computed for Import Settings (display) and frozen on a job at
 * confirmation (job.config.modelPlan); the worker only ever uses the frozen plan.
 */
import type { ModelSelectionMode, SelectionTask } from "@/lib/ai-import/config";

/** Worst-case USD per token (or per request) over every route the model may be served by. */
export interface PlanPrice {
  prompt: number;
  completion: number;
  /** Input-image price (OpenRouter `pricing.image`; billed per image token in the worst case). */
  image: number;
  request: number;
}

export interface CandidateRow {
  id: string;
  eligible: boolean;
  /** Why the model cannot be used for this task (null = eligible). */
  reason: string | null;
  /** Conservative maximum of one request (₹, incl. the price margin); null when it cannot be priced. */
  maxInr: number | null;
  typicalInr: number | null;
  /** Provider routes that satisfy the privacy settings (tags, e.g. "google-vertex/eu"). */
  routes: string[];
}

export interface TaskChoice {
  task: SelectionTask;
  /** The model the job uses for this task (null = nothing eligible: the task does not run). */
  model: string | null;
  /** Manual mode only: cheaper-or-equal OpenRouter-side fallbacks. */
  fallbacks: string[];
  mode: ModelSelectionMode;
  /** Human-readable reason for the choice, or why nothing could be chosen. */
  reason: string;
  vision: boolean;
  price: PlanPrice | null;
  maxUsd: number | null;
  maxInr: number | null;
  typicalInr: number | null;
  routes: string[];
  privacy: { zdrRequired: boolean; dataCollection: "deny" | "allow"; zdrVerified: boolean };
  /** Every evaluated candidate (eligible first, cheapest first). */
  candidates: CandidateRow[];
  /** Set when the worker replaced the confirmed model (unavailable model; never silently pricier). */
  replaced?: { from: string; at: string; why: string };
}

export interface ModelPlan {
  computedAt: string;
  mode: ModelSelectionMode;
  routesFetchedAt: string | null;
  routesStale: boolean;
  fxRate: number | null;
  fxDate: string | null;
  privacy: { zdr: boolean; dataCollection: "deny" | "allow" };
  tasks: Record<SelectionTask, TaskChoice>;
  /** Plan-wide problems (no price source, no exchange rate, route metadata unavailable). */
  problems: string[];
}

export interface RouteStatus {
  fetchedAt: string | null;
  stale: boolean;
  zdrOk: boolean | null;
  zdrError: string | null;
  /** Model ids with a Zero-Data-Retention route (null = the ZDR list has not been read and kept yet). */
  zdrModels: string[] | null;
  models: { id: string; ok: boolean; routes: number; error: string | null }[];
}

/** Recent importer requests of one model (lib/ai-import/health.ts; measured, not a quality rating). */
export interface ModelHealth {
  requests: number;
  ok: number;
  rateLimited: number;
  /** Rate-limited answers in a row, counted from the newest request. */
  consecutiveRateLimited: number;
  /** Internal while counting: still inside the newest rate-limited run. */
  streakOpen: boolean;
  lastRateLimitedAt: string | null;
  lastOkAt: string | null;
}
