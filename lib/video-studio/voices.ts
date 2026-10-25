import "server-only";
import { prisma } from "@/lib/prisma";
import { openRouterBase } from "@/lib/ai-engine/openrouter";
import { resolveOpenRouterKey } from "@/lib/ai-engine/settings";
import type { CapabilityCheck, Language } from "@/lib/video-studio/types";

/**
 * Voice Studio catalog: the OpenRouter speech models (POST /audio/speech).
 *
 * Verified 2026-10-24 against the live API: `GET /models?output_modalities=speech`
 * lists the speech models with `pricing` and `supported_voices`; OpenRouter's
 * TTS guide says most TTS models are priced PER CHARACTER of input
 * (`pricing.prompt`) and some per second of generated audio
 * (`pricing.completion`). OpenAI TTS is NOT in that catalog, so it is not
 * offered here (a direct OpenAI adapter was deliberately not built).
 *
 * Syncing the catalog is a free read; nothing here synthesises audio. Which
 * speech models may be used is the admin's decision (`approvedModels`): Auto
 * Configure never picks an unapproved or unpriced model.
 */

export const VOICE_CATALOG_KEY = "video.voices";

export type SpeechPriceUnit = "character" | "second" | "unknown";

export interface SpeechModel {
  id: string;
  name: string;
  /** USD per character (when unit = character) or per second (unit = second). */
  unitPriceUsd: number | null;
  unit: SpeechPriceUnit;
  voices: string[];
  /** Languages this model can be relied on for, from its voice ids (hi-IN-…, en-IN-…) or its documented multilingual support. */
  languages: { hi: VoiceSupport; en: VoiceSupport; hinglish: VoiceSupport };
  description: string;
}

/**
 * - locale: the model has voices explicitly for that locale (e.g. "hi-IN-Kavya").
 * - multilingual: the model says it is multilingual; Hindi quality must be checked with a preview.
 * - none: not supported as far as the catalog shows.
 */
export type VoiceSupport = "locale" | "multilingual" | "none";

/** Speech-to-text model (AI Video Editor subtitles). Priced per second of audio when `completion` is 0; token-priced models cannot be estimated and are not offered. */
export interface SttModel {
  id: string;
  name: string;
  perSecondUsd: number | null;
  description: string;
}

export interface VoiceCatalog {
  models: SpeechModel[];
  sttModels: SttModel[];
  approvedModels: string[];
  syncedAt: string | null;
  syncError: string | null;
}

function parsePrice(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const HI_VOICE = /(?:^|[^a-z])hi-IN-|^h[fm]_/i;
const EN_IN_VOICE = /(?:^|[^a-z])en-IN-/i;
const MULTI = /multilingual|\b\d{2,} languages\b/i;

export function toSpeechModel(raw: Record<string, unknown>): SpeechModel | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,60}\/[A-Za-z0-9._:-]{1,100}$/.test(id)) return null;
  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const prompt = parsePrice(pricing.prompt);
  const completion = parsePrice(pricing.completion);
  // Per the TTS guide: pricing.prompt = per character; pricing.completion (with prompt 0) = per second of audio.
  let unit: SpeechPriceUnit = "unknown";
  let unitPriceUsd: number | null = null;
  if (prompt !== null && prompt > 0 && (completion === null || completion === 0)) {
    unit = "character";
    unitPriceUsd = prompt;
  } else if ((prompt === null || prompt === 0) && completion !== null && completion > 0) {
    unit = "second";
    unitPriceUsd = completion;
  } else if (prompt === 0 && completion === 0) {
    unit = "character";
    unitPriceUsd = 0;
  }
  const voices = Array.isArray(raw.supported_voices) ? raw.supported_voices.filter((v): v is string => typeof v === "string" && v.length <= 80).slice(0, 300) : [];
  const description = typeof raw.description === "string" ? raw.description.slice(0, 400) : "";
  const multi = MULTI.test(description);
  const hi: VoiceSupport = voices.some((v) => HI_VOICE.test(v)) ? "locale" : multi ? "multilingual" : "none";
  const en: VoiceSupport = voices.some((v) => EN_IN_VOICE.test(v)) ? "locale" : voices.length || multi ? "multilingual" : "none";
  return {
    id,
    name: typeof raw.name === "string" ? raw.name.slice(0, 120) : id,
    unitPriceUsd,
    unit,
    voices,
    languages: { hi, en, hinglish: hi },
    description,
  };
}

export function toSttModel(raw: Record<string, unknown>): SttModel | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,60}\/[A-Za-z0-9._:-]{1,100}$/.test(id)) return null;
  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const prompt = parsePrice(pricing.prompt);
  const completion = parsePrice(pricing.completion);
  return {
    id,
    name: typeof raw.name === "string" ? raw.name.slice(0, 120) : id,
    perSecondUsd: prompt !== null && (completion === null || completion === 0) ? prompt : null,
    description: typeof raw.description === "string" ? raw.description.slice(0, 300) : "",
  };
}

export async function getVoiceCatalog(): Promise<VoiceCatalog> {
  const row = await prisma.setting.findUnique({ where: { key: VOICE_CATALOG_KEY } });
  const v = (row?.value ?? {}) as Partial<VoiceCatalog>;
  return {
    models: Array.isArray(v.models) ? (v.models as SpeechModel[]) : [],
    sttModels: Array.isArray(v.sttModels) ? (v.sttModels as SttModel[]) : [],
    approvedModels: Array.isArray(v.approvedModels) ? v.approvedModels.filter((m): m is string => typeof m === "string") : [],
    syncedAt: typeof v.syncedAt === "string" ? v.syncedAt : null,
    syncError: typeof v.syncError === "string" ? v.syncError : null,
  };
}

async function saveCatalog(c: VoiceCatalog): Promise<void> {
  const value = JSON.parse(JSON.stringify(c));
  await prisma.setting.upsert({ where: { key: VOICE_CATALOG_KEY }, update: { value }, create: { key: VOICE_CATALOG_KEY, value } });
}

/** Free catalog read from OpenRouter (no audio is generated, nothing is billed). Keeps approvals. */
export async function syncVoiceCatalog(fetchImpl: typeof fetch = fetch): Promise<VoiceCatalog> {
  const current = await getVoiceCatalog();
  const key = await resolveOpenRouterKey();
  try {
    const res = await fetchImpl(`${openRouterBase()}/models?output_modalities=speech`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown[] };
    const models = (Array.isArray(body.data) ? body.data : [])
      .map((m) => (m && typeof m === "object" ? toSpeechModel(m as Record<string, unknown>) : null))
      .filter((m): m is SpeechModel => m !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set(models.map((m) => m.id));
    const stt = await fetchImpl(`${openRouterBase()}/models?output_modalities=transcription`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(20_000), redirect: "error" });
    const sttBody = stt.ok ? ((await stt.json()) as { data?: unknown[] }) : { data: [] };
    const sttModels = (Array.isArray(sttBody.data) ? sttBody.data : []).map((m) => (m && typeof m === "object" ? toSttModel(m as Record<string, unknown>) : null)).filter((m): m is SttModel => m !== null).sort((a, b) => a.id.localeCompare(b.id));
    const next: VoiceCatalog = { models, sttModels, approvedModels: current.approvedModels.filter((m) => ids.has(m)), syncedAt: new Date().toISOString(), syncError: null };
    await saveCatalog(next);
    return next;
  } catch (error) {
    const next = { ...current, syncError: error instanceof Error ? error.message.slice(0, 200) : "sync failed" };
    await saveCatalog(next);
    return next;
  }
}

/** Callers own the RBAC check (VIDEO_STUDIO_MANAGE). Only catalog models can be approved. */
export async function setApprovedSpeechModels(ids: string[]): Promise<VoiceCatalog> {
  const c = await getVoiceCatalog();
  const known = new Set(c.models.map((m) => m.id));
  const next = { ...c, approvedModels: [...new Set(ids.filter((id) => known.has(id)))] };
  await saveCatalog(next);
  return next;
}

export function supportFor(m: SpeechModel, language: Language): VoiceSupport {
  return m.languages[language];
}

/** Voices of a model suited to a language (locale voices first; all voices for multilingual models). */
export function voicesFor(m: SpeechModel, language: Language): string[] {
  if (language === "en") {
    const inLocale = m.voices.filter((v) => EN_IN_VOICE.test(v));
    return inLocale.length ? inLocale : m.voices;
  }
  const hi = m.voices.filter((v) => HI_VOICE.test(v));
  return hi.length ? hi : m.languages.hi === "multilingual" ? m.voices : [];
}

/** USD for synthesising `chars` characters, or null when the price cannot be estimated before generation. */
export function speechCostUsd(m: SpeechModel, chars: number, estSeconds: number): { usd: number | null; note: string | null } {
  if (m.unitPriceUsd === null || m.unit === "unknown") return { usd: null, note: `${m.name}: no usable price in the catalog — the cost cannot be estimated before generation.` };
  if (m.unit === "character") return { usd: m.unitPriceUsd * chars, note: null };
  return { usd: m.unitPriceUsd * estSeconds, note: `${m.name} is priced per second of audio: the estimate uses the planned narration length.` };
}

export interface SpeechPick {
  check: CapabilityCheck;
  model: string | null;
  defaultVoiceId: string | null;
}

/**
 * The approved speech model Auto Configure proposes for a language: locale
 * voices (hi-IN / en-IN) beat "multilingual", then the lowest known price.
 */
export async function speechCapability(language: Language): Promise<SpeechPick> {
  const label = "Voice (text-to-speech)";
  const c = await getVoiceCatalog();
  if (!c.models.length) {
    return { check: { key: "voice", label, status: "missing", provider: null, detail: "The speech model list has not been synced yet (AI Video Studio → Voice Studio → Sync voices). Syncing is free." }, model: null, defaultVoiceId: null };
  }
  const approved = c.models.filter((m) => c.approvedModels.includes(m.id) && m.unit !== "unknown" && supportFor(m, language) !== "none" && voicesFor(m, language).length);
  if (!approved.length) {
    return {
      check: { key: "voice", label, status: "missing", provider: null, detail: `No approved speech model with a priced ${language === "en" ? "English" : "Hindi"} voice. Approve one in Voice Studio (e.g. a model with hi-IN voices) after listening to its preview.` },
      model: null,
      defaultVoiceId: null,
    };
  }
  approved.sort((a, b) => (supportFor(a, language) === "locale" ? 0 : 1) - (supportFor(b, language) === "locale" ? 0 : 1) || (a.unitPriceUsd ?? 1e9) - (b.unitPriceUsd ?? 1e9));
  const m = approved[0];
  const voice = voicesFor(m, language)[0] ?? null;
  const multi = supportFor(m, language) === "multilingual";
  return {
    check: { key: "voice", label, status: "ready", provider: `OpenRouter · ${m.name}`, detail: multi ? "Multilingual model — preview the voice to confirm Hindi pronunciation before generating." : "Model has voices for this language." },
    model: m.id,
    defaultVoiceId: voice,
  };
}
