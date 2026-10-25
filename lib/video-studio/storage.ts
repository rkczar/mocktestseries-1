import "server-only";
import { lstat, mkdir, readdir, realpath, rm, statfs } from "node:fs/promises";
import path from "node:path";

/**
 * Temporary job storage for the AI Video Studio.
 *
 * Every job's media live in ONE folder: <VIDEO_STUDIO_DIR>/<jobId>/. The
 * root is outside `public/` and is never served by nginx; media reach the
 * browser only through the permission-checked download route. Nothing in
 * this module accepts a path from a request: callers pass a validated job id
 * plus a relative key built by the server, and `resolveJobPath` refuses
 * anything that escapes the job folder (`..`, absolute paths, symlinks).
 */

export const JOB_ID = /^[a-z0-9]{20,40}$/;
/** Relative media keys the server creates: "audio/scene-03.mp3", "out/final.mp4", … */
export const MEDIA_KEY = /^(?:[a-z0-9][a-z0-9-]{0,40}\/){0,2}[a-z0-9][a-z0-9._-]{0,80}$/;

export class StorageError extends Error {}

export function videoRoot(): string {
  const root = process.env.VIDEO_STUDIO_DIR || "/var/www/mocktestseries-shared/video-studio";
  if (!path.isAbsolute(root)) throw new StorageError("VIDEO_STUDIO_DIR must be an absolute path.");
  // turbopackIgnore: a runtime-only directory, not a build input (keeps file tracing scoped).
  return path.resolve(/* turbopackIgnore: true */ root);
}

export function jobDir(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new StorageError("Invalid job id.");
  return path.join(/* turbopackIgnore: true */ videoRoot(), jobId);
}

/**
 * Absolute path of a media key inside a job folder. Refuses traversal and
 * any symlink on the way (a planted link could point outside the root).
 * `mustExist` = the file must already exist (reads / downloads).
 */
export async function resolveJobPath(jobId: string, key: string, mustExist = false): Promise<string> {
  if (typeof key !== "string" || !MEDIA_KEY.test(key) || key.split("/").some((p) => p === "." || p === "..")) throw new StorageError("Invalid media key.");
  const dir = jobDir(jobId);
  const full = path.resolve(/* turbopackIgnore: true */ dir, key);
  if (path.relative(dir, full).startsWith("..") || path.isAbsolute(path.relative(dir, full))) throw new StorageError("Path outside the job folder.");
  // Walk every existing component from the root down: none may be a symlink.
  const root = videoRoot();
  let cur = root;
  for (const part of path.relative(root, full).split(path.sep)) {
    cur = path.join(/* turbopackIgnore: true */ cur, part);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) throw new StorageError("Symlinks are not allowed in job storage.");
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (mustExist) throw new StorageError("File not found.");
        break;
      }
      throw error;
    }
  }
  if (mustExist) {
    const real = await realpath(full);
    if (path.relative(await realpath(dir), real).startsWith("..")) throw new StorageError("Path outside the job folder.");
    return real;
  }
  return full;
}

export async function ensureJobDir(jobId: string): Promise<string> {
  const dir = jobDir(jobId);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new StorageError("Job folder is not a plain directory.");
  return dir;
}

/** Total bytes under a directory (symlinks are not followed and not counted). */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const e of entries) {
    const p = path.join(/* turbopackIgnore: true */ dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += await dirBytes(p);
    // A file removed meanwhile (the worker's cleanup, a render clearing its frames) counts as 0, not as an error.
    else if (e.isFile()) total += (await lstat(p).catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? { size: 0 } : Promise.reject(err)))).size;
  }
  return total;
}

export async function jobBytes(jobId: string): Promise<number> {
  return dirBytes(jobDir(jobId));
}

/** Free bytes on the filesystem that holds the video root (its parent when the root does not exist yet). */
export async function freeDiskBytes(): Promise<number> {
  let p = videoRoot();
  for (;;) {
    try {
      const s = await statfs(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(p) === p) throw error;
      p = path.dirname(p);
    }
  }
}

/** Deletes a job's whole media folder. Idempotent. */
export async function deleteJobMedia(jobId: string): Promise<number> {
  const dir = jobDir(jobId);
  let st;
  try {
    st = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (st.isSymbolicLink()) {
    // Never follow: remove only the link itself.
    await rm(dir, { force: true });
    return 0;
  }
  const bytes = await dirBytes(dir);
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

/** Folder names under the root (for the orphan scan). Anything that is not a plain job-id directory is reported too. */
export async function listJobFolders(): Promise<{ name: string; valid: boolean }[]> {
  try {
    const entries = await readdir(videoRoot(), { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, valid: e.isDirectory() && !e.isSymbolicLink() && JOB_ID.test(e.name) }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
