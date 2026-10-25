import "server-only";
import crypto from "node:crypto";
import { open, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Prisma, type VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureJobDir, resolveJobPath, jobBytes } from "@/lib/video-studio/storage";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { pdfInfo } from "@/lib/ai-import/pdf";

/**
 * Uploaded inputs of a video job (PDF, images / screenshots, recorded video,
 * music) — chunked upload, validated by content (magic bytes), never by the
 * file name or the browser's MIME type.
 *
 *   start   → upload id + chunk plan (size checked against the settings and the job quota)
 *   chunk   → ≤ 8 MB part written at its offset (idempotent per index)
 *   complete→ size + signature check, images re-encoded (metadata stripped,
 *             size bounded), PDFs page-counted, videos queued for probing in
 *             the render container; the file gets a server-made key.
 *
 * Files live in the job folder (outside public/), reach the browser only via
 * the permission-checked media route, and go with the job's cleanup.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;
export type AssetKind = "pdf" | "image" | "video" | "music";

export interface JobAsset {
  key: string;
  kind: AssetKind;
  name: string;
  bytes: number;
  /** PDF: page count; images: pixel size; video/music: probe (filled by the worker). */
  pages?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  hasAudio?: boolean;
  video?: { codec: string; width: number; height: number; fps: number | null } | null;
  /** video: low-resolution preview + timeline thumbnails (made by the worker). */
  proxyKey?: string;
  thumbsKey?: string;
  thumbs?: { count: number; everySec: number; width: number };
  /** PDF: pages the admin selected (1-based); empty = all (up to 20). */
  selectedPages?: number[];
  state: "ready" | "processing" | "failed";
  error?: string;
  addedAt: string;
}

export class AssetError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const UPLOAD_ID = /^[a-f0-9]{24}$/;

export function readAssets(job: Pick<VideoJob, "assets">): JobAsset[] {
  return Array.isArray(job.assets) ? (job.assets as unknown as JobAsset[]) : [];
}

/** File signature → kind + extension. Anything else is refused. */
export function sniff(head: Buffer): { kind: AssetKind; ext: string } | null {
  const h = head;
  const at = (i: number, s: string) => h.subarray(i, i + s.length).toString("latin1") === s;
  if (at(0, "%PDF-")) return { kind: "pdf", ext: "pdf" };
  if (h[0] === 0x89 && at(1, "PNG")) return { kind: "image", ext: "png" };
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { kind: "image", ext: "jpg" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { kind: "image", ext: "webp" };
  if (at(4, "ftyp")) {
    const brand = h.subarray(8, 12).toString("latin1");
    if (/^(M4A |M4B )/.test(brand)) return { kind: "music", ext: "m4a" };
    return { kind: "video", ext: brand === "qt  " ? "mov" : "mp4" };
  }
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return { kind: "video", ext: "webm" };
  if (at(0, "ID3") || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return { kind: "music", ext: "mp3" };
  if (at(0, "RIFF") && at(8, "WAVE")) return { kind: "music", ext: "wav" };
  return null;
}

const ALLOWED: Record<string, AssetKind[]> = {
  generate: ["pdf", "image", "music"],
  edit: ["video", "image", "music"],
};

interface UploadMeta {
  id: string;
  jobId: string;
  actorId: string;
  name: string;
  size: number;
  chunks: number;
  received: number[];
  purpose: "generate" | "edit";
  createdAt: string;
}

async function metaPath(jobId: string, id: string) {
  return resolveJobPath(jobId, `uploads/${id}.json`);
}

export async function startUpload(input: { job: VideoJob; actorId: string; name: unknown; size: unknown }): Promise<{ uploadId: string; chunkBytes: number; chunks: number }> {
  const { job } = input;
  const settings = await getVideoSettings();
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : -1;
  if (size <= 0) throw new AssetError("Empty file.");
  if (size > settings.maxUploadMb * 1024 * 1024) throw new AssetError(`The file is larger than ${settings.maxUploadMb} MB (Settings → upload limit).`, 413);
  const used = await jobBytes(job.id).catch(() => 0);
  if (used + size > settings.jobQuotaMb * 1024 * 1024) throw new AssetError(`This job would exceed its ${settings.jobQuotaMb} MB storage quota.`, 413);
  if (readAssets(job).length >= 30) throw new AssetError("A job can hold at most 30 files.");
  const name = typeof input.name === "string" ? input.name.replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120) || "file" : "file";
  const id = crypto.randomBytes(12).toString("hex");
  await ensureJobDir(job.id);
  const dir = await resolveJobPath(job.id, "uploads");
  await mkdir(dir, { recursive: true });
  const meta: UploadMeta = { id, jobId: job.id, actorId: input.actorId, name, size, chunks: Math.ceil(size / CHUNK_BYTES), received: [], purpose: job.kind === "EDIT" ? "edit" : "generate", createdAt: new Date().toISOString() };
  await writeFile(await metaPath(job.id, id), JSON.stringify(meta));
  const fh = await open(await resolveJobPath(job.id, `uploads/${id}.part`), "w");
  await fh.truncate(size);
  await fh.close();
  return { uploadId: id, chunkBytes: CHUNK_BYTES, chunks: meta.chunks };
}

async function loadMeta(jobId: string, uploadId: unknown, actorId: string): Promise<UploadMeta> {
  if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) throw new AssetError("Invalid upload id.");
  const raw = await readFile(await metaPath(jobId, uploadId), "utf8").catch(() => null);
  if (!raw) throw new AssetError("Upload not found (it may have expired).", 404);
  const meta = JSON.parse(raw) as UploadMeta;
  if (meta.actorId !== actorId) throw new AssetError("This upload belongs to another admin.", 403);
  return meta;
}

export async function putChunk(input: { jobId: string; uploadId: unknown; actorId: string; index: number; bytes: Buffer }): Promise<void> {
  const meta = await loadMeta(input.jobId, input.uploadId, input.actorId);
  const i = input.index;
  if (!Number.isInteger(i) || i < 0 || i >= meta.chunks) throw new AssetError("Invalid chunk index.");
  const expected = i === meta.chunks - 1 ? meta.size - i * CHUNK_BYTES : CHUNK_BYTES;
  if (input.bytes.length !== expected) throw new AssetError(`Chunk ${i} has the wrong size.`);
  const fh = await open(await resolveJobPath(input.jobId, `uploads/${meta.id}.part`), "r+");
  try {
    await fh.write(input.bytes, 0, input.bytes.length, i * CHUNK_BYTES);
  } finally {
    await fh.close();
  }
  if (!meta.received.includes(i)) {
    meta.received.push(i);
    await writeFile(await metaPath(input.jobId, meta.id), JSON.stringify(meta));
  }
}

/** Validates the assembled file and registers it as a job asset. */
export async function completeUpload(input: { job: VideoJob; uploadId: unknown; actorId: string }): Promise<JobAsset> {
  const { job } = input;
  const meta = await loadMeta(job.id, input.uploadId, input.actorId);
  if (meta.received.length !== meta.chunks) throw new AssetError(`Upload incomplete (${meta.received.length}/${meta.chunks} parts).`);
  const part = await resolveJobPath(job.id, `uploads/${meta.id}.part`, true);
  const st = await stat(part);
  if (st.size !== meta.size) throw new AssetError("Upload size mismatch.");
  const fh = await open(part, "r");
  const head = Buffer.alloc(32);
  await fh.read(head, 0, 32, 0);
  await fh.close();
  const kind = sniff(head);
  const fail = async (msg: string) => {
    await rm(part, { force: true });
    await rm(await metaPath(job.id, meta.id), { force: true });
    throw new AssetError(msg);
  };
  if (!kind) return fail("Unsupported file type. Use PDF, PNG / JPEG / WebP images, MP4 / MOV / WebM video or MP3 / WAV / M4A audio.");
  if (!ALLOWED[meta.purpose].includes(kind.kind)) return fail(meta.purpose === "edit" ? "The editor accepts videos, images and music." : "The generator accepts PDFs, images and music.");
  const base = `${kind.kind}-${meta.id.slice(0, 10)}`;
  const asset: JobAsset = { key: "", kind: kind.kind, name: meta.name, bytes: st.size, state: "ready", addedAt: new Date().toISOString() };
  if (kind.kind === "image") {
    // Re-encode: strips metadata, rejects decompression bombs, bounds the size.
    let img: Buffer;
    try {
      img = await sharp(part, { limitInputPixels: 60_000_000 }).rotate().resize({ width: 2160, height: 2160, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
    } catch {
      return fail("The image could not be read.");
    }
    const m = await sharp(img).metadata();
    asset.key = `inputs/${base}.jpg`;
    await mkdir(path.dirname(await resolveJobPath(job.id, asset.key)), { recursive: true });
    await writeFile(await resolveJobPath(job.id, asset.key), img);
    await rm(part, { force: true });
    Object.assign(asset, { bytes: img.length, width: m.width, height: m.height });
  } else {
    asset.key = `inputs/${base}.${kind.ext}`;
    await mkdir(path.dirname(await resolveJobPath(job.id, asset.key)), { recursive: true });
    await rename(part, await resolveJobPath(job.id, asset.key));
    if (kind.kind === "pdf") {
      try {
        const info = await pdfInfo(await resolveJobPath(job.id, asset.key, true));
        if (info.encrypted) throw new Error("encrypted");
        asset.pages = info.pages;
        asset.selectedPages = [];
      } catch {
        await rm(await resolveJobPath(job.id, asset.key), { force: true });
        throw new AssetError("The PDF could not be read (it may be encrypted or damaged).");
      }
    } else {
      // Video / audio: probed (duration, streams) and proxied by the render container — never decoded in the web process.
      // Generator music is checked by FFmpeg at render time (its signature is already verified).
      asset.state = kind.kind === "music" && meta.purpose === "generate" ? "ready" : "processing";
    }
  }
  await rm(await metaPath(job.id, meta.id), { force: true });
  await addAsset(job.id, asset);
  return asset;
}

export async function addAsset(jobId: string, asset: JobAsset): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VideoJob" WHERE "id" = ${jobId} FOR UPDATE`;
    const j = await tx.videoJob.findUniqueOrThrow({ where: { id: jobId }, select: { assets: true } });
    const list = readAssets(j).filter((a) => a.key !== asset.key);
    list.push(asset);
    await tx.videoJob.update({ where: { id: jobId }, data: { assets: list as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() } });
  });
}

export async function patchAsset(jobId: string, key: string, patch: Partial<JobAsset>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VideoJob" WHERE "id" = ${jobId} FOR UPDATE`;
    const j = await tx.videoJob.findUniqueOrThrow({ where: { id: jobId }, select: { assets: true } });
    const list = readAssets(j).map((a) => (a.key === key ? { ...a, ...patch } : a));
    await tx.videoJob.update({ where: { id: jobId }, data: { assets: list as unknown as Prisma.InputJsonValue } });
  });
}

export async function removeAsset(jobId: string, key: string): Promise<void> {
  let removed: JobAsset | undefined;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "VideoJob" WHERE "id" = ${jobId} FOR UPDATE`;
    const j = await tx.videoJob.findUniqueOrThrow({ where: { id: jobId }, select: { assets: true } });
    const list = readAssets(j);
    removed = list.find((a) => a.key === key);
    if (!removed) throw new AssetError("File not found.", 404);
    await tx.videoJob.update({ where: { id: jobId }, data: { assets: list.filter((a) => a.key !== key) as unknown as Prisma.InputJsonValue } });
  });
  for (const k of [removed!.key, removed!.proxyKey, removed!.thumbsKey]) if (k) await rm(await resolveJobPath(jobId, k), { force: true });
}

/** A scene / overlay image as a bounded data: URI (the template accepts only data: images). */
export async function imageDataUri(jobId: string, key: string, maxPx: number): Promise<string | null> {
  try {
    const buf = await sharp(await resolveJobPath(jobId, key, true)).resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Parts left by abandoned uploads (older than a day) — removed by the worker's cleanup pass. */
export async function staleUploadParts(jobId: string): Promise<void> {
  const dir = await resolveJobPath(jobId, "uploads").catch(() => null);
  if (!dir) return;
  const { readdir } = await import("node:fs/promises");
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, f);
    const s = await stat(p).catch(() => null);
    if (s && Date.now() - s.mtimeMs > 86_400_000) await rm(p, { force: true });
  }
}
