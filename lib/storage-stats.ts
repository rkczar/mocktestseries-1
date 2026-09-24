import "server-only";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { listArtifacts } from "@/lib/backup/discovery";
import { listReleases, planReleaseCleanup } from "@/lib/backup/releases";
import { planBackupCleanup } from "@/lib/backup/cleanup";
import { getRetentionSettings } from "@/lib/backup/settings";
import { buildStorageView, getStorageSnapshot as getCanonicalSnapshot, refreshStorageSnapshot, releaseSizeMap, type StorageView } from "@/lib/backup/storage";

/**
 * Admin Dashboard / System → Storage adapter over the canonical Storage
 * Analysis service (lib/backup/storage.ts). No measuring happens here — the
 * dashboard, the System page and the Backup Center all show the same numbers
 * from the same snapshot + live `df`.
 */

export interface StorageCategory {
  label: string;
  bytes: number | null;
  error?: boolean;
}

export interface StorageSnapshot {
  scannedAt: number;
  categories: StorageCategory[];
  totalUsedBytes: number;
  database: { bytes: number | null; error?: boolean };
  filesystem: { totalBytes: number | null; usedBytes: number | null; availBytes: number | null; error?: boolean };
  view: StorageView;
}

/**
 * forceRefresh re-scans, but waits at most ~40 s (the scan finishes in the
 * background if slower) so a request can never hang on `du`.
 */
export async function getStorageSnapshot({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<StorageSnapshot> {
  const roots = PRODUCTION_ROOTS;
  let snapshot = await getCanonicalSnapshot(roots, { waitMs: 5_000 });
  if (forceRefresh) {
    const scan = refreshStorageSnapshot(roots).catch(() => null);
    snapshot = (await Promise.race([scan, new Promise<null>((r) => setTimeout(() => r(null), 40_000))])) ?? snapshot;
  }
  const settings = await getRetentionSettings();
  const [artifacts, { releases }] = await Promise.all([
    listArtifacts(roots).catch(() => []),
    listReleases(roots, { sizes: releaseSizeMap(snapshot), includePm2: false, rollbackToKeep: settings.rollbackReleasesToKeep }).catch(() => ({ releases: [] })),
  ]);
  const view = await buildStorageView(roots, {
    snapshot,
    releases,
    artifacts,
    releaseReclaimable: planReleaseCleanup(releases).reclaimableBytes,
    backupReclaimable: planBackupCleanup(artifacts, settings).reclaimableBytes,
  });
  const categories = view.partition.map((r) => ({ label: r.label, bytes: r.bytes, error: r.bytes == null }));
  return {
    scannedAt: view.snapshotAt?.getTime() ?? Date.now(),
    categories,
    totalUsedBytes: categories.reduce((s, c) => s + (c.bytes ?? 0), 0),
    database: { bytes: view.databaseLogical, error: view.databaseLogical == null },
    filesystem: view.disk ? { totalBytes: view.disk.total, usedBytes: view.disk.used, availBytes: view.disk.avail } : { totalBytes: null, usedBytes: null, availBytes: null, error: true },
    view,
  };
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
