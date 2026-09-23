import "server-only";
import { mkdir, readdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PATTERNS, type BackupRoots } from "@/lib/backup/roots";
import { opaqueId, resolveInsideRoot } from "@/lib/backup/safe-fs";
import { duBytes } from "@/lib/backup/exec";
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
      sizeBytes: (await duBytes(roots.uploadsMirror)) ?? 0,
      mtime: mirrorSt.mtime,
      verification: null,
      verificationDetail: null,
      verifiedAt: null,
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
    }
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
      report = await verifyPackage(file, { workspace: ws, passphrase, repo: roots.repo });
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

/** Deletes ONE recognized, deletable artifact after re-resolving it safely. */
export async function deleteArtifact(roots: BackupRoots, id: string, protectedIds: Set<string> = new Set()): Promise<{ name: string; bytes: number }> {
  const { artifact, file } = await resolveArtifact(roots, id);
  if (!artifact.deletable) throw new ArtifactNotFoundError(artifact.protectedReason ?? "This backup cannot be deleted here.");
  if (protectedIds.has(id)) throw new ArtifactNotFoundError("This is the protected latest verified backup.");
  const st = await lstat(file);
  await rm(file, { force: false });
  await prisma.backupArtifactCheck.deleteMany({ where: { artifactId: id } });
  return { name: artifact.name, bytes: st.size };
}
