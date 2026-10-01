# Disaster Recovery — mocktestseries.in

Rehearsed 2026-09-25 on a throwaway PostgreSQL instance (never over production).

## What is backed up (nightly, `/etc/cron.d/mocktestseries-backups`, scripts in `ops/backup/`)

| Time (UTC) | What | Where |
|---|---|---|
| 02:00 | PostgreSQL `pg_dump -Fc`, 14-day retention | `/var/backups/mocktestseries/postgres/` |
| 02:15 | File mirrors (never deletes): `/var/lib/mocktestseries/uploads`, `/var/www/mocktestseries-shared/storage` (question images, test resources/OMR) | `/var/backups/mocktestseries/{uploads,storage}/` |
| 02:25 | Config archive (0600, **contains secrets**): shared `.env`, nginx site, PM2 dump, cron, backup scripts; 30-day retention | `/var/backups/mocktestseries/config/` |
| 02:45 | Off-VPS copy of all of the above via the encrypted rclone remote `mts-offsite` | `offsite-status.txt` shows the state |

Not backed up (rebuildable): code (git: `github.com/rkczar/mocktestseries-1`), `node_modules`, `.next`, `/var/www/mocktestseries-releases/*`, TLS certificates (re-issue with certbot).

**Owner must keep outside the server:** the rclone crypt passwords, and a copy of `AUTH_SECRET`. `AUTH_SECRET` also decrypts the provider credentials stored in the DB (Google, MSG91, AI, Razorpay). Without it those must be re-entered in Admin, and every session is invalidated.

## Path A — restore from a pg_dump (primary)

```bash
sudo -u postgres createdb mocktestseries_restore            # NEVER restore over the live DB
pg_restore --no-owner --no-privileges --exit-on-error -d mocktestseries_restore <dump>
DATABASE_URL=postgresql://…/mocktestseries_restore npx prisma migrate deploy   # applies only migrations newer than the dump
```
Point `.env` `DATABASE_URL` at it (or rename databases during a maintenance window), then `pm2 reload mocktestseries`.
Rehearsal: latest dump restored in ~1 s. `migrate deploy` applied the newer migrations. The app served `/`, `/exams`, the exam pages, `/login` and `/sitemap.xml` (200) from the restored DB. Its schema is identical to production.

## Path B — fresh database from migrations (new environment / staging)

```bash
DATABASE_URL=postgresql://…/empty_db npx prisma migrate deploy
```
Guarded by `scripts/verify-migration-replay.sh` (clean replay + drift check, optionally vs a restored dump). This produces schema only: load data with `pg_restore --data-only` from a dump if needed.

## Files and config

- Files: `rsync -a /var/backups/mocktestseries/storage/ /var/www/mocktestseries-shared/storage/` (same for `uploads` → `/var/lib/mocktestseries/uploads`). Rehearsal: byte-identical (sha256).
- Config: `tar -xzf mocktestseries-config-*.tar.gz -C /` restores `.env`, the nginx site, the PM2 dump, cron and scripts. Then `nginx -t && systemctl reload nginx`, `pm2 resurrect`, `certbot --nginx -d mocktestseries.in -d www.mocktestseries.in`.

## New-server order

1. Install Node 24, PostgreSQL 16, nginx, pm2, rclone. Fetch the backups from `mts-offsite` (`rclone copy mts-offsite: /var/backups/mocktestseries`).
2. Restore config (above). Create the DB and user, then run Path A.
3. `git clone`, then create a release: `git archive <sha> | tar -x -C /var/www/mocktestseries-releases/<sha>`, `ln -snT /var/www/mocktestseries-shared/.env <release>/.env` (do **not** link `public/storage` — git already creates it; see "Deploying a release"), `npm ci && npx prisma generate && npx next build`, then `ops/deploy/mocktestseries-deploy.sh --check <release>`.
4. First start only (no current yet): `ln -snT <release> /var/www/mocktestseries-current`, then `pm2 resurrect` (or `pm2 start` per the dump) and `pm2 save`. Every later deploy uses the script below.
5. Restore files, issue TLS, point DNS.

## Deploying a release (routine)

Always deploy with the script. Never hand-run `ln -s` into a release:

```bash
git push origin main
ops/deploy/mocktestseries-deploy.sh <sha>     # run from /var/www/mocktestseries
```

**Why.** On 2026-09-27 a hand-run `ln -s /var/www/mocktestseries-shared/storage <release>/public/storage` crashed both PM2 workers for about 2–3 minutes. `public/storage` is a tracked git symlink (mode 120000), so `git archive` had already created it. `ln -s` onto an existing link to a directory dereferences it, so it created `shared/storage/storage -> shared/storage`. That loop (ELOOP) broke every release, the previous one included.

**What the script does** (guards in `ops/deploy/deploy-guards.sh`):

1. **Preflight**, before writing anything. Checks that:
   - the commit is on `origin/main`;
   - current is a symlink that resolves to exactly one 40-hex release;
   - shared storage is a real directory with **no symlinks inside** and doesn't overlap the releases dir;
   - the candidate directory doesn't exist yet.

   It logs the current SHA, the current target and the shared storage realpath.
2. **Assemble and build the candidate.** Production is untouched. Steps: `git archive`, then `safe_link` for `.env` and `public/storage`, then `npm ci`, `prisma generate`, `next build`. `safe_link` resolves real paths and uses `ln -snT` (never links into a directory). It accepts an existing link only if it already resolves to exactly the target. It rejects:
   - links inside shared storage;
   - links inside their own target;
   - targets inside current or inside the release being assembled;
   - replacing real files.
3. **Validate the candidate.** Every symlink outside `node_modules` must resolve, with no loops and none pointing at an ancestor of itself. `.env` and `public/storage` must resolve to exactly the shared paths, and `.next/BUILD_ID` must exist. Shared storage is re-scanned. The candidate realpath is logged.
4. **Boot test.** `next start` runs on spare port 3199. `/login`, `/` and `/exams` must return 200 and the log must contain no ELOOP. If anything fails, only the failed candidate is removed; current is never touched.
5. **Atomic switch.** Same-directory temp link plus `mv -T`, then `pm2 reload mocktestseries`.
6. **Post-switch health.** Both workers online, `127.0.0.1:3002/login` returns 200 and the public `/login` returns 200, still true after 10 s. On failure the script automatically restores the previous current target and reloads PM2. The failed candidate stays on disk for inspection.

Rollback never deletes anything in shared storage. The script never removes old releases. Retention belongs to Admin → Backup → Releases, which always keeps current plus the previous known-good release.

- Validate a built release without switching: `ops/deploy/mocktestseries-deploy.sh --check <release-dir>`.
- Guard self-test (temp paths only): `bash ops/deploy/test-deploy-guards.sh`.
- Migrations: if the candidate has migration folders the current release lacks, the script stops before the boot test (current untouched). Rerun with `APPLY_MIGRATIONS=1` to apply them with `prisma migrate deploy` from the candidate before the boot test.

## Installable app (PWA) — service worker

The site is installable as "MockTestSeries" (`app/manifest.ts`, icons in `public/icons/` from `scripts/generate-pwa-icons.mjs`). `/sw.js` (`app/sw.js/route.ts`) caches only `/_next/static/*`, the app icons and `/offline.html`. It never caches page HTML or anything under `/api`, `/admin`, `/student/checkout`, `/student/attempt` or `/storage`, and never intercepts POSTs. Each deploy's `BUILD_ID` produces a new worker. Students see "New version available — Update"; the banner is never shown on attempt pages.

- **Kill switch:** if the worker ever misbehaves, add `PWA_SW_DISABLED=1` to the shared `.env` and run `pm2 reload mocktestseries`. Every browser that checks `/sw.js` then gets a worker that deletes the `mts-*` caches and unregisters itself; the site keeps working as a normal website. Remove the line and reload to re-enable.
- **Verify (local build + disposable DB, as for the test-engine suite):** `BASE=http://localhost:3100 FIXTURE=<fixture.json> NODE_PATH=<dir with playwright> node scripts/verify-pwa.mjs`. Add `SIGNAL_DIR=<dir>` to also exercise a live update mid-test (see the script header).
