import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Question Bank image storage. Files live on the shared, persistent mount
 * (`/var/www/mocktestseries-shared/storage`, symlinked in at `public/storage`
 * — see lib/storage-stats.ts's "Uploads / Shared Storage" category and the
 * `STORAGE_DIR` env var) rather than inside the release tree, so uploaded
 * question/option images survive every deploy. Because `public/storage` is a
 * symlink to that same directory, anything written to
 * `<storageRootDir>/question-images/<file>` is immediately servable at
 * `/storage/question-images/<file>` with no extra route needed.
 */

export const QUESTION_IMAGES_SUBDIR = "question-images";

/** 2MB max per image (Question or QuestionOption), enforced server-side. */
export const MAX_QUESTION_IMAGE_BYTES = 2 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

export function isAllowedImageMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_TO_EXT, mime);
}

export function extensionForMime(mime: string): string | null {
  return MIME_TO_EXT[mime] ?? null;
}

export function storageRootDir(): string {
  return process.env.STORAGE_DIR || "/var/www/mocktestseries-shared/storage";
}

export function questionImagesDir(): string {
  return path.join(storageRootDir(), QUESTION_IMAGES_SUBDIR);
}

/** A fresh, unguessable filename — the original filename is never trusted beyond its MIME-derived extension. */
export function randomImageFilename(mime: string): string | null {
  const ext = extensionForMime(mime);
  if (!ext) return null;
  return `${randomUUID()}.${ext}`;
}

export function publicUrlFor(filename: string): string {
  return `/storage/${QUESTION_IMAGES_SUBDIR}/${filename}`;
}

/**
 * Resolves a public `/storage/question-images/<file>` URL back to an absolute
 * on-disk path, or `null` if it isn't exactly one safe filename inside the
 * question-images directory. Refuses path separators and `..` outright so a
 * malicious URL can never escape the directory (no traversal).
 */
export function resolveQuestionImagePath(url: string): string | null {
  const prefix = `/storage/${QUESTION_IMAGES_SUBDIR}/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (!rest || rest.includes("/") || rest.includes("\\") || rest.includes("..")) return null;
  if (!/^[a-zA-Z0-9-]+\.(webp|png|jpe?g)$/i.test(rest)) return null;
  return path.join(questionImagesDir(), rest);
}
