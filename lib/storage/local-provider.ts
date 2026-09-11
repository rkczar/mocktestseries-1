import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReadResult, StorageProvider, StoredFile } from "./types";

// Defaults to a directory that sits alongside the app (not under `public/`), so files are
// never served as static assets by accident and never picked up by the Next.js build. Override
// with UPLOAD_DIR in production to point at a path outside the deployed source tree entirely
// (e.g. a mounted data volume) — never hard-code an absolute path here.
const UPLOAD_ROOT = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  process.env.UPLOAD_DIR || "storage/uploads",
);
const PUBLIC_URL_PREFIX = "/api/uploads";

function extname(fileName: string) {
  const i = fileName.lastIndexOf(".");
  return i === -1 ? "" : fileName.slice(i).toLowerCase();
}

/** Resolves a storage key to an absolute path, refusing anything that would escape UPLOAD_ROOT. */
function resolveKeyPath(key: string) {
  const resolved = path.resolve(/* turbopackIgnore: true */ UPLOAD_ROOT, key);
  if (resolved !== UPLOAD_ROOT && !resolved.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error("Invalid storage key.");
  }
  return resolved;
}

export class LocalDiskStorageProvider implements StorageProvider {
  async save(input: { buffer: Buffer; originalName: string; mimeType: string }): Promise<StoredFile> {
    const now = new Date();
    const subDir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = `${subDir}/${randomUUID()}${extname(input.originalName)}`;

    const destination = resolveKeyPath(key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, input.buffer, { mode: 0o644 });

    return {
      key,
      url: `${PUBLIC_URL_PREFIX}/${key}`,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    await rm(resolveKeyPath(key), { force: true });
  }

  async read(key: string): Promise<ReadResult | null> {
    try {
      const buffer = await readFile(resolveKeyPath(key));
      return { buffer, mimeType: mimeFromExtension(extname(key)) };
    } catch {
      return null;
    }
  }
}

function mimeFromExtension(ext: string) {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".csv":
      return "text/csv";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}
