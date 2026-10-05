import "server-only";
import sharp from "sharp";
import type { Metadata, OutputInfo } from "sharp";
import { prisma } from "@/lib/prisma";
import { mediaStorage, sha256Hex, storageKeyFor } from "@/lib/media-storage";

/**
 * Validation + processing for scientific question images (NEET Phase 2).
 *
 * Input is trusted for nothing: the type comes from DECODING the bytes (not
 * the filename or the browser's MIME), and the decoder runs with a pixel
 * limit so a decompression bomb is refused before it is expanded.
 *
 * Output is always WebP, sRGB, auto-oriented, with EXIF/XMP/ICC/IPTC removed:
 *  - lossless sources (PNG, lossless WebP) → LOSSLESS WebP, so thin lines,
 *    small labels and bonds are bit-exact (diagrams compress very well);
 *  - lossy sources (JPEG, lossy WebP, AVIF) → WebP quality 90.
 * Large images are scaled down to fit 1600 × 2400 px (never up).
 */

export const MEDIA_LIMITS = {
  /**
   * Upload size. Diagrams are usually < 1 MB; scans and photos need headroom.
   * Kept under Next's 10 MB proxy body limit (nginx allows 20 MB).
   */
  maxUploadBytes: 8 * 1024 * 1024,
  /** Decoded pixels: 40 MP (e.g. 8000 × 5000). Larger is refused before decoding (bomb guard). */
  maxInputPixels: 40_000_000,
  maxSide: 10_000,
  minSide: 16,
  /** Delivered size: ~1.5× a 1080 px phone screen at full width, sharp in the zoom viewer. */
  maxOutputWidth: 1600,
  maxOutputHeight: 2400,
  lossyQuality: 90,
  /** A "lossless" result above this is photographic content: re-encode lossy instead. */
  losslessCeilingBytes: 1_500_000,
} as const;

const ACCEPTED: Record<string, { mime: string; exts: string[] }> = {
  png: { mime: "image/png", exts: ["png"] },
  jpeg: { mime: "image/jpeg", exts: ["jpg", "jpeg"] },
  webp: { mime: "image/webp", exts: ["webp"] },
  avif: { mime: "image/avif", exts: ["avif"] },
};

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

export interface ProcessedImage {
  bytes: Buffer;
  sha256: string;
  mime: "image/webp";
  width: number;
  height: number;
  original: { sha256: string; mime: string; width: number; height: number; bytes: number };
}

/** A filename is only checked (never used for storage): no paths, no dot-files, a raster extension. */
export function checkUploadFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  if (name.length > 200) return "File name is too long.";
  if (/[\\/\0]/.test(name) || name.includes("..")) return "File name must not contain a path.";
  if (name.startsWith(".")) return "Hidden (dot) files are not accepted.";
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return "File name contains unsafe characters.";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (!Object.values(ACCEPTED).some((a) => a.exts.includes(ext))) return "Only PNG, JPEG, WebP or AVIF images are accepted.";
  return null;
}

function decodedFormat(meta: Metadata): keyof typeof ACCEPTED | null {
  if (meta.format === "png" || meta.format === "jpeg" || meta.format === "webp") return meta.format;
  // libvips reports AVIF as heif; only the AV1 flavour (not HEIC) is accepted.
  if (meta.format === "heif" && meta.compression === "av1") return "avif";
  return null;
}

const isLosslessWebp = (buf: Buffer) => buf.length > 16 && buf.toString("ascii", 12, 16) === "VP8L";

export async function processScientificImage(input: Buffer, opts: { declaredMime?: string | null; filename?: string | null } = {}): Promise<ProcessedImage> {
  if (input.length === 0) throw new MediaValidationError("The file is empty.");
  if (input.length > MEDIA_LIMITS.maxUploadBytes) throw new MediaValidationError(`Images must be at most ${MEDIA_LIMITS.maxUploadBytes / 1024 / 1024} MB.`);
  const nameProblem = checkUploadFilename(opts.filename);
  if (nameProblem) throw new MediaValidationError(nameProblem);

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MEDIA_LIMITS.maxInputPixels, failOn: "error" }).metadata();
  } catch {
    throw new MediaValidationError("The file is not a readable image.");
  }
  const format = decodedFormat(meta);
  if (!format) throw new MediaValidationError(`Unsupported image type (${meta.format ?? "unknown"}). Only PNG, JPEG, WebP or AVIF; SVG is not accepted.`);
  const accepted = ACCEPTED[format];
  if (opts.declaredMime && opts.declaredMime !== "application/octet-stream" && opts.declaredMime !== accepted.mime) {
    throw new MediaValidationError(`The file content is ${accepted.mime} but it was sent as ${opts.declaredMime}.`);
  }
  if (opts.filename) {
    const ext = opts.filename.toLowerCase().split(".").pop() ?? "";
    if (!accepted.exts.includes(ext)) throw new MediaValidationError(`The file content is ${accepted.mime} but the name ends in .${ext}.`);
  }
  if ((meta.pages ?? 1) > 1) throw new MediaValidationError("Animated or multi-page images are not accepted.");
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  if (w < MEDIA_LIMITS.minSide || h < MEDIA_LIMITS.minSide) throw new MediaValidationError(`Images must be at least ${MEDIA_LIMITS.minSide} px on each side.`);
  if (w > MEDIA_LIMITS.maxSide || h > MEDIA_LIMITS.maxSide || w * h > MEDIA_LIMITS.maxInputPixels) {
    throw new MediaValidationError(`Image dimensions ${w}×${h} exceed the limit (${MEDIA_LIMITS.maxSide} px per side, ${MEDIA_LIMITS.maxInputPixels / 1e6} MP).`);
  }

  const lossless = format === "png" || (format === "webp" && isLosslessWebp(input));
  const pipeline = () =>
    sharp(input, { limitInputPixels: MEDIA_LIMITS.maxInputPixels, failOn: "error" })
      .autoOrient()
      .resize({ width: MEDIA_LIMITS.maxOutputWidth, height: MEDIA_LIMITS.maxOutputHeight, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb");
  let out: { data: Buffer; info: OutputInfo };
  try {
    // No .keepMetadata()/.withMetadata(): sharp writes no EXIF, XMP, IPTC or ICC.
    out = await pipeline().webp(lossless ? { lossless: true, effort: 5 } : { quality: MEDIA_LIMITS.lossyQuality, effort: 5, smartSubsample: true }).toBuffer({ resolveWithObject: true });
    if (lossless && out.data.length > MEDIA_LIMITS.losslessCeilingBytes) {
      out = await pipeline().webp({ quality: MEDIA_LIMITS.lossyQuality, effort: 5, smartSubsample: true }).toBuffer({ resolveWithObject: true });
    }
  } catch {
    throw new MediaValidationError("The image could not be processed (corrupted or truncated).");
  }

  return {
    bytes: out.data,
    sha256: sha256Hex(out.data),
    mime: "image/webp",
    width: out.info.width,
    height: out.info.height,
    original: { sha256: sha256Hex(input), mime: accepted.mime, width: w, height: h, bytes: input.length },
  };
}

export interface StoredMedia {
  sha256: string;
  storageKey: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** false when the identical processed file already existed (exact-duplicate upload). */
  created: boolean;
}

/**
 * Validates, processes and stores one image; returns its immutable MediaObject.
 * Exact duplicates (same original bytes, or a different original that
 * processes to the same bytes) reuse the existing file and row.
 */
export async function storeScientificImage(input: Buffer, opts: { declaredMime?: string | null; filename?: string | null; actorId?: string | null } = {}): Promise<StoredMedia> {
  const originalSha = sha256Hex(input);
  const known = await prisma.mediaObject.findFirst({ where: { originalSha256: originalSha } });
  if (known && (await mediaStorage().exists(known.storageKey))) {
    return { sha256: known.sha256, storageKey: known.storageKey, mime: known.mime, width: known.width, height: known.height, bytes: known.bytes, created: false };
  }

  const img = await processScientificImage(input, opts);
  const storageKey = storageKeyFor(img.sha256, "webp");
  const { created } = await mediaStorage().put(storageKey, img.bytes);
  const row =
    (await prisma.mediaObject.findUnique({ where: { sha256: img.sha256 } })) ??
    (await prisma.mediaObject
      .create({
        data: {
          sha256: img.sha256,
          storageKey,
          mime: img.mime,
          width: img.width,
          height: img.height,
          bytes: img.bytes.length,
          originalSha256: img.original.sha256,
          originalMime: img.original.mime,
          originalWidth: img.original.width,
          originalHeight: img.original.height,
          originalBytes: img.original.bytes,
          createdById: opts.actorId ?? null,
        },
      })
      // A concurrent identical upload won the insert: same content, same row.
      .catch(async () => prisma.mediaObject.findUniqueOrThrow({ where: { sha256: img.sha256 } })));
  return { sha256: row.sha256, storageKey: row.storageKey, mime: row.mime, width: row.width, height: row.height, bytes: row.bytes, created };
}
