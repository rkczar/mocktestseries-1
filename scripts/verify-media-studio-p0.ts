/**
 * Media Studio Phase 0 — regression for three fixes. Pure: no database, no network, no paid call.
 *
 *  A. Text routing never picks an image-generation model (2026-10: google/gemini-3.1-flash-image-preview
 *     answered 248 Instagram text calls, truncated or empty), while image routing still accepts it.
 *  B. Image pricing: a token-priced image model with an implausible "units per image" (0.0006 — a price typed
 *     into the token field) gives an UNKNOWN estimate, never ₹0; a real token count prices correctly.
 *  C. Instagram slide render cache: same input → one render, byte-identical; any change → new render;
 *     at most RENDER_CONCURRENCY renders at once; concurrent identical requests share one render;
 *     the sweep removes expired / temp files and trims to the size cap. One REAL Satori render of the
 *     built-in sample is cached and served identically.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-media-studio-p0.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Isolated storage for the cache (never the shared production storage).
const TMP = mkdtempSync(path.join(os.tmpdir(), "mts-p0-"));
process.env.STORAGE_DIR = TMP;
// Any accidental outbound request fails the suite.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: unknown) => {
  const url = String(u instanceof Request ? u.url : u);
  if (url.startsWith("data:")) return realFetch(url);
  throw new Error(`Unexpected network request: ${url}`);
}) as typeof fetch;

let passes = 0;
let failures = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passes++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        → ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n          ")}`);
  }
}

async function main() {
  const { textEligibility, imageEligibility } = await import("@/lib/ai-engine/router");
  const cfg = await import("@/lib/ai-engine/config");
  const cache = await import("@/lib/instagram/render-cache");
  const { SAMPLE_INPUT } = await import("@/lib/instagram/sample");
  type Model = Parameters<typeof textEligibility>[0];

  const base: Model = {
    id: "vendor/text-model",
    name: "Text model",
    vendor: "vendor",
    contextLength: 128_000,
    maxCompletionTokens: 16_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: ["response_format"],
    promptPrice: 1e-7,
    completionPrice: 4e-7,
    reasoningPrice: null,
    requestPrice: null,
    imageUnit: null,
    imageUnitCostUsd: null,
    imageUnitsPerImage: null,
    pricingRaw: null,
    isImageModel: false,
    expirationDate: null,
    approved: true,
    medicallyApproved: true,
    disabled: false,
    notes: null,
    missingSince: null,
    lastSyncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Model;
  // The production row (2026-10-29), as read from the catalog.
  const imagePreview: Model = {
    ...base,
    id: "google/gemini-3.1-flash-image-preview",
    inputModalities: ["image", "text"],
    outputModalities: ["image", "text"],
    promptPrice: 5e-7,
    completionPrice: 3e-6,
    isImageModel: true,
    imageUnit: "token",
    imageUnitCostUsd: 0.00006,
    imageUnitsPerImage: 0.0006,
  } as Model;

  console.log("\nA. Text routing excludes image-generation models");
  for (const feature of ["ig_carousel", "ig_trap", "ig_diagram", "ig_caption", "explanation"] as const) {
    await check(`${feature}: image-preview model is not a text candidate; a normal text model is`, () => {
      const e = textEligibility(imagePreview, feature, 2000, 3000);
      assert.equal(e.ok, false);
      assert.match(e.reason ?? "", /image-generation model/);
      assert.equal(textEligibility(base, feature, 2000, 3000).ok, true);
    });
  }
  await check("a model listing image OUTPUT is excluded even if isImageModel is unset", () => {
    assert.equal(textEligibility({ ...base, outputModalities: ["text", "image"] } as Model, "ig_carousel", 1000, 1000).ok, false);
  });
  await check("image INPUT (vision) text models stay eligible", () => {
    assert.equal(textEligibility({ ...base, inputModalities: ["text", "image"] } as Model, "ig_carousel", 1000, 1000).ok, true);
  });

  console.log("\nB. Image price: implausible units → unknown, real token count → priced");
  await check("0.0006 units per image (production value) → null estimate, image route refuses with a reason", () => {
    assert.equal(cfg.imageMaxUsd(imagePreview, 0.79), null);
    const e = imageEligibility(imagePreview, "ig_image");
    assert.equal(e.ok, false);
    assert.match(e.reason ?? "", /cannot be estimated/);
  });
  await check("1,150 tokens per image ≈ $0.069 (matches the 3 actual charges $0.0685–0.0689)", () => {
    const fixed = { ...imagePreview, imageUnitsPerImage: 1150 } as Model;
    const usd = cfg.imageMaxUsd(fixed, 0.79)!;
    assert.ok(Math.abs(usd - 0.069) < 1e-9, String(usd));
    assert.equal(imageEligibility(fixed, "ig_image").ok, true);
  });
  await check("per-image and per-megapixel units are unaffected by the token threshold", () => {
    assert.equal(cfg.imageMaxUsd({ ...imagePreview, imageUnit: "image", imageUnitCostUsd: 0.04, imageUnitsPerImage: null } as Model, 0.79), 0.04);
    assert.ok(Math.abs(cfg.imageMaxUsd({ ...imagePreview, imageUnit: "megapixel", imageUnitCostUsd: 0.05 } as Model, 0.79)! - 0.0395) < 1e-12);
    assert.equal(cfg.minUnitsPerImage("token"), 16);
    assert.ok(cfg.minUnitsPerImage(null) < 1e-300);
  });

  console.log("\nC. Instagram slide render cache");
  let calls = 0;
  let concurrent = 0;
  let peak = 0;
  const fake = async (input: typeof SAMPLE_INPUT, index: number, quality = 92) => {
    calls++;
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 25));
    concurrent--;
    return Buffer.from(`jpeg:${index}:${quality}:${input.content.explanation.length}:${calls}`);
  };
  await check("same input → rendered once, second call served from disk byte-identical", async () => {
    const a = await cache.renderSlideJpegCached(SAMPLE_INPUT, 0, 92, fake);
    const b = await cache.renderSlideJpegCached(SAMPLE_INPUT, 0, 92, fake);
    assert.equal(calls, 1);
    assert.ok(a.equals(b));
  });
  await check("an edit (content), another slide, another quality or another release → a new key", () => {
    const k = cache.renderCacheKey(SAMPLE_INPUT, 0, 92, "rel-a");
    assert.notEqual(k, cache.renderCacheKey({ ...SAMPLE_INPUT, content: { ...SAMPLE_INPUT.content, explanation: SAMPLE_INPUT.content.explanation + "." } }, 0, 92, "rel-a"));
    assert.notEqual(k, cache.renderCacheKey(SAMPLE_INPUT, 1, 92, "rel-a"));
    assert.notEqual(k, cache.renderCacheKey(SAMPLE_INPUT, 0, 85, "rel-a"));
    assert.notEqual(k, cache.renderCacheKey(SAMPLE_INPUT, 0, 92, "rel-b"));
    assert.notEqual(k, cache.renderCacheKey({ ...SAMPLE_INPUT, design: { ...SAMPLE_INPUT.design, bodyScale: 1.1 } }, 0, 92, "rel-a"));
    assert.equal(k, cache.renderCacheKey(SAMPLE_INPUT, 0, 92, "rel-a"));
  });
  await check("12 different slides requested at once → never more than RENDER_CONCURRENCY renders in parallel", async () => {
    calls = 0;
    peak = 0;
    const inputs = Array.from({ length: 12 }, (_, i) => ({ ...SAMPLE_INPUT, content: { ...SAMPLE_INPUT.content, explanation: `${SAMPLE_INPUT.content.explanation} ${"x".repeat(i + 1)}` } }));
    await Promise.all(inputs.map((inp) => cache.renderSlideJpegCached(inp, 0, 92, fake)));
    assert.equal(calls, 12);
    assert.equal(peak, cache.RENDER_CONCURRENCY);
    assert.deepEqual(cache.renderQueueState(), { active: 0, waiting: 0, inFlight: 0 });
  });
  await check("5 identical concurrent requests share ONE render", async () => {
    calls = 0;
    const inp = { ...SAMPLE_INPUT, content: { ...SAMPLE_INPUT.content, explanation: "shared request" } };
    const out = await Promise.all(Array.from({ length: 5 }, () => cache.renderSlideJpegCached(inp, 2, 92, fake)));
    assert.equal(calls, 1);
    assert.ok(out.every((b) => b.equals(out[0])));
  });
  await check("a failed render is not cached and the next request renders again", async () => {
    const inp = { ...SAMPLE_INPUT, content: { ...SAMPLE_INPUT.content, explanation: "will fail once" } };
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) throw new Error("boom");
      return Buffer.from("ok");
    };
    await assert.rejects(cache.renderSlideJpegCached(inp, 0, 92, flaky), /boom/);
    assert.equal((await cache.renderSlideJpegCached(inp, 0, 92, flaky)).toString(), "ok");
    assert.equal(n, 2);
  });
  await check("sweep: expired entries + stale temp files removed, then oldest trimmed to the size cap", async () => {
    const root = cache.cacheRoot();
    const dir = path.join(root, "ab");
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 8 * 86_400_000);
    const expired = path.join(dir, `${"ab".padEnd(64, "1")}.jpg`);
    await writeFile(expired, "x");
    await utimes(expired, old, old);
    const tmp = path.join(dir, `${"ab".padEnd(64, "2")}.jpg.1.aa.tmp`);
    await writeFile(tmp, "x");
    await utimes(tmp, old, old);
    const r = await cache.sweepRenderCache(Date.now(), { maxBytes: 40 });
    assert.ok(r.removed >= 2);
    assert.ok(r.keptBytes <= 40, String(r.keptBytes));
    await assert.rejects(stat(expired));
    await assert.rejects(stat(tmp));
  });
  await check("REAL render of the sample slide: 1080×1350 JPEG, cached, served identically, no network", async () => {
    const sharp = (await import("sharp")).default;
    const inp = { ...SAMPLE_INPUT };
    const t0 = Date.now();
    const a = await cache.renderSlideJpegCached(inp, 1, 85);
    const first = Date.now() - t0;
    const t1 = Date.now();
    const b = await cache.renderSlideJpegCached(inp, 1, 85);
    const second = Date.now() - t1;
    assert.ok(a.equals(b));
    const meta = await sharp(a).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1350);
    const files = (await readdir(cache.cacheRoot(), { recursive: true })).filter((f) => String(f).endsWith(".jpg"));
    assert.ok(files.length >= 1);
    console.log(`        (render ${first} ms, cached ${second} ms, ${a.length} bytes)`);
  });

  rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
