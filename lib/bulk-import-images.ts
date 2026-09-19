import "server-only";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Best-effort image-filename lookup for the bulk-import Validate & Preview
 * Workspace (spec Part 5).
 *
 * DELIBERATE SCOPE CUT: full ZIP-of-images upload/extraction was not
 * implemented in this pass (see report). Instead, a row's declared image
 * filename columns (Question/Option A-D Image Filename) are matched by
 * basename, case-insensitively, against whatever already exists under the
 * shared uploads mount (`/var/www/mocktestseries-shared/storage`, the same
 * mount `lib/storage-stats.ts` measures and `public/storage` symlinks to).
 * This means: if an admin uploads matching images through the per-question
 * image endpoint (owned by another agent, in progress at the time of
 * writing) or drops them on the shared mount by hand, bulk-import
 * validation will pick them up as FOUND automatically, with no extra step.
 * DUPLICATE FILENAME and UNUSED IMAGE detection specifically require a
 * per-run uploaded-images manifest (which only a real ZIP upload would
 * provide) and are therefore NOT implemented — only FOUND/MISSING per
 * declared filename.
 */

const SHARED_STORAGE_ROOT = "/var/www/mocktestseries-shared/storage";
const MAX_WALK_DEPTH = 6;
const CACHE_TTL_MS = 30_000;

let cache: { at: number; index: Map<string, string> } | null = null;

async function walk(dir: string, index: Map<string, string>, depth: number): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, index, depth + 1);
    } else if (entry.isFile()) {
      const key = entry.name.toLowerCase();
      // First match wins — filenames are expected to be reasonably unique;
      // this is a best-effort index, not an authoritative asset registry.
      if (!index.has(key)) index.set(key, full);
    }
  }
}

/** Lowercased-basename -> absolute path index of every file under the shared uploads mount, cached briefly. */
export async function getImageFilenameIndex(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.index;
  const index = new Map<string, string>();
  await walk(SHARED_STORAGE_ROOT, index, 0);
  cache = { at: now, index };
  return index;
}
