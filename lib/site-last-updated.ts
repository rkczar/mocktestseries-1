import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * "Last Updated: DD Month YYYY" at the very bottom of the public footer
 * (Admin -> Website -> Footer -> Last Updated Date).
 *
 * Automatic mode shows the later of two timestamps, both of which exist only
 * after something succeeded:
 *  - the release's successful-deployment time — `.deployed-at` in the release
 *    root, written by ops/deploy/mocktestseries-deploy.sh only after the
 *    post-switch health check passes (a failed or rolled-back deploy never
 *    writes it; it is the real deploy time, not the git commit date);
 *  - the newest AuditLog row for an admin change to public content. Admin
 *    mutations write their AuditLog row after (or inside) their own database
 *    write, so a failed transaction leaves no row and never moves the date.
 *    Student activity, logins, AI usage and background jobs are either not in
 *    AuditLog or not in the public-content rules below.
 *
 * Settings live in the existing `Setting` table (no migration) and are read
 * through one cached lookup, so the footer adds no per-request query.
 */

const SETTING_KEY = "website.last_updated";
export const SITE_LAST_UPDATED_TAG = "site-last-updated";
/** Content-change lag is bounded by this; settings saves invalidate the tag immediately. */
const CACHE_SECONDS = 300;
export const DEPLOY_MARKER_FILE = ".deployed-at";
const TIME_ZONE = "Asia/Kolkata";

export type LastUpdatedMode = "AUTOMATIC" | "MANUAL";

export interface LastUpdatedConfig {
  show: boolean;
  mode: LastUpdatedMode;
  /** YYYY-MM-DD (a calendar date, no time zone) or "" when unset. */
  manualDate: string;
  updatedAt: string | null;
}

interface StoredLastUpdatedConfig {
  show?: boolean;
  mode?: string;
  manualDate?: string;
  updatedAt?: string;
}

// AuditLog actions that change what the public site shows. Prefix rules cover
// every current and future action of a content area (questions, mocks, PYQs,
// ...); EXCLUDED_ACTIONS carves out the admin-internal ones. Homepage Builder
// edits land in a DRAFT, so only publishing (and the live statistics / AI demo
// settings) counts there.
const PUBLIC_CONTENT_PREFIXES = [
  "QUESTION_",
  "IMPORT_QUESTION_",
  "IMPORT_BULK_",
  "MOCK_TEST_",
  "TEST_SERIES_",
  "TEST_RESOURCE_",
  "TEST_RANKING_",
  "CUSTOM_MODULE_",
  "PYP_",
  "PYQ_",
  "EXAM_",
  "SUBJECT_",
  "TOPIC_",
  "SUBTOPIC_",
  "SYLLABUS_",
  "PRODUCT_",
  "ANNOUNCEMENT_",
  "REVIEW_",
  "PREMIUM_GLOW_",
] as const;

const PUBLIC_CONTENT_ACTIONS = [
  "HOMEPAGE_PUBLISHED",
  "HOMEPAGE_STATISTICS_REFRESHED",
  "HOMEPAGE_AI_DEMO_SELECTION_SAVED",
  "BULK_IMPORT_COMPLETED",
  "BULK_IMPORT_VALID_ONLY",
  "BULK_IMPORT_ROLLBACK",
  "REVIEWS_SECTION_SETTINGS_SAVED",
  "SEO_SETTINGS_SAVED",
  "APPEARANCE_CHANGED",
  "LOGIN_PAGE_DESIGN_SAVED",
  "TELEGRAM_CHANNEL_CONFIG_SAVED",
  "WHATSAPP_SUPPORT_CONFIG_SAVED",
  "WHATSAPP_SHARE_CONFIG_SAVED",
  "PAYMENT_MODE_CHANGED",
  "GROUP_DISCOUNT_OFFER_TOGGLED",
] as const;

const EXCLUDED_ACTIONS = [
  // Moderation of student reports — the question itself is unchanged.
  "QUESTION_REPORT_STATUS_CHANGED",
  "QUESTION_REPORTED",
] as const;

/** Pure form of the database filter below (kept in one place so they can't drift). */
export function isPublicContentAuditAction(action: string): boolean {
  if ((EXCLUDED_ACTIONS as readonly string[]).includes(action)) return false;
  if ((PUBLIC_CONTENT_ACTIONS as readonly string[]).includes(action)) return true;
  return PUBLIC_CONTENT_PREFIXES.some((p) => action.startsWith(p));
}

const PUBLIC_CONTENT_WHERE: Prisma.AuditLogWhereInput = {
  OR: [{ action: { in: [...PUBLIC_CONTENT_ACTIONS] } }, ...PUBLIC_CONTENT_PREFIXES.map((p) => ({ action: { startsWith: p } }))],
  NOT: { action: { in: [...EXCLUDED_ACTIONS] } },
};

const MANUAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form, or null. */
export function parseManualDate(value: string): { y: number; m: number; d: number } | null {
  const match = MANUAL_DATE_RE.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** "11 October 2026" for an instant, in India Standard Time. */
export function formatIstDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "2-digit", month: "long", year: "numeric" }).format(instant);
}

/** Today's calendar date in IST as YYYY-MM-DD (the upper bound for a manual date). */
export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function formatManualDate(value: string): string | null {
  const parsed = parseManualDate(value);
  if (!parsed) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "long", year: "numeric" }).format(
    new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d))
  );
}

function normalizeConfig(raw: StoredLastUpdatedConfig): LastUpdatedConfig {
  return {
    show: raw.show ?? true,
    mode: raw.mode === "MANUAL" ? "MANUAL" : "AUTOMATIC",
    manualDate: typeof raw.manualDate === "string" && parseManualDate(raw.manualDate) ? raw.manualDate : "",
    updatedAt: raw.updatedAt ?? null,
  };
}

export async function getLastUpdatedConfig(): Promise<LastUpdatedConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  return normalizeConfig((row?.value as StoredLastUpdatedConfig | undefined) ?? {});
}

export async function saveLastUpdatedConfig(update: Omit<LastUpdatedConfig, "updatedAt">): Promise<void> {
  const next: StoredLastUpdatedConfig = { ...update, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
}

/** Newest successful public-content change by an admin, as an ISO string. */
export async function getLatestPublicContentChange(): Promise<string | null> {
  const row = await prisma.auditLog.findFirst({
    where: PUBLIC_CONTENT_WHERE,
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt.toISOString() ?? null;
}

const getCachedFooterInputs = unstable_cache(
  async () => {
    const [config, contentChangedAt] = await Promise.all([getLastUpdatedConfig(), getLatestPublicContentChange()]);
    return { config, contentChangedAt };
  },
  ["site-last-updated-v1"],
  { tags: [SITE_LAST_UPDATED_TAG], revalidate: CACHE_SECONDS }
);

// The marker never changes for a running release: remember it once found.
// While it is missing (first seconds after a switch, or a non-release build),
// look again at most every 30 seconds.
let deployedAt: string | null = null;
let deployCheckedAt = 0;

/** This release's successful-deployment time (ISO), or null when it has no marker. */
export function getDeployedAt(): string | null {
  if (deployedAt) return deployedAt;
  const now = Date.now();
  if (now - deployCheckedAt < 30_000) return null;
  deployCheckedAt = now;
  try {
    const raw = readFileSync(path.join(/* turbopackIgnore: true */ process.cwd(), DEPLOY_MARKER_FILE), "utf8").trim();
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) deployedAt = parsed.toISOString();
  } catch {
    // No marker: automatic mode falls back to content changes only.
  }
  return deployedAt;
}

/** The later of two ISO timestamps (either may be null). */
export function latestInstant(a: string | null, b: string | null): Date | null {
  const times = [a, b].filter((v): v is string => Boolean(v)).map((v) => new Date(v).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/** The date to print ("11 October 2026"), or null to hide the line. */
export function resolveLastUpdatedLabel(
  config: LastUpdatedConfig,
  sources: { deployedAt: string | null; contentChangedAt: string | null }
): string | null {
  if (!config.show) return null;
  if (config.mode === "MANUAL") {
    const manual = formatManualDate(config.manualDate);
    if (manual) return manual;
  }
  const latest = latestInstant(sources.deployedAt, sources.contentChangedAt);
  return latest ? formatIstDate(latest) : null;
}

/** For the footer: never throws (a read failure just hides the line). */
export async function getFooterLastUpdated(): Promise<string | null> {
  try {
    const { config, contentChangedAt } = await getCachedFooterInputs();
    return resolveLastUpdatedLabel(config, { deployedAt: getDeployedAt(), contentChangedAt });
  } catch {
    return null;
  }
}
