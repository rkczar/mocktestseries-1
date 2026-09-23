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
  /** Application-owned persistent files included in backups. */
  persistent: { key: string; label: string; dir: string }[];
  /** Git working copy used to archive the exact production source SHA. */
  repo: string;
}

export const PRODUCTION_ROOTS: BackupRoots = {
  managed: "/var/backups/mocktestseries",
  nightlyDb: "/var/backups/mocktestseries/postgres",
  packages: "/var/backups/mocktestseries/packages",
  incoming: "/var/backups/mocktestseries/incoming",
  tmp: "/var/backups/mocktestseries/tmp",
  uploadsMirror: "/var/backups/mocktestseries/uploads",
  legacyDb: ["/root/db-backups"],
  releases: "/var/www/mocktestseries-releases",
  currentLink: "/var/www/mocktestseries-current",
  persistent: [
    { key: "shared-storage", label: "Shared storage (question images, test resource PDFs, website uploads)", dir: process.env.STORAGE_DIR || "/var/www/mocktestseries-shared/storage" },
    { key: "uploads", label: "Import uploads (bulk-import source files)", dir: "/var/lib/mocktestseries/uploads" },
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
