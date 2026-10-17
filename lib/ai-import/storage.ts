import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { AiImportFileStatus, AiImportJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stagingRoot, discardBundleFiles } from "@/lib/rich-import/bundle";
import { mediaRootDir } from "@/lib/media-storage";
import { listArea, removeVaultDir, removeVaultFile, vaultPath, type VaultEntry } from "@/lib/ai-import/vault";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { logEvent } from "@/lib/ai-import/jobs";

/**
 * Import Storage Manager. Scans the importer's storage and classifies every
 * file; only categories that are provably safe can be deleted, and a delete
 * re-checks each file against the database at execution time. Question
 * media (/media/) is REPORT-ONLY: files referenced by questions, options,
 * explanations or frozen attempt snapshots are never deleted here.
 */

export const CLEANUP_CATEGORIES = {
  TEMP_UPLOADS: "Temporary upload chunks (abandoned or refused uploads)",
  WORKER_SCRATCH: "Worker scratch files (no job running)",
  RENDERS: "Page renders of finished jobs (re-creatable while the original exists)",
  ORPHAN_FIGURES: "Figure originals no longer referenced by any extracted question",
  EXPIRED_ORIGINALS: "Original papers past their retention date (finished jobs only)",
  STAGING_BUNDLES: "AI-importer packages left in Bulk Import staging",
} as const;
export type CleanupCategory = keyof typeof CLEANUP_CATEGORIES;

export interface CleanupItem {
  category: CleanupCategory;
  /** Vault key, "tmp:<id>", "work:<id>", "renders:<jobId>" or "staging:<bundleId>". */
  key: string;
  bytes: number;
  label: string;
  jobId?: string | null;
}

export interface StorageReport {
  scannedAt: string;
  originals: { files: number; bytes: number; uploads: number; sharedUploads: number; expired: number; expiredBytes: number; expiredButOpen: number };
  intermediate: { renders: number; rendersBytes: number; temp: number; tempBytes: number; work: number; workBytes: number };
  figures: { files: number; bytes: number; referenced: number; unreferenced: number; unreferencedBytes: number };
  media: { files: number; bytes: number; mediaObjects: number; referencedByQuestions: number; unreferenced: number; note: string };
  staging: { bundles: number; bytes: number };
  candidates: Record<CleanupCategory, { count: number; bytes: number }>;
  recoverableBytes: number;
  lastCleanup: { at: string; bytes: string; files: number } | null;
}

const FINISHED: AiImportJobStatus[] = [AiImportJobStatus.COMPLETED, AiImportJobStatus.COMPLETED_WITH_ISSUES, AiImportJobStatus.CANCELLED, AiImportJobStatus.FAILED];
const ACTIVE: AiImportJobStatus[] = [AiImportJobStatus.ANALYZING, AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING, AiImportJobStatus.IMPORTING];

async function dirSize(dir: string, depth = 0): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  if (depth > 5) return { files, bytes };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const s = await dirSize(full, depth + 1);
      files += s.files;
      bytes += s.bytes;
    } else if (e.isFile()) {
      files++;
      bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return { files, bytes };
}

const groupBy = (entries: VaultEntry[], depthSegment: number) => {
  const out = new Map<string, { bytes: number; files: number; mtime: Date }>();
  for (const e of entries) {
    const id = e.key.split("/")[depthSegment];
    const g = out.get(id) ?? { bytes: 0, files: 0, mtime: new Date(0) };
    g.bytes += e.bytes;
    g.files++;
    if (e.mtime > g.mtime) g.mtime = e.mtime;
    out.set(id, g);
  }
  return out;
};

/** Every currently deletable item, per category, with the reference checks applied. */
export async function findCandidates(now = new Date()): Promise<CleanupItem[]> {
  const settings = await getImporterSettings();
  const items: CleanupItem[] = [];
  const day = 86_400_000;

  // Temp upload chunks: the file row is gone, refused, or the upload stalled > 24 h.
  const tmp = groupBy(await listArea("tmp"), 1);
  const tmpRows = await prisma.aiImportFile.findMany({ where: { id: { in: [...tmp.keys()] } }, select: { id: true, status: true, jobId: true } });
  for (const [id, g] of tmp) {
    const row = tmpRows.find((r) => r.id === id);
    const stale = now.getTime() - g.mtime.getTime() > day;
    if (!row || row.status !== AiImportFileStatus.UPLOADING || stale) items.push({ category: "TEMP_UPLOADS", key: `tmp:${id}`, bytes: g.bytes, label: row ? `Upload ${id} (${row.status.toLowerCase()})` : `Orphan upload ${id}`, jobId: row?.jobId ?? null });
  }

  // Worker scratch: only when that job is not being worked on.
  const work = groupBy(await listArea("work"), 1);
  const workJobs = await prisma.aiImportJob.findMany({ where: { id: { in: [...work.keys()] } }, select: { id: true, status: true } });
  for (const [id, g] of work) {
    const job = workJobs.find((j) => j.id === id);
    if (!job || !ACTIVE.includes(job.status)) items.push({ category: "WORKER_SCRATCH", key: `work:${id}`, bytes: g.bytes, label: `Scratch of job ${id}`, jobId: job?.id ?? null });
  }

  // Renders: finished jobs, older than the intermediate retention.
  const renders = groupBy(await listArea("renders"), 1);
  const renderJobs = await prisma.aiImportJob.findMany({ where: { id: { in: [...renders.keys()] } }, select: { id: true, status: true, title: true, updatedAt: true } });
  for (const [id, g] of renders) {
    const job = renderJobs.find((j) => j.id === id);
    const old = now.getTime() - (job?.updatedAt ?? g.mtime).getTime() > settings.retention.intermediateDays * day;
    if (!job || (FINISHED.includes(job.status) && old)) items.push({ category: "RENDERS", key: `renders:${id}`, bytes: g.bytes, label: job ? `Page images of "${job.title}"` : `Page images of a deleted job`, jobId: job?.id ?? null });
  }

  // Figure originals with no AiImportFigure row pointing at them.
  const figs = await listArea("figures");
  if (figs.length) {
    const referenced = new Set((await prisma.aiImportFigure.findMany({ where: { originalKey: { in: figs.map((f) => f.key) } }, select: { originalKey: true } })).map((r) => r.originalKey));
    for (const f of figs) if (!referenced.has(f.key) && now.getTime() - f.mtime.getTime() > day) items.push({ category: "ORPHAN_FIGURES", key: f.key, bytes: f.bytes, label: `Unreferenced figure ${f.key.slice(-20)}` });
  }

  // Expired originals: every row sharing the stored file is expired AND belongs to a finished job.
  const files = await prisma.aiImportFile.findMany({ where: { storageKey: { not: null }, status: { not: AiImportFileStatus.PURGED } }, select: { id: true, storageKey: true, retainUntil: true, bytes: true, originalName: true, jobId: true, job: { select: { status: true } } } });
  const byKey = new Map<string, typeof files>();
  for (const f of files) byKey.set(f.storageKey!, [...(byKey.get(f.storageKey!) ?? []), f]);
  for (const [key, rows] of byKey) {
    const allExpired = rows.every((r) => r.retainUntil && r.retainUntil < now);
    const allFinished = rows.every((r) => FINISHED.includes(r.job.status));
    if (allExpired && allFinished) items.push({ category: "EXPIRED_ORIGINALS", key, bytes: rows[0].bytes, label: rows.map((r) => r.originalName).join(", ").slice(0, 120), jobId: rows[0].jobId });
  }

  // Staging packages the AI importer generated and Bulk Import no longer needs.
  const bundles = await prisma.importBundle.findMany({ where: { filename: { startsWith: "ai-import-" }, createdAt: { lt: new Date(now.getTime() - day) } }, select: { id: true, filename: true, run: { select: { id: true, rows: { where: { status: "PENDING", removedFromImport: false }, select: { id: true }, take: 1 } } } } });
  for (const b of bundles) {
    if (b.run && b.run.rows.length) continue;
    const s = await dirSize(path.join(stagingRoot(), b.id));
    if (s.files) items.push({ category: "STAGING_BUNDLES", key: `staging:${b.id}`, bytes: s.bytes, label: b.filename });
  }
  return items;
}

export async function scanStorage(): Promise<StorageReport> {
  const now = new Date();
  const [filesArea, figs, renders, tmp, work] = await Promise.all([listArea("files"), listArea("figures"), listArea("renders"), listArea("tmp"), listArea("work")]);
  const fileRows = await prisma.aiImportFile.findMany({ where: { storageKey: { not: null }, status: { not: AiImportFileStatus.PURGED } }, select: { storageKey: true, retainUntil: true, bytes: true, job: { select: { status: true } } } });
  const keys = new Set(fileRows.map((f) => f.storageKey!));
  const candidates = await findCandidates(now);
  const cats = Object.fromEntries(Object.keys(CLEANUP_CATEGORIES).map((c) => [c, { count: 0, bytes: 0 }])) as StorageReport["candidates"];
  for (const i of candidates) {
    cats[i.category].count++;
    cats[i.category].bytes += i.bytes;
  }
  const referencedFigs = new Set((await prisma.aiImportFigure.findMany({ select: { originalKey: true }, distinct: ["originalKey"] })).map((f) => f.originalKey));
  const media = await dirSize(mediaRootDir());
  const [mediaObjects, referencedMedia] = await Promise.all([
    prisma.mediaObject.count(),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT m."sha256")::bigint AS n FROM "MediaObject" m JOIN "QuestionAsset" a ON a."sha256" = m."sha256"`,
  ]);
  const staging = await prisma.importBundle.findMany({ where: { filename: { startsWith: "ai-import-" } }, select: { id: true } });
  let stagingBytes = 0;
  for (const b of staging) stagingBytes += (await dirSize(path.join(stagingRoot(), b.id))).bytes;
  const expiredRows = fileRows.filter((f) => f.retainUntil && f.retainUntil < now);
  const last = await prisma.aiImportCleanup.findFirst({ orderBy: { createdAt: "desc" } });
  const sum = (a: VaultEntry[]) => a.reduce((x, e) => x + e.bytes, 0);
  return {
    scannedAt: now.toISOString(),
    originals: {
      files: filesArea.length,
      bytes: sum(filesArea),
      uploads: fileRows.length,
      sharedUploads: fileRows.length - keys.size,
      expired: cats.EXPIRED_ORIGINALS.count,
      expiredBytes: cats.EXPIRED_ORIGINALS.bytes,
      expiredButOpen: new Set(expiredRows.filter((f) => !FINISHED.includes(f.job.status)).map((f) => f.storageKey)).size,
    },
    intermediate: { renders: renders.length, rendersBytes: sum(renders), temp: tmp.length, tempBytes: sum(tmp), work: work.length, workBytes: sum(work) },
    figures: { files: figs.length, bytes: sum(figs), referenced: figs.filter((f) => referencedFigs.has(f.key)).length, unreferenced: cats.ORPHAN_FIGURES.count, unreferencedBytes: cats.ORPHAN_FIGURES.bytes },
    media: {
      files: media.files,
      bytes: media.bytes,
      mediaObjects,
      referencedByQuestions: Number(referencedMedia[0]?.n ?? 0),
      unreferenced: mediaObjects - Number(referencedMedia[0]?.n ?? 0),
      note: "Question media is never deleted here: an unreferenced file may still be shown by a submitted attempt's frozen snapshot.",
    },
    staging: { bundles: staging.length, bytes: stagingBytes },
    candidates: cats,
    recoverableBytes: candidates.reduce((a, i) => a + i.bytes, 0),
    lastCleanup: last ? { at: last.createdAt.toISOString(), bytes: last.bytes.toString(), files: last.fileCount } : null,
  };
}

/** Checksums every stored vault file: identical content under two names, and files whose name no longer matches their content. */
export async function findDuplicates(): Promise<{ checked: number; duplicateGroups: { sha256: string; keys: string[]; bytes: number }[]; integrityErrors: string[]; sharedUploads: { storageKey: string; uploads: number }[] }> {
  const entries = [...(await listArea("files")), ...(await listArea("figures"))];
  const bySha = new Map<string, VaultEntry[]>();
  const integrityErrors: string[] = [];
  for (const e of entries) {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => createReadStream(vaultPath(e.key)).on("data", (c) => hash.update(c as Buffer)).on("end", () => resolve()).on("error", reject));
    const sha = hash.digest("hex");
    if (!e.key.includes(sha)) integrityErrors.push(`${e.key}: content does not match its checksum name`);
    bySha.set(sha, [...(bySha.get(sha) ?? []), e]);
  }
  const shared = await prisma.aiImportFile.groupBy({ by: ["storageKey"], where: { storageKey: { not: null }, status: { not: AiImportFileStatus.PURGED } }, _count: { _all: true } });
  return {
    checked: entries.length,
    duplicateGroups: [...bySha].filter(([, v]) => v.length > 1).map(([sha, v]) => ({ sha256: sha, keys: v.map((x) => x.key), bytes: v[0].bytes })),
    integrityErrors,
    sharedUploads: shared.filter((s) => s._count._all > 1).map((s) => ({ storageKey: s.storageKey!, uploads: s._count._all })),
  };
}

export interface CleanupResult {
  deleted: number;
  bytes: number;
  skipped: { key: string; reason: string }[];
  cleanupId: string | null;
}

/**
 * Deletes the confirmed items. Each item is re-checked NOW (a job may have
 * started, a retention may have been extended): only items that are still
 * candidates are removed.
 */
export async function executeCleanup(input: { actorId: string; categories: CleanupCategory[]; keys: string[]; automatic?: boolean }): Promise<CleanupResult> {
  const wanted = new Set(input.keys);
  const current = await findCandidates();
  const allowed = new Map(current.filter((i) => input.categories.includes(i.category)).map((i) => [i.key, i]));
  const skipped: CleanupResult["skipped"] = [];
  let deleted = 0;
  let bytes = 0;
  const done: CleanupItem[] = [];
  for (const key of wanted) {
    const item = allowed.get(key);
    if (!item) {
      skipped.push({ key, reason: "no longer safe to delete (in use, retention extended, or already removed)" });
      continue;
    }
    try {
      if (key.startsWith("tmp:")) await removeVaultDir("tmp", key.slice(4));
      else if (key.startsWith("work:")) await removeVaultDir("work", key.slice(5));
      else if (key.startsWith("renders:")) {
        await removeVaultDir("renders", key.slice(8));
        await prisma.aiImportPage.updateMany({ where: { jobId: key.slice(8) }, data: { renderKey: null } });
      } else if (key.startsWith("staging:")) await discardBundleFiles(key.slice(8));
      else if (item.category === "EXPIRED_ORIGINALS") {
        await removeVaultFile(key);
        await prisma.aiImportFile.updateMany({ where: { storageKey: key }, data: { status: AiImportFileStatus.PURGED, purgedAt: new Date() } });
      } else if (item.category === "ORPHAN_FIGURES") {
        // Re-check the reference at the last moment.
        if (await prisma.aiImportFigure.count({ where: { originalKey: key } })) {
          skipped.push({ key, reason: "referenced again" });
          continue;
        }
        await removeVaultFile(key);
      }
      deleted++;
      bytes += item.bytes;
      done.push(item);
    } catch (e) {
      skipped.push({ key, reason: e instanceof Error ? e.message.slice(0, 120) : "delete failed" });
    }
  }
  if (!deleted && !skipped.length) return { deleted, bytes, skipped, cleanupId: null };
  const byCat: Record<string, { files: number; bytes: number }> = {};
  for (const i of done) byCat[i.category] = { files: (byCat[i.category]?.files ?? 0) + 1, bytes: (byCat[i.category]?.bytes ?? 0) + i.bytes };
  const row = await prisma.aiImportCleanup.create({ data: { actorId: input.actorId, categories: input.categories, fileCount: deleted, bytes: BigInt(bytes), detail: { automatic: input.automatic === true, byCategory: byCat, skipped: skipped.slice(0, 200), items: done.slice(0, 500).map((i) => ({ category: i.category, key: i.key, bytes: i.bytes, label: i.label })) } } });
  await prisma.auditLog.create({ data: { actorId: input.automatic ? null : input.actorId, action: input.automatic ? "AI_IMPORT_AUTO_CLEANUP" : "AI_IMPORT_STORAGE_CLEANUP", entityType: "AiImportCleanup", entityId: row.id, metadata: { categories: input.categories, deleted, bytes, skipped: skipped.length } } });
  for (const jobId of new Set(done.map((i) => i.jobId).filter((x): x is string => !!x))) {
    await logEvent(jobId, "STORAGE_CLEANUP", `Storage cleanup removed ${done.filter((i) => i.jobId === jobId).map((i) => CLEANUP_CATEGORIES[i.category].split(" (")[0].toLowerCase()).join(", ")}`, { cleanupId: row.id }, input.automatic ? null : input.actorId);
  }
  return { deleted, bytes, skipped, cleanupId: row.id };
}

/** Worker hook: when enabled in settings, removes expired temp files, renders and originals (same checks). */
export async function autoCleanup(): Promise<void> {
  const settings = await getImporterSettings();
  if (!settings.retention.autoCleanup) return;
  const categories: CleanupCategory[] = ["TEMP_UPLOADS", "WORKER_SCRATCH", "RENDERS", "EXPIRED_ORIGINALS"];
  const items = (await findCandidates()).filter((i) => categories.includes(i.category));
  if (!items.length) return;
  await executeCleanup({ actorId: "system", categories, keys: items.map((i) => i.key), automatic: true });
}

export async function stagingBundleExists(id: string): Promise<boolean> {
  try {
    await stat(path.join(stagingRoot(), id));
    return true;
  } catch {
    return false;
  }
}

