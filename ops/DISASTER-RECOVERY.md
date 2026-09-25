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
3. `git clone`, then create a release: `git archive <sha> | tar -x -C /var/www/mocktestseries-releases/<sha>`, symlink `.env`, `npm ci && npx prisma generate && npx next build`.
4. `ln -sfn` the release to `/var/www/mocktestseries-current`, then `pm2 resurrect` (or `pm2 start` per the dump) and `pm2 save`.
5. Restore files, issue TLS, point DNS.
