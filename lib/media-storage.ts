import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { storageRootDir } from "@/lib/question-images";

/**
 * Immutable, content-addressed media storage (NEET Phase 2).
 *
 * The database stores only a storage KEY — `q/<aa>/<sha256>.webp`, where
 * <sha256> is the hash of the stored bytes and <aa> its first two hex digits
 * (keeps directories small). Never an absolute path, never image bytes.
 * The public URL is `/media/<key>`, served by nginx straight from the shared
 * persistent storage (ops/nginx/), so a new file is live immediately, with an
 * immutable one-year cache, and Next.js never serves it.
 *
 * Drivers: LOCAL (shared storage, `<STORAGE_DIR>/media/<key>`) today. An
 * S3-compatible driver (Cloudflare R2) only has to implement put/exists/read
 * with the SAME keys — QuestionAsset rows and snapshots don't change.
 *
 * Rules every driver keeps:
 *  - put() NEVER overwrites. A key is the hash of its bytes, so an existing
 *    file with the same key is the same content (verified, not assumed).
 *  - There is no delete. A question that stops using an image only drops its
 *    QuestionAsset reference; frozen attempt snapshots keep the file alive.
 *    A future garbage collector must check every snapshot first.
 */

export const MEDIA_URL_PREFIX = "/media/";
export const MEDIA_SUBDIR = "media";

/** `q/<aa>/<64 hex>.<ext>` (Phase 2 layout) or the flat `q/<64 hex>.<ext>`; raster extensions only. */
const KEY_PATTERN = /^q\/(?:[0-9a-f]{2}\/)?[0-9a-f]{64}\.(webp|png|jpg|avif)$/;
/** The looser Phase 1 rule kept for reading frozen snapshots (safe relative raster path, no dot segments). */
const LEGACY_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_.-]*)*\.(webp|png|jpe?g|avif)$/i;

export function isContentAddressedKey(key: unknown): key is string {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

/** Any key a snapshot may hold: safe, relative, raster, no `..`. */
export function isSafeStorageKey(key: unknown): key is string {
  return typeof key === "string" && LEGACY_KEY_PATTERN.test(key) && !key.includes("..") && !key.split("/").some((s) => s.startsWith("."));
}

export function storageKeyFor(sha256: string, ext: "webp" | "png" | "jpg" | "avif"): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid sha256");
  return `q/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

export function mediaUrl(key: unknown): string | null {
  return isSafeStorageKey(key) ? MEDIA_URL_PREFIX + key : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface MediaStorageDriver {
  readonly kind: "local";
  /** Stores bytes under a content-addressed key. Never overwrites; `created:false` = already present (same bytes). */
  put(key: string, bytes: Buffer): Promise<{ created: boolean }>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<Buffer>;
}

export function mediaRootDir(): string {
  return path.join(storageRootDir(), MEDIA_SUBDIR);
}

class LocalMediaStorage implements MediaStorageDriver {
  readonly kind = "local" as const;
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    if (!isContentAddressedKey(key)) throw new Error("Refusing a non content-addressed media key");
    const full = path.join(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Media key escapes the media root");
    return full;
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async put(key: string, bytes: Buffer): Promise<{ created: boolean }> {
    const target = this.pathFor(key);
    const expected = key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("."));
    if (sha256Hex(bytes) !== expected) throw new Error("Media bytes do not match their content-addressed key");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    if (await this.exists(key)) return this.verifyExisting(key, expected);

    // Write to a private temp file, fsync, then hard-link into place: link()
    // fails with EEXIST instead of replacing, so even two concurrent uploads of
    // the same image can never overwrite (or expose a half-written) file.
    const tmp = path.join(path.dirname(target), `.tmp-${randomBytes(8).toString("hex")}`);
    const fh = await open(tmp, "wx", 0o644);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, target);
      return { created: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return this.verifyExisting(key, expected);
      throw e;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  private async verifyExisting(key: string, expected: string): Promise<{ created: boolean }> {
    if (sha256Hex(await this.read(key)) !== expected) {
      throw new Error(`Stored media ${key} does not match its hash — refusing to overwrite; investigate the file`);
    }
    return { created: false };
  }
}

let driver: MediaStorageDriver | null = null;

/** The configured driver. MEDIA_DRIVER defaults to "local" (the only one until R2 is approved). */
export function mediaStorage(): MediaStorageDriver {
  if (driver) return driver;
  const kind = process.env.MEDIA_DRIVER ?? "local";
  if (kind !== "local") throw new Error(`Unsupported MEDIA_DRIVER "${kind}"`);
  driver = new LocalMediaStorage(path.resolve(mediaRootDir()));
  return driver;
}
