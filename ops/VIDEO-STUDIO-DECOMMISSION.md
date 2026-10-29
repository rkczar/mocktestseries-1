# AI Video Studio — decommissioned (2026-10-29)

AI Video Studio (Generator, Editor, Motion Workflow Studio), its worker, its renderer and its cron were
removed. The last release that contains it is `709037d24072f287e1bd51bf849f79a938aec622`.

## What was removed

- Admin pages `/admin/video-studio/**`, API routes `/api/admin/video-studio/**`, `components/admin/video-studio/**`,
  `lib/video-studio/**`, `lib/ai-engine/speech.ts` and the OpenRouter speech/transcription calls.
- Worker `scripts/video-worker.ts`, renderer `ops/video-worker/{Dockerfile,render.mjs}`, cron source
  `ops/video-worker/mocktestseries-video.cron`, fonts and sound effects under `public/video-studio/`.
- The menu entry, the `video-studio:*` permissions (code only; never stored in the database), the
  `video_script` AI feature and the `video_planning` task profile, the video-script text lint.
- Video-only test suites, fixtures and smoke scripts.

## What was kept on purpose

- Database: tables `VideoJob`, `VideoScene`, `VideoJobEvent`, `VideoSkillPreset`, enums `VideoJobKind` /
  `VideoJobStatus`, the Prisma models, all three migrations (`20261024170000_video_studio`,
  `20261024190000_video_studio_pipeline`, `20261025090000_video_motion`) and the `video.*` Setting rows.
  No application code reads or writes them. Dropping them needs a separate, reviewed migration.
- AI cost history: `AiGatewayCall` rows with feature `video_script` / `video_voice` / `video_transcribe` and
  the `AiCostQuote` rows stay. Screens that list them show the raw feature key as the label.
- Media of the existing jobs under `/var/www/mocktestseries-shared/video-studio` stays until the owner decides
  (backup below).

## Production steps (owner-approved, in this order)

1. Backup: `/var/backups/mocktestseries/pre-video-decommission-<UTC>/` — `db.dump`, `video-studio-media.tar.gz`,
   the cron file, `state.txt` (release, Docker image id, job list, media file list), `SHA256SUMS`.
2. Disable the cron: move `/etc/cron.d/mocktestseries-video` into that backup folder; wait until
   `flock -n /run/mocktestseries-video.lock true` succeeds; confirm no `VideoJob` is QUEUED, GENERATING_*,
   RENDERING or leased and no container with label `mts.video` runs.
3. Deploy the decommission release (no migration).
4. Separately approved: `docker rmi mts-video-render:1`; media deletion after the owner's decision.

## Rollback

1. Code: `atomic_switch` to `/var/www/mocktestseries-releases/709037d24072f287e1bd51bf849f79a938aec622` and
   `pm2 reload mocktestseries` (same procedure as `ops/deploy`). No database step: the schema was not changed.
2. Cron: move `disabled-cron.d-mocktestseries-video` from the backup folder back to
   `/etc/cron.d/mocktestseries-video` (root:root, 0644).
3. Render image (only if it was removed):
   `cd /var/www/mocktestseries-releases/709037d…/ops/video-worker && docker build -t mts-video-render:1 .`
   **Limitation:** the Dockerfile installs `chromium` and `ffmpeg` from Debian bookworm with `apt-get` and does
   not pin versions, so a rebuild gets whatever versions Debian serves that day (only `playwright-core@1.62.1`
   and the `node:24.11.1-bookworm-slim` base are pinned). Renders can differ from the removed image (font
   rasterisation, codec defaults), the build needs network access and ~1.6 GB of disk, and takes several
   minutes on this host. No image archive was kept (owner decision 2026-10-29).
4. Media (only if deleted): `tar -C /var/www/mocktestseries-shared -xzf <backup>/video-studio-media.tar.gz`
   after `sha256sum -c SHA256SUMS`.
