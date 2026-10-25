# AI Video Studio — media retention policy

Applies to every Video Studio job (Generator, Editor, Motion Workflow Studio).
Media = everything in the job's folder `<VIDEO_STUDIO_DIR>/<jobId>/`: uploads,
narration audio, previews, frames, the MP4. The job record, its events and its
costs are kept; only the files are deleted.

Cleanup runs automatically at the end of every worker run (cron, every minute)
and on demand (Settings → Run cleanup now). A job a worker currently holds
(lease) is never touched. All periods are set in **Settings & Branding**
(MASTER_ADMIN) and are clamped to the ranges below. None of them can be unlimited.

| Situation | Files deleted | Setting (default, range) |
| --- | --- | --- |
| **Any job, whatever its state** (hard cap) | `maxRetentionDays` after the job was **created**. A job still queued or running is stopped (FAILED, step "retention") | Maximum retention, 14 days (1–30) |
| Cancelled | at once (or by the next cleanup if a worker held it) | — |
| Failed | `failedRetentionHours` after the failure, so **Retry** can resume from the failed step without paying again for finished steps. After that, Retry is refused | Keep failed jobs for Retry, 72 h (1–336) |
| Completed and downloaded | `deliveredRetentionHours` after the first download | Keep delivered videos, 24 h (1–336) |
| Completed, never downloaded | `undeliveredRetentionHours` after finishing | Keep undelivered videos, 72 h (1–720) |
| Waiting for review (script, storyboard or edit) with no activity | `undeliveredRetentionHours` after the last activity. Any edit counts as activity | same setting |
| Draft never confirmed | after `abandonedAfterHours` without activity: the job is marked abandoned (CANCELLED), its open cost quote is cancelled, files deleted | Abandon unconfirmed drafts, 48 h (1–720) |
| Folder without a job, or of a job whose media were deleted | next cleanup | — |
| Unfinished upload parts | removed after 24 h | — |

Retry resets the failure (`finishedAt` cleared), so a job being retried is
not counted as failed. A retried job that fails again starts a new
`failedRetentionHours` window, but the hard cap still applies from creation.

Tests: `scripts/verify-video-studio.ts` (the pure decision, every row above;
setting clamps) and `scripts/verify-video-pipeline.ts` § H (real job rows and
folders: retry window, failed past the window, delivered, hard cap with a
queued job, idle review, cancellation).
