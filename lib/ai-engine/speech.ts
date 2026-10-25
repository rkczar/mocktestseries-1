import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import { usdToInr } from "@/lib/ai-engine/config";
import { getEngineConfig, patchOpenRouterState, resolveOpenRouterKey, type EngineConfig } from "@/lib/ai-engine/settings";
import { getUsdInr, type FxRate } from "@/lib/ai-engine/fx";
import { releaseBudget, reserveBudget, settleBudget } from "@/lib/ai-engine/budget";
import { OpenRouterError, TRANSIENT_OPENROUTER_ERRORS, createSpeech, createTranscription, describeCategory, sanitize, type ProviderPreferences, type TranscriptionResult } from "@/lib/ai-engine/openrouter";

/**
 * Speech (text-to-speech) and transcription through the EXISTING OpenRouter
 * key, budgets, privacy policy and cost ledger (AiGatewayCall) — the same
 * accounting as the text and image paths in engine.ts. No other provider and
 * no other key is ever used.
 *
 * Speech: OpenRouter returns raw audio with no usage block, so the provider
 * cost is not reported. The ledger row carries the catalog estimate
 * (price × characters) with costStatus "unknown" (or "pending" when a
 * generation id is returned), and the budget keeps the reserved amount —
 * never 0. Transcription returns usage.cost → recorded as actual.
 *
 * Ledger feature keys: "video_voice", "video_transcribe" (Video Studio only;
 * they are not AI Engine routing features, so AI → Features is unchanged).
 */

export const VOICE_FEATURE = "video_voice";
export const TRANSCRIBE_FEATURE = "video_transcribe";
const LABELS: Record<string, string> = { [VOICE_FEATURE]: "AI Video Studio Voice", [TRANSCRIBE_FEATURE]: "AI Video Studio Transcription" };

export class SpeechEngineFailure extends Error {
  constructor(
    message: string,
    readonly category: string
  ) {
    super(message);
  }
}

async function prepare() {
  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) throw new AiNotConfiguredError("OpenRouter is not configured or is disabled (AI → Providers).");
  const engine = await getEngineConfig();
  if (engine.budgets.emergencyStop) throw new AiNotConfiguredError("AI generation is stopped by the AI emergency stop (Admin → AI → Budgets).");
  const fx = await getUsdInr();
  if (fx.rate === null) throw new AiNotConfiguredError(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate."} Nothing was sent to the AI provider.`);
  return { apiKey, engine, fx };
}

function prefs(engine: EngineConfig): ProviderPreferences {
  return { data_collection: engine.privacy.dataCollection, ...(engine.privacy.zdr ? { zdr: true } : {}), allow_fallbacks: true };
}

async function log(e: {
  feature: string;
  kind: "speech" | "transcription";
  requestId: string;
  attempt: number;
  model: string;
  ok: boolean;
  latencyMs: number;
  errorCategory?: string | null;
  errorSummary?: string | null;
  generationId?: string | null;
  estUsd: number | null;
  actualUsd: number | null;
  costStatus: "actual" | "pending" | "unknown" | "none";
  fx: FxRate;
  actorId: string | null;
  ref: string | null;
  inputUnits?: number | null;
}): Promise<void> {
  try {
    await prisma.aiGatewayCall.create({
      data: {
        feature: e.feature,
        provider: "openrouter",
        model: e.model.slice(0, 80),
        modelRequested: e.model.slice(0, 80),
        kind: e.kind,
        routingMode: "manual",
        ok: e.ok,
        errorCategory: e.errorCategory ?? null,
        errorSummary: e.errorSummary ? sanitize(e.errorSummary) : null,
        latencyMs: e.latencyMs,
        // Characters (speech) / seconds of audio (transcription) — the billing unit, kept for estimates.
        inputTokens: e.inputUnits ?? null,
        outputTokens: null,
        estCostUsd: e.estUsd,
        estCostInr: usdToInr(e.estUsd, e.fx.rate),
        actualCostUsd: e.actualUsd,
        actualCostInr: usdToInr(e.actualUsd, e.fx.rate),
        fxRate: e.fx.rate,
        fxAt: e.fx.at,
        costStatus: e.costStatus,
        generationId: e.generationId ?? null,
        attempt: e.attempt,
        requestId: e.requestId,
        actorId: e.actorId,
        // Job reference ("video:<jobId>") so the job's cost is the sum of its own ledger rows.
        quoteId: e.ref,
      },
    });
  } catch (error) {
    console.error("[ai-engine] could not log speech call", error instanceof Error ? error.message.slice(0, 120) : "unknown");
  }
}

export interface SpeechCall {
  model: string;
  voice: string;
  text: string;
  instructions?: string;
  /** Catalog estimate for this request (USD); reserved against the AI budgets before sending. */
  estUsd: number;
  actorId: string | null;
  /** Ledger reference, e.g. "video:<jobId>". */
  ref: string | null;
  timeoutMs?: number;
}

export interface SpeechCallResult {
  audio: Buffer;
  estInr: number;
  costStatus: "pending" | "unknown";
}

export async function synthesizeSpeech(c: SpeechCall): Promise<SpeechCallResult> {
  const { apiKey, engine, fx } = await prepare();
  const estInr = usdToInr(c.estUsd, fx.rate)!;
  // A small margin over the per-character estimate (provider rounding); the budget keeps it when the cost is unreported.
  const reserveInr = Math.max(0.01, estInr * 1.1);
  const requestId = crypto.randomUUID();
  const chars = [...c.text].length;
  let last: OpenRouterError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const requestKey = `${requestId}:${attempt}`;
    await reserveBudget({ requestKey, feature: VOICE_FEATURE, featureLabel: LABELS[VOICE_FEATURE], reservedInr: reserveInr, budgets: engine.budgets, featureDailyInr: null });
    const started = Date.now();
    try {
      const r = await createSpeech({ apiKey, model: c.model, voice: c.voice, input: c.text, instructions: c.instructions, provider: prefs(engine), timeoutMs: c.timeoutMs ?? 120_000 });
      await settleBudget(requestKey, null);
      const costStatus = r.generationId ? "pending" : "unknown";
      await log({ feature: VOICE_FEATURE, kind: "speech", requestId, attempt, model: c.model, ok: true, latencyMs: Date.now() - started, generationId: r.generationId, estUsd: c.estUsd, actualUsd: null, costStatus, fx, actorId: c.actorId, ref: c.ref, inputUnits: chars });
      await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
      return { audio: r.audio, estInr, costStatus };
    } catch (error) {
      const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
      last = e;
      const billedUnknown = e.category === "timeout" || e.generationId !== null;
      if (billedUnknown) await settleBudget(requestKey, null);
      else await releaseBudget(requestKey);
      await log({ feature: VOICE_FEATURE, kind: "speech", requestId, attempt, model: c.model, ok: false, latencyMs: Date.now() - started, errorCategory: e.category, errorSummary: e.message, generationId: e.generationId, estUsd: c.estUsd, actualUsd: null, costStatus: e.generationId ? "pending" : billedUnknown ? "unknown" : "none", fx, actorId: c.actorId, ref: c.ref, inputUnits: chars });
      await patchOpenRouterState({ lastError: { category: e.category, message: sanitize(e.message), at: new Date().toISOString() } });
      if (!TRANSIENT_OPENROUTER_ERRORS.includes(e.category)) break;
    }
  }
  throw new SpeechEngineFailure(`OpenRouter speech failed: ${describeCategory(last!.category)}${last!.message !== describeCategory(last!.category) ? ` (${sanitize(last!.message).slice(0, 160)})` : ""}`, last!.category);
}

export interface TranscribeCall {
  model: string;
  audio: Buffer;
  format: "mp3" | "wav";
  language?: string;
  estUsd: number;
  audioSec: number;
  actorId: string | null;
  ref: string | null;
}

export async function transcribeAudio(c: TranscribeCall): Promise<TranscriptionResult & { costInr: number | null }> {
  const { apiKey, engine, fx } = await prepare();
  const reserveInr = Math.max(0.01, usdToInr(c.estUsd, fx.rate)! * 1.2);
  const requestId = crypto.randomUUID();
  const requestKey = `${requestId}:1`;
  await reserveBudget({ requestKey, feature: TRANSCRIBE_FEATURE, featureLabel: LABELS[TRANSCRIBE_FEATURE], reservedInr: reserveInr, budgets: engine.budgets, featureDailyInr: null });
  const started = Date.now();
  try {
    const r = await createTranscription({ apiKey, model: c.model, audioBase64: c.audio.toString("base64"), format: c.format, language: c.language, provider: prefs(engine), timeoutMs: 300_000 });
    const costInr = usdToInr(r.costUsd, fx.rate);
    await settleBudget(requestKey, costInr);
    await log({ feature: TRANSCRIBE_FEATURE, kind: "transcription", requestId, attempt: 1, model: c.model, ok: true, latencyMs: Date.now() - started, generationId: r.generationId, estUsd: c.estUsd, actualUsd: r.costUsd, costStatus: r.costUsd !== null ? "actual" : r.generationId ? "pending" : "unknown", fx, actorId: c.actorId, ref: c.ref, inputUnits: Math.round(c.audioSec) });
    await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
    return { ...r, costInr };
  } catch (error) {
    const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
    const billedUnknown = e.category === "timeout" || e.generationId !== null;
    if (billedUnknown) await settleBudget(requestKey, null);
    else await releaseBudget(requestKey);
    await log({ feature: TRANSCRIBE_FEATURE, kind: "transcription", requestId, attempt: 1, model: c.model, ok: false, latencyMs: Date.now() - started, errorCategory: e.category, errorSummary: e.message, generationId: e.generationId, estUsd: c.estUsd, actualUsd: null, costStatus: e.generationId ? "pending" : billedUnknown ? "unknown" : "none", fx, actorId: c.actorId, ref: c.ref, inputUnits: Math.round(c.audioSec) });
    throw new SpeechEngineFailure(`OpenRouter transcription failed: ${describeCategory(e.category)}${e.message !== describeCategory(e.category) ? ` (${sanitize(e.message).slice(0, 160)})` : ""}`, e.category);
  }
}
