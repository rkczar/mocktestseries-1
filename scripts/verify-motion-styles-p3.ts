/**
 * Motion Workflow Studio — Phase 3 styles (Whiteboard Draw, Kinetic Typography). Pure: no database, no
 * network, no render container.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-motion-styles-p3.ts [baseline-ref]
 *
 * Proves: the six earlier styles produce byte-identical frame documents to `baseline-ref` (default
 * bd436bd, the commit before Phase 3) for every frame type and aspect; the new styles are deterministic
 * CSS only (no script, no transition, every animation name defined), stay inside the Instagram safe zone
 * with readable captions, and time their writing / word landings from the narration.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ASPECT_MAP, type AspectRatio } from "@/lib/video-studio/types";
import { MOTION_STYLES, MOTION_STYLE_MAP, TRANSITIONS, contrastRatio } from "@/lib/video-studio/motion/styles";
import { FRAME_TYPES, safeZone, type MotionVisual } from "@/lib/video-studio/motion/storyboard";
import { motionFrameDocument, type MotionDocOptions, type MotionFrameInput } from "@/lib/video-studio/motion/template";

let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const OLD = ["concept_map", "level_up", "case_story", "time_course", "big_sentence", "photo_story"];
const NEW = ["whiteboard", "kinetic_type"];
const ASPECTS: AspectRatio[] = ["9:16", "16:9", "1:1", "4:5"];
const WORDS = [
  { text: "Troponin", start: 0.4, end: 0.9 },
  { text: "I", start: 0.95, end: 1.05 },
  { text: "rises", start: 1.1, end: 1.4 },
  { text: "by", start: 1.45, end: 1.55 },
  { text: "six", start: 1.6, end: 1.8 },
  { text: "hours", start: 1.85, end: 2.3 },
];

function frame(type: (typeof FRAME_TYPES)[number], motion: MotionVisual["motion"]): MotionFrameInput {
  return {
    sentence: "Troponin I rises by six hours",
    onScreen: "Troponin I rises by six hours",
    visual: { kind: "motion", type, motion, highlight: "hours", tag: "Level 1", nodes: ["Plaque rupture", "Thrombus", "Necrosis"], items: ["Myoglobin", "Troponin I"], value: "6", unit: "hours", left: "CK-MB", right: "Troponin", stem: "Most specific marker?", options: [{ label: "A", text: "Myoglobin" }, { label: "B", text: "Troponin I" }], correctLabel: "B", revealAtSec: 1.5 },
  };
}
function opts(styleKey: string, aspect: AspectRatio, over: Partial<MotionDocOptions> = {}): MotionDocOptions {
  return { aspect, styleKey, index: 1, all: [{ onScreen: "a", tag: null }, { onScreen: "b", tag: null }, { onScreen: "c", tag: null }], durationSec: 4, words: WORDS, subtitles: true, brand: { wordmark: "MockTestSeries.in", examLabel: null, showBranding: true, cta: "" }, imageSrc: null, fontBase: "http://render.local/fonts/", fontOrigin: "http://render.local", ...over };
}
const cssOf = (html: string) => html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
const px = (css: string, sel: string, prop: string) => {
  const rule = css.split("\n").find((l) => l.startsWith(`${sel}{`)) ?? "";
  const m = new RegExp(`[{;]${prop}:(-?\\d+)px`).exec(rule);
  return m ? Number(m[1]) : null;
};

async function main() {
  const ref = process.argv[2] ?? "bd436bd";

  console.log("A. Style library");
  await check("eight styles: the six earlier ones unchanged in order, plus Whiteboard Draw and Kinetic Typography", () => {
    assert.deepEqual(MOTION_STYLES.map((s) => s.key), [...OLD, ...NEW]);
    for (const k of NEW) {
      const s = MOTION_STYLE_MAP[k];
      assert.equal(s.status, "ready");
      assert.ok(s.motions.length >= 2);
      assert.ok((TRANSITIONS as readonly string[]).includes(s.transition.type));
      assert.ok((contrastRatio(s.palette.text, s.palette.background) ?? 0) >= 7, `${k} text contrast ≥ 7:1`);
      assert.ok((contrastRatio(s.palette.highlightText, s.palette.highlight) ?? 0) >= 4.5, `${k} highlight contrast`);
    }
  });

  console.log("B. Earlier styles are byte-identical to " + ref);
  await check(`every earlier style × frame type × aspect: same document as ${ref}`, async () => {
    // The baseline template is loaded from git next to the current one (same imports), compared, then removed.
    const src = execFileSync("git", ["show", `${ref}:lib/video-studio/motion/template.ts`], { encoding: "utf8" });
    const tmp = path.join(process.cwd(), "lib/video-studio/motion/.baseline-template.ts");
    await writeFile(tmp, src);
    try {
      const base = (await import(tmp)) as { motionFrameDocument: typeof motionFrameDocument };
      let n = 0;
      for (const k of OLD)
        for (const a of ASPECTS)
          for (const t of FRAME_TYPES)
            for (const m of MOTION_STYLE_MAP[k].motions) {
              const f = frame(t, m);
              const o = opts(k, a, { imageSrc: t === "image" || k === "photo_story" ? "data:image/png;base64,iVBORw0KGgo=" : null });
              assert.equal(motionFrameDocument(f, o), base.motionFrameDocument(f, o), `${k}/${a}/${t}/${m}`);
              n++;
            }
      assert.ok(n > 400, `${n} documents compared`);
    } finally {
      await rm(tmp, { force: true });
    }
  });

  console.log("C. New styles: deterministic, safe, readable");
  await check("pure: the same input gives the same document; no script, no CSS transition, no JS time source", () => {
    for (const k of NEW)
      for (const a of ASPECTS)
        for (const t of FRAME_TYPES) {
          const f = frame(t, MOTION_STYLE_MAP[k].motions[0]);
          const html = motionFrameDocument(f, opts(k, a));
          assert.equal(html, motionFrameDocument(f, opts(k, a)));
          assert.ok(!/<script|javascript:|\bon[a-z]+=/i.test(html), `${k}/${t}`);
          assert.ok(!/(^|[;{\s])transition\s*:/m.test(cssOf(html)), `${k}/${t}: CSS transitions are not seekable`);
          assert.ok(!/<animate|<set\b/i.test(html), "no SMIL (not seeked by the renderer)");
        }
  });

  await check("every animation name used is a defined @keyframes (the renderer seeks CSS animations only)", () => {
    for (const k of NEW)
      for (const t of FRAME_TYPES)
        for (const m of MOTION_STYLE_MAP[k].motions) {
          const html = motionFrameDocument(frame(t, m), opts(k, "9:16"));
          const css = cssOf(html);
          const defined = new Set([...css.matchAll(/@keyframes ([\w-]+)/g)].map((x) => x[1]));
          const used = new Set<string>();
          for (const x of css.matchAll(/animation(?:-name)?:([^;}]+)/g))
            for (const part of x[1].split(",")) {
              const name = part.trim().split(/\s+/)[0];
              if (name && name !== "none" && !/^[\d.]/.test(name) && !name.startsWith("var(")) used.add(name);
            }
          for (const u of used) assert.ok(defined.has(u), `${k}/${t}: animation "${u}" has no @keyframes`);
        }
  });

  await check("safe zone: content, captions and brand line stay inside the platform safe zone at every aspect", () => {
    for (const k of NEW)
      for (const a of ASPECTS) {
        const { width: W, height: H } = ASPECT_MAP[a];
        const z = safeZone(a);
        const css = cssOf(motionFrameDocument(frame("statement", MOTION_STYLE_MAP[k].motions[0]), opts(k, a)));
        assert.ok(px(css, ".content", "top")! >= z.top, `${k}/${a} content top`);
        assert.ok(px(css, ".content", "bottom")! >= z.bottom, `${k}/${a} content bottom`);
        assert.ok(px(css, ".content", "left")! >= z.side && px(css, ".content", "right")! >= z.side, `${k}/${a} sides`);
        assert.ok(px(css, ".cap", "bottom")! >= z.bottom, `${k}/${a} captions above the bottom UI`);
        assert.ok(px(css, ".cap", "left")! >= z.side, `${k}/${a} caption sides`);
        const u = Math.min(W, H) / 1080;
        assert.ok(px(css, ".cap", "font-size")! >= Math.round(44 * u), `${k}/${a} caption size`);
        assert.ok(px(css, ".cap", "font-size")! >= 30, `${k}/${a} caption ≥ 30 px`);
      }
  });

  await check("Whiteboard: headline written left to right within 0.8–1.8 s, key word underlined after it is written", () => {
    const html = motionFrameDocument(frame("statement", "draw"), opts("whiteboard", "9:16"));
    const parts = [...html.matchAll(/<span class="wr" style="--d:([\d.]+)s;--w:([\d.]+)s">(.*?)<\/span>/g)].map((m) => ({ d: Number(m[1]), w: Number(m[2]), t: m[3] }));
    assert.equal(parts.length, 6);
    for (let i = 1; i < parts.length; i++) assert.ok(parts[i].d >= parts[i - 1].d + parts[i - 1].w - 0.011, "word i starts when word i−1 is written");
    const end = parts[parts.length - 1].d + parts[parts.length - 1].w;
    assert.ok(end <= 0.1 + 1.8 + 0.13 && end >= 0.8, `writing ends at ${end}`);
    const mark = /<mark style="--h:([\d.]+)s">hours<\/mark>/.exec(html);
    assert.ok(mark && Number(mark[1]) >= parts[5].d + parts[5].w - 0.011, "underline after the word is written");
    assert.equal((html.match(/<mark /g) ?? []).length, 1);
    assert.match(cssOf(html), /@property --a\{syntax:'<angle>'/);
    assert.match(cssOf(html), /mask:conic-gradient/, "outlines drawn by an animated conic mask");
    assert.match(cssOf(html), /\.cap\{font-family:MTSLatin/, "captions stay in the readable sans font");
  });

  await check("Kinetic: each word lands at its spoken time, in order, within 60 % of the frame; the key word once", () => {
    const html = motionFrameDocument(frame("statement", "pop"), opts("kinetic_type", "16:9"));
    const lands = [...html.matchAll(/<span class="kw k(\d)( hi)?" style="--d:([\d.]+)s">(.*?)<\/span>/g)].map((m) => ({ k: Number(m[1]), hi: Boolean(m[2]), d: Number(m[3]), t: m[4] }));
    assert.deepEqual(lands.map((l) => l.t), ["Troponin", "I", "rises", "by", "six", "hours"]);
    assert.deepEqual(lands.map((l) => l.d), [0.4, 0.95, 1.1, 1.45, 1.6, 1.85], "spoken times");
    assert.deepEqual(lands.map((l) => l.k), [0, 1, 2, 3, 0, 1], "entrances rotate");
    assert.deepEqual(lands.filter((l) => l.hi).map((l) => l.t), ["hours"]);
    // Words that are not in the narration still land in order on a steady beat, never after 60 % of the frame.
    const off = motionFrameDocument({ ...frame("statement", "pop"), onScreen: "Alpha beta gamma delta epsilon zeta eta theta" }, opts("kinetic_type", "9:16", { words: [], durationSec: 2 }));
    const ds = [...off.matchAll(/class="kw[^"]*" style="--d:([\d.]+)s"/g)].map((m) => Number(m[1]));
    for (let i = 1; i < ds.length; i++) assert.ok(ds[i] >= ds[i - 1], "monotonic");
    assert.ok(Math.max(...ds) <= 1.2 + 1e-9, "≤ 60 % of 2 s");
  });
}

main()
  .then(() => console.log(`\n${passed} passed, 0 failed`))
  .catch((e) => {
    console.error(e);
    console.log(`\n${passed} passed, 1 failed`);
    process.exit(1);
  });
