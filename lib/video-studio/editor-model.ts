import { ASPECT_KEYS, type AspectRatio } from "@/lib/video-studio/types";
import { subtitleLines } from "@/lib/video-studio/text";
import { SFX_MAP } from "@/lib/video-studio/sfx";

/**
 * AI Video Editor — the project model (client-safe, pure, unit-tested).
 *
 * The edit is non-destructive: the uploaded recording is never modified.
 *  - segments: pieces of uploaded videos [in, out] (source seconds), played in order
 *    (trim = move in/out, split = one segment becomes two, arrange = reorder).
 *  - cues: subtitles in SOURCE time of the primary recording, so trimming or
 *    reordering never desynchronises them; they are mapped onto the output
 *    timeline for preview and export.
 *  - overlays: text / diagram / image / picture-in-picture / B-roll, in OUTPUT time.
 *  - audio: level, fades, clean-up, optional music bed.
 *  - sfx: optional sound-effect clips (lib/video-studio/sfx.ts) in OUTPUT time; a clip may be anchored
 *    to a cut (the start of a segment) or an overlay's start, so it follows that event when the edit
 *    changes. Never added automatically.
 */

export const FITS = ["blur", "crop", "pad"] as const;
export type Fit = (typeof FITS)[number];
export const OVERLAY_KINDS = ["text", "diagram", "image", "pip", "broll"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];
export const TEXT_STYLES = ["title", "lower_third", "label"] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];
export const POSITIONS = ["top", "center", "bottom"] as const;
export type Position = (typeof POSITIONS)[number];
export const SUB_STYLES = ["clean", "boxed", "highlight"] as const;
export type SubStyle = (typeof SUB_STYLES)[number];

export interface EditSegment {
  id: string;
  src: string;
  in: number;
  out: number;
  volume: number;
}

export interface EditCue {
  id: string;
  /** Source seconds in the primary recording. */
  start: number;
  end: number;
  text: string;
}

export interface EditOverlay {
  id: string;
  kind: OverlayKind;
  /** Output seconds. */
  start: number;
  end: number;
  text?: string;
  subtext?: string;
  style?: TextStyle;
  position?: Position;
  nodes?: string[];
  assetKey?: string;
  /** Box as fractions of the frame (image / pip). */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** pip: seconds into the overlay video where it starts. */
  srcIn?: number;
}

/**
 * One sound-effect clip. `start` is the output second the clip's (trimmed) sound begins. When `anchor`
 * is set, the start is recomputed from the anchored event + `offsetSec` (negative = before it, e.g. to
 * land a whoosh's peak on the cut) and `start` is only the fallback if that event is deleted.
 */
export interface EditSfx {
  id: string;
  key: string;
  start: number;
  anchor: { kind: "cut" | "overlay"; id: string } | null;
  offsetSec: number;
  /** Trim inside the sound file (seconds). */
  trimIn: number;
  trimOut: number;
  /** Linear gain, 0–1.5 (1 = the file's level, peak −3 dBFS). */
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface EditProject {
  version: 1;
  primary: string;
  aspect: AspectRatio;
  fit: Fit;
  segments: EditSegment[];
  transition: "none" | "fade";
  subtitles: { on: boolean; style: SubStyle; cues: EditCue[] };
  overlays: EditOverlay[];
  audio: { volume: number; fadeInSec: number; fadeOutSec: number; clean: boolean; musicKey: string | null; musicVolumePct: number };
  /** Optional sound effects (absent in projects saved before they existed = none). */
  sfx: EditSfx[];
  branding: boolean;
  designKey: string;
}

export interface EditAsset {
  key: string;
  kind: "video" | "image" | "music" | "pdf";
  durationSec?: number;
  hasAudio?: boolean;
}

export const FADE_SEC = 0.5;
export const LIMITS = { segments: 200, cues: 1500, overlays: 60, text: 160, sfx: 40 } as const;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const ID = /^[a-z0-9]{4,24}$/;
const KEY = /^(?:[a-z0-9][a-z0-9-]{0,40}\/){0,2}[a-z0-9][a-z0-9._-]{0,80}$/;

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

export function transitionSec(p: Pick<EditProject, "transition" | "segments">): number {
  if (p.transition !== "fade" || p.segments.length < 2) return 0;
  return Math.min(FADE_SEC, ...p.segments.map((s) => (s.out - s.in) / 3));
}

/** Output start of each segment (fades overlap neighbouring segments). */
export function segmentOffsets(p: Pick<EditProject, "transition" | "segments">): number[] {
  const tr = transitionSec(p);
  const out: number[] = [];
  let t = 0;
  for (const s of p.segments) {
    out.push(r3(t));
    t += s.out - s.in - tr;
  }
  return out;
}

export function outputDuration(p: Pick<EditProject, "transition" | "segments">): number {
  const tr = transitionSec(p);
  return r3(p.segments.reduce((a, s) => a + (s.out - s.in), 0) - tr * Math.max(0, p.segments.length - 1));
}

/** Where a source moment of the primary recording appears on the output timeline (it may appear 0, 1 or several times). */
export function mapSourceRange(p: EditProject, start: number, end: number): { start: number; end: number }[] {
  const offs = segmentOffsets(p);
  const out: { start: number; end: number }[] = [];
  p.segments.forEach((s, i) => {
    if (s.src !== p.primary) return;
    const a = Math.max(start, s.in);
    const b = Math.min(end, s.out);
    if (b - a > 0.05) out.push({ start: r3(offs[i] + a - s.in), end: r3(offs[i] + b - s.in) });
  });
  return out;
}

/** The segment playing at an output time, and the source time inside it. */
export function outputToSource(p: EditProject, t: number): { index: number; src: string; time: number } | null {
  const offs = segmentOffsets(p);
  for (let i = p.segments.length - 1; i >= 0; i--) {
    const s = p.segments[i];
    if (t >= offs[i] - 1e-6 && t <= offs[i] + (s.out - s.in) + 1e-6) return { index: i, src: s.src, time: r3(s.in + (t - offs[i])) };
  }
  return null;
}

/** Subtitle cues on the output timeline (sorted, overlaps trimmed). */
export function outputCues(p: EditProject): { start: number; end: number; text: string }[] {
  if (!p.subtitles.on) return [];
  const all = p.subtitles.cues.flatMap((c) => mapSourceRange(p, c.start, c.end).map((r) => ({ ...r, text: c.text })));
  all.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < all.length; i++) if (all[i].end > all[i + 1].start) all[i].end = all[i + 1].start;
  return all.filter((c) => c.end - c.start >= 0.2);
}

/** Splits the segment at an output time. Returns null when the split point is too close to an edge. */
export function splitAt(p: EditProject, t: number): EditProject | null {
  const hit = outputToSource(p, t);
  if (!hit) return null;
  const s = p.segments[hit.index];
  if (hit.time - s.in < 0.3 || s.out - hit.time < 0.3) return null;
  const a = { ...s, out: hit.time };
  const b = { ...s, id: newId(), in: hit.time };
  const segments = [...p.segments.slice(0, hit.index), a, b, ...p.segments.slice(hit.index + 1)];
  return { ...p, segments };
}

/** Words with timestamps (source seconds) → readable subtitle cues (≤ 2 lines, ≤ ~4 s each). */
export function cuesFromWords(words: { word: string; start: number; end: number }[], maxChars = 42, maxSec = 4): EditCue[] {
  const cues: EditCue[] = [];
  let cur: { start: number; end: number; parts: string[] } | null = null;
  const flush = () => {
    if (cur && cur.parts.length) cues.push({ id: newId(), start: r3(cur.start), end: r3(cur.end), text: cur.parts.join(" ").replace(/\s+([,.!?।])/g, "$1") });
    cur = null;
  };
  for (const w of words) {
    const word = w.word.trim();
    if (!word) continue;
    if (cur && (cur.parts.join(" ").length + word.length + 1 > maxChars || w.end - cur.start > maxSec || w.start - cur.end > 0.8)) flush();
    if (!cur) cur = { start: w.start, end: w.end, parts: [] };
    cur.parts.push(word);
    cur.end = w.end;
    if (/[.!?।]$/.test(word)) flush();
  }
  flush();
  return cues;
}

/** Segment-level transcripts (no word timestamps) → cues, splitting long segments evenly by line. */
export function cuesFromSegments(segs: { start: number; end: number; text: string }[], maxChars = 42): EditCue[] {
  const out: EditCue[] = [];
  for (const s of segs) {
    const lines = subtitleLines(s.text, maxChars);
    const total = lines.reduce((a, l) => a + l.length, 0) || 1;
    let t = s.start;
    for (const l of lines) {
      const d = ((s.end - s.start) * l.length) / total;
      out.push({ id: newId(), start: r3(t), end: r3(t + d), text: l });
      t += d;
    }
  }
  return out;
}

export function defaultProject(primary: EditAsset, aspect: AspectRatio, designKey: string, musicVolumePct: number): EditProject {
  const d = primary.durationSec ?? 0;
  return {
    version: 1,
    primary: primary.key,
    aspect,
    fit: "blur",
    segments: [{ id: newId(), src: primary.key, in: 0, out: r3(d), volume: 1 }],
    transition: "none",
    subtitles: { on: true, style: "boxed", cues: [] },
    overlays: [],
    audio: { volume: 1, fadeInSec: 0, fadeOutSec: 0, clean: false, musicKey: null, musicVolumePct },
    sfx: [],
    branding: true,
    designKey,
  };
}

export class EditValidationError extends Error {}

const n = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const s = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");

/** Validates an edit project coming from the browser against the job's own assets. */
export function parseEditProject(raw: unknown, assets: EditAsset[]): EditProject {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const byKey = new Map(assets.map((a) => [a.key, a]));
  const primary = typeof r.primary === "string" ? byKey.get(r.primary) : undefined;
  if (!primary || primary.kind !== "video") throw new EditValidationError("The project's main video is missing.");
  const aspect = ASPECT_KEYS.find((a) => a === r.aspect) ?? "9:16";
  const fit = FITS.find((f) => f === r.fit) ?? "blur";
  const segRaw = Array.isArray(r.segments) ? r.segments.slice(0, LIMITS.segments) : [];
  const segments: EditSegment[] = [];
  for (const x of segRaw) {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const a = typeof o.src === "string" ? byKey.get(o.src) : undefined;
    if (!a || a.kind !== "video") throw new EditValidationError("A segment refers to an unknown video.");
    const dur = a.durationSec ?? 0;
    const inn = r3(n(o.in, 0, dur, 0));
    const out = r3(n(o.out, 0, dur, dur));
    if (out - inn < 0.2) throw new EditValidationError("Every segment must be at least 0.2 s long.");
    segments.push({ id: typeof o.id === "string" && ID.test(o.id) ? o.id : newId(), src: a.key, in: inn, out, volume: r3(n(o.volume, 0, 2, 1)) });
  }
  if (!segments.length) throw new EditValidationError("Keep at least one segment.");
  const transition = r.transition === "fade" ? "fade" : "none";
  const total = outputDuration({ transition, segments });
  const sub = r.subtitles && typeof r.subtitles === "object" ? (r.subtitles as Record<string, unknown>) : {};
  const cues: EditCue[] = (Array.isArray(sub.cues) ? sub.cues.slice(0, LIMITS.cues) : [])
    .map((x) => {
      const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
      const start = r3(n(o.start, 0, primary.durationSec ?? 0, 0));
      const end = r3(n(o.end, start, primary.durationSec ?? 0, start));
      return { id: typeof o.id === "string" && ID.test(o.id) ? o.id : newId(), start, end, text: s(o.text, LIMITS.text) };
    })
    .filter((c) => c.text && c.end - c.start >= 0.2)
    .sort((a, b) => a.start - b.start);
  const overlays: EditOverlay[] = [];
  for (const x of Array.isArray(r.overlays) ? r.overlays.slice(0, LIMITS.overlays) : []) {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const kind = OVERLAY_KINDS.find((k) => k === o.kind);
    if (!kind) continue;
    const start = r3(n(o.start, 0, total, 0));
    const end = r3(n(o.end, start, total, Math.min(total, start + 3)));
    if (end - start < 0.2) continue;
    const ov: EditOverlay = { id: typeof o.id === "string" && ID.test(o.id) ? o.id : newId(), kind, start, end };
    if (kind === "text") {
      ov.text = s(o.text, LIMITS.text);
      ov.subtext = s(o.subtext, LIMITS.text) || undefined;
      ov.style = TEXT_STYLES.find((t) => t === o.style) ?? "title";
      ov.position = POSITIONS.find((p) => p === o.position) ?? "top";
      if (!ov.text) continue;
    } else if (kind === "diagram") {
      ov.text = s(o.text, 90) || undefined;
      ov.nodes = (Array.isArray(o.nodes) ? o.nodes : []).map((v) => s(v, 48)).filter(Boolean).slice(0, 6);
      ov.position = POSITIONS.find((p) => p === o.position) ?? "center";
      if (ov.nodes.length < 2) continue;
    } else {
      const a = typeof o.assetKey === "string" && KEY.test(o.assetKey) ? byKey.get(o.assetKey) : undefined;
      const want = kind === "image" ? ["image"] : kind === "pip" ? ["video", "image"] : ["video", "image"];
      if (!a || !want.includes(a.kind)) throw new EditValidationError(`An ${kind} overlay refers to an unknown file.`);
      ov.assetKey = a.key;
      if (kind === "broll") Object.assign(ov, { x: 0, y: 0, w: 1, h: 1 });
      else {
        const w = r3(n(o.w, 0.1, 1, kind === "pip" ? 0.32 : 0.5));
        const h = r3(n(o.h, 0.1, 1, kind === "pip" ? 0.24 : 0.3));
        Object.assign(ov, { w, h, x: r3(n(o.x, 0, 1 - w, 0.62)), y: r3(n(o.y, 0, 1 - h, 0.06)) });
      }
      if (a.kind === "video") ov.srcIn = r3(n(o.srcIn, 0, a.durationSec ?? 0, 0));
    }
    overlays.push(ov);
  }
  const sfx: EditSfx[] = [];
  for (const x of Array.isArray(r.sfx) ? r.sfx.slice(0, LIMITS.sfx) : []) {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const sound = typeof o.key === "string" ? SFX_MAP[o.key] : undefined;
    if (!sound) throw new EditValidationError("A sound effect refers to an unknown sound.");
    const trimIn = r3(n(o.trimIn, 0, sound.durationSec - 0.05, 0));
    const trimOut = r3(n(o.trimOut, trimIn + 0.05, sound.durationSec, sound.durationSec));
    const len = trimOut - trimIn;
    const a = o.anchor && typeof o.anchor === "object" ? (o.anchor as Record<string, unknown>) : null;
    const anchor: EditSfx["anchor"] = a && (a.kind === "cut" || a.kind === "overlay") && typeof a.id === "string" && ID.test(a.id) ? { kind: a.kind, id: a.id } : null;
    sfx.push({
      id: typeof o.id === "string" && ID.test(o.id) ? o.id : newId(),
      key: sound.key,
      start: r3(n(o.start, 0, Math.max(0, total - 0.05), 0)),
      anchor,
      offsetSec: r3(n(o.offsetSec, -5, 5, 0)),
      trimIn,
      trimOut,
      volume: r3(n(o.volume, 0, 1.5, 1)),
      fadeInSec: r3(n(o.fadeInSec, 0, len / 2, 0)),
      fadeOutSec: r3(n(o.fadeOutSec, 0, len / 2, 0)),
    });
  }
  const au = r.audio && typeof r.audio === "object" ? (r.audio as Record<string, unknown>) : {};
  const music = typeof au.musicKey === "string" ? byKey.get(au.musicKey) : undefined;
  if (au.musicKey && (!music || music.kind !== "music")) throw new EditValidationError("Unknown music file.");
  return {
    version: 1,
    primary: primary.key,
    aspect,
    fit,
    segments,
    transition,
    subtitles: { on: sub.on !== false, style: SUB_STYLES.find((x) => x === sub.style) ?? "boxed", cues },
    overlays,
    audio: {
      volume: r3(n(au.volume, 0, 2, 1)),
      fadeInSec: r3(n(au.fadeInSec, 0, 5, 0)),
      fadeOutSec: r3(n(au.fadeOutSec, 0, 5, 0)),
      clean: au.clean === true,
      musicKey: music?.key ?? null,
      musicVolumePct: Math.round(n(au.musicVolumePct, 0, 60, 12)),
    },
    sfx,
    branding: r.branding !== false,
    designKey: typeof r.designKey === "string" && /^[a-z_]{2,40}$/.test(r.designKey) ? r.designKey : "minimal_professional",
  };
}

/** Output time of a timeline event a sound effect can follow (null when the event no longer exists). */
export function anchorTime(p: Pick<EditProject, "transition" | "segments" | "overlays">, anchor: EditSfx["anchor"]): number | null {
  if (!anchor) return null;
  if (anchor.kind === "cut") {
    const i = p.segments.findIndex((x) => x.id === anchor.id);
    return i < 0 ? null : segmentOffsets(p)[i];
  }
  const ov = p.overlays.find((x) => x.id === anchor.id);
  return ov ? ov.start : null;
}

export interface ResolvedSfx {
  id: string;
  key: string;
  file: string;
  /** Output second the clip starts (after anchoring and clamping). */
  start: number;
  /** Seconds of the clip that play (trimmed, and cut at the end of the video). */
  duration: number;
  trimIn: number;
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** The anchored event was deleted, so the stored start is used. */
  orphaned: boolean;
}

/** Sound effects on the output timeline, sorted; clips that would start after the video ends are dropped. */
export function sfxTimeline(p: EditProject): ResolvedSfx[] {
  const total = outputDuration(p);
  const out: ResolvedSfx[] = [];
  for (const c of p.sfx ?? []) {
    const sound = SFX_MAP[c.key];
    if (!sound) continue;
    const at = anchorTime(p, c.anchor);
    const start = r3(Math.max(0, at === null ? c.start : at + c.offsetSec));
    const duration = r3(Math.min(c.trimOut - c.trimIn, total - start));
    if (duration < 0.05) continue;
    out.push({ id: c.id, key: c.key, file: sound.file, start, duration, trimIn: c.trimIn, volume: c.volume, fadeInSec: Math.min(c.fadeInSec, duration / 2), fadeOutSec: Math.min(c.fadeOutSec, duration / 2), orphaned: c.anchor !== null && at === null });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The export task's `sfx` list (render.mjs doEdit): files under the container's read-only /sfx mount. */
export function sfxRenderList(p: EditProject): { file: string; start: number; duration: number; trimIn: number; volume: number; fadeInSec: number; fadeOutSec: number }[] {
  return sfxTimeline(p).map((c) => ({ file: c.file, start: c.start, duration: c.duration, trimIn: c.trimIn, volume: c.volume, fadeInSec: c.fadeInSec, fadeOutSec: c.fadeOutSec }));
}

export interface AudioCheck {
  code: string;
  severity: "warn" | "info";
  message: string;
}

/**
 * Pre-render audio checks for the sound effects (pure; the measured loudness of the export is reported
 * after rendering). The export always ends in a limiter, so these warn about audible squashing, never
 * about digital clipping in the file.
 */
export function sfxChecks(p: EditProject): AudioCheck[] {
  const out: AudioCheck[] = [];
  const total = outputDuration(p);
  const list = sfxTimeline(p);
  const dropped = (p.sfx ?? []).length - list.length;
  if (dropped > 0) out.push({ code: "SFX_AFTER_END", severity: "warn", message: `${dropped} sound effect(s) start after the video ends and will not play.` });
  for (const c of list) {
    const sound = SFX_MAP[c.key];
    if (c.orphaned) out.push({ code: `SFX_ORPHANED:${c.id}`, severity: "warn", message: `"${sound.label}" was attached to a cut or overlay that no longer exists; it now plays at ${c.start.toFixed(2)} s.` });
    if (c.start + c.duration > total - 0.01 && c.duration < (SFX_MAP[c.key].durationSec - c.trimIn) - 0.05) out.push({ code: `SFX_CUT_OFF:${c.id}`, severity: "info", message: `"${sound.label}" is cut off by the end of the video.` });
  }
  // Worst-case peak where clips overlap: their peaks add (linear), on top of the voice track's level.
  const peakLin = (c: ResolvedSfx) => 10 ** (SFX_MAP[c.key].peakDbfs / 20) * c.volume;
  let worst = 0;
  let worstAt = 0;
  for (const c of list) {
    const t = c.start + Math.min(c.duration, SFX_MAP[c.key].peakAtSec);
    const sum = list.filter((o) => o.start <= t && t < o.start + o.duration).reduce((a, o) => a + peakLin(o), 0);
    if (sum > worst) [worst, worstAt] = [sum, t];
  }
  const voice = Math.min(1, 0.9 * p.audio.volume);
  if (worst + voice > 1.4) {
    out.push({ code: "SFX_LOUD", severity: "warn", message: `Around ${worstAt.toFixed(1)} s, overlapping sound effects plus the voice could peak at ${(20 * Math.log10(worst + voice)).toFixed(1)} dBFS — the limiter will squash it. Lower their volume or move one.` });
  }
  if (list.length > Math.max(6, total / 2)) out.push({ code: "SFX_DENSE", severity: "info", message: `${list.length} sound effects in ${total.toFixed(0)} s — fewer usually sounds more professional.` });
  return out;
}
