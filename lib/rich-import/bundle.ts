import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ImportBundleStatus, type ImportBundle, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MediaValidationError, storeScientificImage } from "@/lib/media-processing";
import { mediaStorage } from "@/lib/media-storage";
import { readZipDirectory, readZipEntry, ZIP_LIMITS, ZipSecurityError, type ZipEntryInfo } from "@/lib/rich-import/zip";

/**
 * Image bundles for RICH bulk imports (NEET Phase 3).
 *
 * Upload: the browser sends the ZIP in ≤ 8 MB chunks (nginx allows 20 MB per
 * request and the Next proxy buffers ~10 MB), each written to private staging
 * storage — `IMPORT_STAGING_DIR` (default /var/lib/mocktestseries/import-staging),
 * which is outside the public storage tree and never under /media/. The
 * archive is then assembled by streaming (never held in RAM) and inspected.
 *
 * Processing: only images that rows actually reference are processed, one
 * at a time, in bounded time slices (≤ PROCESS_SLICE_MS per request — nginx
 * cuts requests at 60 s), through the ONE media engine:
 *   storeScientificImage = decode-validate → sharp → SHA-256 → immutable
 *   storageKey → MediaObject (exact duplicates reuse the existing file/row).
 * The result per entry is recorded in ImportBundle.entries; the commit step
 * only references those MediaObjects. A slice can be retried at any time —
 * finished entries are skipped, and the media engine is idempotent.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const PROCESS_SLICE_MS = 20_000;
const LEASE_MS = 2 * 60_000;

export function stagingRoot(): string {
  // turbopackIgnore: a runtime-only directory, not a build input (keeps file tracing scoped).
  return path.resolve(/* turbopackIgnore: true */ process.env.IMPORT_STAGING_DIR || "/var/lib/mocktestseries/import-staging");
}

function bundleDir(bundleId: string): string {
  if (!/^[a-z0-9]{20,40}$/.test(bundleId)) throw new Error("Invalid bundle id");
  const dir = path.join(/* turbopackIgnore: true */ stagingRoot(), bundleId);
  if (!dir.startsWith(stagingRoot() + path.sep)) throw new Error("Bundle path escapes staging");
  return dir;
}
export const archivePath = (bundleId: string) => path.join(bundleDir(bundleId), "bundle.zip");

export class BundleError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "BundleError";
  }
}

export type BundleEntryStatus = "PENDING" | "READY" | "INVALID" | "IGNORED" | "UNSUPPORTED";

/** One archive entry as stored in ImportBundle.entries (no local paths). */
export interface BundleEntry {
  name: string;
  basename: string;
  kind: ZipEntryInfo["kind"];
  size: number;
  compressedSize: number;
  method: number;
  crc32: number;
  offset: number;
  status: BundleEntryStatus;
  /** Two entries whose basenames collide case-insensitively: never matched. */
  ambiguous: boolean;
  error: string | null;
  originalSha256?: string;
  sha256?: string;
  storageKey?: string;
  mime?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export function bundleEntries(raw: unknown): BundleEntry[] {
  return Array.isArray(raw) ? (raw as BundleEntry[]) : [];
}

/** Case-insensitive basename → entry index; ambiguous names map to every candidate. */
export function entryIndex(entries: BundleEntry[]): Map<string, BundleEntry[]> {
  const idx = new Map<string, BundleEntry[]>();
  for (const e of entries) {
    if (e.kind === "DIRECTORY" || e.kind === "IGNORED") continue;
    const k = e.basename.toLowerCase();
    idx.set(k, [...(idx.get(k) ?? []), e]);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function createBundle(input: { actorId: string; filename: string; declaredBytes: number }) {
  const name = input.filename.trim();
  if (!/\.zip$/i.test(name) || name.length > 200 || /[\\/\0]/.test(name)) throw new BundleError("The image bundle must be a .zip file.");
  if (!Number.isInteger(input.declaredBytes) || input.declaredBytes < 22) throw new BundleError("The ZIP file is empty.");
  if (input.declaredBytes > ZIP_LIMITS.maxArchiveBytes) throw new BundleError(`The ZIP is larger than ${ZIP_LIMITS.maxArchiveBytes / 1024 / 1024} MB. Split the paper into two imports or compress the images.`);
  const bundle = await prisma.importBundle.create({
    data: { createdById: input.actorId, filename: name, declaredBytes: input.declaredBytes, chunkCount: Math.ceil(input.declaredBytes / CHUNK_BYTES) },
  });
  await mkdir(bundleDir(bundle.id), { recursive: true, mode: 0o700 });
  return bundle;
}

async function loadOwned(bundleId: string, actorId: string) {
  const bundle = await prisma.importBundle.findUnique({ where: { id: bundleId } });
  if (!bundle) throw new BundleError("Image bundle not found.", 404);
  if (bundle.createdById !== actorId) throw new BundleError("This image bundle belongs to another admin's upload.", 403);
  return bundle;
}

/**
 * Stores chunk `index` (0-based). Idempotent: re-sending a chunk (a retry after
 * a lost response) replaces the same part file with identical bytes.
 */
export async function putChunk(input: { bundleId: string; actorId: string; index: number; bytes: Buffer }) {
  const bundle = await loadOwned(input.bundleId, input.actorId);
  if (bundle.status !== ImportBundleStatus.UPLOADING) throw new BundleError("This bundle is already complete.", 409);
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= bundle.chunkCount) throw new BundleError("Chunk index out of range.");
  const expected = input.index === bundle.chunkCount - 1 ? bundle.declaredBytes - CHUNK_BYTES * input.index : CHUNK_BYTES;
  if (input.bytes.length !== expected) throw new BundleError(`Chunk ${input.index} has ${input.bytes.length} bytes, expected ${expected}.`);
  const dir = bundleDir(bundle.id);
  const tmp = path.join(dir, `.part-${input.index}-${process.pid}-${Date.now()}`);
  await writeFile(tmp, input.bytes, { mode: 0o600 });
  await rename(tmp, path.join(dir, `part-${String(input.index).padStart(5, "0")}`));
  const received = (await readdir(dir)).filter((f) => f.startsWith("part-")).length;
  await prisma.importBundle.update({ where: { id: bundle.id }, data: { receivedBytes: Math.min(bundle.declaredBytes, received * CHUNK_BYTES) } });
  return { received, chunkCount: bundle.chunkCount };
}

/** Assembles the parts (streaming), hashes, inspects the archive. FAILED bundles keep the reason. */
export async function completeBundle(input: { bundleId: string; actorId: string }) {
  const bundle = await loadOwned(input.bundleId, input.actorId);
  if (bundle.status !== ImportBundleStatus.UPLOADING) return bundle;
  const dir = bundleDir(bundle.id);
  const parts = (await readdir(dir)).filter((f) => f.startsWith("part-")).sort();
  if (parts.length !== bundle.chunkCount) throw new BundleError(`Only ${parts.length} of ${bundle.chunkCount} parts were received — resend the missing parts.`, 409);
  const out = archivePath(bundle.id);
  const hash = createHash("sha256");
  const ws = createWriteStream(out, { mode: 0o600 });
  for (const part of parts) {
    await pipeline(createReadStream(path.join(dir, part)), async function* (src) {
      for await (const chunk of src) {
        hash.update(chunk as Buffer);
        yield chunk;
      }
    }, ws, { end: false });
  }
  await new Promise<void>((resolve, reject) => ws.end((err?: Error | null) => (err ? reject(err) : resolve())));
  for (const part of parts) await rm(path.join(dir, part), { force: true });
  const size = (await stat(out)).size;
  if (size !== bundle.declaredBytes) {
    return prisma.importBundle.update({ where: { id: bundle.id }, data: { status: ImportBundleStatus.FAILED, errorMessage: "The assembled ZIP does not match the declared size. Upload it again." } });
  }

  let zipEntries: ZipEntryInfo[];
  try {
    zipEntries = await readZipDirectory(out);
  } catch (e) {
    const message = e instanceof ZipSecurityError ? e.message : "The file could not be read as a ZIP archive.";
    // A refused archive is never read again: drop it, keep the reason.
    await rm(out, { force: true });
    return prisma.importBundle.update({ where: { id: bundle.id }, data: { status: ImportBundleStatus.FAILED, receivedBytes: size, sha256: hash.digest("hex"), errorMessage: message } });
  }

  const collisions = new Map<string, number>();
  for (const e of zipEntries) if (e.kind === "IMAGE" || e.kind === "UNSUPPORTED") collisions.set(e.basename.toLowerCase(), (collisions.get(e.basename.toLowerCase()) ?? 0) + 1);
  const entries: BundleEntry[] = zipEntries.map((e) => ({
    name: e.name,
    basename: e.basename,
    kind: e.kind,
    size: e.uncompressedSize,
    compressedSize: e.compressedSize,
    method: e.method,
    crc32: e.crc32,
    offset: e.localHeaderOffset,
    status: e.kind === "IMAGE" ? "PENDING" : e.kind === "UNSUPPORTED" ? "UNSUPPORTED" : "IGNORED",
    ambiguous: (collisions.get(e.basename.toLowerCase()) ?? 0) > 1,
    error: e.note,
  }));
  return prisma.importBundle.update({
    where: { id: bundle.id },
    data: {
      status: ImportBundleStatus.UPLOADED,
      receivedBytes: size,
      sha256: hash.digest("hex"),
      entryCount: entries.filter((e) => e.kind !== "DIRECTORY").length,
      imageCount: entries.filter((e) => e.kind === "IMAGE").length,
      expandedBytes: Math.min(2_000_000_000, zipEntries.reduce((s, e) => s + e.uncompressedSize, 0)),
      entries: entries as unknown as Prisma.InputJsonValue,
    },
  });
}

// ---------------------------------------------------------------------------
// Processing (bounded, resumable)
// ---------------------------------------------------------------------------

export interface ProcessResult {
  status: ImportBundleStatus;
  pending: number;
  processedNow: number;
  ready: number;
  invalid: number;
  done: boolean;
}

/**
 * Processes PENDING image entries whose (lowercased) basename is in `wanted`,
 * sequentially, until the time slice is used up. One worker at a time per
 * bundle (DB lease), so double clicks / two PM2 instances never race.
 */
export async function processBundleSlice(input: { bundleId: string; actorId: string; wanted: Set<string>; sliceMs?: number }): Promise<ProcessResult> {
  const deadline = Date.now() + (input.sliceMs ?? PROCESS_SLICE_MS);
  const leased = await prisma.importBundle.updateMany({
    where: {
      id: input.bundleId,
      status: { in: [ImportBundleStatus.UPLOADED, ImportBundleStatus.PROCESSING, ImportBundleStatus.READY] },
      OR: [{ processingAt: null }, { processingAt: { lt: new Date(Date.now() - LEASE_MS) } }],
    },
    data: { processingAt: new Date(), status: ImportBundleStatus.PROCESSING },
  });
  const bundle = await prisma.importBundle.findUnique({ where: { id: input.bundleId } });
  if (!bundle) throw new BundleError("Image bundle not found.", 404);
  const entries = bundleEntries(bundle.entries);
  const summarize = (status: ImportBundleStatus, processedNow: number): ProcessResult => {
    const pending = entries.filter((e) => e.status === "PENDING" && input.wanted.has(e.basename.toLowerCase()) && !e.ambiguous).length;
    return {
      status,
      pending,
      processedNow,
      ready: entries.filter((e) => e.status === "READY").length,
      invalid: entries.filter((e) => e.status === "INVALID").length,
      done: pending === 0,
    };
  };
  if (leased.count === 0) return summarize(bundle.status, 0); // another worker holds it, or the bundle failed

  let processedNow = 0;
  try {
    const file = archivePath(bundle.id);
    for (const entry of entries) {
      if (Date.now() > deadline) break;
      if (entry.status !== "PENDING" || entry.ambiguous || !input.wanted.has(entry.basename.toLowerCase())) continue;
      try {
        const bytes = await readZipEntry(file, {
          name: entry.name,
          basename: entry.basename,
          kind: "IMAGE",
          note: null,
          method: entry.method,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.size,
          crc32: entry.crc32,
          localHeaderOffset: entry.offset,
        });
        const media = await storeScientificImage(bytes, { filename: entry.basename, actorId: input.actorId });
        Object.assign(entry, {
          status: "READY",
          error: null,
          originalSha256: createHash("sha256").update(bytes).digest("hex"),
          sha256: media.sha256,
          storageKey: media.storageKey,
          mime: media.mime,
          width: media.width,
          height: media.height,
          bytes: media.bytes,
        } satisfies Partial<BundleEntry>);
      } catch (e) {
        entry.status = "INVALID";
        entry.error = e instanceof MediaValidationError || e instanceof ZipSecurityError ? e.message : "The image could not be processed.";
        if (!(e instanceof MediaValidationError || e instanceof ZipSecurityError)) console.error("[rich-import] bundle entry processing failed", { bundleId: bundle.id, entry: entry.name, error: (e as Error)?.message });
      }
      processedNow++;
      // Persist after every image: a crash or timeout loses at most one image of work.
      await prisma.importBundle.update({
        where: { id: bundle.id },
        data: {
          entries: entries as unknown as Prisma.InputJsonValue,
          processedCount: entries.filter((x) => x.status === "READY").length,
          invalidCount: entries.filter((x) => x.status === "INVALID").length,
        },
      });
    }
  } finally {
    const result = summarize(ImportBundleStatus.PROCESSING, processedNow);
    await prisma.importBundle.update({
      where: { id: bundle.id },
      data: { processingAt: null, status: result.done ? ImportBundleStatus.READY : ImportBundleStatus.PROCESSING },
    });
  }
  return summarize(entries.some((e) => e.status === "PENDING" && input.wanted.has(e.basename.toLowerCase()) && !e.ambiguous) ? ImportBundleStatus.PROCESSING : ImportBundleStatus.READY, processedNow);
}

/** Commit-time re-check that a READY entry's media still exists (DB row + immutable file). */
export async function verifyEntryMedia(entry: BundleEntry): Promise<boolean> {
  if (entry.status !== "READY" || !entry.sha256 || !entry.storageKey) return false;
  const row = await prisma.mediaObject.findUnique({ where: { sha256: entry.sha256 }, select: { storageKey: true } });
  return !!row && row.storageKey === entry.storageKey && (await mediaStorage().exists(entry.storageKey));
}

/** Removes a bundle's private staging files (the archive is no longer needed once its run is imported). */
export async function discardBundleFiles(bundleId: string): Promise<void> {
  await rm(bundleDir(bundleId), { recursive: true, force: true });
}

/** Public (admin) view of a bundle: counts and per-entry status. No local paths, no storage internals beyond media keys. */
export function bundleSummary(b: ImportBundle) {
  return {
    id: b.id,
    filename: b.filename,
    status: b.status,
    errorMessage: b.errorMessage,
    declaredBytes: b.declaredBytes,
    receivedBytes: b.receivedBytes,
    chunkCount: b.chunkCount,
    entryCount: b.entryCount,
    imageCount: b.imageCount,
    processedCount: b.processedCount,
    invalidCount: b.invalidCount,
    entries: bundleEntries(b.entries)
      .filter((e) => e.kind !== "DIRECTORY")
      .map((e) => ({ name: e.name, basename: e.basename, kind: e.kind, status: e.status, ambiguous: e.ambiguous, error: e.error, size: e.size, width: e.width ?? null, height: e.height ?? null, bytes: e.bytes ?? null })),
  };
}

