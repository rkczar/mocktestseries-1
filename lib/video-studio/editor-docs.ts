import { ASPECT_MAP, type AspectRatio } from "@/lib/video-studio/types";
import { FONT_FILES, esc } from "@/lib/video-studio/template";
import type { DesignTheme } from "@/lib/video-studio/designs";
import type { EditOverlay, SubStyle } from "@/lib/video-studio/editor-model";

/**
 * AI Video Editor — transparent HTML documents for text / diagram overlays,
 * the subtitle track and the brand line (client-safe, pure). The render
 * container draws them with the same Chromium and fonts as generated videos
 * (Devanagari shaping identical to the preview), on a transparent page the
 * size of the output frame. Same CSP as scene documents: no scripts, no
 * network except the font files.
 */

export interface DocOptions {
  aspect: AspectRatio;
  theme: DesignTheme;
  fontBase: string;
  fontOrigin: string;
}

function head(o: DocOptions, css: string): string {
  const { width: W, height: H } = ASPECT_MAP[o.aspect];
  const fb = o.fontBase;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src ${o.fontOrigin} data:; img-src data:`;
  const dev = o.theme.devanagari === "kalam" ? "MTSKalam" : "MTSDev";
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
html,body{width:${W}px;height:${H}px;overflow:hidden;background:transparent}
body{position:relative;color:#fff;font-family:MTSLatin,${dev},MTSFallback;font-weight:500;-webkit-font-smoothing:antialiased}
${css}
</style></head><body>`;
}

const cssVal = (v: string) => (/^[#a-zA-Z0-9(),.%\s-]+$/.test(v) ? v : "#000");

function frame(o: DocOptions) {
  const { width: W, height: H } = ASPECT_MAP[o.aspect];
  const vertical = H > W;
  const unit = Math.min(W, H) / 1080;
  const side = vertical ? 80 : Math.round(W * 0.06);
  // 9:16: platform UI covers the top ~230 px and the bottom ~480 px.
  const top = vertical ? 260 : Math.round(H * 0.07);
  const bottom = vertical ? 520 : Math.round(H * 0.08);
  return { W, H, vertical, unit, side, top, bottom };
}

/** One text or diagram overlay. */
export function overlayDocument(ov: EditOverlay, o: DocOptions): string {
  const f = frame(o);
  const t = o.theme;
  const u = f.unit;
  const pos = ov.position ?? "top";
  const place = pos === "top" ? `top:${f.top}px` : pos === "bottom" ? `bottom:${f.bottom + Math.round(170 * u)}px` : `top:50%;transform:translateY(-50%)`;
  if (ov.kind === "diagram") {
    const nodes = (ov.nodes ?? []).slice(0, 6);
    const row = !f.vertical && f.W > f.H;
    const css = `.panel{position:absolute;left:${f.side}px;right:${f.side}px;${place};padding:${Math.round(28 * u)}px;border-radius:${t.radius}px;background:${cssVal(t.background.startsWith("linear") ? "#0b1324" : t.background)}e6;border:${Math.round(3 * u)}px solid ${cssVal(t.accent)}}
h2{font-weight:700;font-size:${Math.round(46 * u)}px;color:${cssVal(t.accent)};margin-bottom:${Math.round(18 * u)}px}
.flow{display:flex;flex-direction:${row ? "row;align-items:center" : "column;align-items:stretch"};gap:${Math.round(8 * u)}px}
.node{flex:1 1 0;padding:${Math.round(16 * u)}px ${Math.round(20 * u)}px;border-radius:${t.radius}px;border:${Math.round(3 * u)}px solid ${cssVal(t.accent)};background:${cssVal(t.surface)};color:${cssVal(t.text)};font-size:${Math.round(36 * u)}px;font-weight:700;text-align:center;line-height:1.3}
.arrow{text-align:center;font-size:${Math.round(38 * u)}px;color:${cssVal(t.accent2)}}`;
    return `${head(o, css)}<div class="panel">${ov.text ? `<h2>${esc(ov.text)}</h2>` : ""}<div class="flow">${nodes.map((n, i) => `${i ? `<div class="arrow">${row ? "→" : "↓"}</div>` : ""}<div class="node">${esc(n)}</div>`).join("")}</div></div></body></html>`;
  }
  const style = ov.style ?? "title";
  let css = "";
  let body = "";
  if (style === "title") {
    css = `.t{position:absolute;left:${f.side}px;right:${f.side}px;${place};text-align:center}
.t span{display:inline;font-weight:700;font-size:${Math.round(66 * u)}px;line-height:1.35;color:#fff;background:${cssVal(t.accent)};color:#0b0b0b;padding:${Math.round(6 * u)}px ${Math.round(20 * u)}px;border-radius:${Math.round(14 * u)}px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.t p{margin-top:${Math.round(18 * u)}px;font-size:${Math.round(38 * u)}px;text-shadow:0 2px 10px rgba(0,0,0,.7)}`;
    body = `<div class="t"><span>${esc(ov.text ?? "")}</span>${ov.subtext ? `<p>${esc(ov.subtext)}</p>` : ""}</div>`;
  } else if (style === "lower_third") {
    css = `.lt{position:absolute;left:${f.side}px;max-width:${f.W - 2 * f.side}px;bottom:${f.bottom + Math.round(190 * u)}px;padding:${Math.round(16 * u)}px ${Math.round(26 * u)}px;border-left:${Math.round(10 * u)}px solid ${cssVal(t.accent)};background:rgba(0,0,0,.72);border-radius:${Math.round(10 * u)}px}
.lt b{display:block;font-weight:700;font-size:${Math.round(44 * u)}px;line-height:1.3}
.lt span{display:block;font-size:${Math.round(32 * u)}px;color:#d4d4d8;margin-top:${Math.round(4 * u)}px}`;
    body = `<div class="lt"><b>${esc(ov.text ?? "")}</b>${ov.subtext ? `<span>${esc(ov.subtext)}</span>` : ""}</div>`;
  } else {
    css = `.lb{position:absolute;left:${f.side}px;${place};padding:${Math.round(10 * u)}px ${Math.round(22 * u)}px;border-radius:999px;background:${cssVal(t.accent)};color:#0b0b0b;font-weight:700;font-size:${Math.round(34 * u)}px}`;
    body = `<div class="lb">${esc(ov.text ?? "")}</div>`;
  }
  return `${head(o, css)}${body}</body></html>`;
}

/**
 * The whole subtitle track as one document: each cue is a step animation
 * (visible from start to end), exactly like scene subtitles, so the render
 * container captures a frame only when a cue changes.
 */
export function subtitleDocument(cues: { start: number; end: number; text: string }[], style: SubStyle, o: DocOptions, brand: string | null): string {
  const f = frame(o);
  const u = f.unit;
  const t = o.theme;
  const span =
    style === "boxed"
      ? `background:rgba(0,0,0,.74);color:#fff;padding:${Math.round(6 * u)}px ${Math.round(16 * u)}px;border-radius:${Math.round(12 * u)}px;`
      : style === "highlight"
        ? `color:${cssVal(t.accent)};text-shadow:0 ${Math.round(3 * u)}px ${Math.round(12 * u)}px rgba(0,0,0,.8);`
        : `color:#fff;text-shadow:0 ${Math.round(3 * u)}px ${Math.round(10 * u)}px rgba(0,0,0,.85);`;
  const css = `.subs{position:absolute;left:${f.side}px;right:${f.side}px;bottom:${f.bottom}px;height:${Math.round(160 * u)}px}
.cue{position:absolute;bottom:0;left:0;right:0;text-align:center;font-weight:700;font-size:${Math.round(46 * u)}px;line-height:1.4;opacity:0;animation-name:cue;animation-timing-function:step-end;animation-fill-mode:none}
.cue span{${span}-webkit-box-decoration-break:clone;box-decoration-break:clone}
.brand{position:absolute;right:${f.side}px;top:${f.vertical ? 240 : Math.round(f.H * 0.04)}px;font-weight:700;font-size:${Math.round(28 * u)}px;color:rgba(255,255,255,.85);text-shadow:0 2px 8px rgba(0,0,0,.7)}
.brand b{color:${cssVal(t.accent)}}
@keyframes cue{from{opacity:1}to{opacity:1}}`;
  const body = `<div class="subs">${cues.map((c) => `<div class="cue" style="animation-delay:${c.start.toFixed(3)}s;animation-duration:${Math.max(0.05, c.end - c.start).toFixed(3)}s"><span>${esc(c.text)}</span></div>`).join("")}</div>${brand ? `<div class="brand">${esc(brand).replace(/\.in$/, "<b>.in</b>")}</div>` : ""}`;
  return `${head(o, css)}${body}</body></html>`;
}
