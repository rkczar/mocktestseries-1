import { SLIDE_HEIGHT, SLIDE_WIDTH, type PostContent, type PostDesign, type SlideModule, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Deterministic text fitting for the 1080 × 1350 slides. Satori wraps text but
 * cannot report overflow, so sizes are chosen here from a conservative
 * width estimate (Geist average glyph width) — the renderer and the quality
 * gate share these numbers, so "fits" in the gate means fits on the slide.
 * When even the minimum size overflows, the slide is reported as too long
 * (a blocking quality issue) instead of shrinking text below phone legibility.
 */

export const GEOMETRY = {
  padX: 72,
  padTop: 60,
  padBottom: 52,
  headerHeight: 168,
  headerGap: 36,
  footerHeight: 40,
  footerGap: 28,
  get contentWidth() {
    return SLIDE_WIDTH - 2 * this.padX;
  },
  get bodyHeight() {
    return SLIDE_HEIGHT - this.padTop - this.headerHeight - this.headerGap - this.footerGap - this.footerHeight - this.padBottom;
  },
};

const LINE = 1.28;
/** Average advance width as a fraction of font size (slightly generous so estimates err toward wrapping). */
const FACTOR = { bold: 0.56, medium: 0.53 } as const;

export function plainText(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

/** Greedy word-wrap estimate: number of lines `text` takes at `size` in `width`. */
export function estimateLines(text: string, size: number, width: number, weight: keyof typeof FACTOR = "medium"): number {
  const t = plainText(text);
  if (!t) return 0;
  const charW = size * FACTOR[weight];
  const maxChars = Math.max(1, Math.floor(width / charW));
  let lines = 1;
  let used = 0;
  for (const word of t.split(" ")) {
    const w = word.length;
    if (w > maxChars) {
      // A single over-long token starts a fresh line and wraps by force.
      if (used > 0) lines++;
      const span = Math.ceil(w / maxChars);
      lines += span - 1;
      used = w - (span - 1) * maxChars;
      continue;
    }
    const need = used === 0 ? w : used + 1 + w;
    if (need <= maxChars) used = need;
    else {
      lines++;
      used = w;
    }
  }
  return lines;
}

export function textHeight(text: string, size: number, width: number, weight: keyof typeof FACTOR = "medium"): number {
  return estimateLines(text, size, width, weight) * size * LINE;
}

export interface FitResult {
  size: number;
  overflow: boolean;
}

/** Largest size in [min, max] (step 2) for which `heightAt(size)` ≤ available. */
function fit(max: number, min: number, available: number, heightAt: (size: number) => number): FitResult {
  for (let s = Math.round(max); s >= min; s -= 2) {
    if (heightAt(s) <= available) return { size: s, overflow: false };
  }
  return { size: min, overflow: heightAt(min) > available };
}

// ---- Question slide -------------------------------------------------------

export const OPTION = { padY: 22, padX: 28, bubble: 56, gap: 22, between: 16 };

export interface QuestionLayout {
  headline: string | null;
  headlineSize: number;
  stemSize: number;
  optionSize: number;
  overflow: boolean;
}

export function questionLayout(snapshot: SourceSnapshot, headline: string | null, scale: number): QuestionLayout {
  const W = GEOMETRY.contentWidth;
  const optW = W - 2 * OPTION.padX - OPTION.bubble - OPTION.gap;
  const headlineSize = 38;
  const headlineH = headline ? textHeight(headline, headlineSize, W, "bold") + 28 : 0;
  const heightAt = (s: number) => {
    const o = Math.max(26, Math.round(s * 0.8));
    const stem = textHeight(snapshot.text, s, W, "bold");
    const opts = snapshot.options.reduce((h, opt) => h + Math.max(OPTION.bubble, textHeight(opt.text || " ", o, optW)) + 2 * OPTION.padY + OPTION.between, 0);
    return headlineH + stem + 36 + opts;
  };
  const r = fit(Math.round(54 * scale), 30, GEOMETRY.bodyHeight, heightAt);
  return { headline, headlineSize, stemSize: r.size, optionSize: Math.max(26, Math.round(r.size * 0.8)), overflow: r.overflow };
}

// ---- Answer slide -----------------------------------------------------------

export interface AnswerLayout {
  answerSize: number;
  noteSize: number;
  showNote: boolean;
  overflow: boolean;
}

export function answerLayout(snapshot: SourceSnapshot, note: string, showNote: boolean, scale: number): AnswerLayout {
  const W = GEOMETRY.contentWidth;
  const correct = snapshot.options.filter((o) => o.isCorrect);
  const cardInner = W - 2 * 44 - OPTION.bubble - OPTION.gap;
  const heightAt = (s: number) => {
    const n = Math.max(28, Math.round(s * 0.72));
    const cards = correct.reduce((h, o) => h + Math.max(OPTION.bubble, textHeight(o.text, s, cardInner, "bold")) + 2 * 40 + 16, 0);
    const label = 30 + 24;
    const noteH = showNote && note ? 40 + 30 + 18 + textHeight(note, n, W) : 0;
    return label + cards + noteH;
  };
  const r = fit(Math.round(50 * scale), 30, GEOMETRY.bodyHeight, heightAt);
  return { answerSize: r.size, noteSize: Math.max(28, Math.round(r.size * 0.72)), showNote: showNote && Boolean(note), overflow: r.overflow };
}

// ---- Text slides (explanation, trick, pearl, revision) --------------------

export interface TextBlock {
  label: string;
  text: string;
  bullets?: string[];
  tone: "plain" | "highlight" | "accent";
}

export interface TextLayout {
  size: number;
  overflow: boolean;
}

export const TEXT_CARD = { pad: 40, labelH: 30, labelGap: 18, between: 28 };

export function textSlideLayout(blocks: TextBlock[], scale: number): TextLayout {
  const visible = blocks.filter((b) => b.text || b.bullets?.length);
  const inner = GEOMETRY.contentWidth - 2 * TEXT_CARD.pad;
  const heightAt = (s: number) =>
    visible.reduce((h, b) => {
      const body = b.bullets?.length
        ? b.bullets.reduce((bh, item) => bh + textHeight(item, s, inner - 40) + 14, 0)
        : textHeight(b.text, s, inner);
      return h + 2 * TEXT_CARD.pad + TEXT_CARD.labelH + TEXT_CARD.labelGap + body + TEXT_CARD.between;
    }, 0);
  return fit(Math.round(42 * scale), 28, GEOMETRY.bodyHeight, heightAt);
}

// ---- Hook slide ------------------------------------------------------------

export interface HookLayout {
  size: number;
  overflow: boolean;
}

export function hookLayout(hook: string, extraLines: number, scale: number): HookLayout {
  const W = GEOMETRY.contentWidth;
  const reserved = 60 + extraLines * 120;
  return fit(Math.round(84 * scale), 48, GEOMETRY.bodyHeight - reserved, (s) => textHeight(hook || " ", s, W, "bold"));
}

// ---- Per-slide plan (shared by renderer + quality gate) ---------------------

export interface SlidePlan {
  module: SlideModule;
  overflow: boolean;
  /** Required content missing for this slide ("Memory Trick is empty"). */
  missing: string[];
}

/** Blocks for the text-type modules. */
export function textBlocksFor(module: SlideModule, c: PostContent): TextBlock[] {
  switch (module) {
    case "EXPLANATION":
      return [{ label: "EXPLANATION", text: c.explanation, tone: "plain" }];
    case "EXPLANATION_TRICK":
      return [
        { label: "EXPLANATION", text: c.explanation, tone: "plain" },
        { label: "MEMORY TRICK", text: c.memoryTrick, tone: "highlight" },
      ];
    case "MEMORY_TRICK":
      return [
        { label: "MEMORY TRICK", text: c.memoryTrick, tone: "highlight" },
        { label: "CLINICAL PEARL", text: c.clinicalPearl, tone: "accent" },
      ];
    case "PEARL_REVISION":
      return [
        { label: "CLINICAL PEARL", text: c.clinicalPearl, tone: "accent" },
        { label: "QUICK REVISION", text: "", bullets: c.quickRevision.filter(Boolean), tone: "plain" },
      ];
    default:
      return [];
  }
}

/** The hook line shown as a headline on the Question slide when the carousel has no Hook slide. */
export function questionHeadline(design: PostDesign, c: PostContent): string | null {
  return design.modules.includes("HOOK") ? null : c.hookText.trim() || null;
}

/** Answer slide carries the explanation itself when no explanation slide exists. */
export function answerCarriesExplanation(design: PostDesign): boolean {
  return !design.modules.some((m) => m === "EXPLANATION" || m === "EXPLANATION_TRICK");
}

export function planSlides(snapshot: SourceSnapshot, content: PostContent, design: PostDesign, hookExtraLines = 1): SlidePlan[] {
  return design.modules.map((module) => {
    const missing: string[] = [];
    let overflow = false;
    switch (module) {
      case "HOOK":
        if (!content.hookText.trim()) missing.push("Hook text");
        overflow = hookLayout(content.hookText, hookExtraLines, design.bodyScale).overflow;
        break;
      case "QUESTION":
        overflow = questionLayout(snapshot, questionHeadline(design, content), design.questionScale).overflow;
        break;
      case "ANSWER": {
        const carries = answerCarriesExplanation(design);
        if (carries && !content.explanation.trim()) missing.push("Explanation");
        overflow = answerLayout(snapshot, content.explanation, carries, design.bodyScale).overflow;
        break;
      }
      case "FOLLOW":
        break;
      default: {
        const blocks = textBlocksFor(module, content);
        for (const b of blocks) if (!b.text.trim() && !(b.bullets && b.bullets.length)) missing.push(b.label.charAt(0) + b.label.slice(1).toLowerCase());
        overflow = textSlideLayout(blocks, design.bodyScale).overflow;
      }
    }
    return { module, overflow, missing };
  });
}
