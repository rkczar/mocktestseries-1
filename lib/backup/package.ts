import "server-only";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BackupRoots } from "@/lib/backup/roots";
import { databaseNameFromUrl, duBytes, pgEnv, run, runOk, sha256File } from "@/lib/backup/exec";
import { buildRestoreReadme } from "@/lib/backup/readme";

/**
 * Backup package builder (format v1). One uncompressed outer .tar holding:
 *
 *   manifest.json          format/version, SHA, schema, components+sha256, inventory
 *   checksums.sha256       `sha256sum -c` compatible, every file incl. manifest
 *   README-RESTORE.md      fresh-VPS restore procedure for THIS backup
 *   database.dump          pg_dump custom format (consistent snapshot)
 *   source.tar.gz          git archive of the exact production release SHA   (FULL, CLEAN)
 *   assets-<key>.tar.gz    application-owned persistent files                (FULL, CLEAN)
 *   portable-config/*      env template (no secrets), nginx/cron/pm2 refs    (FULL, CLEAN)
 *   secrets.env.gpg        .env encrypted with the Backup Recovery Passphrase (FULL only)
 *
 * The database dump and the row-count/fingerprint facts in the manifest come
 * from ONE exported REPEATABLE READ snapshot (pg_export_snapshot +
 * pg_dump --snapshot), so rehearsal restores can be checked exactly against
 * the manifest. Live rows are only ever read — Clean mode omits disposable
 * tables' DATA from the dump copy via --exclude-table-data.
 */

export const BACKUP_FORMAT = "mocktestseries-backup";
export const BACKUP_FORMAT_VERSION = 1;

export type BackupKindName = "FULL" | "CLEAN" | "DATABASE";

/**
 * Tables whose rows are conclusively disposable operational logs / ephemeral
 * rate-limit or OTP state. Clean Portable backups keep their SCHEMA but omit
 * their DATA. Everything else (students, questions, attempts, payments,
 * entitlements, communications, audit history, AI cache …) is kept.
 */
export const CLEAN_EXCLUDED_TABLE_DATA: { table: string; category: "OPERATIONAL LOG" | "CACHE/TEMPORARY"; reason: string }[] = [
  { table: "LoginAttempt", category: "OPERATIONAL LOG", reason: "Admin login attempt log (brute-force throttling window only)" },
  { table: "StudentLoginAttempt", category: "OPERATIONAL LOG", reason: "Student login attempt log (throttling window only)" },
  { table: "OtpRequest", category: "CACHE/TEMPORARY", reason: "Short-lived OTP challenges (expire in minutes)" },
  { table: "PaymentRateLimitHit", category: "CACHE/TEMPORARY", reason: "Payment endpoint rate-limit counters (sliding window)" },
];

/** Non-secret .env keys whose values are kept in the portable env template. */
const NON_SECRET_ENV = new Set(["NODE_ENV", "PORT", "STORAGE_DIR", "NEXTAUTH_URL"]);

export interface ManifestComponent {
  path: string;
  kind: "database" | "source" | "assets" | "config" | "secrets" | "docs";
  bytes: number;
  sha256: string;
  description: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  backupType: BackupKindName;
  createdAt: string;
  app: { name: string; version: string; gitSha: string | null; sourceProvenance: string; workingTreeDirty: boolean | null; node: string; next: string | null; postgres: string };
  database: {
    name: string;
    latestMigration: string | null;
    migrationCount: number;
    tableCount: number;
    rowCounts: Record<string, number>;
    fingerprints: { auth: string; commerce: string; settings: string };
    excludedTableData: string[];
  };
  components: ManifestComponent[];
  persistentAssets: { key: string; label: string; fileCount: number; bytes: number }[];
  secrets: { included: boolean; method: string | null; file: string | null; variableNames: string[] };
  inventory: { item: string; status: "INCLUDED" | "REGENERABLE" | "EXCLUDED BY DESIGN" | "EXTERNAL / RECONFIGURATION REQUIRED"; note: string }[];
  restorePrerequisites: string[];
}

export class BackupPreflightError extends Error {}

function ts(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function packageFileName(kind: BackupKindName, at: Date, rand: string): string {
  const k = kind === "FULL" ? "full" : kind === "CLEAN" ? "clean" : "db";
  return `mocktestseries-${k}-${ts(at)}-${rand}.tar`;
}

export async function currentReleaseSha(roots: BackupRoots): Promise<string | null> {
  try {
    const real = await realpath(roots.currentLink);
    const name = path.basename(real);
    return /^[0-9a-f]{40}$/.test(name) && path.dirname(real) === (await realpath(roots.releases)) ? name : null;
  } catch {
    return null;
  }
}

export async function latestMigrationOnDisk(repo: string): Promise<string | null> {
  const names = (await readdir(path.join(repo, "prisma", "migrations")).catch(() => [] as string[])).filter((n) => /^\d{14}_/.test(n)).sort();
  return names.at(-1) ?? null;
}

async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(d: string, depth: number) {
    if (depth > 12) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        files++;
        bytes += (await stat(p)).size;
      }
    }
  }
  await walk(dir, 0);
  return { files, bytes };
}

/** Rough upper bound on workspace bytes the build needs (components + outer tar). */
export async function estimateRequiredBytes(kind: BackupKindName, roots: BackupRoots): Promise<number> {
  const db = await prisma.$queryRaw<{ s: bigint }[]>`SELECT pg_database_size(current_database()) AS s`;
  let est = Number(db[0]?.s ?? 0);
  if (kind !== "DATABASE") {
    for (const p of roots.persistent) est += (await duBytes(p.dir)) ?? 0;
    est += 200 * 1024 * 1024; // source archive + configs, generous
  }
  return est * 2 + 512 * 1024 * 1024; // components + packed copy + margin
}

interface SnapshotFacts {
  rowCounts: Record<string, number>;
  fingerprints: BackupManifest["database"]["fingerprints"];
  tableCount: number;
  migrationCount: number;
  latestMigration: string | null;
  pgVersion: string;
}

export async function snapshotFacts(tx: Prisma.TransactionClient): Promise<SnapshotFacts> {
  const tables = await tx.$queryRaw<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const rowCounts: Record<string, number> = {};
  for (const { t } of tables) {
    const r = await tx.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) AS c FROM "public"."${t.replace(/"/g, '""')}"`);
    rowCounts[t] = Number(r[0].c);
  }
  const fp = await tx.$queryRaw<{ auth: string; commerce: string; settings: string }[]>`
    SELECT
      encode(sha256(convert_to(
        coalesce((SELECT string_agg(id || ':' || "passwordHash", ',' ORDER BY id) FROM "AdminUser"), '') || '|' ||
        coalesce((SELECT string_agg(id || ':' || coalesce("passwordHash", ''), ',' ORDER BY id) FROM "Student"), ''), 'UTF8')), 'hex') AS auth,
      encode(sha256(convert_to(
        coalesce((SELECT string_agg(id || ':' || status::text || ':' || "amountPaise", ',' ORDER BY id) FROM "PaymentOrder"), '') || '|' ||
        coalesce((SELECT string_agg(id || ':' || status::text || ':' || "amountPaise", ',' ORDER BY id) FROM "Payment"), '') || '|' ||
        coalesce((SELECT string_agg(id || ':' || status::text || ':' || coalesce("expiresAt"::text, 'life'), ',' ORDER BY id) FROM "StudentEntitlement"), '') || '|' ||
        coalesce((SELECT string_agg("invoiceNumber" || ':' || "totalPaise", ',' ORDER BY "invoiceNumber") FROM "Invoice"), '') || '|' ||
        coalesce((SELECT string_agg(code || ':' || "sellingPricePaise", ',' ORDER BY code) FROM "Product"), '') || '|' ||
        coalesce((SELECT string_agg(code || ':' || "discountValue", ',' ORDER BY code) FROM "Coupon"), ''), 'UTF8')), 'hex') AS commerce,
      encode(sha256(convert_to(coalesce((SELECT string_agg(key || '=' || value::text, ',' ORDER BY key) FROM "Setting"), ''), 'UTF8')), 'hex') AS settings`;
  const mig = await tx.$queryRaw<{ n: string | null; c: bigint }[]>`
    SELECT max(migration_name) AS n, count(*) AS c FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const ver = await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('server_version') AS v`;
  return {
    rowCounts,
    fingerprints: fp[0],
    tableCount: tables.length,
    migrationCount: Number(mig[0].c),
    latestMigration: mig[0].n,
    pgVersion: ver[0].v,
  };
}

/** pg_dump inside the same REPEATABLE READ snapshot the manifest facts came from. */
async function dumpDatabase(outFile: string, kind: BackupKindName, databaseUrl: string): Promise<SnapshotFacts> {
  return prisma.$transaction(
    async (tx) => {
      const snap = await tx.$queryRaw<{ s: string }[]>`SELECT pg_export_snapshot() AS s`;
      const facts = await snapshotFacts(tx);
      const args = ["-Fc", "--no-owner", "--no-privileges", `--snapshot=${snap[0].s}`, "-f", outFile];
      if (kind === "CLEAN") for (const t of CLEAN_EXCLUDED_TABLE_DATA) args.push(`--exclude-table-data=public."${t.table}"`);
      await runOk("pg_dump", args, { env: pgEnv(databaseUrl), timeoutMs: 60 * 60_000 });
      if (kind === "CLEAN") for (const t of CLEAN_EXCLUDED_TABLE_DATA) facts.rowCounts[t.table] = 0;
      return facts;
    },
    { timeout: 60 * 60_000, maxWait: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

async function buildPortableConfig(dir: string, roots: BackupRoots, envText: string | null) {
  await mkdir(dir, { recursive: true });
  const lines = (envText ?? "")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const k = l.slice(0, l.indexOf("="));
      return NON_SECRET_ENV.has(k) ? l : `${k}=<restore from secrets.env.gpg or set a new value>`;
    });
  await writeFile(
    path.join(dir, "env.template"),
    ["# MockTestSeries.in environment template — secret values intentionally omitted.", "# FULL backups carry them in ../secrets.env.gpg (decrypt with the Backup Recovery Passphrase).", ...lines, ""].join("\n")
  );
  await writeFile(
    path.join(dir, "pm2-process.json"),
    JSON.stringify(
      {
        name: "mocktestseries",
        exec_mode: "cluster",
        instances: 2,
        cwd: "/var/www/mocktestseries-current",
        script: "node_modules/next/dist/bin/next",
        args: "start -p 3002 -H 127.0.0.1",
      },
      null,
      2
    ) + "\n"
  );
  const refs: [string, string][] = [
    ["/etc/nginx/sites-available/mocktestseries.in", "nginx-mocktestseries.in.conf"],
    ["/etc/cron.d/mocktestseries-backups", "cron-mocktestseries-backups"],
    ["/usr/local/bin/mocktestseries-backup-db.sh", "mocktestseries-backup-db.sh"],
    ["/usr/local/bin/mocktestseries-backup-uploads.sh", "mocktestseries-backup-uploads.sh"],
  ];
  for (const [src, name] of refs) await copyFile(src, path.join(dir, name)).catch(() => undefined);
  void roots;
}

async function encryptSecrets(envText: string, outFile: string, passphrase: string, gnupgHome: string) {
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
  // OpenPGP symmetric encryption via GnuPG (AES-256, iterated+salted SHA-512
  // S2K, integrity-protected). Plaintext arrives on stdin and the passphrase
  // on fd 3 — neither ever touches disk or argv.
  await runOk(
    "gpg",
    [
      "--homedir", gnupgHome, "--batch", "--yes", "--no-tty", "--pinentry-mode", "loopback", "--passphrase-fd", "3",
      "--symmetric", "--cipher-algo", "AES256", "--s2k-mode", "3", "--s2k-digest-algo", "SHA512", "--s2k-count", "65011712",
      "--output", outFile,
    ],
    { stdin: envText, fd3: passphrase, env: { PATH: process.env.PATH, GNUPGHOME: gnupgHome } }
  );
}

export async function decryptSecrets(file: string, passphrase: string, gnupgHome: string): Promise<string | null> {
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
  const r = await run(
    "gpg",
    ["--homedir", gnupgHome, "--batch", "--no-tty", "--pinentry-mode", "loopback", "--passphrase-fd", "3", "--decrypt", file],
    { fd3: passphrase, env: { PATH: process.env.PATH, GNUPGHOME: gnupgHome } }
  );
  return r.code === 0 ? r.stdout : null;
}

export interface BuildResult {
  file: string;
  manifest: BackupManifest;
}

/**
 * Builds a package inside `workspace` (a fresh 0700 job dir). Returns the
 * outer tar path. Caller owns workspace cleanup.
 */
export async function buildBackupPackage(opts: {
  kind: BackupKindName;
  roots: BackupRoots;
  workspace: string;
  fileName: string;
  passphrase?: string;
  databaseUrl?: string;
  envFile?: string;
}): Promise<BuildResult> {
  const { kind, roots, workspace } = opts;
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL ?? "";
  if (kind === "FULL" && (!opts.passphrase || opts.passphrase.length < 12)) throw new BackupPreflightError("FULL backups need a Backup Recovery Passphrase of at least 12 characters.");
  const stage = path.join(workspace, "stage");
  await mkdir(stage, { recursive: true, mode: 0o700 });
  await chmod(workspace, 0o700);
  const components: ManifestComponent[] = [];
  const add = async (rel: string, kindName: ManifestComponent["kind"], description: string) => {
    const f = path.join(stage, rel);
    components.push({ path: rel, kind: kindName, bytes: (await stat(f)).size, sha256: await sha256File(f), description });
  };

  // 1. Database (consistent snapshot).
  const facts = await dumpDatabase(path.join(stage, "database.dump"), kind, databaseUrl);
  await add("database.dump", "database", "PostgreSQL custom-format dump (pg_dump -Fc --no-owner --no-privileges), single consistent snapshot");

  const gitSha = await currentReleaseSha(roots);
  let sourceProvenance = "not included (database-only backup)";
  let workingTreeDirty: boolean | null = null;
  const persistentAssets: BackupManifest["persistentAssets"] = [];
  let envText: string | null = null;
  const envFile = opts.envFile ?? path.join(roots.currentLink, ".env");
  if (kind !== "DATABASE") envText = await readFile(envFile, "utf8").catch(() => null);

  if (kind !== "DATABASE") {
    // 2. Source: exact production SHA from git (immutable release == git archive of it).
    const out = path.join(stage, "source.tar.gz");
    if (gitSha && (await run("git", ["-C", roots.repo, "cat-file", "-e", `${gitSha}^{commit}`])).code === 0) {
      await runOk("git", ["-C", roots.repo, "archive", "--format=tar.gz", `--prefix=mocktestseries/`, "-o", out, gitSha]);
      sourceProvenance = `git archive of production release ${gitSha}`;
    } else {
      // Fallback: the live release directory minus regenerable artifacts.
      const rel = await realpath(roots.currentLink);
      await runOk("tar", ["-czf", out, "--exclude=./node_modules", "--exclude=./.next", "--exclude=./.env", "--exclude=./public/storage", "-C", rel, "."]);
      sourceProvenance = "tar of the live production release directory (commit not found in repo)";
    }
    const st = await run("git", ["-C", roots.repo, "status", "--porcelain"]);
    workingTreeDirty = st.code === 0 ? st.stdout.trim().length > 0 : null;
    await add("source.tar.gz", "source", sourceProvenance);

    // 3. Persistent assets (application-owned dirs only; symlinks stored as links, never followed).
    for (const p of roots.persistent) {
      const exists = await stat(p.dir).catch(() => null);
      const name = `assets-${p.key}.tar.gz`;
      if (exists?.isDirectory()) {
        await runOk("tar", ["-czf", path.join(stage, name), "-C", path.dirname(p.dir), path.basename(p.dir)]);
        const c = await countFiles(p.dir);
        persistentAssets.push({ key: p.key, label: p.label, fileCount: c.files, bytes: c.bytes });
      } else {
        await runOk("tar", ["-czf", path.join(stage, name), "--files-from=/dev/null"]);
        persistentAssets.push({ key: p.key, label: `${p.label} (directory absent at backup time)`, fileCount: 0, bytes: 0 });
      }
      await add(name, "assets", `${p.label} — originally at ${p.dir}`);
    }

    // 4. Portable config (no secret values).
    await buildPortableConfig(path.join(stage, "portable-config"), roots, envText);
    for (const f of (await readdir(path.join(stage, "portable-config"))).sort()) await add(`portable-config/${f}`, "config", "Infrastructure reference / template (no secrets)");
  }

  // 5. Secrets (FULL only), encrypted.
  const variableNames = (envText ?? "").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.slice(0, l.indexOf("=")));
  if (kind === "FULL") {
    if (!envText) throw new BackupPreflightError("Production .env could not be read for the encrypted secrets payload.");
    await encryptSecrets(envText, path.join(stage, "secrets.env.gpg"), opts.passphrase!, path.join(workspace, "gnupg"));
    await add("secrets.env.gpg", "secrets", "Production .env encrypted with the Backup Recovery Passphrase (OpenPGP/GnuPG AES-256)");
  }
  envText = null;

  const pkg = JSON.parse(await readFile(path.join(roots.repo, "package.json"), "utf8").catch(() => "{}")) as { version?: string; dependencies?: Record<string, string> };
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    backupType: kind,
    createdAt: new Date().toISOString(),
    app: {
      name: "mocktestseries",
      version: pkg.version ?? "unknown",
      gitSha,
      sourceProvenance,
      workingTreeDirty,
      node: process.version,
      next: pkg.dependencies?.next ?? null,
      postgres: facts.pgVersion,
    },
    database: {
      name: databaseNameFromUrl(databaseUrl),
      latestMigration: facts.latestMigration,
      migrationCount: facts.migrationCount,
      tableCount: facts.tableCount,
      rowCounts: facts.rowCounts,
      fingerprints: facts.fingerprints,
      excludedTableData: kind === "CLEAN" ? CLEAN_EXCLUDED_TABLE_DATA.map((t) => t.table) : [],
    },
    components,
    persistentAssets,
    secrets: {
      included: kind === "FULL",
      method: kind === "FULL" ? "OpenPGP symmetric (GnuPG): AES-256, SHA-512 iterated+salted S2K, integrity-protected" : null,
      file: kind === "FULL" ? "secrets.env.gpg" : null,
      variableNames: kind === "DATABASE" ? [] : variableNames,
    },
    inventory: buildInventory(kind),
    restorePrerequisites: [
      "Ubuntu 24.04 LTS (or compatible) with root/sudo",
      `Node.js ${process.version.replace(/^v/, "").split(".")[0]}.x and npm`,
      `PostgreSQL ${facts.pgVersion.split(".")[0]}.x (server + client tools: pg_restore)`,
      "nginx, certbot, PM2 (npm i -g pm2), git, tar, gzip, gnupg",
    ],
  };

  await writeFile(path.join(stage, "README-RESTORE.md"), buildRestoreReadme(manifest));
  await add("README-RESTORE.md", "docs", "Step-by-step restore guide for this backup");
  await writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // checksums.sha256 covers every file, manifest included.
  const all = [...components.map((c) => c.path), "manifest.json"];
  const sums: string[] = [];
  for (const rel of all) sums.push(`${await sha256File(path.join(stage, rel))}  ${rel}`);
  await writeFile(path.join(stage, "checksums.sha256"), sums.join("\n") + "\n");

  const file = path.join(workspace, opts.fileName);
  await runOk("tar", ["-cf", file, "-C", stage, "manifest.json", "checksums.sha256", ...components.map((c) => c.path)]);
  await chmod(file, 0o600);
  return { file, manifest };
}

export function buildInventory(kind: BackupKindName): BackupManifest["inventory"] {
  const db = "INCLUDED" as const;
  const full = kind !== "DATABASE";
  return [
    { item: "PostgreSQL: students, admins, roles/permissions, auth (password hashes as stored)", status: db, note: "database.dump" },
    { item: "Exams, subjects, topics, sub-topics, questions, options, PYQ papers", status: db, note: "database.dump" },
    { item: "Mock/Grand/Live/Custom/Subject tests, test series, schedules, resources metadata", status: db, note: "database.dump" },
    { item: "Test attempts, frozen question snapshots, answers, results, leaderboards", status: db, note: "database.dump" },
    { item: "Saved/reported questions, analytics-backed activity, announcements, communications", status: db, note: "database.dump" },
    { item: "AI explanations, variants, versions, cache; AI/model-pool settings", status: db, note: "database.dump (Setting + AI tables)" },
    { item: "Website Builder/homepage, appearance, header/footer, SEO, page visibility, route registry", status: db, note: "database.dump" },
    { item: "Commerce: products/pricing, coupons, orders, payments, refunds, entitlements, invoices, webhook log", status: db, note: "database.dump" },
    { item: "Provider credentials stored in Settings (Google OAuth, MSG91, Gemini/OpenAI, Razorpay)", status: db, note: "AES-256-GCM ciphertext in database.dump; needs the original AUTH_SECRET (in secrets.env.gpg) to decrypt" },
    { item: "Audit log / admin history", status: db, note: "database.dump" },
    {
      item: "Disposable logs: login attempts, OTP challenges, payment rate-limit counters",
      status: kind === "CLEAN" ? "EXCLUDED BY DESIGN" : db,
      note: kind === "CLEAN" ? "Clean Portable omits their rows (schema kept)" : "database.dump",
    },
    { item: "Application source (exact production git SHA), package.json, lockfile, Prisma schema + migrations, scripts", status: full ? "INCLUDED" : "EXCLUDED BY DESIGN", note: full ? "source.tar.gz" : "database-only backup" },
    { item: "Persistent files: question/option images, test resource PDFs/OMR, uploads", status: full ? "INCLUDED" : "EXCLUDED BY DESIGN", note: full ? "assets-*.tar.gz" : "database-only backup" },
    { item: "node_modules, .next build output, npm cache", status: "REGENERABLE", note: "npm ci && npx prisma generate && npm run build" },
    {
      item: "Environment secrets (.env: DATABASE_URL, AUTH_SECRET, …)",
      status: kind === "FULL" ? "INCLUDED" : "EXCLUDED BY DESIGN",
      note: kind === "FULL" ? "secrets.env.gpg — encrypted, needs the Backup Recovery Passphrase" : "no secrets in this backup type",
    },
    { item: "nginx site, PM2 process definition, backup cron scripts", status: full ? "INCLUDED" : "EXCLUDED BY DESIGN", note: full ? "portable-config/ (reference copies)" : "database-only backup" },
    { item: "DNS records, TLS certificates (Let's Encrypt)", status: "EXTERNAL / RECONFIGURATION REQUIRED", note: "Point DNS to the new VPS, re-issue with certbot" },
    { item: "Google OAuth redirect URIs, MSG91 sender/templates & IP allowlists, AI provider key restrictions", status: "EXTERNAL / RECONFIGURATION REQUIRED", note: "Update in each provider console if domain/IP changes" },
    { item: "Razorpay webhook URL/secret and dashboard settings", status: "EXTERNAL / RECONFIGURATION REQUIRED", note: "Webhook URL must point at the restored domain" },
    { item: "VPS firewall, SSH keys, OS users, PostgreSQL server config", status: "EXTERNAL / RECONFIGURATION REQUIRED", note: "Server-level; not application data" },
    { item: "Existing nightly backups / old release directories", status: "EXCLUDED BY DESIGN", note: "Backups of backups are not included" },
  ];
}

/** Writes a package to disk as a stream destination helper (used by uploads). */
export function createPrivateWriteStream(file: string) {
  return createWriteStream(file, { mode: 0o600, flags: "wx" });
}
