import { estimateSpeechSec, graphemeCount, graphemes, words as wordTokens } from "@/lib/video-studio/text";
import { ASPECT_MAP, type AspectRatio, type Audience, type Language } from "@/lib/video-studio/types";
import { MOTION_KEYS, MOTION_STYLE_MAP, type MotionKey, type MotionStyle } from "@/lib/video-studio/motion/styles";

/**
 * Motion Workflow Studio — the storyboard model (client-safe, pure, unit-tested).
 *
 *   Topic → Script → Storyboard (one sentence = one frame; per frame: the
 *   spoken sentence, ONE on-screen idea, ONE motion, ONE highlighted word)
 *   → Voice-over plan (one take) → word timing → animation → render.
 *
 * Frames are stored as VideoScene rows of a MOTION job: narration = the
 * spoken sentence, onScreenText = the one on-screen idea, visual = MotionVisual.
 * Question frames never take the stem, options or answer from the model: the
 * server fills them from the Question Bank (same rule as the Generator).
 */

export const MOTION_VIDEO_TYPES = [
  { key: "medical_explainer", label: "Medical educational video", medical: true },
  { key: "exam_prep", label: "Exam preparation", medical: true },
  { key: "mcq_explainer", label: "MCQ explainer (Question Bank)", medical: true },
  { key: "clinical_case", label: "Clinical case", medical: true },
  { key: "diagram_explainer", label: "Diagram explainer", medical: true },
  { key: "revision_reel", label: "Revision reel", medical: true },
  { key: "promo", label: "Promotional video", medical: false },
] as const;
export type MotionVideoType = (typeof MOTION_VIDEO_TYPES)[number]["key"];
export const MOTION_VIDEO_TYPE_MAP = Object.fromEntries(MOTION_VIDEO_TYPES.map((t) => [t.key, t])) as Record<MotionVideoType, (typeof MOTION_VIDEO_TYPES)[number]>;

/** Style the workflow proposes for each video type (the admin may change it before the script). */
export const DEFAULT_STYLE: Record<MotionVideoType, string> = {
  medical_explainer: "concept_map",
  exam_prep: "level_up",
  mcq_explainer: "level_up",
  clinical_case: "case_story",
  diagram_explainer: "concept_map",
  revision_reel: "big_sentence",
  promo: "big_sentence",
};

export const FRAME_TYPES = ["statement", "steps", "diagram", "stat", "question", "compare", "cta", "image"] as const;
export type FrameType = (typeof FRAME_TYPES)[number];

export interface MotionVisual {
  kind: "motion";
  type: FrameType;
  motion: MotionKey;
  /** The ONE word that gets highlighted when it is spoken (must occur in the sentence or the on-screen text). */
  highlight: string;
  /** Level / Day / Step label (styles with a tag). */
  tag: string | null;
  items?: string[];
  nodes?: string[];
  value?: string;
  unit?: string;
  left?: string;
  right?: string;
  /** question: filled from the Question Bank only. */
  questionId?: string;
  stem?: string;
  options?: { label: string; text: string }[];
  correctLabel?: string | null;
  /** Seconds into the frame when the stored answer is revealed (0 = never). */
  revealAtSec?: number;
  /** image: an uploaded image of the job. */
  assetKey?: string;
}

export interface MotionFrameDraft {
  sentence: string;
  onScreen: string;
  visual: MotionVisual;
  durationSec: number;
  needsReview: boolean;
  reviewNote: string | null;
}

export interface MotionTiming {
  /** precise = word timestamps from transcribing the narration; estimated = spread over the measured narration length; reading = no narration (reading speed). */
  mode: "precise" | "estimated" | "reading";
  totalSec: number;
  frames: { start: number; end: number }[];
  /** Every spoken word of every frame, with its time on the video timeline. */
  words: { frame: number; text: string; start: number; end: number }[];
}

export interface MotionConfig {
  version: 1;
  module: "motion";
  videoType: MotionVideoType;
  styleKey: string;
  aspect: AspectRatio;
  language: Language;
  audience: Audience;
  targetSec: number;
  frameCount: number;
  examLabel: string | null;
  cta: string;
  branding: boolean;
  subtitles: boolean;
  questionIds: string[];
  skillKeys: string[];
  topic: string;
  brief: string;
  title?: string;
  caption?: string;
  scriptModel?: string;
  voice?: { model: string; voice: string } | null;
  timing?: MotionTiming | null;
}

export const MOTION_LIMITS = { minSec: 20, maxSec: 90, minFrames: 4, maxFrames: 12, sentenceWords: 28, onScreenWords: 8, onScreenGraphemes: 56 } as const;

/** Words per second of narration (planning only) and the word budget of a script. */
export function wordBudget(targetSec: number, language: Language): number {
  return Math.round((targetSec / 60) * ({ en: 150, hi: 135, hinglish: 140 } as const)[language]);
}

/**
 * Safe zone (fractions of the frame). 9:16 follows the reference: the platform
 * UI covers the top 14 % and the bottom 35 %, keep 6 % clear at each side
 * (65 / 269 / 672 px at 1080×1920). Other formats keep smaller margins.
 */
export function safeZone(aspect: AspectRatio): { top: number; bottom: number; side: number; W: number; H: number } {
  const { width: W, height: H } = ASPECT_MAP[aspect];
  if (aspect === "9:16") return { top: 269, bottom: 672, side: 65, W, H };
  if (aspect === "4:5") return { top: Math.round(H * 0.08), bottom: Math.round(H * 0.14), side: Math.round(W * 0.06), W, H };
  return { top: Math.round(H * 0.07), bottom: Math.round(H * 0.1), side: Math.round(W * 0.06), W, H };
}

// ---- prompt ---------------------------------------------------------------------------------

export interface MotionQuestion {
  id: string;
  code: string;
  stem: string;
  options: { label: string; text: string }[];
  correctLabel: string | null;
  explanation: string | null;
}

const LANGUAGE_RULES: Record<Language, string> = {
  hinglish: "Sentences in natural spoken Hinglish: Hindi in Devanagari script, medical and technical terms in English (Latin script).",
  hi: "Sentences in clear spoken Hindi (Devanagari); keep standard English medical terms in Latin script where students use them.",
  en: "Sentences in clear spoken Indian English.",
};

export function buildMotionPrompt(cfg: MotionConfig, style: MotionStyle, questions: MotionQuestion[], skills: string, brandCta: string): string {
  const { width, height } = ASPECT_MAP[cfg.aspect];
  const z = safeZone(cfg.aspect);
  const p: string[] = [];
  p.push("You plan short motion-graphics teaching videos for MockTestSeries.in (Indian medical exam preparation). You write the SCRIPT and its STORYBOARD together.");
  p.push(`Video: ${cfg.targetSec} seconds, ${cfg.frameCount} frames (±1), at most ${wordBudget(cfg.targetSec, cfg.language)} spoken words, ${width}×${height} (${cfg.aspect}), for ${cfg.audience.replace(/_/g, " ").toUpperCase()} students.${cfg.examLabel ? ` Exam context: ${cfg.examLabel}.` : ""}`);
  p.push(`Style (locked for every frame): “${style.name}” — ${style.description}${style.tagHint ? ` Each frame gets a short tag such as ${style.tagHint}.` : ""}`);
  p.push(LANGUAGE_RULES[cfg.language]);
  p.push(
    [
      "Script rules: talk to one student across a table; full spoken sentences, no slogans, no hashtags, no emoji.",
      "Frame 1 opens with the problem or a striking clinical clue in ONE sentence.",
      "ONE idea per sentence, and ONE sentence per frame (the sentence is exactly what is spoken during that frame).",
      `The last frame is the call to action: “${cfg.cta || brandCta}”.`,
      "Never invent statistics, doses, guideline names or exam history; if a claim is uncertain set needsReview true with a short reviewNote.",
    ].join(" ")
  );
  p.push(
    [
      "Storyboard rules: for every frame give (1) the sentence, (2) onScreen: the ONE idea shown, at most 6 words, (3) motion: exactly one of " +
        style.motions.join(", ") +
        ", (4) highlight: the single word of onScreen that is emphasised when it is spoken, (5) a visual.",
      "Two frames in a row must not look the same (change the visual type or the motion).",
      `Text must fit the safe zone (nothing in the top ${Math.round((z.top / z.H) * 100)} % or the bottom ${Math.round((z.bottom / z.H) * 100)} % of the frame); keep labels short.`,
    ].join(" ")
  );
  if (skills) p.push(`Skills to apply:\n${skills}`);
  if (cfg.topic) p.push(`Topic: ${cfg.topic}`);
  if (cfg.brief) p.push(`Brief from the admin:\n${cfg.brief}`);
  if (questions.length) {
    p.push(
      'Question Bank questions — show one with visual {"type":"question","questionId":…}; the platform shows the exact stem, options and STORED answer. Never state a different answer; explain why the stored answer is correct:\n' +
        questions.map((q) => `- questionId ${q.id} (${q.code}): ${q.stem}\n  Options: ${q.options.map((o) => `${o.label}) ${o.text}`).join("  ")}\n  Stored correct answer: ${q.correctLabel ?? "NONE STORED — do not guess"}`).join("\n")
    );
  }
  p.push(
    'Answer with ONE JSON object and nothing else:\n{"title":"…","caption":"≤ 300 characters","frames":[{"sentence":"…","onScreen":"…","highlight":"…","motion":"…","tag":"…","visual":{…},"needsReview":false,"reviewNote":""}]}\n' +
      '"visual" is ONE of: {"type":"statement"} | {"type":"steps","items":["…","…","…"]} (2–4 items, ≤ 5 words each) | {"type":"diagram","nodes":["…","…","…"]} (2–6 nodes of a flow) | {"type":"stat","value":"…","unit":"…"} (a number from the topic you are sure of) | {"type":"compare","left":"…","right":"…"} | {"type":"question","questionId":"…","revealAtSec":3} | {"type":"cta"}'
  );
  return p.join("\n\n");
}

// ---- parsing --------------------------------------------------------------------------------

const clip = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

const STOP = new Set("a an the is are was were be of to in on for and or with by at as it this that these those from into than then so very what which who how why your you we our their is are है हैं था थी थे की का के को में से पर और भी तो यह वह ये वो एक इस उस कि हम आप अब कर करता करती करते होता होती होते".split(" "));

/** The word to highlight: the given one if it occurs in the frame's text, else the most distinctive word of the on-screen idea. */
export function pickHighlight(onScreen: string, sentence: string, wanted?: string): string {
  const all = [...wordTokens(onScreen), ...wordTokens(sentence)];
  const w = clip(wanted, 40);
  if (w && all.some((x) => x.toLowerCase() === w.toLowerCase())) return all.find((x) => x.toLowerCase() === w.toLowerCase())!;
  const cands = wordTokens(onScreen).filter((x) => !STOP.has(x.toLowerCase()) && graphemeCount(x) > 1);
  if (!cands.length) return wordTokens(sentence).filter((x) => !STOP.has(x.toLowerCase())).sort((a, b) => graphemeCount(b) - graphemeCount(a))[0] ?? "";
  // Prefer numbers and Latin technical terms (Troponin, CK-MB), then the longest word.
  return cands.find((x) => /\d/.test(x)) ?? cands.find((x) => /^[A-Z][A-Za-z-]{2,}$/.test(x)) ?? [...cands].sort((a, b) => graphemeCount(b) - graphemeCount(a))[0];
}

/** Motion for a frame: the requested one if the style allows it, else the style's next one (never the same twice in a row when avoidable). */
export function pickMotion(style: MotionStyle, wanted: unknown, previous: MotionKey | null, index: number, type: FrameType): MotionKey {
  const ok = (m: MotionKey) => style.motions.includes(m);
  if (typeof wanted === "string" && (MOTION_KEYS as readonly string[]).includes(wanted) && ok(wanted as MotionKey) && (wanted !== previous || style.motions.length === 1)) return wanted as MotionKey;
  const natural: Partial<Record<FrameType, MotionKey>> = { stat: "count", steps: "stagger", diagram: "draw", question: "flip", image: "ken_burns" };
  const n = natural[type];
  if (n && ok(n) && n !== previous) return n;
  const rot = style.motions.filter((m) => m !== previous);
  return (rot.length ? rot : style.motions)[index % (rot.length || style.motions.length)];
}

export function plannedFrameSec(sentence: string, language: Language): number {
  return Math.round(Math.min(14, Math.max(2.2, estimateSpeechSec(sentence, language) + 0.4)) * 10) / 10;
}

function parseVisual(raw: unknown, questions: MotionQuestion[], assets: { key: string }[], notes: string[], n: number): Omit<MotionVisual, "kind" | "motion" | "highlight" | "tag"> {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const type = FRAME_TYPES.find((t) => t === v.type) ?? "statement";
  switch (type) {
    case "steps": {
      const items = (Array.isArray(v.items) ? v.items : []).map((x) => clip(x, 48)).filter(Boolean).slice(0, 4);
      return items.length >= 2 ? { type, items } : { type: "statement" };
    }
    case "diagram": {
      const nodes = (Array.isArray(v.nodes) ? v.nodes : []).map((x) => clip(x, 40)).filter(Boolean).slice(0, 6);
      return nodes.length >= 2 ? { type, nodes } : { type: "statement" };
    }
    case "stat": {
      const value = clip(v.value, 12);
      return value ? { type, value, unit: clip(v.unit, 24) || undefined } : { type: "statement" };
    }
    case "compare": {
      const left = clip(v.left, 40);
      const right = clip(v.right, 40);
      return left && right ? { type, left, right } : { type: "statement" };
    }
    case "question": {
      const q = questions.find((x) => x.id === v.questionId);
      if (!q) {
        notes.push(`Frame ${n}: the model referred to a question that was not supplied — shown as a statement.`);
        return { type: "statement" };
      }
      const reveal = typeof v.revealAtSec === "number" && Number.isFinite(v.revealAtSec) ? Math.min(12, Math.max(1, v.revealAtSec)) : 3;
      return { type, questionId: q.id, stem: q.stem.slice(0, 300), options: q.options.slice(0, 5).map((o) => ({ label: o.label, text: o.text.slice(0, 120) })), correctLabel: q.correctLabel, revealAtSec: q.correctLabel ? reveal : 0 };
    }
    case "image": {
      const a = assets.find((x) => x.key === v.assetKey) ?? assets[typeof v.assetIndex === "number" ? v.assetIndex : -1];
      return a ? { type, assetKey: a.key } : { type: "statement" };
    }
    default:
      return { type };
  }
}

export interface ParsedMotion {
  title: string;
  caption: string;
  frames: MotionFrameDraft[];
  warnings: string[];
}

/** One frame object (from the model, or from an admin's edit). */
export function parseFrame(raw: unknown, cfg: Pick<MotionConfig, "language" | "styleKey">, questions: MotionQuestion[], assets: { key: string }[], previous: MotionKey | null, index: number, warnings: string[], strip: (s: string) => string = (s) => s): MotionFrameDraft {
  const style = MOTION_STYLE_MAP[cfg.styleKey] ?? MOTION_STYLE_MAP.big_sentence;
  const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sentence = strip(clip(f.sentence, 320));
  let onScreen = strip(clip(f.onScreen, 90));
  if (!onScreen) onScreen = wordTokens(sentence).filter((w) => !STOP.has(w.toLowerCase())).slice(0, 5).join(" ");
  const pv = parseVisual(f.visual, questions, assets, warnings, index + 1);
  const motion = pickMotion(style, f.motion, previous, index, pv.type);
  const highlight = pickHighlight(onScreen, sentence, typeof f.highlight === "string" ? f.highlight : undefined);
  const tag = style.tagHint ? strip(clip(f.tag, 24)) || null : null;
  const visual: MotionVisual = { kind: "motion", motion, highlight, tag, ...pv };
  if (visual.items) visual.items = visual.items.map(strip);
  if (visual.nodes) visual.nodes = visual.nodes.map(strip);
  const notes: string[] = [];
  if (f.needsReview === true) notes.push(clip(f.reviewNote, 240) || "Flagged by the Medical Fact Checker.");
  if (pv.type === "question" && !pv.correctLabel) notes.push("This question has no stored correct answer — it is shown without a reveal.");
  return { sentence, onScreen, visual, durationSec: plannedFrameSec(sentence, cfg.language), needsReview: notes.length > 0, reviewNote: notes.join(" ") || null };
}

export function parseMotionAnswer(root: unknown, cfg: Pick<MotionConfig, "language" | "styleKey" | "targetSec">, questions: MotionQuestion[], assets: { key: string }[], strip: (s: string) => string = (s) => s): ParsedMotion {
  const r = root && typeof root === "object" ? (root as Record<string, unknown>) : {};
  const raw = Array.isArray(r.frames) ? r.frames.slice(0, MOTION_LIMITS.maxFrames) : [];
  if (raw.length < 3) throw new Error("The model returned fewer than 3 frames.");
  const warnings: string[] = [];
  const frames: MotionFrameDraft[] = [];
  for (const [i, f] of raw.entries()) {
    const d = parseFrame(f, cfg, questions, assets, frames[i - 1]?.visual.motion ?? null, i, warnings, strip);
    if (d.sentence) frames.push(d);
  }
  if (frames.length < 3) throw new Error("The model returned fewer than 3 frames with a spoken sentence.");
  if (frames[frames.length - 1].visual.type !== "cta") frames[frames.length - 1].visual.type = "cta";
  const total = frames.reduce((a, f) => a + f.durationSec, 0);
  if (total > cfg.targetSec * 1.5) warnings.push(`The script is long (~${Math.round(total)} s planned for ${cfg.targetSec} s).`);
  return { title: strip(clip(r.title, 120)), caption: strip(clip(r.caption, 300)), frames, warnings };
}

// ---- deterministic re-plan (free, no AI) ----------------------------------------------------

/** Splits a script into spoken sentences (Devanagari danda aware). Very short pieces are joined to the previous one. */
export function splitSentences(script: string): string[] {
  const parts = script
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && wordTokens(p).length < 3) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

/**
 * Builds a storyboard from a script without AI: one frame per sentence, the
 * on-screen idea from the sentence's key words, motions rotated through the
 * style, number sentences as stats, lists as steps, the last frame as CTA.
 * Existing frames with the same sentence keep their visual (edits survive).
 */
export function planStoryboard(script: string, cfg: Pick<MotionConfig, "language" | "styleKey">, existing: MotionFrameDraft[] = []): MotionFrameDraft[] {
  const style = MOTION_STYLE_MAP[cfg.styleKey] ?? MOTION_STYLE_MAP.big_sentence;
  const sentences = splitSentences(script).slice(0, MOTION_LIMITS.maxFrames);
  const frames: MotionFrameDraft[] = [];
  sentences.forEach((sentence, i) => {
    const keep = existing.find((f) => f.sentence === sentence);
    const prev = frames[i - 1]?.visual.motion ?? null;
    if (keep) {
      frames.push({ ...keep, visual: { ...keep.visual, motion: pickMotion(style, keep.visual.motion, prev, i, keep.visual.type) } });
      return;
    }
    const last = i === sentences.length - 1 && sentences.length > 1;
    const num = /(\d+(?:[.,]\d+)?)\s*(%|hours?|hrs?|days?|mg|घंटे|दिन|मिनट|minutes?)?/i.exec(sentence);
    const list = sentence.split(/,|और|\band\b/).map((s) => s.trim()).filter((s) => wordTokens(s).length >= 1);
    let type: FrameType = last ? "cta" : "statement";
    const extra: Partial<MotionVisual> = {};
    if (!last && num && i > 0) {
      type = "stat";
      extra.value = num[1];
      extra.unit = num[2] || undefined;
    } else if (!last && i > 0 && list.length >= 3) {
      type = "steps";
      extra.items = list.slice(0, 4).map((s) => wordTokens(s).filter((w) => !STOP.has(w.toLowerCase())).slice(0, 4).join(" ")).filter(Boolean);
      if ((extra.items?.length ?? 0) < 2) type = "statement";
    }
    // Key words as written (keeps "CK-MB", "Troponin I"), stop words and end punctuation removed.
    const onScreen = sentence
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, ""))
      .filter((w) => w && !STOP.has(w.toLowerCase()))
      .slice(0, 5)
      .join(" ");
    frames.push({
      sentence,
      onScreen,
      visual: { kind: "motion", type, motion: pickMotion(style, null, prev, i, type), highlight: pickHighlight(onScreen, sentence), tag: style.tagHint ? defaultTag(style, i, sentences.length) : null, ...extra },
      durationSec: plannedFrameSec(sentence, cfg.language),
      needsReview: false,
      reviewNote: null,
    });
  });
  return frames;
}

export function defaultTag(style: MotionStyle, i: number, n: number): string | null {
  if (style.layout === "levels") return i === 0 ? "Start" : i >= n - 2 ? (i === n - 1 ? "Done" : "Boss") : `Level ${i}`;
  if (style.layout === "case") return ["Presentation", "History", "Finding", "Diagnosis", "Next step"][Math.min(4, i)] ?? null;
  if (style.layout === "calendar") return `Step ${i + 1}`;
  return null;
}

// ---- timing ---------------------------------------------------------------------------------

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const GAP = 0.18;

/**
 * Spreads every frame's words over `totalSec` in proportion to their length
 * (graphemes), with a short pause between sentences. Used for silent renders
 * (reading speed) and as the fallback when no word timestamps exist.
 */
export function estimateTiming(sentences: string[], language: Language, totalSec: number | null, mode: "estimated" | "reading"): MotionTiming {
  const planned = sentences.map((s) => Math.max(1.6, estimateSpeechSec(s, language) * (mode === "reading" ? 1.25 : 1) + 0.3));
  const sum = planned.reduce((a, b) => a + b, 0);
  const scale = totalSec ? totalSec / sum : 1;
  const frames: { start: number; end: number }[] = [];
  const out: MotionTiming["words"] = [];
  let t = 0;
  sentences.forEach((s, i) => {
    const d = planned[i] * scale;
    frames.push({ start: r3(t), end: r3(t + d) });
    const ws = wordTokens(s);
    const weights = ws.map((w) => Math.max(1, graphemes(w).length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const speak = Math.max(0.4, d - GAP * 2);
    let w0 = t + GAP;
    ws.forEach((w, j) => {
      const wd = (speak * weights[j]) / total;
      out.push({ frame: i, text: w, start: r3(w0), end: r3(w0 + wd) });
      w0 += wd;
    });
    t += d;
  });
  return { mode, totalSec: r3(t), frames, words: out };
}

const norm = (w: string) => w.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");

/**
 * Aligns the script's words to transcribed word timestamps (monotonic: each
 * script word matches the next equal transcript word within a short window;
 * unmatched words are interpolated between their matched neighbours). Frame
 * boundaries are then the first word of each sentence.
 */
export function alignTiming(sentences: string[], stt: { word: string; start: number; end: number }[], totalSec: number, language: Language): MotionTiming {
  const script = sentences.flatMap((s, frame) => wordTokens(s).map((text) => ({ frame, text, n: norm(text) })));
  const tr = stt.map((w) => ({ ...w, n: norm(w.word) })).filter((w) => w.n);
  const times: ({ start: number; end: number } | null)[] = script.map(() => null);
  let j = 0;
  for (let i = 0; i < script.length; i++) {
    search: for (let k = j; k < Math.min(tr.length, j + 6); k++) {
      // One transcribed word may cover up to 3 script tokens ("CK-MB" = "CK" + "MB").
      for (let m = 1; m <= 3 && i + m <= script.length; m++) {
        const joined = script.slice(i, i + m).map((x) => x.n).join("");
        if (tr[k].n === joined) {
          const step = (tr[k].end - tr[k].start) / m;
          for (let x = 0; x < m; x++) times[i + x] = { start: r3(tr[k].start + x * step), end: r3(tr[k].start + (x + 1) * step) };
          i += m - 1;
          j = k + 1;
          break search;
        }
        if (!tr[k].n.startsWith(joined)) break;
      }
    }
  }
  const matched = times.filter(Boolean).length;
  // Too few matches (e.g. the transcript used another script for Hindi words): fall back to spreading over the measured length.
  if (script.length && matched / script.length < 0.35) return estimateTiming(sentences, language, totalSec, "estimated");
  // Interpolate the gaps.
  for (let i = 0; i < times.length; i++) {
    if (times[i]) continue;
    let a = i - 1;
    while (a >= 0 && !times[a]) a--;
    let b = i + 1;
    while (b < times.length && !times[b]) b++;
    const from = a >= 0 ? times[a]!.end : 0;
    const to = b < times.length ? times[b]!.start : totalSec;
    const gapWords = b - a - 1;
    const step = Math.max(0.05, (to - from) / Math.max(1, gapWords));
    for (let k = a + 1; k < b; k++) times[k] = { start: r3(from + (k - a - 1) * step), end: r3(from + (k - a) * step) };
    i = b - 1;
  }
  const words = script.map((w, i) => ({ frame: w.frame, text: w.text, start: r3(times[i]!.start), end: r3(Math.max(times[i]!.start + 0.05, times[i]!.end)) }));
  const frames = sentences.map((_, f) => {
    const first = words.find((w) => w.frame === f);
    return { start: first ? Math.max(0, first.start - 0.12) : 0, end: 0 };
  });
  frames[0].start = 0;
  for (let f = 0; f < frames.length; f++) frames[f].end = r3(f + 1 < frames.length ? frames[f + 1].start : Math.max(totalSec, (words[words.length - 1]?.end ?? 0) + 0.4));
  // Guarantee a minimum on-screen time per frame.
  for (let f = 1; f < frames.length; f++) if (frames[f].start < frames[f - 1].start + 0.8) frames[f].start = frames[f - 1].end = r3(frames[f - 1].start + 0.8);
  return { mode: "precise", totalSec: r3(frames[frames.length - 1].end), frames: frames.map((x) => ({ start: r3(x.start), end: r3(x.end) })), words };
}
