import "server-only";

/**
 * The ONLY filesystem locations the Backup Center may read, list, stream or
 * delete. Every path the browser can influence is resolved against these via
 * an opaque artifact/release id (lib/backup/safe-fs.ts) — the browser never
 * sends a path. Functions take a `BackupRoots` argument (defaulting to these
 * production values) so the verification suite can run the exact same code
 * against disposable fixture roots.
 */

export interface BackupRoots {
  /** Managed root: postgres/, packages/, incoming/, tmp/, uploads/ (mirror). */
  managed: string;
  /** Nightly cron pg_dump output (existing, see /etc/cron.d/mocktestseries-backups). */
  nightlyDb: string;
  /** Backup Center packages the admin chose to keep on the VPS. */
  packages: string;
  /** Packages copied onto the VPS (scp) or uploaded for verification/restore. */
  incoming: string;
  /** Job workspaces (0700). Only recognized job-<id> dirs are ever cleaned. */
  tmp: string;
  /** Nightly rsync mirror of uploads (existing cron). Informational/protected. */
  uploadsMirror: string;
  /** Manual pre-migration dumps from earlier deploys. Read-only here. */
  legacyDb: string[];
  /** Immutable deploy releases and the production symlink. */
  releases: string;
  currentLink: string;
  /** Application-owned persistent files included in backups. `exclude`: transient top-level subfolders never archived. */
  persistent: { key: string; label: string; dir: string; exclude?: string[] }[];
  /** Git working copy used to archive the exact production source SHA. */
  repo: string;
  /** Where the app's cron files (mocktestseries-*) and host backup scripts live (default /etc/cron.d, /usr/local/bin). */
  cronDir?: string;
  hostScriptsDir?: string;
}

// BACKUP_ROOT_DIR exists only so a scratch server can run the Backup Center on fixture backups; production never sets it.
const MANAGED = process.env.BACKUP_ROOT_DIR || "/var/backups/mocktestseries";

export const PRODUCTION_ROOTS: BackupRoots = {
  managed: MANAGED,
  nightlyDb: `${MANAGED}/postgres`,
  packages: `${MANAGED}/packages`,
  incoming: `${MANAGED}/incoming`,
  tmp: `${MANAGED}/tmp`,
  uploadsMirror: `${MANAGED}/uploads`,
  legacyDb: process.env.BACKUP_ROOT_DIR ? [`${MANAGED}/legacy`] : ["/root/db-backups"],
  releases: "/var/www/mocktestseries-releases",
  currentLink: "/var/www/mocktestseries-current",
  persistent: [
    { key: "shared-storage", label: "Shared storage (question images, test resource PDFs, website uploads)", dir: process.env.STORAGE_DIR || "/var/www/mocktestseries-shared/storage" },
    { key: "uploads", label: "Import uploads (bulk-import source files)", dir: "/var/lib/mocktestseries/uploads" },
    // Same defaults as lib/ai-import/vault.ts and lib/rich-import/bundle.ts; tmp/ (upload chunks) and work/ (worker scratch) are transient.
    { key: "ai-import-vault", label: "Original Paper Vault (AI Importer originals, figures, page renders)", dir: process.env.AI_IMPORT_VAULT_DIR || "/var/lib/mocktestseries/ai-import-vault", exclude: ["tmp", "work"] },
    { key: "import-staging", label: "Import staging (rich-import image bundles)", dir: process.env.IMPORT_STAGING_DIR || "/var/lib/mocktestseries/import-staging" },
  ],
  repo: "/var/www/mocktestseries",
};

/** Recognized artifact file names per root — anything else is UNKNOWN and never deletable. */
export const PATTERNS = {
  nightlyDump: /^mocktestseries-\d{8}T\d{6}Z\.dump$/,
  package: /^mocktestseries-(full|clean|db)-\d{8}-\d{6}-[a-z0-9]{6}\.tar$/,
  upload: /^upload-\d{8}-\d{6}-[a-z0-9]{6}\.tar$/,
  legacySqlGz: /^mocktestseries-[A-Za-z0-9-]+-\d{8}-\d{6}\.sql\.gz$/,
  jobDir: /^job-[a-z0-9]{20,32}$/,
  releaseDir: /^[0-9a-f]{40}$/,
};
