import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { storageRootDir } from "@/lib/question-images";

/**
 * Storage convention for Paper PDF / Solution PDF / OMR Template uploads
 * (TestResource), mirroring lib/question-images.ts exactly: an allowlisted
 * MIME map, UUID-randomized filenames (the original filename is never
 * trusted or persisted), and a resolve* helper that rejects path traversal
 * before touching the filesystem. Shares the same storageRootDir() as
 * question images, so lib/storage-stats.ts's existing "Uploads / Shared
 * Storage" bucket already counts this — no new storage-stats wiring needed.
 */
export const TEST_RESOURCES_SUBDIR = "test-resources";
export const MAX_TEST_RESOURCE_BYTES = 20 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
};

export function isAllowedResourceMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_TO_EXT, mime);
}

export function extensionForResourceMime(mime: string): string | null {
  return MIME_TO_EXT[mime] ?? null;
}

export function testResourcesDir(): string {
  return path.join(storageRootDir(), TEST_RESOURCES_SUBDIR);
}

export function randomResourceFilename(mime: string): string | null {
  const ext = extensionForResourceMime(mime);
  if (!ext) return null;
  return `${randomUUID()}.${ext}`;
}

export function publicResourceUrlFor(filename: string): string {
  return `/storage/${TEST_RESOURCES_SUBDIR}/${filename}`;
}

export function resolveTestResourcePath(url: string): string | null {
  const prefix = `/storage/${TEST_RESOURCES_SUBDIR}/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (!rest || rest.includes("/") || rest.includes("\\") || rest.includes("..")) return null;
  if (!/^[a-zA-Z0-9-]+\.pdf$/i.test(rest)) return null;
  return path.join(testResourcesDir(), rest);
}
