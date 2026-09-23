import "server-only";
import crypto from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "@/lib/prisma";
import type { BackupRoots } from "@/lib/backup/roots";
import { pgEnv, run, runOk } from "@/lib/backup/exec";
import { snapshotFacts, type BackupManifest } from "@/lib/backup/package";
import { verifyPackage, type VerifyReport } from "@/lib/backup/verify";
import { logBackupAudit } from "@/lib/backup/audit";

/**
 * Restore center.
 *
 * - `rehearseRestore` restores a verified package into a THROWAWAY database
 *   (mts_rehearsal_<random>) and a throwaway directory, then proves the
 *   restore against the manifest: every table's row count, the auth
 *   fingerprint (password hashes byte-identical), the commerce fingerprint
 *   (orders/payments/entitlements/invoices/products/coupons), the settings
 *   fingerprint, persistent file counts, and source essentials. Production
 *   is never touched; the rehearsal DB and files are always dropped.
 * - `restoreProduction` is the strongly-gated in-place restore: package must
 *   verify VALID with a matching schema; a pre-restore safety dump is taken
 *   first; pg_restore runs with --clean --single-transaction (all-or-
 *   nothing); persistent files are copied in (add/overwrite, never delete).
 */

export interface RehearsalReport {
  ok: boolean;
  checks: { label: string; ok: boolean; detail?: string }[];
}

function urlForDatabase(base: string, db: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

async function countTree(dir: string): Promise<number> {
  let n = 0;
  async function walk(d: string, depth: number) {
    if (depth > 12) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(path.join(d, e.name), depth + 1);
      else if (e.isFile()) n++;
    }
  }
  await walk(dir, 0);
  return n;
}

async function compareDb(url: string, manifest: BackupManifest, checks: RehearsalReport["checks"]) {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const facts = await client.$transaction((tx) => snapshotFacts(tx));
    const mismatched = Object.entries(manifest.database.rowCounts).filter(([t, n]) => facts.rowCounts[t] !== n);
    checks.push({
      label: "Every table's row count matches the manifest",
      ok: mismatched.length === 0 && facts.tableCount === manifest.database.tableCount,
      detail: mismatched.length ? `mismatch: ${mismatched.slice(0, 5).map(([t]) => t).join(", ")}` : `${facts.tableCount} tables, ${Object.values(facts.rowCounts).reduce((s, n) => s + n, 0)} rows`,
    });
    checks.push({ label: "Auth representations byte-identical (password hashes)", ok: facts.fingerprints.auth === manifest.database.fingerprints.auth });
    checks.push({ label: "Commerce records identical (orders, payments, entitlements, invoices, products, coupons)", ok: facts.fingerprints.commerce === manifest.database.fingerprints.commerce });
    checks.push({ label: "Settings identical (website, SEO, auth/AI/payment config)", ok: facts.fingerprints.settings === manifest.database.fingerprints.settings });
    checks.push({ label: "Migration history restored", ok: facts.latestMigration === manifest.database.latestMigration, detail: facts.latestMigration ?? "none" });
  } finally {
    await client.$disconnect();
  }
}

async function checkAssetsAndSource(extracted: string, ws: string, manifest: BackupManifest, checks: RehearsalReport["checks"]) {
  for (const a of manifest.persistentAssets) {
    const dest = path.join(ws, "assets", a.key);
    await mkdir(dest, { recursive: true, mode: 0o700 });
    await runOk("tar", ["-xzf", path.join(extracted, `assets-${a.key}.tar.gz`), "-C", dest, "--no-same-owner"]);
    const n = await countTree(dest);
    checks.push({ label: `Persistent files restored: ${a.key}`, ok: n === a.fileCount, detail: `${n}/${a.fileCount} files` });
  }
  if (manifest.components.some((c) => c.path === "source.tar.gz")) {
    const list = await run("tar", ["-tzf", path.join(extracted, "source.tar.gz")], { maxStdout: 32 * 1024 * 1024 });
    const names = new Set(list.stdout.split("\n").map((l) => l.replace(/^mocktestseries\//, "")));
    const essentials = ["package.json", "package-lock.json", "prisma/schema.prisma", `prisma/migrations/${manifest.database.latestMigration}/migration.sql`, "next.config.ts", "lib/payments/access.ts"];
    const missing = essentials.filter((e) => !names.has(e));
    checks.push({ label: "Source archive has package manifests, lockfile, Prisma schema + latest migration", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : `${names.size} entries` });
  }
}

export async function rehearseRestore(opts: { file: string; roots: BackupRoots; passphrase?: string; adminId?: string; databaseUrl?: string }): Promise<RehearsalReport & { verify: VerifyReport }> {
  const baseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const ws = path.join(opts.roots.tmp, `job-rehearsal${crypto.randomBytes(8).toString("hex")}`);
  await mkdir(ws, { recursive: true, mode: 0o700 });
  const dbName = `mts_rehearsal_${crypto.randomBytes(6).toString("hex")}`;
  const checks: RehearsalReport["checks"] = [];
  let created = false;
  try {
    const verify = await verifyPackage(opts.file, { workspace: ws, passphrase: opts.passphrase, repo: opts.roots.repo });
    checks.push({ label: "Package verification", ok: verify.status === "VALID", detail: verify.summary });
    if (verify.status !== "VALID" || !verify.extractedDir || !verify.manifest) return { ok: false, checks, verify };
    const manifest = verify.manifest as BackupManifest;

    await prisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    created = true;
    const url = urlForDatabase(baseUrl, dbName);
    await runOk("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "-d", dbName, path.join(verify.extractedDir, "database.dump")], { env: pgEnv(url), timeoutMs: 60 * 60_000 });
    checks.push({ label: "Isolated database restore (pg_restore)", ok: true, detail: `into ${dbName}` });
    await compareDb(url, manifest, checks);
    if (manifest.backupType !== "DATABASE") await checkAssetsAndSource(verify.extractedDir, ws, manifest, checks);
    if (manifest.secrets.included) checks.push({ label: "Encrypted secrets payload decrypts with passphrase", ok: verify.passphrase === "CORRECT", detail: verify.passphrase });

    const ok = checks.every((c) => c.ok);
    await logBackupAudit(opts.adminId, "RESTORE_REHEARSAL", "Restore", null, { ok, backupType: manifest.backupType, checks: checks.length });
    return { ok, checks, verify };
  } finally {
    if (created) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await rm(ws, { recursive: true, force: true });
  }
}

export class RestoreRefusedError extends Error {}

export async function restoreProduction(opts: {
  file: string;
  roots: BackupRoots;
  passphrase?: string;
  adminId?: string;
  /** Target DB — production by default. The verification suite points this at an isolated DB. */
  databaseUrl?: string;
  /** Target persistent dirs — production by default. */
  persistentDirs?: Record<string, string>;
}): Promise<RehearsalReport & { safetyDump: string | null }> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const ws = path.join(opts.roots.tmp, `job-restore${crypto.randomBytes(10).toString("hex")}`);
  await mkdir(ws, { recursive: true, mode: 0o700 });
  const checks: RehearsalReport["checks"] = [];
  let safetyDump: string | null = null;
  try {
    const verify = await verifyPackage(opts.file, { workspace: ws, passphrase: opts.passphrase, repo: opts.roots.repo });
    if (verify.status !== "VALID" || !verify.extractedDir || !verify.manifest) throw new RestoreRefusedError(`Package did not verify: ${verify.summary}`);
    if (!verify.compatibility?.productionRestore) throw new RestoreRefusedError(verify.compatibility?.reason ?? "Schema incompatible.");
    if (verify.manifest.secrets.included && verify.passphrase !== "CORRECT") throw new RestoreRefusedError("Enter the correct Backup Recovery Passphrase for this FULL backup.");
    const manifest = verify.manifest as BackupManifest;
    await logBackupAudit(opts.adminId, "RESTORE_STARTED", "Restore", null, { backupType: manifest.backupType, createdAt: manifest.createdAt, gitSha: manifest.app.gitSha });

    // 1. Safety dump of the CURRENT database first (recognized nightly-format name).
    await mkdir(opts.roots.nightlyDb, { recursive: true, mode: 0o700 });
    const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    safetyDump = path.join(opts.roots.nightlyDb, `mocktestseries-${t}.dump`);
    await runOk("pg_dump", ["-Fc", "--no-owner", "--no-privileges", "-f", safetyDump], { env: pgEnv(url), timeoutMs: 60 * 60_000 });
    checks.push({ label: "Pre-restore safety backup of current database", ok: true, detail: path.basename(safetyDump) });

    // 2. All-or-nothing database restore.
    await runOk(
      "pg_restore",
      ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error", "-d", new URL(url).pathname.slice(1), path.join(verify.extractedDir, "database.dump")],
      { env: pgEnv(url), timeoutMs: 60 * 60_000 }
    );
    checks.push({ label: "Database restored (single transaction)", ok: true });

    // 3. Persistent files: add/overwrite, never delete existing files.
    if (manifest.backupType !== "DATABASE") {
      for (const a of manifest.persistentAssets) {
        const target = opts.persistentDirs?.[a.key] ?? opts.roots.persistent.find((p) => p.key === a.key)?.dir;
        if (!target) continue;
        const staging = path.join(ws, "assets", a.key);
        await mkdir(staging, { recursive: true, mode: 0o700 });
        await runOk("tar", ["-xzf", path.join(verify.extractedDir, `assets-${a.key}.tar.gz`), "-C", staging, "--no-same-owner"]);
        const inner = (await readdir(staging))[0];
        if (!inner) continue;
        await mkdir(target, { recursive: true });
        await runOk("cp", ["-a", "--no-dereference", path.join(staging, inner) + "/.", target + "/"]);
        checks.push({ label: `Persistent files restored: ${a.key}`, ok: (await stat(target).catch(() => null)) !== null, detail: `${a.fileCount} files` });
      }
    }

    // 4. Post-restore checks against the manifest.
    await compareDb(url, manifest, checks);
    const ok = checks.every((c) => c.ok);
    await logBackupAudit(opts.adminId, ok ? "RESTORE_COMPLETED" : "RESTORE_FAILED", "Restore", null, { backupType: manifest.backupType, safetyDump: safetyDump ? path.basename(safetyDump) : null, ok });
    return { ok, checks, safetyDump };
  } catch (e) {
    await logBackupAudit(opts.adminId, "RESTORE_FAILED", "Restore", null, { reason: e instanceof Error ? e.message.slice(0, 200) : "unknown", safetyDump: safetyDump ? path.basename(safetyDump) : null });
    throw e;
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}
