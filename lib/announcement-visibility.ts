/**
 * Derives whether an Announcement is currently visible to students from
 * authoritative server time, mirroring how lib/live-test.ts derives a Live
 * Test's LIVE/ENDED state — DRAFT and ARCHIVED are explicit admin decisions
 * and always win outright; once PUBLISHED, visibility is computed purely
 * from `now` against `publishAt`/`expiresAt`, so it can never drift the way
 * a cron-updated status column could, and a scheduled announcement can never
 * appear before its time regardless of any client clock.
 *
 * Pure (no prisma, no `server-only`) so the exact boundary behavior is
 * directly testable from a Node script — see scripts/verify-announcements.ts.
 */

export type AnnouncementStatusValue = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface AnnouncementVisibilityRow {
  status: AnnouncementStatusValue;
  publishAt: Date | null;
  expiresAt: Date | null;
}

/** True once `publishAt` (if set) has passed and before `expiresAt` (if set) — exclusive at the expiry boundary. */
export function isAnnouncementVisible(row: AnnouncementVisibilityRow, now: Date): boolean {
  if (row.status !== "PUBLISHED") return false;
  if (row.publishAt && row.publishAt.getTime() > now.getTime()) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

export type DerivedAnnouncementState = "DRAFT" | "SCHEDULED" | "ACTIVE" | "EXPIRED" | "ARCHIVED";

/** Admin-facing derived state — same inputs as isAnnouncementVisible, but distinguishes "not yet" from "no longer" for the admin list/detail UI. */
export function deriveAnnouncementState(row: AnnouncementVisibilityRow, now: Date): DerivedAnnouncementState {
  if (row.status === "DRAFT" || row.status === "ARCHIVED") return row.status;
  if (row.publishAt && row.publishAt.getTime() > now.getTime()) return "SCHEDULED";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}
