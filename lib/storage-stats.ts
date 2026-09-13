import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prisma } from "@/lib/prisma";

const execFileAsync = promisify(execFile);

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
}

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: StorageSnapshot | null = null;

/** Fixed argv only, never a shell string — `absPath` is always one of this module's own hardcoded paths. */
async function measureDir(label: string, absPath: string): Promise<StorageCategory> {
  try {
    const { stdout } = await execFileAsync("du", ["-sb", absPath]);
    const bytes = Number.parseInt(stdout.split("\t")[0] ?? "", 10);
    return Number.isFinite(bytes) ? { label, bytes } : { label, bytes: null, error: true };
  } catch {
    return { label, bytes: null, error: true };
  }
}

async function measureRootFilesBytes(rootDir: string): Promise<{ bytes: number | null; error?: boolean }> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const info = await stat(path.join(rootDir, entry.name));
      total += info.size;
    }
    return { bytes: total };
  } catch {
    return { bytes: null, error: true };
  }
}

/** "Application/source" is app + lib + components + prisma + the loose root files, combined into one bucket. */
async function measureApplicationSource(cwd: string): Promise<StorageCategory> {
  const [dirs, rootFiles] = await Promise.all([
    Promise.all(
      ["app", "lib", "components", "prisma"].map((dir) => measureDir(dir, path.join(cwd, dir)))
    ),
    measureRootFilesBytes(cwd),
  ]);

  let total = rootFiles.bytes ?? 0;
  let anyMeasured = rootFiles.bytes != null;
  let anyError = rootFiles.error ?? false;
  for (const d of dirs) {
    if (d.bytes != null) {
      total += d.bytes;
      anyMeasured = true;
    } else {
      anyError = true;
    }
  }

  return { label: "Application / Source", bytes: anyMeasured ? total : null, error: anyError };
}

async function measureDatabase(): Promise<{ bytes: number | null; error?: boolean }> {
  try {
    const rows = await prisma.$queryRaw<{ pg_database_size: bigint }[]>`SELECT pg_database_size(current_database())`;
    const raw = rows[0]?.pg_database_size;
    return { bytes: raw != null ? Number(raw) : null };
  } catch {
    return { bytes: null, error: true };
  }
}

async function measureFilesystem(
  targetPath: string
): Promise<{ totalBytes: number | null; usedBytes: number | null; availBytes: number | null; error?: boolean }> {
  try {
    const { stdout } = await execFileAsync("df", ["-B1", "--output=size,used,avail", targetPath]);
    const lines = stdout.trim().split("\n");
    const [sizeStr, usedStr, availStr] = (lines[lines.length - 1] ?? "").trim().split(/\s+/);
    const totalBytes = Number.parseInt(sizeStr ?? "", 10);
    const usedBytes = Number.parseInt(usedStr ?? "", 10);
    const availBytes = Number.parseInt(availStr ?? "", 10);
    if (![totalBytes, usedBytes, availBytes].every(Number.isFinite)) {
      return { totalBytes: null, usedBytes: null, availBytes: null, error: true };
    }
    return { totalBytes, usedBytes, availBytes };
  } catch {
    return { totalBytes: null, usedBytes: null, availBytes: null, error: true };
  }
}

/**
 * Cached snapshot of where disk space actually goes. Every path scanned here is a fixed,
 * hardcoded constant — nothing client-supplied is ever passed to `du`/`df`. Recomputed at
 * most every CACHE_TTL_MS unless `forceRefresh` is set (the "Scan Now" action).
 */
export async function getStorageSnapshot({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<StorageSnapshot> {
  if (!forceRefresh && cache && Date.now() - cache.scannedAt < CACHE_TTL_MS) {
    return cache;
  }

  const cwd = process.cwd();

  const [nodeModules, dotNext, publicDir, appSource, releases, shared, logs, database, filesystem] = await Promise.all([
    measureDir("node_modules", path.join(cwd, "node_modules")),
    measureDir(".next (build output)", path.join(cwd, ".next")),
    measureDir("public", path.join(cwd, "public")),
    measureApplicationSource(cwd),
    measureDir("Backup / Release History", "/var/www/mocktestseries-releases"),
    measureDir("Uploads / Shared Storage", "/var/www/mocktestseries-shared"),
    measureDir("Logs", path.join(os.homedir(), ".pm2", "logs")),
    measureDatabase(),
    measureFilesystem(cwd),
  ]);

  const categories = [nodeModules, dotNext, publicDir, appSource, releases, shared, logs];
  const totalUsedBytes = categories.reduce((sum, c) => (c.bytes != null ? sum + c.bytes : sum), 0);

  const snapshot: StorageSnapshot = {
    scannedAt: Date.now(),
    categories,
    totalUsedBytes,
    database,
    filesystem,
  };

  cache = snapshot;
  return snapshot;
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
