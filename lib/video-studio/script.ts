import { estimateSpeechSec, graphemeCount } from "@/lib/video-studio/text";
import { ASPECT_MAP, type Language, type VideoConfig } from "@/lib/video-studio/types";
import type { SceneVisual } from "@/lib/video-studio/template";
import { extractJsonObject, type OutputCheck } from "@/lib/ai-engine/structured";

/**
 * AI Video Studio — the script stage's prompt and the strict parser for the
 * model's answer (pure: no database, no network; unit-tested).
 *
 * Trust rules:
 * - Question scenes NEVER take the stem, options or correct answer from the
 *   model: the model names a questionId from the supplied list and the server
 *   fills everything from the Question Bank. A question with no stored correct
 *   answer is shown without a reveal and flagged for review.
 * - A quiz question the model writes itself (no questionId) is always flagged
 *   for review, its "correct" option is not highlighted until a human checks it.
 * - Everything is length-limited; unknown visual kinds fall back to a title card.
 * - The Medical Fact Checker's flags (needsReview + note) are kept as-is.
 */

export interface SourceQuestion {
  id: string;
  code: string;
  stem: string;
  options: { label: string; text: string }[];
  correctLabel: string | null;
  explanation: string | null;
}

export interface SourceAsset {
  key: string;
  label: string;
}

export interface ScriptMaterial {
  topic: string;
  prompt: string;
  customInstructions: string;
  questions: SourceQuestion[];
  /** Extracted document text (PDF pages), already length-limited. */
  documentText: string;
  /** Images / PDF pages the model may put on screen (by index). */
  assets: SourceAsset[];
  /** Number of images attached to the request for the model to look at. */
  attachedImages: number;
}

export interface SceneDraft {
  narration: string;
  onScreenText: string;
  visual: SceneVisual | null;
  durationSec: number;
  needsReview: boolean;
  reviewNote: string | null;
  assetKey: string | null;
}

export interface ParsedScript {
  title: string;
  caption: string;
  scenes: SceneDraft[];
  warnings: string[];
}

const LANGUAGE_RULES: Record<Language, string> = {
  hinglish: "Write narration in natural spoken Hinglish: Hindi in Devanagari script, with medical and technical terms kept in English (Latin script), e.g. “Troponin I सबसे specific marker है।”. On-screen text may use either script.",
  hi: "Write narration in clear spoken Hindi (Devanagari script). Keep standard medical terms that students use in English (Latin script) when there is no common Hindi term.",
  en: "Write narration in clear spoken Indian English.",
};

export const VISUAL_SCHEMA = `"visual" is ONE of:
  {"kind":"title","title":"…","subtitle":"…"}
  {"kind":"bullets","title":"…","items":["…","…"]}            (2–4 short items)
  {"kind":"diagram","title":"…","nodes":["…","…","…"]}        (2–6 steps of a flow / mechanism / classification)
  {"kind":"question","questionId":"<id from the list>","revealAtSec":<seconds into the scene>}
  {"kind":"quiz","stem":"…","options":["…","…","…","…"],"answerIndex":<0-3>}   (only when no Question Bank question is given)
  {"kind":"image","assetIndex":<number from the asset list>,"title":"…","caption":"…"}
  {"kind":"cta","title":"…","subtitle":"…"}`;

export function buildScriptPrompt(cfg: VideoConfig, m: ScriptMaterial, skills: string, opts: { brandCta: string; designName: string }): string {
  const words = Math.round((cfg.durationSec / 60) * ({ en: 150, hi: 135, hinglish: 140 } as const)[cfg.language]);
  const { width, height } = ASPECT_MAP[cfg.aspect];
  const parts: string[] = [];
  parts.push(`You write short educational videos for MockTestSeries.in (Indian medical entrance and licensing exam preparation).`);
  parts.push(`Task: plan a ${cfg.durationSec}-second video in ${cfg.sceneCount} scenes (±2) for ${cfg.audience.replace(/_/g, " ").toUpperCase()} students. Total narration ≈ ${words} words. Frame: ${width}×${height} (${cfg.aspect}), design “${opts.designName}”.`);
  parts.push(LANGUAGE_RULES[cfg.language]);
  if (cfg.examLabel) parts.push(`Exam context: ${cfg.examLabel}.`);
  parts.push(`Scene 1 is a hook (a question or striking fact). The last scene is a call to action: “${cfg.cta || opts.brandCta}”.`);
  parts.push(`Rules: one idea per scene; on-screen text is short (≤ 8 words per line); no emoji; never invent statistics, drug doses or guidelines you are not sure of — if a claim is uncertain, keep it out or set "needsReview": true with a short "reviewNote". Diagrams are schematic boxes and arrows only (no anatomy drawings).`);
  if (skills) parts.push(`Skills to apply:\n${skills}`);
  if (m.topic) parts.push(`Topic: ${m.topic}`);
  if (m.prompt) parts.push(`Brief from the admin:\n${m.prompt}`);
  if (m.questions.length) {
    parts.push(
      `Question Bank questions (use them with {"kind":"question","questionId":…}; the platform shows the exact stem, options and stored answer — do NOT restate a different answer; explain why the stored answer is correct):\n` +
        m.questions
          .map((q) => `- questionId ${q.id} (${q.code}): ${q.stem}\n  Options: ${q.options.map((o) => `${o.label}) ${o.text}`).join("  ")}\n  Stored correct answer: ${q.correctLabel ?? "NONE STORED — do not guess; say the answer will be confirmed"}${q.explanation ? `\n  Stored explanation: ${q.explanation}` : ""}`)
          .join("\n")
    );
  }
  if (m.documentText) parts.push(`Source document (extracted text — teach only what it supports):\n"""\n${m.documentText}\n"""`);
  if (m.assets.length) parts.push(`Assets you may show on screen with {"kind":"image","assetIndex":N}:\n${m.assets.map((a, i) => `${i}: ${a.label}`).join("\n")}`);
  if (m.attachedImages) parts.push(`${m.attachedImages} image(s) are attached: describe and teach from what they actually show; if something is unreadable, say so in a reviewNote instead of guessing.`);
  if (m.customInstructions) parts.push(`Admin's custom instructions:\n${m.customInstructions}`);
  parts.push(
    `Answer with ONE JSON object and nothing else:\n{"title":"…","caption":"social caption, ≤ 300 characters","scenes":[{"narration":"spoken text","onScreenText":"short text","visual":{…},"needsReview":false,"reviewNote":""}]}\n${VISUAL_SCHEMA}`
  );
  return parts.join("\n\n");
}

const clip = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** The JSON object of a model answer (shared structural reader: fences and chatter tolerated); throws the reason when unusable. */
export function extractJson(text: string): unknown {
  const r = extractJsonObject(text);
  if (!r.ok) throw new Error(r.category === "truncated" ? "The model answer's JSON is incomplete (cut off)." : r.category === "invalid_json" && !text.includes("{") ? "The model answer contains no JSON object." : r.message);
  return r.value;
}

/** AI Engine output check from a parser that throws on an unusable answer. */
export function throwingCheck(parse: (text: string) => unknown): OutputCheck {
  return (text) => {
    const j = extractJsonObject(text);
    if (!j.ok) return { ok: false, category: j.category, message: j.message };
    try {
      parse(text);
      return { ok: true };
    } catch (e) {
      return { ok: false, category: "schema_invalid", message: e instanceof Error ? e.message.slice(0, 200) : "invalid answer" };
    }
  };
}

const LABELS = ["A", "B", "C", "D", "E"];

function parseVisual(raw: unknown, m: ScriptMaterial, warnings: string[], sceneNo: number): { visual: SceneVisual | null; review: string | null; assetKey: string | null } {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!v) return { visual: null, review: null, assetKey: null };
  switch (v.kind) {
    case "title":
      return { visual: { kind: "title", title: clip(v.title, 120) || "…", subtitle: clip(v.subtitle, 160) || undefined }, review: null, assetKey: null };
    case "bullets": {
      const items = (Array.isArray(v.items) ? v.items : []).map((x) => clip(x, 90)).filter(Boolean).slice(0, 4);
      if (!items.length) return { visual: null, review: null, assetKey: null };
      return { visual: { kind: "bullets", title: clip(v.title, 90) || undefined, items }, review: null, assetKey: null };
    }
    case "diagram": {
      const nodes = (Array.isArray(v.nodes) ? v.nodes : []).map((x) => clip(x, 48)).filter(Boolean).slice(0, 6);
      if (nodes.length < 2) return { visual: null, review: null, assetKey: null };
      return { visual: { kind: "diagram", title: clip(v.title, 90) || undefined, nodes }, review: null, assetKey: null };
    }
    case "question": {
      const q = m.questions.find((x) => x.id === v.questionId);
      if (!q) {
        warnings.push(`Scene ${sceneNo}: the model referred to a question that was not supplied — shown as a title card.`);
        return { visual: null, review: "The model referred to an unknown question.", assetKey: null };
      }
      const reveal = typeof v.revealAtSec === "number" && Number.isFinite(v.revealAtSec) ? Math.min(30, Math.max(0.5, v.revealAtSec)) : 3;
      return {
        visual: { kind: "question", stem: q.stem.slice(0, 400), options: q.options.slice(0, 5).map((o) => ({ label: o.label, text: o.text.slice(0, 160) })), correctLabel: q.correctLabel, revealAtSec: q.correctLabel ? reveal : 0 },
        review: q.correctLabel ? null : `Question ${q.code} has no stored correct answer — the answer is not revealed. Add it in the Question Bank, then regenerate.`,
        assetKey: null,
      };
    }
    case "quiz": {
      if (m.questions.length) return { visual: null, review: "The model wrote its own question although Question Bank questions were supplied.", assetKey: null };
      const opts = (Array.isArray(v.options) ? v.options : []).map((x) => clip(x, 120)).filter(Boolean).slice(0, 4);
      if (opts.length < 2) return { visual: null, review: null, assetKey: null };
      const stem = clip(v.stem, 300);
      const idx = typeof v.answerIndex === "number" && Number.isInteger(v.answerIndex) && v.answerIndex >= 0 && v.answerIndex < opts.length ? v.answerIndex : null;
      // An AI-written answer is never highlighted before a human checks it.
      return {
        visual: { kind: "question", stem, options: opts.map((text, i) => ({ label: LABELS[i], text })), correctLabel: idx === null ? null : LABELS[idx], revealAtSec: 0 },
        review: `AI-written quiz question${idx === null ? "" : ` (model's answer: ${LABELS[idx]})`}: verify the answer, then enable the reveal by editing the scene.`,
        assetKey: null,
      };
    }
    case "image": {
      const i = typeof v.assetIndex === "number" && Number.isInteger(v.assetIndex) ? v.assetIndex : -1;
      const a = m.assets[i];
      if (!a) {
        warnings.push(`Scene ${sceneNo}: unknown asset index — shown as a title card.`);
        return { visual: null, review: null, assetKey: null };
      }
      return { visual: { kind: "image", title: clip(v.title, 90) || undefined, caption: clip(v.caption, 140) || undefined, assetKey: a.key }, review: null, assetKey: a.key };
    }
    case "cta":
      return { visual: { kind: "cta", title: clip(v.title, 90) || "…", subtitle: clip(v.subtitle, 120) || undefined }, review: null, assetKey: null };
    default:
      return { visual: null, review: null, assetKey: null };
  }
}

/** Planned scene length before audio exists (replaced by the measured audio length later). */
export function plannedSceneSec(narration: string, language: Language): number {
  return Math.round(Math.min(40, Math.max(2.5, estimateSpeechSec(narration, language) + 0.6)) * 10) / 10;
}

export function parseScript(text: string, cfg: Pick<VideoConfig, "language" | "durationSec">, m: ScriptMaterial, strip: (s: string) => string = (s) => s): ParsedScript {
  const root = extractJson(text) as Record<string, unknown>;
  const warnings: string[] = [];
  const rawScenes = Array.isArray(root.scenes) ? root.scenes.slice(0, 16) : [];
  if (rawScenes.length < 2) throw new Error("The model returned fewer than 2 scenes.");
  const scenes: SceneDraft[] = rawScenes.map((r, i) => parseScene(r, cfg, m, warnings, i + 1, strip));
  if (scenes.every((s) => !s.narration)) throw new Error("The model returned no narration.");
  const total = scenes.reduce((a, s) => a + s.durationSec, 0);
  if (total > cfg.durationSec * 1.6) warnings.push(`The script is long (~${Math.round(total)} s planned for ${cfg.durationSec} s). Shorten scenes in review if needed.`);
  for (const s of scenes) if (graphemeCount(s.onScreenText) > 120) s.onScreenText = s.onScreenText.slice(0, 120);
  return { title: strip(clip(root.title, 120)), caption: strip(clip(root.caption, 300)), scenes, warnings };
}

/** One scene object from the model (also used when a single scene is regenerated). */
export function parseScene(r: unknown, cfg: Pick<VideoConfig, "language">, m: ScriptMaterial, warnings: string[], sceneNo: number, strip: (s: string) => string = (s) => s): SceneDraft {
  const s = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
  const narration = strip(clip(s.narration, 700));
  const onScreenText = strip(clip(s.onScreenText, 140));
  const pv = parseVisual(s.visual, m, warnings, sceneNo);
  const flagged = s.needsReview === true;
  const note = [flagged ? clip(s.reviewNote, 300) || "Flagged by the Medical Fact Checker." : "", pv.review ?? ""].filter(Boolean).join(" ");
  let visual = pv.visual;
  if (visual && visual.kind !== "question" && visual.kind !== "image") visual = stripVisual(visual, strip);
  return {
    narration,
    onScreenText: onScreenText || (narration ? narration.slice(0, 60) : `Scene ${sceneNo}`),
    visual,
    durationSec: plannedSceneSec(narration, cfg.language),
    needsReview: Boolean(note),
    reviewNote: note || null,
    assetKey: pv.assetKey,
  };
}

function stripVisual(v: SceneVisual, strip: (s: string) => string): SceneVisual {
  switch (v.kind) {
    case "title":
    case "cta":
      return { ...v, title: strip(v.title), subtitle: v.subtitle ? strip(v.subtitle) : undefined };
    case "bullets":
      return { ...v, title: v.title ? strip(v.title) : undefined, items: v.items.map(strip) };
    case "diagram":
      return { ...v, title: v.title ? strip(v.title) : undefined, nodes: v.nodes.map(strip) };
    default:
      return v;
  }
}

/** Plain text from Question Bank content (HTML tags and LaTeX delimiters removed; text kept). */
export function plainQuestionText(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\$\$?([^$]+)\$\$?/g, "$1")
    .replace(/\\ce\{([^}]*)\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
