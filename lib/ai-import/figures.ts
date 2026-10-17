import "server-only";
import sharp, { type Metadata } from "sharp";
import { putContent } from "@/lib/ai-import/vault";
import type { NBox } from "@/lib/ai-import/types";

/**
 * Original figure bytes for the vault. Embedded images (PDF/DOCX) are kept
 * byte-for-byte; crops are cut from the page render losslessly (PNG). The
 * vault copy is never modified — the media engine makes the delivered WebP
 * from it at import time.
 */

export interface StoredFigure {
  key: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

const MAX_PIXELS = 40_000_000;
const DECODABLE = new Set(["png", "jpeg", "jpg", "webp", "gif", "tiff", "tif", "bmp"]);

export class FigureError extends Error {}

/** Validates (decodes) and stores original image bytes; `ext` is the claimed type. */
export async function storeOriginalFigure(bytes: Buffer, ext: string): Promise<StoredFigure> {
  const e = ext.toLowerCase();
  if (!DECODABLE.has(e)) throw new FigureError(`Images in .${e} format cannot be processed (convert them to PNG or JPEG).`);
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new FigureError("The image could not be decoded (damaged or unsupported).");
  }
  if (!meta.width || !meta.height) throw new FigureError("The image has no dimensions.");
  const fmt = String(meta.format ?? e);
  const outExt = fmt === "jpeg" || fmt === "jpg" ? "jpg" : fmt;
  const stored = await putContent("figures", bytes, outExt);
  return { key: stored.key, sha256: stored.sha256, mime: outExt === "jpg" ? "image/jpeg" : `image/${outExt}`, width: meta.width, height: meta.height, bytes: bytes.length };
}

/**
 * Crops a box (0..1, with a small margin so axis labels and captions are
 * kept) out of a page render, losslessly. Returns null for a degenerate box.
 */
export async function cropFromRender(render: Buffer, box: NBox, margin = 0.012): Promise<{ bytes: Buffer; clipped: boolean } | null> {
  const meta = await sharp(render).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return null;
  const x0 = Math.max(0, box.x - margin);
  const y0 = Math.max(0, box.y - margin);
  const x1 = Math.min(1, box.x + box.w + margin);
  const y1 = Math.min(1, box.y + box.h + margin);
  const left = Math.floor(x0 * W);
  const top = Math.floor(y0 * H);
  const width = Math.ceil((x1 - x0) * W);
  const height = Math.ceil((y1 - y0) * H);
  if (width < 16 || height < 16) return null;
  // A box touching the page edge may have been cut short — reported, never silently trusted.
  const clipped = box.x <= 0.002 || box.y <= 0.002 || box.x + box.w >= 0.998 || box.y + box.h >= 0.998;
  const bytes = await sharp(render).extract({ left, top, width: Math.min(width, W - left), height: Math.min(height, H - top) }).png({ compressionLevel: 9 }).toBuffer();
  return { bytes, clipped };
}

export function iou(a: NBox, b: NBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Downscaled JPEG data URL of a page render for a vision model (long side ≤ 1600 px). */
export async function visionImage(render: Buffer, longSide = 1600): Promise<string> {
  const jpg = await sharp(render).resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}
