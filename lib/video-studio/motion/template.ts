import { ASPECT_MAP, type AspectRatio } from "@/lib/video-studio/types";
import { FONT_FILES, esc } from "@/lib/video-studio/template";
import { graphemeCount } from "@/lib/video-studio/text";
import { MOTION_STYLE_MAP, type MotionStyle } from "@/lib/video-studio/motion/styles";
import { safeZone, type MotionVisual } from "@/lib/video-studio/motion/storyboard";

/**
 * Motion Workflow Studio — one storyboard frame → one self-contained HTML
 * document (client-safe, pure). Same contract as the Generator's scene
 * documents (lib/video-studio/template.ts): used by the admin preview and by
 * the render container, which pauses every CSS animation and seeks it frame
 * by frame (deterministic). No scripts; CSP forbids everything but the bundled
 * fonts and data: images the server produced.
 *
 * What makes it "motion-first":
 *  - every spoken word of the frame appears at the second it is spoken
 *    (word timing from the narration), the highlighted word lands with it;
 *  - the frame's ONE motion (push in, pop, draw, count, stagger, pan, flip,
 *    Ken Burns) runs on its main element;
 *  - the style's layout (map camera, level HUD, case file, calendar, big
 *    sentence card, photo) is identical in every frame — only the content and
 *    the camera change — so the video looks planned, not random.
 */

export interface MotionFrameInput {
  sentence: string;
  onScreen: string;
  visual: MotionVisual;
}

export interface MotionDocOptions {
  aspect: AspectRatio;
  styleKey: string;
  index: number;
  /** Every frame of the video (the map and the progress HUD show the whole plan). */
  all: { onScreen: string; tag: string | null }[];
  durationSec: number;
  /** Spoken words of this frame, times relative to the frame start. */
  words: { text: string; start: number; end: number }[];
  subtitles: boolean;
  brand: { wordmark: string; examLabel: string | null; showBranding: boolean; cta: string };
  /** data: URI of the frame's image (image frames / Photo Story). */
  imageSrc?: string | null;
  fontBase: string;
  fontOrigin: string;
}

const cssVal = (v: string) => (/^[#a-zA-Z0-9(),.%\s-]+$/.test(v) ? v : "#000");
const s2 = (n: number) => `${Math.max(0, n).toFixed(2)}s`;
const norm = (w: string) => w.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");

/** Time (frame-relative) a word is first spoken, or null. */
function spokenAt(words: MotionDocOptions["words"], word: string): number | null {
  const n = norm(word);
  if (!n) return null;
  const hit = words.find((w) => norm(w.text) === n) ?? words.find((w) => norm(w.text).startsWith(n) || n.startsWith(norm(w.text)));
  return hit ? hit.start : null;
}

/** On-screen text with the highlight word wrapped (escaped). */
function marked(text: string, highlight: string, at: number): string {
  const h = norm(highlight);
  if (!h) return esc(text);
  let done = false;
  return text
    .split(/(\s+)/)
    .map((tok) => {
      if (!done && norm(tok) === h) {
        done = true;
        return `<mark style="--h:${s2(at)}">${esc(tok)}</mark>`;
      }
      return esc(tok);
    })
    .join("");
}

function countable(v: string): number | null {
  return /^\d{1,6}$/.test(v) ? Number(v) : null;
}

export function motionFrameDocument(frame: MotionFrameInput, o: MotionDocOptions): string {
  const style: MotionStyle = MOTION_STYLE_MAP[o.styleKey] ?? MOTION_STYLE_MAP.big_sentence;
  const p = style.palette;
  const { width: W, height: H } = ASPECT_MAP[o.aspect];
  const z = safeZone(o.aspect);
  const u = Math.min(W, H) / 1080;
  const vertical = H > W;
  const dur = Math.max(1, o.durationSec);
  const v = frame.visual;
  const dev = style.devanagari === "kalam" ? "MTSKalam" : "MTSDev";
  const hiAt = spokenAt(o.words, v.highlight) ?? 0.6;
  const fb = o.fontBase;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src ${o.fontOrigin} data:; img-src data:`;
  const capH = o.subtitles ? Math.round(150 * u) : 0;
  // Bottom of the safe zone, from the edge up: brand line, caption band, then the content box.
  const brandH = o.brand.showBranding ? Math.round(52 * u) : 0;
  const capBottom = z.bottom + brandH;
  // Layout chrome at the top of the safe zone (calendar, level HUD, case-file header); content starts below it.
  const chromeTop = style.layout === "calendar" ? Math.round(210 * u) : style.layout === "levels" || style.layout === "case" ? Math.round(84 * u) : 0;
  // The case file's progress track sits just above the captions: keep content clear of it.
  const chromeBottom = style.layout === "case" ? Math.round(36 * u) : 0;
  const box = { top: z.top + chromeTop, left: z.side, right: z.side, bottom: capBottom + capH + Math.round(24 * u) + chromeBottom };
  // Landscape question frames (stem + options + answer) use a compact scale so they fit the shorter safe zone.
  const compact = !vertical && v.type === "question";
  const k = compact ? 0.78 : 1;
  const big = Math.round((compact ? 64 : graphemeCount(frame.onScreen) > 34 ? 70 : graphemeCount(frame.onScreen) > 22 ? 84 : 100) * u);
  const mainMotion = { push_in: "popIn", slide_up: "riseIn", pop: "popIn", draw: "fadeIn", count: "popIn", stagger: "fadeIn", pan: "fadeIn", flip: "flipIn", ken_burns: "fadeIn" }[v.motion];

  // ---- the visual (inside the content box) ----
  const itemAt = (text: string, i: number, base: number) => spokenAt(o.words, text.split(/\s+/)[0] ?? "") ?? base + i * 0.55;
  let visual = "";
  switch (v.type) {
    case "steps":
      visual = `<ol class="steps">${(v.items ?? []).map((it, i) => `<li class="in" style="--d:${s2(Math.max(0.3, itemAt(it, i, 0.5)))}"><b>${i + 1}</b><span>${esc(it)}</span></li>`).join("")}</ol>`;
      break;
    case "diagram": {
      const nodes = v.nodes ?? [];
      const row = !vertical;
      visual = `<div class="flow${row ? " row" : ""}">${nodes
        .map((n, i) => {
          const d = Math.max(0.3, itemAt(n, i, 0.4));
          return `${i ? `<i class="arr${row ? " h" : ""}" style="--d:${s2(d - 0.2)}"></i>` : ""}<div class="node in" style="--d:${s2(d)}">${esc(n)}</div>`;
        })
        .join("")}</div>`;
      break;
    }
    case "stat": {
      const n = countable(v.value ?? "");
      const at = spokenAt(o.words, v.value ?? "") ?? 0.4;
      visual = `<div class="stat in" style="--d:${s2(Math.max(0.2, at - 0.3))}">${n !== null ? `<span class="num" style="--to:${n};--d:${s2(Math.max(0.2, at - 0.3))}"></span>` : `<span>${esc(v.value ?? "")}</span>`}${v.unit ? `<small>${esc(v.unit)}</small>` : ""}</div>`;
      break;
    }
    case "compare":
      visual = `<div class="cmp"><div class="in" style="--d:.3s">${esc(v.left ?? "")}</div><b class="in" style="--d:.6s">vs</b><div class="in" style="--d:${s2(itemAt(v.right ?? "", 0, 0.9))}">${esc(v.right ?? "")}</div></div>`;
      break;
    case "question": {
      // The stored answer must stay readable: reveal by 40 % of the frame at the latest.
      const reveal = v.correctLabel && v.revealAtSec ? Math.max(0.8, Math.min(v.revealAtSec, dur * 0.4)) : 0;
      visual = `<div class="q"><p class="stem in" style="--d:.2s">${esc(v.stem ?? "")}</p><ul>${(v.options ?? [])
        .map((op, i) => `<li class="in${reveal > 0 && op.label === v.correctLabel ? " ok" : ""}" style="--d:${s2(0.5 + i * 0.25)};--r:${s2(reveal)}"><b>${esc(op.label)}</b><span>${esc(op.text)}</span></li>`)
        .join("")}</ul>${reveal > 0 ? `<p class="ans" style="--r:${s2(reveal)}">Answer: ${esc(v.correctLabel ?? "")}</p>` : ""}</div>`;
      break;
    }
    case "cta":
      visual = `<div class="cta in" style="--d:.5s">${o.brand.showBranding ? esc(o.brand.wordmark) : ""}</div>`;
      break;
    case "image":
      visual = o.imageSrc ? `<div class="pic in" style="--d:.2s"><img src="${esc(o.imageSrc)}" alt=""></div>` : "";
      break;
    default:
      visual = "";
  }

  // ---- layout chrome (identical in every frame of the style) ----
  const n = o.all.length;
  const tag = v.tag ? `<div class="tag">${esc(v.tag)}</div>` : "";
  let chrome = "";
  let body = "";
  const headline = `<h1 class="main">${marked(frame.onScreen, v.highlight, hiAt)}</h1>`;
  if (style.layout === "map") {
    // The map has its own viewport (upper part of the content box); the frame's visual sits below it, never under the map.
    const mvW = W - z.side * 2;
    const mvH = Math.round((H - box.top - box.bottom) * (vertical ? 0.42 : 0.5));
    const nodeW = Math.round(Math.min(mvW * 0.78, 760 * u));
    const nodeH = Math.round(140 * u);
    const pos = Array.from({ length: n }, (_, i) => ({ x: (i % 2 === 0 ? 0.3 : 0.7) * mvW * 2, y: mvH * 0.5 + Math.floor(i / 2) * mvH * 1.05 + (i % 2) * mvH * 0.5 }));
    const cw = mvW * 2;
    const wh = (pos[n - 1]?.y ?? 0) + mvH * 0.5;
    const last = o.index === n - 1 && n > 1;
    const cam = (i: number) => `translate(${Math.round(mvW / 2 - pos[Math.max(0, Math.min(i, n - 1))].x)}px,${Math.round(mvH / 2 - pos[Math.max(0, Math.min(i, n - 1))].y)}px) scale(1)`;
    const fit = Math.min(mvW / cw, mvH / wh) * 0.92;
    const from = cam(Math.max(0, o.index - 1));
    const to = last ? `translate(${Math.round((mvW - cw * fit) / 2)}px,${Math.round((mvH - wh * fit) / 2)}px) scale(${fit.toFixed(4)})` : cam(o.index);
    const lines = pos
      .slice(1)
      .map((q, i) => {
        const a = pos[i];
        const cls = i + 1 < o.index || last ? "done" : i + 1 === o.index ? "draw" : "todo";
        return `<line x1="${Math.round(a.x)}" y1="${Math.round(a.y)}" x2="${Math.round(q.x)}" y2="${Math.round(q.y)}" class="${cls}"/>`;
      })
      .join("");
    const nodes = o.all
      .map((f, i) => {
        const cls = i === o.index && !last ? " cur" : i < o.index || last ? " seen" : "";
        const label = i === o.index ? marked(f.onScreen, v.highlight, hiAt) : esc(f.onScreen);
        return `<div class="mnode${cls}" style="left:${Math.round(pos[i].x - nodeW / 2)}px;top:${Math.round(pos[i].y - nodeH / 2)}px;width:${nodeW}px;height:${nodeH}px"><span>${label}</span></div>`;
      })
      .join("");
    chrome = `<div class="mapview" style="top:${box.top}px;left:${z.side}px;width:${mvW}px;height:${mvH}px"><div class="world" style="--from:${from};--to:${to};width:${cw}px;height:${Math.round(wh)}px"><svg width="${cw}" height="${Math.round(wh)}">${lines}</svg>${nodes}</div></div>`;
    // The end card (pull-back over the whole map) also states the call to action in full.
    body = `<div class="spacer" style="flex:0 0 ${mvH}px"></div>${last ? headline : ""}${visual ? `<div class="panel">${visual}</div>` : ""}`;
  } else if (style.layout === "levels") {
    const hearts = "<i></i><i></i><i></i>";
    chrome = `<div class="hud"><span class="lvl">${esc(v.tag ?? `Level ${o.index + 1}`)}</span><span class="hearts">${hearts}</span><span class="bar"><i style="--from:${(o.index / n) * 100}%;--to:${((o.index + 1) / n) * 100}%"></i></span></div>`;
    body = `${headline}${visual}`;
  } else if (style.layout === "case") {
    chrome = `<div class="file"><span>CASE FILE · illustrative patient</span><span>${o.index + 1}/${n}</span></div><div class="track">${o.all.map((f, i) => `<i class="${i <= o.index ? "on" : ""}">${esc(f.tag ?? "")}</i>`).join("")}</div>`;
    body = `${tag}${headline}${visual}`;
  } else if (style.layout === "calendar") {
    chrome = `<div class="cal"><div class="rings"><i></i><i></i></div><div class="page"><span>${esc(v.tag ?? `Step ${o.index + 1}`)}</span></div></div>`;
    body = `${headline}${visual}`;
  } else if (style.layout === "photo") {
    chrome = o.imageSrc ? `<div class="kb"><img src="${esc(o.imageSrc)}" alt=""></div><div class="shade"></div>` : `<div class="shade"></div>`;
    body = `<div class="spacer"></div>${headline}`;
  } else {
    body = `${headline}${visual ? `<div class="card">${visual}</div>` : ""}`;
  }

  // ---- kinetic captions: each spoken word appears when it is spoken ----
  const caption = o.subtitles && o.words.length ? `<div class="cap">${o.words.map((w) => `<span class="w${norm(w.text) === norm(v.highlight) ? " hw" : ""}" style="--d:${s2(w.start)}">${esc(w.text)}</span>`).join(" ")}</div>` : "";
  const grain = style.grain ? `<div class="grain"></div>` : "";
  const brandLine = o.brand.showBranding && v.type !== "cta" ? `<div class="brand">${esc(o.brand.wordmark)}</div>` : "";

  const css = `
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
body{position:relative;background:${cssVal(p.background)};color:${cssVal(p.text)};font-family:MTSLatin,${dev},MTSFallback;font-weight:500;-webkit-font-smoothing:antialiased}
.content{position:absolute;top:${box.top}px;left:${box.left}px;right:${box.right}px;bottom:${box.bottom}px;display:flex;flex-direction:column;justify-content:center;gap:${Math.round(34 * u * k * k)}px${v.motion === "push_in" ? `;animation:push ${s2(dur)} linear both;transform-origin:50% 45%` : ""}}
h1.main{font-weight:700;font-size:${big}px;line-height:1.22;letter-spacing:-.01em;animation:${mainMotion} .7s cubic-bezier(.2,.8,.2,1) .05s both}
mark{background:transparent;color:inherit;padding:0 .08em;border-radius:.12em;${style.highlight === "underline" ? `background-image:linear-gradient(${cssVal(p.highlight)},${cssVal(p.highlight)});background-repeat:no-repeat;background-position:0 92%;background-size:0 .14em;` : `background-image:linear-gradient(${cssVal(p.highlight)},${cssVal(p.highlight)});background-repeat:no-repeat;background-position:0 60%;background-size:0 ${style.highlight === "box" ? "100%" : "62%"};`}animation:mark .4s ease-out var(--h) both;color:${style.highlight === "box" ? cssVal(p.highlightText) : "inherit"}}
.in{animation:${v.motion === "pop" || v.motion === "count" ? "popIn" : v.motion === "flip" ? "flipIn" : "riseIn"} .55s cubic-bezier(.2,.8,.2,1) var(--d) both}
.steps{list-style:none;display:flex;flex-direction:column;gap:${Math.round(18 * u)}px}
.steps li{display:flex;gap:${Math.round(22 * u)}px;align-items:center;font-size:${Math.round(46 * u)}px;font-weight:700;padding:${Math.round(20 * u)}px ${Math.round(26 * u)}px;border-radius:${Math.round(22 * u)}px;background:${cssVal(p.surface)};border:${Math.round(3 * u)}px solid ${cssVal(p.line)}}
.steps b{display:inline-grid;place-items:center;min-width:${Math.round(64 * u)}px;height:${Math.round(64 * u)}px;border-radius:50%;background:${cssVal(p.highlight)};color:${cssVal(p.highlightText)};font-size:${Math.round(36 * u)}px}
.flow{display:flex;flex-direction:column;align-items:stretch;gap:${Math.round(6 * u)}px}
.flow.row{flex-direction:row;align-items:center}
.flow.row .node{flex:1 1 0}
.node{padding:${Math.round(20 * u)}px ${Math.round(24 * u)}px;border-radius:${Math.round(20 * u)}px;border:${Math.round(4 * u)}px solid ${cssVal(p.accent)};background:${cssVal(p.surface)};font-size:${Math.round(42 * u)}px;font-weight:700;text-align:center}
.arr{display:block;align-self:center;width:${Math.round(6 * u)}px;height:${Math.round(46 * u)}px;background:${cssVal(p.accent)};transform-origin:top;animation:grow .35s ease-out var(--d) both}
.arr.h{width:${Math.round(46 * u)}px;height:${Math.round(6 * u)}px;transform-origin:left}
.stat{display:flex;align-items:baseline;gap:${Math.round(18 * u)}px;font-weight:700}
.stat span{font-size:${Math.round(200 * u)}px;line-height:1;color:${cssVal(p.accent)}}
.stat small{font-size:${Math.round(56 * u)}px;color:${cssVal(p.muted)}}
@property --n{syntax:'<integer>';initial-value:0;inherits:false}
.num{--n:0;counter-reset:n var(--n);animation:count 1.1s ease-out var(--d) both}
.num::after{content:counter(n)}
.cmp{display:grid;grid-template-columns:1fr auto 1fr;gap:${Math.round(20 * u)}px;align-items:center}
.cmp div{padding:${Math.round(30 * u)}px;border-radius:${Math.round(22 * u)}px;background:${cssVal(p.surface)};border:${Math.round(3 * u)}px solid ${cssVal(p.line)};font-size:${Math.round(44 * u)}px;font-weight:700;text-align:center}
.cmp b{font-size:${Math.round(40 * u)}px;color:${cssVal(p.muted)}}
.q .stem{font-size:${Math.round(44 * u * k)}px;font-weight:700;line-height:1.4}
.q ul{list-style:none;display:flex;flex-direction:column;gap:${Math.round(14 * u * k)}px;margin-top:${Math.round(18 * u * k)}px}
.q li{display:flex;gap:${Math.round(18 * u)}px;padding:${Math.round(18 * u * k * k)}px ${Math.round(24 * u)}px;border-radius:${Math.round(18 * u)}px;background:${cssVal(p.surface)};border:${Math.round(3 * u)}px solid ${cssVal(p.line)};font-size:${Math.round(38 * u * k)}px}
.q li.ok{animation:riseIn .55s ease-out var(--d) both,ok .45s ease-out var(--r) both}
.ans{font-size:${Math.round(40 * u * k)}px;font-weight:700;margin-top:${Math.round(14 * u * k)}px;opacity:0;animation:fadeIn .4s ease-out var(--r) both}
.cta{font-size:${Math.round(64 * u)}px;font-weight:700;padding:${Math.round(26 * u)}px ${Math.round(36 * u)}px;border-radius:${Math.round(24 * u)}px;background:${cssVal(p.highlight)};color:${cssVal(p.highlightText)};align-self:flex-start}
.pic{border-radius:${Math.round(24 * u)}px;overflow:hidden;max-height:${Math.round(H * 0.3)}px}
.pic img{width:100%;height:100%;object-fit:cover;display:block}
.card{padding:${Math.round(36 * u)}px;border-radius:${Math.round(28 * u)}px;border:${Math.round(4 * u)}px solid ${cssVal(p.line)};background:${cssVal(p.surface)};box-shadow:${Math.round(14 * u)}px ${Math.round(14 * u)}px 0 ${cssVal(p.highlight)};animation:popIn .6s cubic-bezier(.2,.8,.2,1) .25s both}
.cap{position:absolute;left:${z.side}px;right:${z.side}px;bottom:${capBottom}px;height:${capH}px;display:flex;flex-wrap:wrap;align-content:flex-end;justify-content:center;gap:0 ${Math.round(14 * u)}px;font-size:${Math.round(44 * u)}px;font-weight:700;line-height:1.35;text-align:center}
.cap .w{opacity:0;animation:word .18s ease-out var(--d) both}
.cap .hw{color:${style.layout === "photo" || p.background.startsWith("#0") ? cssVal(p.highlight) : cssVal(p.accent)};${style.highlight === "box" ? `background:${cssVal(p.highlight)};color:${cssVal(p.highlightText)};padding:0 .15em;border-radius:.15em;` : ""}}
.brand{position:absolute;left:${z.side}px;right:${z.side}px;bottom:${z.bottom}px;height:${brandH}px;display:flex;align-items:flex-end;justify-content:center;font-weight:700;font-size:${Math.round(28 * u)}px;letter-spacing:.02em;color:${cssVal(p.muted)}}
.tag{align-self:flex-start;font-size:${Math.round(30 * u)}px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:${Math.round(8 * u)}px ${Math.round(20 * u)}px;border-radius:999px;background:${cssVal(p.accent)};color:${cssVal(p.background)}}
.grain{position:absolute;inset:0;pointer-events:none;opacity:.08;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")}
/* map */
.mapview{position:absolute;overflow:hidden}
.world{position:absolute;left:0;top:0;transform-origin:0 0;animation:cam .9s cubic-bezier(.65,0,.35,1) .05s both}
.world svg{position:absolute;inset:0}
.world line{stroke:${cssVal(p.line)};stroke-width:${Math.round(6 * u)};stroke-dasharray:8 14}
.world line.done{stroke:${cssVal(p.accent)};stroke-dasharray:none}
.world line.draw{stroke:${cssVal(p.accent)};stroke-dasharray:3000;stroke-dashoffset:3000;animation:dash .9s ease-out .1s both}
.mnode{position:absolute;display:flex;align-items:center;justify-content:center;padding:0 ${Math.round(24 * u)}px;border-radius:${Math.round(26 * u)}px;background:${cssVal(p.surface)};border:${Math.round(4 * u)}px solid ${cssVal(p.line)};font-size:${Math.round(50 * u)}px;font-weight:700;text-align:center;line-height:1.2;opacity:.35}
.mnode.seen{opacity:.75;border-color:${cssVal(p.accent)}}
.mnode.cur{opacity:1;border-color:${cssVal(p.accent)};box-shadow:0 0 0 ${Math.round(10 * u)}px ${cssVal(p.highlight)}}
.mnode.cur span{animation:popIn .6s ease-out .75s both}
.panel{display:flex;flex-direction:column;gap:${Math.round(20 * u)}px}
/* levels */
.hud{position:absolute;top:${z.top}px;left:${z.side}px;right:${z.side}px;display:flex;align-items:center;gap:${Math.round(20 * u)}px;font-weight:700;font-size:${Math.round(32 * u)}px}
.lvl{padding:${Math.round(8 * u)}px ${Math.round(18 * u)}px;border:${Math.round(3 * u)}px solid ${cssVal(p.text)};border-radius:${Math.round(10 * u)}px;text-transform:uppercase}
.hearts{display:flex;gap:${Math.round(8 * u)}px}.hearts i{width:${Math.round(26 * u)}px;height:${Math.round(26 * u)}px;border-radius:50%;background:${cssVal(p.highlight)};border:${Math.round(3 * u)}px solid ${cssVal(p.text)}}
.bar{flex:1;height:${Math.round(22 * u)}px;border:${Math.round(3 * u)}px solid ${cssVal(p.text)};border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:${cssVal(p.highlight)};animation:bar .8s ease-out .2s both}
/* case */
.file{position:absolute;top:${z.top}px;left:${z.side}px;right:${z.side}px;display:flex;justify-content:space-between;font-size:${Math.round(26 * u)}px;letter-spacing:.12em;color:${cssVal(p.muted)};border-bottom:${Math.round(2 * u)}px solid ${cssVal(p.line)};padding-bottom:${Math.round(12 * u)}px}
.track{position:absolute;left:${z.side}px;right:${z.side}px;bottom:${capBottom + capH + Math.round(8 * u)}px;display:flex;gap:${Math.round(8 * u)}px}.track i{flex:1;height:${Math.round(8 * u)}px;border-radius:9px;background:${cssVal(p.line)};font-size:0}.track i.on{background:${cssVal(p.accent)}}
/* calendar */
.cal{position:absolute;top:${z.top}px;left:${z.side}px;width:${Math.round(260 * u)}px;filter:drop-shadow(0 ${Math.round(8 * u)}px ${Math.round(14 * u)}px rgba(0,0,0,.15))}
.rings{display:flex;justify-content:space-around;height:${Math.round(26 * u)}px}.rings i{width:${Math.round(18 * u)}px;height:${Math.round(40 * u)}px;border-radius:9px;background:${cssVal(p.muted)}}
.page{background:${cssVal(p.surface)};border-radius:${Math.round(16 * u)}px;border-top:${Math.round(40 * u)}px solid ${cssVal(p.accent)};padding:${Math.round(22 * u)}px;text-align:center;font-weight:700;font-size:${Math.round(48 * u)}px;transform-origin:top;animation:tear .7s cubic-bezier(.2,.8,.2,1) .05s both}
/* photo */
.kb{position:absolute;inset:0;overflow:hidden}.kb img{width:100%;height:100%;object-fit:cover;animation:kb ${s2(dur + 0.6)} linear both}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.15) 30%,rgba(0,0,0,.7) 100%)}
.spacer{flex:1}
@keyframes popIn{from{opacity:0;transform:scale(.86)}70%{opacity:1;transform:scale(1.03)}to{opacity:1;transform:none}}
@keyframes riseIn{from{opacity:0;transform:translateY(${Math.round(50 * u)}px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes flipIn{from{opacity:0;transform:perspective(1200px) rotateX(-80deg)}to{opacity:1;transform:none}}
@keyframes word{from{opacity:0;transform:translateY(${Math.round(12 * u)}px)}to{opacity:1;transform:none}}
@keyframes mark{to{background-size:100% ${style.highlight === "underline" ? ".14em" : style.highlight === "box" ? "100%" : "62%"}}}
@keyframes grow{from{transform:scale(0)}to{transform:none}}
@keyframes count{from{--n:0}to{--n:var(--to)}}
@keyframes ok{to{background:${cssVal(p.highlight)};color:${cssVal(p.highlightText)};border-color:${cssVal(p.text)}}}
@keyframes push{from{transform:scale(1)}to{transform:scale(1.05)}}
@keyframes cam{from{transform:var(--from)}to{transform:var(--to)}}
@keyframes dash{to{stroke-dashoffset:0}}
@keyframes bar{from{width:var(--from)}to{width:var(--to)}}
@keyframes tear{from{opacity:0;transform:rotateX(70deg)}to{opacity:1;transform:none}}
@keyframes kb{from{transform:scale(1.02) translate(0,0)}to{transform:scale(1.12) translate(-2%,-1.5%)}}
`;
  return `<!doctype html><html lang="hi"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<style>${css}</style></head><body>
${chrome}
<div class="content">${body}</div>
${caption}
${grain}
${brandLine}
</body></html>`;
}
