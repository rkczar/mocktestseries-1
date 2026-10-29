/**
 * AI Engine task profiles and model registry — shared, client-safe.
 *
 * Every AI feature belongs to ONE task profile that says what a model must be
 * able to do for it (input/output modality, JSON, quality) and how long one
 * request may take end to end. The router (lib/ai-engine/router.ts) uses the
 * profile to filter the admin-approved catalog and, in "Task-aware" routing,
 * to rank it: verified registry models first, then healthy models, then price.
 *
 * The registry lists OpenRouter model ids that were checked against the live
 * catalog (GET /api/v1/models) on REGISTRY_VERIFIED_AT: they exist, accept the
 * listed input, write text (or images), accept `response_format`, and are not
 * `:batch` ids. A model is still only ever used after an admin approves it in
 * AI → Models (medical features: also medically approved). Updating the
 * registry = editing this file only; no feature code names a model.
 */

import type { AiFeature } from "@/lib/ai-gateway-config";

export const REGISTRY_VERIFIED_AT = "2026-10-29";

export const TASK_PROFILE_KEYS = ["medical_explanation", "medical_content", "structured_json", "video_planning", "image_generation"] as const;
export type TaskProfileKey = (typeof TASK_PROFILE_KEYS)[number];

export interface TaskProfile {
  key: TaskProfileKey;
  label: string;
  /** Why these models: shown on the Features page. */
  description: string;
  output: "text" | "image";
  /** Input the model must accept (text-only callers need "text"). */
  inputModalities: string[];
  /** The caller expects one JSON object back: JSON mode is requested where the model supports it. */
  json: boolean;
  /**
   * Whole-request deadline (every attempt, retry wait and fallback), in ms.
   * Interactive features stay below nginx's 60 s proxy timeout so the browser
   * gets a clear error instead of a 504; background jobs (Video Studio worker) may run longer.
   */
  deadlineMs: number;
  /** Free (":free") routes are slow and rate-limited: Task-aware routing uses them only when nothing else is approved. */
  freeLastResort: boolean;
  /** Verified OpenRouter ids, best first (Task-aware routing tries approved ones in this order). */
  preferred: string[];
}

export const TASK_PROFILES: Record<TaskProfileKey, TaskProfile> = {
  medical_explanation: {
    key: "medical_explanation",
    label: "Medical explanations (fast)",
    description: "Student-facing explanations and question variants: accurate, instruction-following, JSON, answers within the page timeout.",
    output: "text",
    inputModalities: ["text"],
    json: true,
    deadlineMs: 50_000,
    freeLastResort: true,
    preferred: ["anthropic/claude-haiku-5.5", "google/gemini-3.1-flash-lite", "openai/gpt-5.6-luna", "google/gemini-3.6-flash"],
  },
  medical_content: {
    key: "medical_content",
    label: "Medical content (quality)",
    description: "Instagram carousels, topic posts, traps and diagrams: quality-sensitive medical writing in strict JSON.",
    output: "text",
    inputModalities: ["text"],
    json: true,
    deadlineMs: 55_000,
    freeLastResort: true,
    preferred: ["anthropic/claude-sonnet-5.5", "google/gemini-3.6-flash", "anthropic/claude-haiku-5.5", "openai/gpt-5.6-luna"],
  },
  structured_json: {
    key: "structured_json",
    label: "Structured marketing text",
    description: "Captions, hashtags, trends and competitor summaries: short JSON, speed and price matter more than depth.",
    output: "text",
    inputModalities: ["text"],
    json: true,
    deadlineMs: 55_000,
    freeLastResort: true,
    preferred: ["anthropic/claude-haiku-5.5", "google/gemini-3.1-flash-lite", "openai/gpt-5.6-luna"],
  },
  video_planning: {
    key: "video_planning",
    label: "Video scripts and storyboards",
    description: "Background Video Studio planning: long structured JSON (script, scenes, motion), runs in the worker, may take longer.",
    output: "text",
    inputModalities: ["text"],
    json: true,
    deadlineMs: 240_000,
    freeLastResort: true,
    preferred: ["anthropic/claude-sonnet-5.5", "google/gemini-3.6-flash", "anthropic/claude-haiku-5.5"],
  },
  image_generation: {
    key: "image_generation",
    label: "Medical image generation",
    description: "Image output through the OpenRouter Images API; every image is reviewed before it is added to a post.",
    output: "image",
    inputModalities: ["text"],
    json: false,
    deadlineMs: 90_000,
    freeLastResort: false,
    preferred: ["google/gemini-3.1-flash-image", "google/gemini-3.1-flash-image-preview"],
  },
};

export const FEATURE_PROFILE: Record<AiFeature, TaskProfileKey> = {
  explanation: "medical_explanation",
  variant: "medical_explanation",
  explanation_admin: "medical_explanation",
  variant_admin: "medical_explanation",
  ig_carousel: "medical_content",
  ig_topic: "medical_content",
  ig_trap: "medical_content",
  ig_diagram: "medical_content",
  ig_caption: "structured_json",
  ig_hashtags: "structured_json",
  ig_keywords: "structured_json",
  ig_trends: "structured_json",
  ig_competitors: "structured_json",
  ig_image: "image_generation",
  video_script: "video_planning",
};

export function profileFor(feature: AiFeature): TaskProfile {
  return TASK_PROFILES[FEATURE_PROFILE[feature] ?? "structured_json"];
}

/**
 * Models that are listed with text output but cannot answer a generation
 * prompt. Seen in production (2026-10-18…28): a safety classifier wrote
 * "User Safety: safe" as 65 student explanations and as Instagram/Video JSON;
 * `:batch` ids failed on chat completions; music models were approved as text.
 * Returns the reason, or null when the model may generate.
 */
export function nonGenerativeReason(id: string, outputModalities: string[] = ["text"]): string | null {
  const m = id.toLowerCase();
  if (/content-safety|safeguard|llama-guard|shieldgemma|(^|[/-])guard([-:]|$)|moderation|classifier|-safety([-:]|$)/.test(m)) return "a safety/moderation classifier (rates text instead of writing an answer)";
  if (m.endsWith(":batch")) return "a batch-only id (not served by chat completions)";
  if (m === "openrouter/free" || m === "openrouter/auto") return "a meta-router (the answering model is unknown)";
  if (/(^|\/)(lyria|whisper)|music|embed|rerank|(^|[-/])tts([-:]|$)/.test(m) || outputModalities.includes("audio")) return "not a text-writing model (audio, music or embeddings)";
  return null;
}

export function isFreeModel(id: string): boolean {
  return id.endsWith(":free");
}
