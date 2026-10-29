import "server-only";
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageRootDir } from "@/lib/question-images";
import { renderSlideJpeg, type RenderInput } from "@/lib/instagram/render";

/**
 * Cache + bounded concurrency for the admin slide images (editor preview, thumbnails, downloads).
 *
 * Satori + sharp run on the web workers of a 2-vCPU host, and the Bulk / publish panels request many slides at
 * once. So:
 *  - at most RENDER_CONCURRENCY renders run per process (others wait in order; the same slide is rendered once);
 *  - a finished JPEG is kept on disk, keyed by a hash of EVERYTHING it is drawn from (snapshot, content, design,
 *    settings, slide index, JPEG quality) plus the release directory — any edit or deploy gives a new key, so a
 *    stale image is never served;
 *  - entries unused for CACHE_TTL_MS are removed, and the folder is trimmed to CACHE_MAX_BYTES.
 * The publisher (lib/instagram/publish.ts) does not use this cache: it renders its own immutable snapshot.
 */

export const RENDER_CONCURRENCY = 1;
const CACHE_SUBDIR = "instagram-render-cache";
const CACHE_TTL_MS = 7 * 86_400_000;
const CACHE_MAX_BYTES = 300 * 1024 * 1024;
const SWEEP_EVERY_MS = 60 * 60_000;
const KEY_RE = /^[a-f0-9]{64}$/;

let releaseId: string | null = null;
function release(): string {
  if (releaseId === null) {
    try {
      releaseId = realpathSync(process.cwd());
    } catch {
      releaseId = process.cwd();
    }
  }
  return releaseId;
}

export function cacheRoot(): string {
  return path.join(storageRootDir(), CACHE_SUBDIR);
}

/** Deterministic key; exported for the test suite. */
export function renderCacheKey(input: RenderInput, index: number, quality: number, releaseTag = release()): string {
  return crypto.createHash("sha256").update(JSON.stringify(["ig-slide-cache-v1", releaseTag, index, quality, input])).digest("hex");
}

function fileFor(key: string): string {
  if (!KEY_RE.test(key)) throw new Error("Invalid cache key.");
  return path.join(cacheRoot(), key.slice(0, 2), `${key}.jpg`);
}

// ---- Concurrency ---------------------------------------------------------------------------------

let active = 0;
const waiting: (() => void)[] = [];
const inFlight = new Map<string, Promise<Buffer>>();

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= RENDER_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** For tests and diagnostics. */
export function renderQueueState() {
  return { active, waiting: waiting.length, inFlight: inFlight.size };
}

// ---- Cache ---------------------------------------------------------------------------------------

let lastSweep = 0;

/** Renders slide `index`, or returns the cached JPEG for the identical input. */
export async function renderSlideJpegCached(input: RenderInput, index: number, quality = 92, render: typeof renderSlideJpeg = renderSlideJpeg): Promise<Buffer> {
  const key = renderCacheKey(input, index, quality);
  const file = fileFor(key);
  const hit = await readFile(file).catch(() => null);
  if (hit && hit.length > 0) {
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
    return hit;
  }
  const running = inFlight.get(key);
  if (running) return running;
  const job = withSlot(() => render(input, index, quality))
    .then(async (jpeg) => {
      await store(file, jpeg).catch((e: unknown) => console.error("[instagram-render-cache] store", (e as Error)?.message));
      if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = Date.now();
        void sweepRenderCache().catch(() => 0);
      }
      return jpeg;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function store(file: string, jpeg: Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a reader never sees a half-written file (two workers may render the same slide).
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, jpeg);
  await rename(tmp, file);
}

/** Removes entries unused for CACHE_TTL_MS, leftover temp files, then the oldest until under CACHE_MAX_BYTES. */
export async function sweepRenderCache(now = Date.now(), opts: { ttlMs?: number; maxBytes?: number } = {}): Promise<{ removed: number; keptBytes: number }> {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const max = opts.maxBytes ?? CACHE_MAX_BYTES;
  const root = cacheRoot();
  const entries: { file: string; size: number; mtime: number }[] = [];
  let removed = 0;
  for (const dir of await readdir(root).catch(() => [] as string[])) {
    if (!/^[a-f0-9]{2}$/.test(dir)) continue;
    for (const name of await readdir(path.join(root, dir)).catch(() => [] as string[])) {
      const file = path.join(root, dir, name);
      const s = await stat(file).catch(() => null);
      if (!s?.isFile()) continue;
      const stale = name.endsWith(".tmp") ? now - s.mtimeMs > 10 * 60_000 : !/^[a-f0-9]{64}\.jpg$/.test(name) || now - s.mtimeMs > ttl;
      if (stale) {
        await rm(file, { force: true }).catch(() => {});
        removed++;
      } else if (!name.endsWith(".tmp")) entries.push({ file, size: s.size, mtime: s.mtimeMs });
    }
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= max) break;
    await rm(e.file, { force: true }).catch(() => {});
    total -= e.size;
    removed++;
  }
  return { removed, keptBytes: total };
}
