import { ASPECT_MAP, type AspectRatio } from "@/lib/video-studio/types";
import type { DesignTheme } from "@/lib/video-studio/designs";
import { subtitleLines, timeCues } from "@/lib/video-studio/text";

/**
 * One scene → one self-contained HTML document (client-safe, pure).
 *
 * Used by BOTH the admin preview (an iframe in the admin's browser) and the
 * render worker (headless Chromium, which seeks every animation with the Web
 * Animations API: `document.getAnimations()` → pause → `currentTime = t`).
 * Animations are plain CSS keyframes with explicit delays, so any frame can
 * be rendered alone and in any order (deterministic).
 *
 * Security: every piece of text is HTML-escaped, and the document carries a
 * Content-Security-Policy that forbids scripts, frames and any network
 * access except the font files (font-src) — so even an escaping bug cannot
 * run code or fetch arbitrary URLs. Images are only data: URIs that the
 * server produced itself.
 */

export type SceneVisual =
  | { kind: "title"; title: string; subtitle?: string }
  | { kind: "bullets"; title?: string; items: string[] }
  | { kind: "diagram"; title?: string; nodes: string[] }
  | { kind: "question"; stem: string; options: { label: string; text: string }[]; correctLabel: string | null; revealAtSec?: number }
  | { kind: "cta"; title: string; subtitle?: string }
  /** An uploaded image or PDF page (assetKey in the job folder); `src` is a data: URI the server builds from it. */
  | { kind: "image"; title?: string; caption?: string; assetKey: string; src?: string };

export interface TemplateScene {
  narration: string;
  onScreenText: string;
  visual: SceneVisual | null;
  durationSec: number;
}

export interface TemplateBrand {
  wordmark: string;
  examLabel: string | null;
  showBranding: boolean;
  cta: string;
}

export interface TemplateOptions {
  aspect: AspectRatio;
  theme: DesignTheme;
  brand: TemplateBrand;
  subtitles: boolean;
  /** Absolute or root-relative base URL of the bundled font files (ends with "/"). */
  fontBase: string;
  /** Extra origin allowed by font-src (the admin site origin for previews; "file:" for the worker). */
  fontOrigin: string;
}

export const FONT_FILES = {
  latinMedium: "Geist-Medium.ttf",
  latinBold: "Geist-Bold.ttf",
  devRegular: "NotoSansDevanagari-Regular.ttf",
  devBold: "NotoSansDevanagari-Bold.ttf",
  kalamRegular: "Kalam-Regular.ttf",
  kalamBold: "Kalam-Bold.ttf",
  /** Glyph fallback for Greek, arrows and symbols Geist lacks (same role as in the Instagram renderer). */
  fallbackRegular: "LiberationSans-Regular.ttf",
  fallbackBold: "LiberationSans-Bold.ttf",
} as const;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Safe CSS value: our own theme tokens are validated, but never trust a string that reaches CSS. */
function cssVal(v: string): string {
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(v) ? v : "#000";
}

function decoration(kind: DesignTheme["decoration"], accent: string): string {
  const a = cssVal(accent);
  switch (kind) {
    case "grid":
      return `background-image:linear-gradient(${a}14 1px,transparent 1px),linear-gradient(90deg,${a}14 1px,transparent 1px);background-size:60px 60px;`;
    case "blueprint":
      return `background-image:linear-gradient(${a}33 2px,transparent 2px),linear-gradient(90deg,${a}33 2px,transparent 2px),linear-gradient(${a}14 1px,transparent 1px),linear-gradient(90deg,${a}14 1px,transparent 1px);background-size:200px 200px,200px 200px,40px 40px,40px 40px;`;
    case "dots":
      return `background-image:radial-gradient(${a}26 2px,transparent 2px);background-size:36px 36px;`;
    case "glow":
      return `background-image:radial-gradient(circle at 20% 15%,${a}40,transparent 45%),radial-gradient(circle at 85% 80%,${a}26,transparent 40%);`;
    default:
      return "";
  }
}

const ECG_PATH = "M0 60 L120 60 L140 60 L150 40 L160 60 L190 60 L200 75 L215 5 L230 100 L242 60 L300 60 L320 45 L345 60 L460 60 L480 60 L490 40 L500 60 L530 60 L540 75 L555 5 L570 100 L582 60 L640 60 L660 45 L685 60 L800 60";

function visualHtml(v: SceneVisual | null, onScreen: string, landscape: boolean): string {
  if (!v) return `<h1 class="a" style="--d:0s">${esc(onScreen)}</h1>`;
  switch (v.kind) {
    case "title":
      return `<h1 class="a" style="--d:0s">${esc(v.title)}</h1>${v.subtitle ? `<p class="sub a" style="--d:.25s">${esc(v.subtitle)}</p>` : ""}`;
    case "bullets":
      return `${v.title ? `<h2 class="a" style="--d:0s">${esc(v.title)}</h2>` : ""}<ul>${v.items
        .slice(0, 4)
        .map((it, i) => `<li class="a" style="--d:${(0.3 + i * 0.45).toFixed(2)}s">${esc(it)}</li>`)
        .join("")}</ul>`;
    case "diagram": {
      const nodes = v.nodes.slice(0, 6);
      return `${v.title ? `<h2 class="a" style="--d:0s">${esc(v.title)}</h2>` : ""}<div class="flow">${nodes
        .map((n, i) => `${i ? `<div class="arrow a" style="--d:${(0.15 + i * 0.5).toFixed(2)}s">${landscape ? "→" : "↓"}</div>` : ""}<div class="node a" style="--d:${(0.3 + i * 0.5).toFixed(2)}s">${esc(n)}</div>`)
        .join("")}</div>`;
    }
    case "question": {
      const reveal = v.revealAtSec ?? 0;
      return `<div class="stem a" style="--d:0s">${esc(v.stem)}</div><ol class="opts">${v.options
        .slice(0, 5)
        .map((o, i) => {
          const correct = v.correctLabel !== null && o.label === v.correctLabel;
          return `<li class="a${correct && reveal > 0 ? " correct" : ""}" style="--d:${(0.3 + i * 0.25).toFixed(2)}s;--r:${reveal.toFixed(2)}s"><b>${esc(o.label)}</b><span>${esc(o.text)}</span></li>`;
        })
        .join("")}</ol>`;
    }
    case "cta":
      return `<h1 class="a" style="--d:0s">${esc(v.title)}</h1>${v.subtitle ? `<p class="sub a" style="--d:.3s">${esc(v.subtitle)}</p>` : ""}`;
    case "image": {
      const src = typeof v.src === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v.src) ? v.src : null;
      return `${v.title ? `<h2 class="a" style="--d:0s">${esc(v.title)}</h2>` : ""}${src ? `<figure class="img a" style="--d:.2s"><img src="${src}" alt=""></figure>` : `<div class="img missing a" style="--d:.2s">${esc(v.caption ?? "")}</div>`}${v.caption && src ? `<p class="sub a" style="--d:.5s">${esc(v.caption)}</p>` : ""}`;
    }
  }
}

/** The full HTML document for one scene. Width/height come from the aspect ratio. */
export function sceneDocument(scene: TemplateScene, opts: TemplateOptions): string {
  const { width: W, height: H } = ASPECT_MAP[opts.aspect];
  const t = opts.theme;
  const vertical = H > W;
  const unit = Math.min(W, H) / 1080;
  // Safe zone: on 9:16 the platform UI covers the top ~230 px, the bottom ~480 px and the right action rail.
  const pad = vertical ? { top: 300, left: 80, right: 150 } : { top: Math.round(H * 0.09), left: Math.round(W * 0.07), right: Math.round(W * 0.07) };
  const dev = t.devanagari === "kalam" ? "MTSKalam" : "MTSDev";
  const motion = { fade: "fadeIn", rise: "riseIn", slide: "slideIn", pop: "popIn", zoom: "riseIn" }[t.motion];
  const dur = Math.max(1, scene.durationSec);
  const cues = opts.subtitles && scene.narration.trim() ? timeCues(subtitleLines(scene.narration, vertical ? 30 : 46), 0, dur) : [];
  // Bottom stack (inside the safe zone): brand line, then the subtitle band above it, then the main content.
  const brandBottom = vertical ? 490 : Math.round(H * 0.05);
  const subsBottom = brandBottom + Math.round(70 * unit);
  const subsHeight = Math.round(150 * unit);
  const fb = opts.fontBase;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src ${opts.fontOrigin} data:; img-src data:`;

  return `<!doctype html><html lang="hi"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<style>
@font-face{font-family:MTSLatin;src:url(${fb}${FONT_FILES.latinMedium});font-weight:500}
@font-face{font-family:MTSLatin;src:url(${fb}${FONT_FILES.latinBold});font-weight:700}
@font-face{font-family:MTSDev;src:url(${fb}${FONT_FILES.devRegular});font-weight:500}
@font-face{font-family:MTSDev;src:url(${fb}${FONT_FILES.devBold});font-weight:700}
@font-face{font-family:MTSKalam;src:url(${fb}${FONT_FILES.kalamRegular});font-weight:500}
@font-face{font-family:MTSKalam;src:url(${fb}${FONT_FILES.kalamBold});font-weight:700}
@font-face{font-family:MTSFallback;src:url(${fb}${FONT_FILES.fallbackRegular});font-weight:500}
@font-face{font-family:MTSFallback;src:url(${fb}${FONT_FILES.fallbackBold});font-weight:700}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{position:relative;background:${cssVal(t.background)};color:${cssVal(t.text)};font-family:MTSLatin,${dev},MTSFallback;font-weight:500;-webkit-font-smoothing:antialiased}
.bg{position:absolute;inset:0;${decoration(t.decoration, t.accent)}${t.motion === "zoom" ? `animation:pushIn ${dur}s linear both;` : ""}}
.ecg{position:absolute;left:0;right:0;bottom:${vertical ? 560 : Math.round(H * 0.22)}px;height:${Math.round(110 * unit)}px;opacity:.55}
.ecg path{fill:none;stroke:${cssVal(t.accent)};stroke-width:4;stroke-dasharray:1700;stroke-dashoffset:1700;animation:trace 2.4s linear .2s both}
.label{position:absolute;top:${vertical ? 240 : Math.round(H * 0.04)}px;left:${pad.left}px;padding:${Math.round(10 * unit)}px ${Math.round(22 * unit)}px;border-radius:999px;background:${cssVal(t.accent)};color:#0b0b0b;font-weight:700;font-size:${Math.round(30 * unit)}px;letter-spacing:.02em}
.brand{position:absolute;bottom:${brandBottom}px;left:${pad.left}px;font-weight:700;font-size:${Math.round(30 * unit)}px;color:${cssVal(t.muted)}}
.brand b{color:${cssVal(t.accent)}}
main{position:absolute;top:${pad.top}px;bottom:${subsBottom + (cues.length ? subsHeight + Math.round(30 * unit) : 0)}px;left:${pad.left}px;right:${pad.right}px;display:flex;flex-direction:column;justify-content:center;gap:${Math.round(28 * unit)}px}
h1{font-weight:700;font-size:${Math.round(84 * unit * t.titleScale)}px;line-height:1.25}
h2{font-weight:700;font-size:${Math.round(58 * unit * t.titleScale)}px;line-height:1.3;color:${cssVal(t.accent)}}
.sub{font-size:${Math.round(44 * unit)}px;line-height:1.45;color:${cssVal(t.muted)}}
ul{list-style:none;display:flex;flex-direction:column;gap:${Math.round(22 * unit)}px}
li{font-size:${Math.round(46 * unit)}px;line-height:1.4}
ul li{padding:${Math.round(22 * unit)}px ${Math.round(28 * unit)}px;border-radius:${t.radius}px;background:${cssVal(t.surface)};border-left:${Math.round(8 * unit)}px solid ${cssVal(t.accent)}}
.flow{display:flex;flex-direction:${!vertical && W > H ? "row;flex-wrap:wrap;align-items:center;justify-content:center" : "column;align-items:stretch"};gap:${Math.round(6 * unit)}px}
${!vertical && W > H ? `.flow .node{flex:1 1 0;min-width:${Math.round(220 * unit)}px}` : ""}
.node{padding:${Math.round(20 * unit)}px ${Math.round(26 * unit)}px;border-radius:${t.radius}px;border:${Math.round(3 * unit)}px solid ${cssVal(t.accent)};background:${cssVal(t.surface)};font-size:${Math.round(42 * unit)}px;font-weight:700;text-align:center;line-height:1.3}
.img{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;border-radius:${t.radius}px;overflow:hidden;background:${cssVal(t.surface)}}
.img img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.arrow{text-align:center;font-size:${Math.round(44 * unit)}px;color:${cssVal(t.accent2)};line-height:1}
.stem{font-size:${Math.round(46 * unit)}px;line-height:1.45;font-weight:700}
.opts{list-style:none;display:flex;flex-direction:column;gap:${Math.round(16 * unit)}px}
.opts li{display:flex;gap:${Math.round(18 * unit)}px;align-items:flex-start;padding:${Math.round(18 * unit)}px ${Math.round(24 * unit)}px;border-radius:${t.radius}px;background:${cssVal(t.surface)};font-size:${Math.round(40 * unit)}px}
.opts b{color:${cssVal(t.accent)}}
.opts li.correct{animation:${motion} .6s ease-out var(--d) both,correct .5s ease-out var(--r) both}
.subs{position:absolute;left:${pad.left}px;right:${pad.right}px;bottom:${subsBottom}px;height:${subsHeight}px;display:flex;align-items:flex-end;justify-content:center}
.cue{position:absolute;bottom:0;left:0;right:0;text-align:center;font-weight:700;font-size:${Math.round(44 * unit)}px;line-height:1.4;opacity:0;animation-name:cue;animation-timing-function:step-end;animation-fill-mode:none}
.cue span{${t.subtitleStyle === "boxed" ? `background:rgba(0,0,0,.72);color:#fff;padding:${Math.round(6 * unit)}px ${Math.round(16 * unit)}px;border-radius:${Math.round(12 * unit)}px;` : t.subtitleStyle === "highlight" ? `color:${cssVal(t.accent)};text-shadow:0 ${Math.round(3 * unit)}px ${Math.round(12 * unit)}px rgba(0,0,0,.6);` : `text-shadow:0 ${Math.round(3 * unit)}px ${Math.round(10 * unit)}px rgba(0,0,0,.55);`}-webkit-box-decoration-break:clone;box-decoration-break:clone}
.a{animation:${motion} .6s ease-out var(--d) both}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes riseIn{from{opacity:0;transform:translateY(${Math.round(40 * unit)}px)}to{opacity:1;transform:none}}
@keyframes slideIn{from{opacity:0;transform:translateX(${Math.round(-60 * unit)}px)}to{opacity:1;transform:none}}
@keyframes popIn{from{opacity:0;transform:scale(.85)}70%{transform:scale(1.03)}to{opacity:1;transform:none}}
@keyframes pushIn{from{transform:scale(1)}to{transform:scale(1.06)}}
@keyframes trace{to{stroke-dashoffset:0}}
@keyframes correct{from{background:${cssVal(t.surface)}}to{background:${cssVal(t.accent2)}55;outline:${Math.round(4 * unit)}px solid ${cssVal(t.accent2)}}}
@keyframes cue{from{opacity:1}to{opacity:1}}
</style></head><body>
<div class="bg"></div>
${t.decoration === "ecg" ? `<svg class="ecg" viewBox="0 0 800 110" preserveAspectRatio="none" aria-hidden="true"><path d="${ECG_PATH}"/></svg>` : ""}
${opts.brand.showBranding && opts.brand.examLabel ? `<div class="label">${esc(opts.brand.examLabel)}</div>` : ""}
<main>${visualHtml(scene.visual, scene.onScreenText, !vertical && W > H)}</main>
${cues.length ? `<div class="subs">${cues.map((c) => `<div class="cue" style="animation-delay:${c.startSec}s;animation-duration:${Math.max(0.05, c.endSec - c.startSec).toFixed(3)}s"><span>${esc(c.text)}</span></div>`).join("")}</div>` : ""}
${opts.brand.showBranding ? `<div class="brand">${esc(opts.brand.wordmark).replace(/\.in$/, "<b>.in</b>")}</div>` : ""}
</body></html>`;
}
