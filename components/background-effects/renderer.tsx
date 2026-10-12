import type { CSSProperties } from "react";
import {
  BG_DOT_SIZE_PX,
  BG_GALAXY_MOBILE_MAX,
  BG_WORDMARK,
  hexToRgba,
  mixHex,
  resolveDotColors,
  resolveGlowColors,
  type BackgroundEffectsConfig,
  type BgDesignSettings,
  type BgPosition,
  type BgSize,
  type BgSpread,
} from "@/lib/background-effects";
import { GalaxyLoader } from "./galaxy-loader";

/**
 * The ONE renderer for Background Effects — used by the site layer
 * (components/background-effects/layer.tsx) and by the Admin live preview,
 * so the preview is the real thing, not a second implementation.
 *
 * Static designs are pure CSS: a radial-gradient dot grid, masked by an
 * inline SVG of the wordmark so the letters themselves are made of dots
 * (one element, no per-dot DOM, no image download, no JavaScript). Glows
 * are layered gradients / a pre-blurred SVG mask — no full-screen CSS blur
 * filter. Only Galaxy with its animation ON loads JavaScript, through a
 * dynamic import.
 *
 * Every value reaching a style comes from a validated config
 * (lib/background-effects.ts): enums, clamped numbers and #RRGGBB colors.
 */

// Static rules, emitted only while a background is rendered (never on a page
// with effects OFF). Theme: the `.t` layers carry a dark (--d) and a light
// (--l) background; Automatic follows the site's Day/Night toggle. Eye-Saver
// is an accessibility mode, so the site layer hides itself there.
export const BGFX_CSS = [
  ".bgfx{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;contain:strict;container-type:size;user-select:none}",
  ".bgfx[data-preview]{position:absolute}",
  ".bgfx>div,.bgfx>canvas{position:absolute;inset:0}",
  ".bgfx .t{background-image:var(--d)}",
  ':root[data-theme="light"] .bgfx[data-mode="auto"] .t,.bgfx[data-mode="light"] .t{background-image:var(--l)}',
  ".bgfx .s{display:none}",
  "@container (max-width:640px){.bgfx .w{display:none}.bgfx .s{display:block}}",
  ".bgfx .b{animation:bgfx-breathe 8s ease-in-out infinite}",
  "@keyframes bgfx-breathe{0%,100%{opacity:1}50%{opacity:.55}}",
  ".bgfx .gx-fb{display:none}",
  "@media (prefers-reduced-motion:reduce){.bgfx .b{animation:none}.bgfx .gx-fb{display:block}}",
  ':root[data-theme="eyesaver"] .bgfx:not([data-preview]){display:none}',
].join("");

// --- Wordmark masks --------------------------------------------------------
// One line on wide screens, two lines below 640px (container query) so the
// dotted letters stay readable on a phone. textLength pins the width, so the
// layout is identical whatever sans-serif font the device has.
const FONT = "'Arial Black','Helvetica Neue',Arial,Helvetica,sans-serif";
const WIDE = { w: 1100, h: 230 };
const STACK = { w: 700, h: 400 };

function wordmarkSvg(layout: "wide" | "stack", blur = 0, stroke = 0): string {
  const filter = blur ? `<filter id="b" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="${blur}"/></filter>` : "";
  const attrs = `font-family="${FONT}" font-weight="900" fill="#fff"${stroke ? ` stroke="#fff" stroke-width="${stroke}" stroke-linejoin="round"` : ""}${blur ? ' filter="url(#b)"' : ""} text-anchor="middle" lengthAdjust="spacingAndGlyphs"`;
  const body =
    layout === "wide"
      ? `<text x="550" y="158" font-size="132" textLength="980" ${attrs}>${BG_WORDMARK}</text>`
      : `<text x="350" y="178" font-size="150" textLength="600" ${attrs}>MockTest</text><text x="350" y="345" font-size="150" textLength="600" ${attrs}>Series.in</text>`;
  const box = layout === "wide" ? WIDE : STACK;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box.w} ${box.h}">${filter}${body}</svg>`;
}
const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

const WM_WIDTH: Record<"wide" | "stack", Record<BgSize, string>> = {
  wide: { SMALL: "min(56%,900px)", MEDIUM: "min(78%,1250px)", LARGE: "min(100%,1600px)" },
  stack: { SMALL: "70%", MEDIUM: "85%", LARGE: "100%" },
};
const WM_POS: Record<BgPosition, string> = { CENTER: "50% 50%", TOP: "50% 12%", BOTTOM: "50% 88%" };
const WM_Y: Record<BgPosition, number> = { CENTER: 50, TOP: 18, BOTTOM: 82 };
const NEON_BLUR: Record<BgSpread, number> = { LOW: 4, MEDIUM: 8, HIGH: 14 };
const NEON_STROKE: Record<BgSpread, number> = { LOW: 2, MEDIUM: 5, HIGH: 9 };
const SPREAD_SCALE: Record<BgSpread, number> = { LOW: 0.7, MEDIUM: 1, HIGH: 1.4 };

function maskStyle(image: string, size: string, position: string, extra?: CSSProperties): CSSProperties {
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskSize: `${size} auto`,
    WebkitMaskSize: `${size} auto`,
    maskPosition: position,
    WebkitMaskPosition: position,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    ...extra,
  };
}

type Vars = CSSProperties & Record<`--${string}`, string>;

function dotGrid(color: string, s: BgDesignSettings): string {
  const r = BG_DOT_SIZE_PX[s.dotSize] / 2;
  return `radial-gradient(circle at center,${color} 0,${color} ${r}px,transparent ${r + 0.75}px)`;
}

/** Dark/light dot backgrounds for a `.t` element. */
function dotVars(s: BgDesignSettings): Vars {
  const c = resolveDotColors(s);
  return { "--d": dotGrid(c.dark, s), "--l": dotGrid(c.light, s), backgroundSize: `${s.dotSpacing}px ${s.dotSpacing}px`, backgroundPosition: "center" };
}

/** Same gradient recipe for both themes; light gets a softer alpha. */
function themedGradient(s: BgDesignSettings, build: (color: string, alpha: number) => string, alpha: number): Vars {
  const g = resolveGlowColors(s);
  return { "--d": build(g.dark, alpha), "--l": build(g.light, alpha * 0.7) };
}

/**
 * The dotted wordmark (wide + stacked) — Designs 1, 3 (static) and 4.
 * `dense`: Design 4 lays the wordmark over a sparse dot field; on that same
 * grid the letters would dissolve into the pattern, so the wordmark gets its
 * own finer grid (at most 8px apart, 2px dots).
 */
function Watermark({ s: base, opacityScale = 1, dense = false }: { s: BgDesignSettings; opacityScale?: number; dense?: boolean }) {
  const s: BgDesignSettings = dense ? { ...base, dotSpacing: Math.min(base.dotSpacing, 8), dotSize: base.dotSize === "LARGE" ? "LARGE" : "MEDIUM" } : base;
  const opacity = (s.opacity / 100) * opacityScale;
  return (
    <>
      <div className="t w" data-bgfx-layer="watermark" style={{ ...dotVars(s), opacity, ...maskStyle(svgUrl(wordmarkSvg("wide")), WM_WIDTH.wide[s.watermarkScale], WM_POS[s.watermarkPosition]) }} />
      <div className="t s" data-bgfx-layer="watermark" style={{ ...dotVars(s), opacity, ...maskStyle(svgUrl(wordmarkSvg("stack")), WM_WIDTH.stack[s.watermarkScale], WM_POS[s.watermarkPosition]) }} />
    </>
  );
}

/** Soft Neon (Design 1, and Galaxy's static glow): a halo + a pre-blurred letter glow. */
function NeonGlow({ s, haloOnly = false }: { s: BgDesignSettings; haloOnly?: boolean }) {
  const i = s.glowIntensity / 100;
  const k = SPREAD_SCALE[s.glowSpread];
  const y = WM_Y[s.watermarkPosition];
  const breathe = s.glowAnimation ? " b" : "";
  const halo = themedGradient(s, (c, a) => `radial-gradient(ellipse ${Math.round(55 * k)}% ${Math.round(30 * k)}% at 50% ${y}%,${hexToRgba(c, a)},transparent 70%)`, i * 0.2);
  const glow = resolveGlowColors(s);
  const neon = (layout: "wide" | "stack"): CSSProperties =>
    maskStyle(svgUrl(wordmarkSvg(layout, NEON_BLUR[s.glowSpread], NEON_STROKE[s.glowSpread])), WM_WIDTH[layout][s.watermarkScale], WM_POS[s.watermarkPosition]);
  const neonVars: Vars = { "--d": `linear-gradient(${hexToRgba(glow.dark, i * 0.35)},${hexToRgba(glow.dark, i * 0.35)})`, "--l": `linear-gradient(${hexToRgba(glow.light, i * 0.25)},${hexToRgba(glow.light, i * 0.25)})` };
  return (
    <>
      <div className={`t${breathe}`} data-bgfx-layer="glow" style={halo} />
      {haloOnly ? null : (
        <>
          <div className={`t w${breathe}`} data-bgfx-layer="glow" style={{ ...neonVars, ...neon("wide") }} />
          <div className={`t s${breathe}`} data-bgfx-layer="glow" style={{ ...neonVars, ...neon("stack") }} />
        </>
      )}
    </>
  );
}

function DottedWatermark({ s }: { s: BgDesignSettings }) {
  return (
    <>
      {s.glowEnabled ? <NeonGlow s={s} /> : null}
      <Watermark s={s} />
    </>
  );
}

function DottedPattern({ s }: { s: BgDesignSettings }) {
  const k = SPREAD_SCALE[s.glowSpread];
  const e = (w: number, h: number) => `${Math.round(w * k)}% ${Math.round(h * k)}%`;
  const ambient = themedGradient(
    s,
    (c, a) =>
      `radial-gradient(ellipse ${e(45, 40)} at 12% 8%,${hexToRgba(c, a)},transparent 70%),` +
      `radial-gradient(ellipse ${e(40, 35)} at 88% 55%,${hexToRgba(c, a * 0.75)},transparent 70%),` +
      `radial-gradient(ellipse ${e(55, 30)} at 40% 100%,${hexToRgba(c, a * 0.55)},transparent 70%)`,
    (s.glowIntensity / 100) * 0.45
  );
  return (
    <>
      {s.glowEnabled ? <div className={`t${s.glowAnimation ? " b" : ""}`} data-bgfx-layer="glow" style={ambient} /> : null}
      <div className="t" data-bgfx-layer="dots" style={{ ...dotVars(s), opacity: s.opacity / 100 }} />
    </>
  );
}

function GradientDots({ s }: { s: BgDesignSettings }) {
  const op = s.opacity / 100;
  const dots = resolveDotColors(s);
  const tint: Vars = {
    "--d": `radial-gradient(ellipse 90% 70% at 50% 25%,${hexToRgba(dots.dark, op * 1.2)},transparent 70%),radial-gradient(ellipse 120% 80% at 50% 115%,${hexToRgba("#1E3A8A", op * 3)},transparent 70%)`,
    "--l": `radial-gradient(ellipse 90% 70% at 50% 25%,${hexToRgba(dots.light, op * 0.6)},transparent 70%),radial-gradient(ellipse 120% 80% at 50% 115%,${hexToRgba("#94A3B8", op * 2)},transparent 70%)`,
  };
  const k = SPREAD_SCALE[s.glowSpread];
  const e = (w: number, h: number) => `${Math.round(w * k)}% ${Math.round(h * k)}%`;
  const aurora = themedGradient(
    s,
    (c, a) =>
      `radial-gradient(ellipse ${e(50, 35)} at 18% 15%,${hexToRgba(c, a)},transparent 70%),` +
      `radial-gradient(ellipse ${e(45, 35)} at 82% 25%,${hexToRgba(mixHex(c, "#8B5CF6", 0.6), a * 0.8)},transparent 70%),` +
      `radial-gradient(ellipse ${e(60, 30)} at 50% 85%,${hexToRgba(mixHex(c, "#22D3EE", 0.5), a * 0.6)},transparent 70%)`,
    (s.glowIntensity / 100) * 0.5
  );
  const fade = "radial-gradient(ellipse 70% 60% at 50% 45%,#000 30%,transparent 100%)";
  return (
    <>
      <div className="t" data-bgfx-layer="gradient" style={tint} />
      {s.glowEnabled ? <div className={`t${s.glowAnimation ? " b" : ""}`} data-bgfx-layer="glow" style={aurora} /> : null}
      <div className="t" data-bgfx-layer="dots" style={{ ...dotVars(s), opacity: op * 0.9, maskImage: fade, WebkitMaskImage: fade }} />
      {s.glowEnabled ? <NeonGlow s={s} haloOnly /> : null}
      <Watermark s={s} dense opacityScale={1.1} />
    </>
  );
}

function Galaxy({ s, mode, preview }: { s: BgDesignSettings; mode: "auto" | "dark" | "light"; preview?: PreviewOptions }) {
  const animate = s.galaxyAnimate || !!preview?.forceAnimate;
  const still = (
    <>
      {s.glowEnabled ? <NeonGlow s={s} /> : null}
      <Watermark s={s} />
    </>
  );
  // Animation OFF: the finished dotted wordmark, pure CSS — no JavaScript.
  if (!animate) return still;
  const dots = resolveDotColors(s);
  const glow = resolveGlowColors(s);
  return (
    <>
      {/* Reduced motion: CSS shows this still version and the loader never fetches the canvas code. */}
      {preview ? null : <div className="gx-fb">{still}</div>}
      <GalaxyLoader
        key={`${preview?.replayKey ?? 0}:${mode}:${JSON.stringify(s)}`}
        particles={s.galaxyParticles}
        mobileParticles={Math.min(BG_GALAXY_MOBILE_MAX, s.galaxyParticles)}
        durationMs={s.galaxyDuration * 1000}
        opacity={s.opacity / 100}
        dotSize={BG_DOT_SIZE_PX[s.dotSize]}
        dotColors={dots}
        glowColors={glow}
        glow={s.glowEnabled ? { intensity: s.glowIntensity / 100, spread: SPREAD_SCALE[s.glowSpread], trail: s.glowAnimation } : null}
        position={WM_Y[s.watermarkPosition] / 100}
        scale={{ SMALL: 0.56, MEDIUM: 0.78, LARGE: 0.92 }[s.watermarkScale]}
        mode={mode}
        ignoreReducedMotion={!!preview}
      />
    </>
  );
}

export interface PreviewOptions {
  /** The theme of the preview frame (Automatic follows it). */
  theme: "dark" | "light";
  /** Bump to replay the Galaxy formation. */
  replayKey?: number;
  /** Preview the Galaxy formation even while its animation setting is OFF. */
  forceAnimate?: boolean;
}

export function BackgroundEffectsRenderer({ config, preview }: { config: BackgroundEffectsConfig; preview?: PreviewOptions }) {
  const s = config.designs[config.design];
  const mode = config.theme === "AUTO" ? (preview ? preview.theme : "auto") : config.theme === "DARK" ? "dark" : "light";
  return (
    <div className="bgfx" aria-hidden="true" data-bgfx={config.design} data-mode={mode} data-preview={preview ? "" : undefined}>
      <style dangerouslySetInnerHTML={{ __html: BGFX_CSS }} />
      {config.design === "DOTTED_WATERMARK" ? <DottedWatermark s={s} /> : null}
      {config.design === "DOTTED_PATTERN" ? <DottedPattern s={s} /> : null}
      {config.design === "GALAXY" ? <Galaxy s={s} mode={mode} preview={preview} /> : null}
      {config.design === "GRADIENT_DOTS" ? <GradientDots s={s} /> : null}
    </div>
  );
}
