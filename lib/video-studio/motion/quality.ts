import { graphemeCount, words as wordTokens } from "@/lib/video-studio/text";
import { MOTION_STYLE_MAP, contrastRatio } from "@/lib/video-studio/motion/styles";
import { MOTION_LIMITS, type MotionConfig, type MotionFrameDraft, type MotionTiming } from "@/lib/video-studio/motion/storyboard";

/**
 * Motion Workflow Studio — quality checks (client-safe, pure). They run free,
 * on every change, BEFORE anything paid, and once more on the rendered video.
 * They turn the reference's "check it like a stranger" list into rules a
 * machine can test: one idea per frame, the highlighted word really occurs,
 * no two frames look alike, every word appears no later than it is spoken,
 * text fits the safe zone, enough reading time, contrast, the CTA comes last,
 * the stored answer is the only one revealed.
 */

export type QaStatus = "pass" | "warn" | "fail";
export interface QaCheck {
  key: string;
  label: string;
  status: QaStatus;
  detail: string;
  frames?: number[];
}

const norm = (w: string) => w.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");

export function storyboardChecks(cfg: Pick<MotionConfig, "styleKey" | "targetSec" | "language" | "aspect">, frames: MotionFrameDraft[], timing: MotionTiming | null, unsupported: (text: string) => string[] = () => []): QaCheck[] {
  const out: QaCheck[] = [];
  const style = MOTION_STYLE_MAP[cfg.styleKey];
  const add = (key: string, label: string, bad: number[], status: QaStatus, ok: string, problem: string) =>
    out.push({ key, label, status: bad.length ? status : "pass", detail: bad.length ? `${problem} Frame${bad.length > 1 ? "s" : ""} ${bad.map((i) => i + 1).join(", ")}.` : ok, ...(bad.length ? { frames: bad } : {}) });

  out.push(style ? { key: "style_lock", label: "One style for the whole video", status: "pass", detail: `Every frame uses ${style.name}.` } : { key: "style_lock", label: "One style for the whole video", status: "fail", detail: "Unknown style." });
  const n = frames.length;
  out.push({ key: "frame_count", label: "Frame count", status: n >= MOTION_LIMITS.minFrames && n <= MOTION_LIMITS.maxFrames ? "pass" : n < 3 ? "fail" : "warn", detail: `${n} frames (${MOTION_LIMITS.minFrames}–${MOTION_LIMITS.maxFrames} recommended).` });

  const firstWords = n ? wordTokens(frames[0].sentence).length : 0;
  out.push({ key: "hook", label: "Opening frame is a hook", status: !n ? "fail" : firstWords <= 16 ? "pass" : "warn", detail: n ? `Frame 1 is ${firstWords} words${firstWords > 16 ? " — a hook should land in about 3 seconds (≤ 16 words)." : "."}` : "No frames." });

  add("one_idea", "One idea per frame", frames.flatMap((f, i) => (wordTokens(f.onScreen).length > MOTION_LIMITS.onScreenWords || wordTokens(f.sentence).length > MOTION_LIMITS.sentenceWords ? [i] : [])), "warn", "Every frame has one short sentence and at most 8 on-screen words.", "Too much on one frame — split it into two frames.");
  add(
    "highlight",
    "Highlighted word occurs in the frame",
    frames.flatMap((f, i) => {
      const h = norm(f.visual.highlight);
      return !h || ![...wordTokens(f.onScreen), ...wordTokens(f.sentence)].some((w) => norm(w) === h) ? [i] : [];
    }),
    "warn",
    "Every frame highlights a word that is shown or spoken.",
    "The highlighted word is not in the frame."
  );
  add(
    "variety",
    "Consecutive frames look different",
    frames.flatMap((f, i) => (i > 0 && f.visual.type === frames[i - 1].visual.type && f.visual.motion === frames[i - 1].visual.motion && f.visual.type !== "statement" ? [i] : i > 1 && f.visual.motion === frames[i - 1].visual.motion && f.visual.motion === frames[i - 2].visual.motion ? [i] : [])),
    "warn",
    "No two frames in a row share the same layout and motion.",
    "Looks like the previous frame — change its visual or motion."
  );
  add("motion_allowed", "Motions belong to the style", frames.flatMap((f, i) => (style && !style.motions.includes(f.visual.motion) ? [i] : [])), "fail", "Every motion is part of the style's motion set.", "Motion outside the style.");
  add("safe_zone", "Text fits the safe zone", frames.flatMap((f, i) => (graphemeCount(f.onScreen) > MOTION_LIMITS.onScreenGraphemes || (f.visual.items ?? []).some((x) => graphemeCount(x) > 42) || (f.visual.nodes ?? []).some((x) => graphemeCount(x) > 36) ? [i] : [])), "warn", `On-screen text stays short enough for the ${cfg.aspect} safe zone.`, "Text is long for the safe zone — shorten it.");
  add("glyphs", "Every character can be drawn", frames.flatMap((f, i) => (unsupported(`${f.sentence} ${f.onScreen} ${(f.visual.items ?? []).join(" ")} ${(f.visual.nodes ?? []).join(" ")}`).length ? [i] : [])), "fail", "All characters are covered by the bundled fonts (Devanagari included).", "Contains characters the video fonts cannot draw (emoji or rare symbols).");
  add("questions", "Questions reveal only the stored answer", frames.flatMap((f, i) => (f.visual.type === "question" && (!f.visual.questionId || (f.visual.revealAtSec && !f.visual.correctLabel)) ? [i] : [])), "fail", "Question frames come from the Question Bank and reveal only its stored answer.", "A question frame is not from the Question Bank.");
  add("review", "Fact-check flags resolved", frames.flatMap((f, i) => (f.needsReview ? [i] : [])), "warn", "No frame is waiting for a medical review.", "Flagged for review — check the claim and mark it reviewed.");
  out.push({ key: "cta", label: "Last frame tells the viewer what to do", status: n && frames[n - 1].visual.type === "cta" ? "pass" : "warn", detail: n && frames[n - 1].visual.type === "cta" ? "The last frame is the call to action." : "Make the last frame the call to action." });

  if (style) {
    const c = contrastRatio(style.palette.text, style.palette.background);
    out.push({ key: "contrast", label: "Readable on a phone (contrast)", status: c === null || c >= 4.5 ? "pass" : "fail", detail: c === null ? "Style colours are not plain hex — not measured." : `Text / background contrast ${c}:1 (≥ 4.5:1 needed).` });
  }

  const total = timing?.totalSec ?? frames.reduce((a, f) => a + f.durationSec, 0);
  out.push({ key: "length", label: "Length close to the target", status: Math.abs(total - cfg.targetSec) <= Math.max(8, cfg.targetSec * 0.35) ? "pass" : "warn", detail: `${total.toFixed(1)} s for a ${cfg.targetSec} s target.` });
  if (timing) {
    const fr = timing.frames;
    add(
      "reading_time",
      "Enough time to read each frame",
      fr.flatMap((t, i) => (frames[i] && t.end - t.start < Math.max(1.4, wordTokens(frames[i].onScreen).length * 0.28 + 0.8) ? [i] : [])),
      "warn",
      "Every frame stays on screen long enough to read.",
      "On screen too briefly to read."
    );
    add("question_time", "Question frames last long enough", fr.flatMap((t, i) => (frames[i]?.visual.type === "question" && t.end - t.start < 4.5 ? [i] : [])), "warn", "Question frames stay at least 4.5 s, long enough to read the options and see the stored answer.", "A question frame is short — lengthen its spoken sentence so students can read the options.");
    // A word must never appear after it is spoken: captions start at the spoken time by construction; check the times are inside their frame and in order.
    const late = new Set<number>();
    let prev = -1;
    for (const w of timing.words) {
      const f = fr[w.frame];
      if (!f || w.start < prev - 1e-3 || w.start < f.start - 0.15 || w.start > f.end + 0.05) late.add(w.frame);
      prev = w.start;
    }
    add("sync", "Words appear when they are spoken", [...late].sort((a, b) => a - b), "warn", timing.mode === "precise" ? "Every word appears at its transcribed time." : timing.mode === "estimated" ? "Words follow an estimate spread over the measured narration (precise sync needs the paid transcription)." : "No narration — words follow reading speed.", "Word times fall outside their frame.");
    out.push({ key: "sync_mode", label: "Sync source", status: timing.mode === "precise" || timing.mode === "reading" ? "pass" : "warn", detail: timing.mode === "precise" ? "Word timestamps from transcribing the narration." : timing.mode === "estimated" ? "Estimated from the narration length — close, not exact." : "Silent video: reading-speed timing." });
  }
  return out;
}

/** Checks on the rendered MP4 (from the render container's validated probe). */
export function renderChecks(r: { width: number; height: number; durationSec: number; hasAudio: boolean }, want: { width: number; height: number; durationSec: number; audio: boolean }): QaCheck[] {
  return [
    { key: "out_size", label: "Output size", status: r.width === want.width && r.height === want.height ? "pass" : "fail", detail: `${r.width}×${r.height} (expected ${want.width}×${want.height}).` },
    { key: "out_duration", label: "Output length matches the plan", status: Math.abs(r.durationSec - want.durationSec) <= Math.max(0.6, want.durationSec * 0.02) ? "pass" : "fail", detail: `${r.durationSec.toFixed(2)} s (planned ${want.durationSec.toFixed(2)} s).` },
    { key: "out_audio", label: "Audio track", status: !want.audio || r.hasAudio ? "pass" : "fail", detail: want.audio ? (r.hasAudio ? "Narration is in the MP4." : "Narration missing from the MP4.") : "Silent video (no narration)." },
  ];
}

export function qaSummary(checks: QaCheck[]): { fail: number; warn: number; pass: number } {
  return { fail: checks.filter((c) => c.status === "fail").length, warn: checks.filter((c) => c.status === "warn").length, pass: checks.filter((c) => c.status === "pass").length };
}
