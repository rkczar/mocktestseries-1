import "server-only";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { run, sha256File } from "@/lib/backup/exec";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, decryptSecrets, latestMigrationOnDisk, type BackupManifest } from "@/lib/backup/package";

/**
 * Backup verification — read-only, never touches production.
 *
 * Package (.tar): members are listed first and every entry must be a regular
 * file or directory with an allowlisted name (no absolute paths, "..",
 * symlinks or devices) BEFORE anything is extracted into a private
 * workspace. Then: manifest format/version, sha256 of every file against both
 * checksums.sha256 and the manifest, pg_restore catalog readability, inner
 * archive readability, secrets payload presence (and decryptability when a
 * passphrase is supplied — values are never returned), schema compatibility.
 *
 * Nightly .dump: pg_restore --list must parse a catalog with table data.
 * Legacy .sql.gz: gzip integrity + plain-SQL pg_dump header.
 */

export type VerifyStatus = "VALID" | "LEGACY_VERIFIED" | "LEGACY_UNVERIFIED" | "INVALID" | "CORRUPT" | "INCOMPATIBLE";

export interface VerifyReport {
  status: VerifyStatus;
  summary: string;
  checks: { label: string; ok: boolean; detail?: string }[];
  manifest?: Pick<BackupManifest, "backupType" | "createdAt" | "app" | "database" | "persistentAssets" | "secrets" | "components" | "inventory">;
  compatibility?: { productionRestore: boolean; reason: string };
  passphrase?: "NOT_REQUIRED" | "NOT_PROVIDED" | "CORRECT" | "INCORRECT";
  sha256?: string;
}

const MEMBER_RE = /^(manifest\.json|checksums\.sha256|README-RESTORE\.md|database\.dump|source\.tar\.gz|assets-[a-z0-9-]{1,40}\.tar\.gz|secrets\.env\.gpg|portable-config\/[A-Za-z0-9._-]{1,80}|portable-config\/)$/;

export async function verifyNightlyDump(file: string): Promise<VerifyReport> {
  const r = await run("pg_restore", ["--list", file], { maxStdout: 8 * 1024 * 1024 }).catch(() => null);
  if (!r || r.code !== 0) return { status: "CORRUPT", summary: "pg_restore could not read this dump.", checks: [{ label: "pg_restore catalog", ok: false }] };
  const tables = (r.stdout.match(/ TABLE DATA /g) ?? []).length;
  const ok = tables > 0;
  return {
    status: ok ? "VALID" : "INVALID",
    summary: ok ? `Readable PostgreSQL custom-format dump (${tables} tables with data).` : "Readable, but the dump contains no table data (empty database).",
    checks: [{ label: "pg_restore catalog readable", ok, detail: `${tables} TABLE DATA entries` }],
  };
}

export async function verifyLegacySqlGz(file: string): Promise<VerifyReport> {
  const t = await run("gzip", ["-t", file]).catch(() => null);
  if (!t || t.code !== 0) return { status: "CORRUPT", summary: "gzip integrity check failed.", checks: [{ label: "gzip integrity", ok: false }] };
  const head = await run("sh", ["-c", 'gzip -dc -- "$1" | head -c 4096', "sh", file]).catch(() => null);
  const ok = Boolean(head?.stdout.includes("PostgreSQL database dump"));
  return {
    status: ok ? "LEGACY_VERIFIED" : "LEGACY_UNVERIFIED",
    summary: ok ? "Readable legacy plain-SQL pg_dump (no manifest/checksums)." : "gzip readable but not recognized as a pg_dump.",
    checks: [
      { label: "gzip integrity", ok: true },
      { label: "PostgreSQL dump header", ok },
    ],
  };
}

export async function verifyPackage(file: string, opts: { workspace: string; passphrase?: string; repo: string }): Promise<VerifyReport & { extractedDir?: string }> {
  const checks: VerifyReport["checks"] = [];
  const fail = (status: VerifyStatus, summary: string): VerifyReport => ({ status, summary, checks });

  const list = await run("tar", ["-tvf", file], { maxStdout: 1024 * 1024 }).catch(() => null);
  if (!list || list.code !== 0) {
    checks.push({ label: "Archive readable", ok: false });
    return fail("CORRUPT", "Not a readable tar archive.");
  }
  const members = list.stdout.trim().split("\n").filter(Boolean);
  for (const line of members) {
    const type = line[0];
    const name = line.split(/\s+/).slice(5).join(" ").replace(/^\.\//, "");
    if (type === "d" && (name === "" || name === ".")) continue; // archive root entry ("./")
    if ((type !== "-" && type !== "d") || !MEMBER_RE.test(name)) {
      checks.push({ label: "Archive members allowlisted", ok: false, detail: `unexpected entry "${name.slice(0, 80)}"` });
      return fail("INVALID", "Archive contains unexpected entries — refusing to extract.");
    }
  }
  checks.push({ label: "Archive readable, members allowlisted", ok: true, detail: `${members.length} entries` });

  const dir = path.join(opts.workspace, "extract");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const x = await run("tar", ["-xf", file, "-C", dir, "--no-same-owner", "--no-same-permissions"]);
  if (x.code !== 0) return fail("CORRUPT", "Extraction failed.");

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    checks.push({ label: "manifest.json", ok: false });
    return fail("INVALID", "manifest.json missing or unreadable.");
  }
  if (manifest.format !== BACKUP_FORMAT) {
    checks.push({ label: "Backup format", ok: false });
    return fail("INVALID", "Not a MockTestSeries.in backup package.");
  }
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    checks.push({ label: "Format version", ok: false, detail: `v${manifest.formatVersion} is newer than this app understands` });
    return fail("INCOMPATIBLE", "Backup format version is newer than this application.");
  }
  checks.push({ label: "Manifest format/version", ok: true, detail: `${manifest.format} v${manifest.formatVersion}, ${manifest.backupType}` });

  // Checksums: checksums.sha256 and manifest must agree with the bytes.
  const sumsText = await readFile(path.join(dir, "checksums.sha256"), "utf8").catch(() => "");
  const sums = new Map(
    sumsText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(66), l.slice(0, 64)] as const)
  );
  let bad = 0;
  for (const c of manifest.components) {
    const f = path.join(dir, c.path);
    const actual = await sha256File(f).catch(() => null);
    if (!actual || actual !== c.sha256 || sums.get(c.path) !== actual) bad++;
  }
  const manifestSum = await sha256File(path.join(dir, "manifest.json"));
  if (sums.get("manifest.json") !== manifestSum) bad++;
  checks.push({ label: "SHA-256 checksums", ok: bad === 0, detail: bad === 0 ? `${manifest.components.length + 1} files match` : `${bad} mismatched/missing` });
  if (bad > 0) return { ...fail("CORRUPT", "Checksum mismatch — the package is damaged or was modified."), manifest };

  // Database payload.
  const db = await verifyNightlyDump(path.join(dir, "database.dump"));
  const expectedTables = Object.values(manifest.database.rowCounts).filter((n) => n > 0).length;
  checks.push({ label: "Database dump readable", ok: db.status === "VALID", detail: db.summary + ` (manifest: ${manifest.database.tableCount} tables, ${expectedTables} with rows)` });
  if (db.status !== "VALID") return { ...fail("CORRUPT", "Database payload unreadable."), manifest };

  // Inner archives.
  for (const c of manifest.components.filter((c) => c.path.endsWith(".tar.gz"))) {
    const t = await run("tar", ["-tzf", path.join(dir, c.path)], { maxStdout: 16 * 1024 * 1024 });
    checks.push({ label: `${c.path} readable`, ok: t.code === 0, detail: t.code === 0 ? `${t.stdout.split("\n").filter(Boolean).length} entries` : undefined });
    if (t.code !== 0) return { ...fail("CORRUPT", `${c.path} is unreadable.`), manifest };
  }

  // Secrets payload.
  let passphrase: VerifyReport["passphrase"] = "NOT_REQUIRED";
  if (manifest.secrets.included) {
    const sf = path.join(dir, manifest.secrets.file ?? "secrets.env.gpg");
    const present = await stat(sf).catch(() => null);
    checks.push({ label: "Encrypted secrets payload present", ok: Boolean(present), detail: manifest.secrets.method ?? undefined });
    if (!present) return { ...fail("INVALID", "Encrypted secrets payload missing."), manifest };
    if (opts.passphrase) {
      const plain = await decryptSecrets(sf, opts.passphrase, path.join(opts.workspace, "gnupg"));
      const names = plain ? plain.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.slice(0, l.indexOf("="))) : [];
      const okNames = plain !== null && manifest.secrets.variableNames.every((n) => names.includes(n));
      passphrase = plain === null ? "INCORRECT" : "CORRECT";
      checks.push({ label: "Recovery passphrase decrypts payload", ok: okNames, detail: plain === null ? "wrong passphrase or damaged payload" : `${names.length} variables present (values not shown)` });
    } else {
      passphrase = "NOT_PROVIDED";
    }
  }

  // Compatibility for an in-place production restore.
  const current = await latestMigrationOnDisk(opts.repo);
  const productionRestore = manifest.database.latestMigration === current;
  const compatibility = {
    productionRestore,
    reason: productionRestore
      ? `Schema matches production (${current}).`
      : `Backup schema ${manifest.database.latestMigration ?? "unknown"} ≠ production ${current ?? "unknown"} — restore to a server running the matching release (see README-RESTORE).`,
  };
  checks.push({ label: "Schema compatible with this production release", ok: productionRestore, detail: compatibility.reason });

  const sha256 = await sha256File(file);
  const { backupType, createdAt, app, database, persistentAssets, secrets, components, inventory } = manifest;
  const status: VerifyStatus = passphrase === "INCORRECT" ? "INVALID" : "VALID";
  return {
    status,
    summary:
      status === "VALID"
        ? `${backupType} backup verified: manifest, ${components.length} components, checksums and database payload OK.`
        : "Recovery passphrase did not decrypt the secrets payload.",
    checks,
    manifest: { backupType, createdAt, app, database, persistentAssets, secrets, components, inventory },
    compatibility,
    passphrase,
    sha256,
    extractedDir: dir,
  };
}
