/**
 * Instagram Content Studio — renders sample carousels (all templates, 3–6 slides,
 * PYQ + Most Missed) from SYNTHETIC data to a folder, no database needed.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/ig-studio-render-samples.ts <outDir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { renderSlideJpeg, type RenderInput } from "@/lib/instagram/render";
import { defaultDesign, TEMPLATE_KEYS, type SlideCount } from "@/lib/instagram/types";
import { SAMPLE_INPUT as base } from "@/lib/instagram/sample";

const out = process.argv[2] ?? "/tmp/ig-samples";

// The renderer must never reach the network (Satori fetches missing glyphs/emoji). Any fetch fails the run.
const fetches: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("data:")) return realFetch(input, init); // the renderer's own bundled wasm
  fetches.push(url);
  throw new Error("network disabled in slide rendering");
}) as typeof fetch;

async function sheet(files: string[], dest: string) {
  const w = 360, h = 450, gap = 16;
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h).toBuffer()));
  await sharp({ create: { width: tiles.length * (w + gap) + gap, height: h + 2 * gap, channels: 3, background: "#444" } })
    .composite(tiles.map((input, i) => ({ input, left: gap + i * (w + gap), top: gap })))
    .jpeg()
    .toFile(dest);
}

async function carousel(name: string, input: RenderInput) {
  const dir = path.join(out, name);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < input.design.modules.length; i++) {
    const f = path.join(dir, `slide-${i + 1}.jpg`);
    await writeFile(f, await renderSlideJpeg(input, i));
    files.push(f);
  }
  await sheet(files, path.join(out, `${name}-sheet.jpg`));
  console.log(`${name}: ${files.length} slides`);
}

async function main() {
  for (const tpl of TEMPLATE_KEYS) await carousel(`pyq-5-${tpl}`, { ...base, design: defaultDesign(tpl, 5) });
  for (const n of [3, 4, 6] as SlideCount[]) await carousel(`pyq-${n}-midnight`, { ...base, design: defaultDesign("midnight", n) });
  await carousel("mostmissed-5-midnight", {
    ...base,
    series: "MOST_MISSED",
    content: { ...base.content, hookText: "Most Aspirants Missed This One" },
    seriesStats: { attempts: 214, wrong: 151, wrongPct: 70.56, rangeLabel: "Yesterday", headlineSuffix: "YESTERDAY", rangePreset: "yesterday", capturedAt: new Date().toISOString() },
  });
  await carousel("greek-emoji-midnight", {
    ...base,
    snapshot: {
      ...base.snapshot,
      text: "β-lactamase inhibitor combined with amoxicillin is: (α and γ forms excluded; Ca⁺⁺ dependent?)",
      options: base.snapshot.options.map((o, i) => (i === 1 ? { ...o, text: "Clavulanic acid (β-lactam)" } : o)),
    },
    content: { ...base.content, hookText: "🔥 Can You Solve This β-lactam PYQ?" },
    design: defaultDesign("midnight", 3),
  });
  if (fetches.length) {
    console.error(`FAIL: renderer attempted ${fetches.length} network request(s):`, fetches.slice(0, 5));
    process.exit(1);
  }
  console.log("OK: no network requests");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
