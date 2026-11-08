import "server-only";
import { mkdir, readdir, readFile, lstat, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PATTERNS, type BackupRoots } from "@/lib/backup/roots";
import { opaqueId, resolveInsideRoot } from "@/lib/backup/safe-fs";
import { duBytes, sha256File } from "@/lib/backup/exec";
import { verifyLegacySqlGz, verifyNightlyDump, verifyPackage, type VerifyReport, type VerifyStatus } from "@/lib/backup/verify";

/**
 * VPS backup discovery — ONLY the allowlisted roots in lib/backup/roots.ts,
 * never a general filesystem browser. Each artifact gets an opaque id; the
 * browser never sees or sends absolute paths.
 */

export type ArtifactCategory = "Database Backup" | "Disaster Recovery Backup" | "Clean Portable Backup" | "Database Package" | "Uploaded Backup" | "Legacy Backup" | "Uploads Mirror" | "Unknown";

export interface Artifact {
  id: string;
  rootKey: "nightly" | "packages" | "incoming" | "legacy" | "mirror";
  name: string;
  category: ArtifactCategory;
  format: string;
  sizeBytes: number;
  mtime: Date;
  /** null = not verified yet. */
  verification: VerifyStatus | null;
  verificationDetail: string | null;
  verifiedAt: Date | null;
  recognized: boolean;
  deletable: boolean;
  /** Why it can't be deleted from the UI (if not deletable). */
  protectedReason: string | null;
  /** SHA-256 recorded by the last integrity check (packages), null otherwise. */
  sha256: string | null;
  /** When a restore rehearsal of THESE bytes (same SHA-256) last passed; null = never restore-tested. */
  restoreTestedAt: Date | null;
  kind: "DB_DUMP" | "PACKAGE" | "LEGACY_SQL" | "MIRROR" | "UNKNOWN";
}

interface RootSpec {
  key: Artifact["rootKey"];
  dir: string;
  deletable: boolean;
}

function rootSpecs(roots: BackupRoots): RootSpec[] {
  return [
    { key: "nightly", dir: roots.nightlyDb, deletable: true },
    { key: "packages", dir: roots.packages, deletable: true },
    { key: "incoming", dir: roots.incoming, deletable: true },
    ...roots.legacyDb.map((dir) => ({ key: "legacy" as const, dir, deletable: false })),
  ];
}

function classify(rootKey: Artifact["rootKey"], name: string): Pick<Artifact, "category" | "format" | "recognized" | "kind"> {
  if (rootKey === "nightly" && PATTERNS.nightlyDump.test(name)) return { category: "Database Backup", format: "pg_dump custom (.dump)", recognized: true, kind: "DB_DUMP" };
  if ((rootKey === "packages" || rootKey === "incoming") && PATTERNS.package.test(name)) {
    const k = name.split("-")[1];
    return {
      category: k === "full" ? "Disaster Recovery Backup" : k === "clean" ? "Clean Portable Backup" : "Database Package",
      format: "Backup package v1 (.tar)",
      recognized: true,
      kind: "PACKAGE",
    };
  }
  if (rootKey === "incoming" && PATTERNS.upload.test(name)) return { category: "Uploaded Backup", format: "Backup package (.tar)", recognized: true, kind: "PACKAGE" };
  if (rootKey === "legacy" && PATTERNS.legacySqlGz.test(name)) return { category: "Legacy Backup", format: "plain SQL pg_dump (.sql.gz)", recognized: true, kind: "LEGACY_SQL" };
  return { category: "Unknown", format: "unrecognized", recognized: false, kind: "UNKNOWN" };
}

function patternFor(a: Pick<Artifact, "rootKey" | "kind" | "name">): RegExp {
  if (a.kind === "DB_DUMP") return PATTERNS.nightlyDump;
  if (a.kind === "LEGACY_SQL") return PATTERNS.legacySqlGz;
  if (a.kind === "PACKAGE") return PATTERNS.upload.test(a.name) ? PATTERNS.upload : PATTERNS.package;
  return /^$/;
}

export async function ensureManagedDirs(roots: BackupRoots) {
  for (const d of [roots.managed, roots.packages, roots.incoming, roots.tmp]) await mkdir(d, { recursive: true, mode: 0o700 });
}

export async function listArtifacts(roots: BackupRoots): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const spec of rootSpecs(roots)) {
    const entries = await readdir(spec.dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue; // symlinks/dirs inside backup roots are never treated as backups
      if (e.name.endsWith(".sha256")) continue; // checksum sidecars of a dump (checked before download), not backups
      const st = await lstat(path.join(spec.dir, e.name)).catch(() => null);
      if (!st || !st.isFile()) continue;
      const c = classify(spec.key, e.name);
      const deletable = spec.deletable && c.recognized;
      out.push({
        id: opaqueId(`${spec.key}:${spec.dir}`, e.name),
        rootKey: spec.key,
        name: e.name,
        ...c,
        sizeBytes: st.size,
        mtime: st.mtime,
        verification: null,
        verificationDetail: null,
        verifiedAt: null,
        sha256: null,
        restoreTestedAt: null,
        deletable,
        protectedReason: deletable ? null : !c.recognized ? "Unknown file — never deleted by the Backup Center" : "Outside the managed backup root — read-only here",
      });
    }
  }
  // Uploads mirror (existing nightly rsync target) — one informational row.
  const mirrorSt = await lstat(roots.uploadsMirror).catch(() => null);
  if (mirrorSt?.isDirectory()) {
    out.push({
      id: opaqueId(`mirror:${roots.uploadsMirror}`, "uploads"),
      rootKey: "mirror",
      name: "uploads (nightly mirror)",
      category: "Uploads Mirror",
      format: "rsync mirror (directory)",
      kind: "MIRROR",
      recognized: true,
      sizeBytes: (await duBytes(roots.uploadsMirror, 15_000)) ?? 0,
      mtime: mirrorSt.mtime,
      verification: null,
      verificationDetail: null,
      verifiedAt: null,
      sha256: null,
      restoreTestedAt: null,
      deletable: false,
      protectedReason: "Live target of the nightly uploads mirror cron",
    });
  }

  // Attach cached verification results (invalidated on size/mtime change).
  const checks = await prisma.backupArtifactCheck.findMany({ where: { artifactId: { in: out.map((a) => a.id) } } });
  const byId = new Map(checks.map((c) => [c.artifactId, c]));
  for (const a of out) {
    const c = byId.get(a.id);
    if (c && Number(c.sizeBytes) === a.sizeBytes && Number(c.mtimeMs) === Math.floor(a.mtime.getTime())) {
      a.verification = c.status;
      a.verificationDetail = c.detail;
      a.verifiedAt = c.checkedAt;
      a.sha256 = c.sha256;
    }
  }
  // Restore Tested = a passing rehearsal recorded for this artifact AND these exact bytes (sha256).
  const tested = await prisma.auditLog.findMany({
    where: { action: "RESTORE_TESTED", entityType: "BackupArtifact", entityId: { in: out.filter((a) => a.sha256).map((a) => a.id) } },
    select: { entityId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  for (const a of out) {
    const t = tested.find((x) => x.entityId === a.id && (x.metadata as { sha256?: string } | null)?.sha256 === a.sha256);
    if (t) a.restoreTestedAt = t.createdAt;
  }
  return out.sort((x, y) => y.mtime.getTime() - x.mtime.getTime());
}

export class ArtifactNotFoundError extends Error {}

/** Resolves an opaque id to a vetted absolute path (server-side only). */
export async function resolveArtifact(roots: BackupRoots, id: string): Promise<{ artifact: Artifact; file: string }> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new ArtifactNotFoundError("Invalid id");
  const a = (await listArtifacts(roots)).find((x) => x.id === id);
  if (!a || a.kind === "MIRROR" || a.kind === "UNKNOWN") throw new ArtifactNotFoundError("Backup not found");
  const dir = a.rootKey === "nightly" ? roots.nightlyDb : a.rootKey === "packages" ? roots.packages : a.rootKey === "incoming" ? roots.incoming : roots.legacyDb.find((d) => opaqueId(`legacy:${d}`, a.name) === a.id);
  if (!dir) throw new ArtifactNotFoundError("Backup not found");
  const file = await resolveInsideRoot(dir, a.name, { pattern: patternFor(a), expect: "file" });
  return { artifact: a, file };
}

/** Verifies one artifact (server-side, read-only) and caches the result. */
export async function verifyArtifact(roots: BackupRoots, id: string, passphrase?: string): Promise<VerifyReport> {
  const { artifact, file } = await resolveArtifact(roots, id);
  let report: VerifyReport;
  if (artifact.kind === "DB_DUMP") report = await verifyNightlyDump(file);
  else if (artifact.kind === "LEGACY_SQL") report = await verifyLegacySqlGz(file);
  else {
    const ws = path.join(roots.tmp, `job-verify${crypto.randomBytes(10).toString("hex")}`);
    await mkdir(ws, { recursive: true, mode: 0o700 });
    try {
      report = await verifyPackage(file, { workspace: ws, passphrase, repo: roots.repo, release: roots.currentLink });
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  }
  const st = await lstat(file);
  await prisma.backupArtifactCheck.upsert({
    where: { artifactId: id },
    create: { artifactId: id, fileName: artifact.name, sizeBytes: BigInt(st.size), mtimeMs: BigInt(st.mtime.getTime()), status: report.status, detail: report.summary.slice(0, 500), sha256: report.sha256 ?? null },
    update: { fileName: artifact.name, sizeBytes: BigInt(st.size), mtimeMs: BigInt(st.mtime.getTime()), status: report.status, detail: report.summary.slice(0, 500), sha256: report.sha256 ?? null, checkedAt: new Date() },
  });
  return report;
}

/** Auto-verifies cheap unverified artifacts (nightly dumps, legacy .sql.gz ≤ 200 MB). */
export async function autoVerifyCheap(roots: BackupRoots, artifacts: Artifact[]): Promise<number> {
  let n = 0;
  for (const a of artifacts) {
    if (a.verification || (a.kind !== "DB_DUMP" && a.kind !== "LEGACY_SQL") || a.sizeBytes > 200 * 1024 * 1024) continue;
    await verifyArtifact(roots, a.id).catch(() => undefined);
    n++;
  }
  return n;
}

export function isVerified(a: Pick<Artifact, "verification">): boolean {
  return a.verification === "VALID";
}

/**
 * The backup's lifecycle as the dashboard shows it. A file that merely exists is only CREATED;
 * INTEGRITY_VERIFIED needs a passing check of its bytes; RESTORE_TESTED needs a passing rehearsal of the same bytes.
 */
export type BackupLifecycle = "CREATED" | "INTEGRITY_VERIFIED" | "RESTORE_TESTED" | "FAILED" | "INCOMPLETE";
export function backupLifecycle(a: Pick<Artifact, "verification" | "restoreTestedAt" | "kind">): BackupLifecycle {
  if (a.verification === "CORRUPT" || a.verification === "INVALID" || a.verification === "INCOMPATIBLE") return "FAILED";
  if (a.verification === "VALID" || a.verification === "LEGACY_VERIFIED") return a.restoreTestedAt ? "RESTORE_TESTED" : "INTEGRITY_VERIFIED";
  return "CREATED";
}

/** Records a fresh package's verification (same cache row verifyArtifact writes) without re-reading it. */
export async function recordPackageCheck(roots: BackupRoots, fileName: string, report: VerifyReport): Promise<void> {
  const file = await resolveInsideRoot(roots.packages, fileName, { pattern: PATTERNS.package, expect: "file" });
  const st = await lstat(file);
  const id = opaqueId(`packages:${roots.packages}`, fileName);
  const data = { fileName, sizeBytes: BigInt(st.size), mtimeMs: BigInt(st.mtime.getTime()), status: report.status, detail: report.summary.slice(0, 500), sha256: report.sha256 ?? null };
  await prisma.backupArtifactCheck.upsert({ where: { artifactId: id }, create: { artifactId: id, ...data }, update: { ...data, checkedAt: new Date() } });
}

/**
 * Integrity check right before a download, so a damaged file is never served as a backup:
 * packages must still hash to the SHA-256 recorded when they were verified (or verify VALID now);
 * nightly dumps must parse with pg_restore and match their .sha256 sidecar when one exists.
 */
export async function checkBeforeDownload(roots: BackupRoots, artifact: Artifact, file: string): Promise<{ ok: true; sha256: string } | { ok: false; reason: string }> {
  const actual = await sha256File(file);
  if (artifact.kind === "PACKAGE") {
    if (artifact.verification === "VALID" && artifact.sha256) {
      if (artifact.sha256 === actual) return { ok: true, sha256: actual };
      await prisma.backupArtifactCheck.update({ where: { artifactId: artifact.id }, data: { status: "CORRUPT", detail: "SHA-256 changed since verification — the stored file is damaged.", checkedAt: new Date() } }).catch(() => undefined);
      return { ok: false, reason: "The stored package no longer matches its verified SHA-256 — it is damaged and was not sent." };
    }
    const r = await verifyArtifact(roots, artifact.id);
    return r.status === "VALID" && r.sha256 === actual ? { ok: true, sha256: actual } : { ok: false, reason: `Integrity check failed: ${r.summary}` };
  }
  if (artifact.kind === "DB_DUMP") {
    const side = await readFile(`${file}.sha256`, "utf8").catch(() => null);
    if (side && side.trim().split(/\s+/)[0] !== actual) return { ok: false, reason: "The dump does not match its .sha256 checksum file — it was not sent." };
    const r = await verifyNightlyDump(file);
    return r.status === "VALID" ? { ok: true, sha256: actual } : { ok: false, reason: `Integrity check failed: ${r.summary}` };
  }
  if (artifact.kind === "LEGACY_SQL") {
    const r = await verifyLegacySqlGz(file);
    return r.status === "LEGACY_VERIFIED" ? { ok: true, sha256: actual } : { ok: false, reason: `Integrity check failed: ${r.summary}` };
  }
  return { ok: false, reason: "Not a recognized backup." };
}

/**
 * Deletes ONE recognized, deletable artifact after re-resolving it safely.
 * An id that no longer resolves returns NOT_FOUND (idempotent — the opaque id
 * binds to one root + file name, so a replayed delete can't hit anything else).
 */
export async function deleteArtifact(roots: BackupRoots, id: string, protectedIds: Set<string> = new Set()): Promise<{ status: "DELETED"; name: string; bytes: number } | { status: "NOT_FOUND" }> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new ArtifactNotFoundError("Invalid id");
  const listed = (await listArtifacts(roots)).find((x) => x.id === id);
  if (!listed) return { status: "NOT_FOUND" };
  const { artifact, file } = await resolveArtifact(roots, id);
  if (!artifact.deletable) throw new ArtifactNotFoundError(artifact.protectedReason ?? "This backup cannot be deleted here.");
  if (protectedIds.has(id)) throw new ArtifactNotFoundError("This is the protected latest verified backup.");
  const st = await lstat(file);
  await rm(file, { force: false });
  if (artifact.kind === "DB_DUMP") await rm(`${file}.sha256`, { force: true }); // its checksum sidecar (hidden from the listing)
  await prisma.backupArtifactCheck.deleteMany({ where: { artifactId: id } });
  return { status: "DELETED", name: artifact.name, bytes: st.size };
}
