import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toIstDateString } from "@/lib/ist-time";
import { GA4_PROPERTY_ID, SEO_SITE_URL, SeoIntelError, getAccessToken, googleEndpoints, googleErrorText, googleFetch } from "@/lib/seo-intel/google";
import { getIntelSettings, pruneHistory, recordHistory } from "@/lib/seo-intel/history";

/**
 * "Sync now" (manual) and the daily scheduled sync (scripts/seo-intel-sync.ts)
 * for SEO Intelligence: pulls a 28-day read-only snapshot
 * from Search Console and the GA4 Data API through the shared connection and
 * stores it in Setting "seo.intel.snapshot" (no new tables), plus one daily
 * history summary (lib/seo-intel/history.ts), pruned to the retention setting. Nothing here
 * writes to Google or changes the site's own SEO output.
 */

export const SNAPSHOT_SETTING_KEY = "seo.intel.snapshot";
const LOCK_SETTING_KEY = "seo.intel.sync-lock";
const LOCK_STALE_MS = 3 * 60_000;
export const MIN_SYNC_INTERVAL_MS = 60_000;
const DAYS = 28;
const TOP_ROWS = 25;
/** Full Search Console tables, fetched a page at a time (startRow) up to a cap that bounds the snapshot's size. */
const GSC_PAGE_ROWS = 1000;
const GSC_MAX_ROWS = 5000;

export interface GscRow {
  key: string;
  /** Second dimension (the page, for query × page rows). */
  key2?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface Ga4Row {
  key: string;
  activeUsers: number;
  sessions: number;
  screenPageViews?: number;
}

export interface SeoSnapshot {
  lastSync: {
    ok: boolean;
    at: string;
    byId: string | null;
    gscError: string | null;
    ga4Error: string | null;
    /** Absent on syncs stored before scheduled sync existed (= manual). */
    source?: SyncSource;
    /** Consecutive failed syncs, 0 after a fully successful one. */
    failStreak?: number;
  } | null;
  gsc: {
    property: string;
    range: { start: string; end: string };
    totals: Omit<GscRow, "key">;
    daily: GscRow[];
    topQueries: GscRow[];
    topPages: GscRow[];
    /** Absent on snapshots stored before the full tables existed. */
    queries?: GscRow[];
    pages?: GscRow[];
    queryPages?: GscRow[];
    devices?: GscRow[];
    countries?: GscRow[];
    /** Tables that hit GSC_MAX_ROWS (more rows exist than were stored). */
    truncated?: string[];
  } | null;
  ga4: {
    propertyId: string;
    range: { start: string; end: string };
    totals: { activeUsers: number; sessions: number; screenPageViews: number; engagementRate: number };
    daily: Ga4Row[];
    channels: Ga4Row[];
    landingPages: Ga4Row[];
    /** Organic Search sessions only; absent on older snapshots. */
    organicLandingPages?: (Ga4Row & { engagedSessions: number; keyEvents: number })[];
  } | null;
}

const EMPTY: SeoSnapshot = { lastSync: null, gsc: null, ga4: null };

export async function getSnapshot(): Promise<SeoSnapshot> {
  const row = await prisma.setting.findUnique({ where: { key: SNAPSHOT_SETTING_KEY } });
  return { ...EMPTY, ...((row?.value as Partial<SeoSnapshot> | null) ?? {}) };
}

async function saveSnapshot(value: SeoSnapshot) {
  const json = value as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: SNAPSHOT_SETTING_KEY }, create: { key: SNAPSHOT_SETTING_KEY, value: json }, update: { value: json } });
}

function isoDaysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");

// ---- Search Console --------------------------------------------------------------------------

/** The Search Console property for the site: the Domain property first, else the URL-prefix one. */
function pickGscProperty(json: Record<string, unknown> | null): string | null {
  const host = new URL(SEO_SITE_URL).host;
  const entries = Array.isArray(json?.siteEntry) ? (json!.siteEntry as { siteUrl?: unknown; permissionLevel?: unknown }[]) : [];
  const usable = new Set(entries.filter((e) => typeof e.siteUrl === "string" && e.permissionLevel !== "siteUnverifiedUser").map((e) => e.siteUrl as string));
  return [`sc-domain:${host}`, `${SEO_SITE_URL}/`].find((p) => usable.has(p)) ?? null;
}

async function syncSearchConsole(accessToken: string, secrets: string[]): Promise<NonNullable<SeoSnapshot["gsc"]>> {
  const base = googleEndpoints().searchConsole;
  const sites = await googleFetch(`${base}/sites`, { method: "GET", accessToken });
  if (sites.status !== 200) throw new SeoIntelError(`Search Console sites: ${googleErrorText(sites, secrets)}`);
  const property = pickGscProperty(sites.json);
  if (!property) throw new SeoIntelError(`The connected Google account has no verified Search Console property for ${new URL(SEO_SITE_URL).host}.`);

  // Search Console data settles ~2–3 days after the fact.
  const end = isoDaysBefore(toIstDateString(new Date()), 3);
  const start = isoDaysBefore(end, DAYS - 1);
  const query = async (dimensions: string[], rowLimit: number, startRow = 0) => {
    const r = await googleFetch(`${base}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      method: "POST",
      accessToken,
      json: { startDate: start, endDate: end, dimensions, rowLimit, startRow, type: "web" },
    });
    if (r.status !== 200) throw new SeoIntelError(`Search Console query: ${googleErrorText(r, secrets)}`);
    const rows = Array.isArray(r.json?.rows) ? (r.json!.rows as Record<string, unknown>[]) : [];
    return rows.map((row) => ({
      key: Array.isArray(row.keys) ? str(row.keys[0]) : "",
      ...(Array.isArray(row.keys) && row.keys.length > 1 ? { key2: str(row.keys[1]) } : {}),
      clicks: num(row.clicks),
      impressions: num(row.impressions),
      ctr: num(row.ctr),
      position: num(row.position),
    }));
  };
  // Every row up to GSC_MAX_ROWS: a short page means the table is complete.
  const truncated: string[] = [];
  const queryAll = async (dimensions: string[]) => {
    const rows: GscRow[] = [];
    while (rows.length < GSC_MAX_ROWS) {
      const page = await query(dimensions, GSC_PAGE_ROWS, rows.length);
      rows.push(...page);
      if (page.length < GSC_PAGE_ROWS) return rows;
    }
    truncated.push(dimensions.join("+"));
    return rows.slice(0, GSC_MAX_ROWS);
  };
  const [totalsRows, daily, queries, pages, queryPages, devices, countries] = await Promise.all([
    query([], 1),
    query(["date"], DAYS + 2),
    queryAll(["query"]),
    queryAll(["page"]),
    queryAll(["query", "page"]),
    query(["device"], 10),
    query(["country"], 50),
  ]);
  const t = totalsRows[0];
  return {
    property,
    range: { start, end },
    totals: { clicks: t?.clicks ?? 0, impressions: t?.impressions ?? 0, ctr: t?.ctr ?? 0, position: t?.position ?? 0 },
    daily: daily.sort((a, b) => a.key.localeCompare(b.key)),
    // The dashboard tables and history keep reading the top 25.
    topQueries: queries.slice(0, TOP_ROWS),
    topPages: pages.slice(0, TOP_ROWS),
    queries,
    pages,
    queryPages,
    devices,
    countries,
    ...(truncated.length ? { truncated } : {}),
  };
}

// ---- GA4 Data API ----------------------------------------------------------------------------

async function syncGa4(accessToken: string, secrets: string[]): Promise<NonNullable<SeoSnapshot["ga4"]>> {
  const end = isoDaysBefore(toIstDateString(new Date()), 1);
  const start = isoDaysBefore(end, DAYS - 1);
  const dateRanges = [{ startDate: start, endDate: end }];
  const r = await googleFetch(`${googleEndpoints().analyticsData}/properties/${GA4_PROPERTY_ID}:batchRunReports`, {
    method: "POST",
    accessToken,
    json: {
      requests: [
        { dateRanges, metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }, { name: "engagementRate" }] },
        {
          dateRanges,
          dimensions: [{ name: "date" }],
          metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
          orderBys: [{ dimension: { dimensionName: "date" } }],
          limit: DAYS + 2,
        },
        {
          dateRanges,
          dimensions: [{ name: "sessionDefaultChannelGroup" }],
          metrics: [{ name: "activeUsers" }, { name: "sessions" }],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 20,
        },
        {
          dateRanges,
          dimensions: [{ name: "landingPage" }],
          metrics: [{ name: "activeUsers" }, { name: "sessions" }],
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: TOP_ROWS,
        },
        {
          dateRanges,
          dimensions: [{ name: "landingPage" }],
          metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }],
          dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 100,
        },
      ],
    },
  });
  if (r.status !== 200) throw new SeoIntelError(`GA4 property ${GA4_PROPERTY_ID}: ${googleErrorText(r, secrets)}`);
  const reports = Array.isArray(r.json?.reports) ? (r.json!.reports as Record<string, unknown>[]) : [];
  const rowsOf = (i: number) => {
    const rep = reports[i] ?? {};
    const names = Array.isArray(rep.metricHeaders) ? (rep.metricHeaders as { name?: string }[]).map((h) => h.name ?? "") : [];
    const rows = Array.isArray(rep.rows) ? (rep.rows as { dimensionValues?: { value?: unknown }[]; metricValues?: { value?: unknown }[] }[]) : [];
    return rows.map((row) => {
      const m: Record<string, number> = {};
      names.forEach((n, j) => (m[n] = num(row.metricValues?.[j]?.value)));
      return { key: str(row.dimensionValues?.[0]?.value), m };
    });
  };
  const totals = rowsOf(0)[0]?.m ?? {};
  const toRow = (x: { key: string; m: Record<string, number> }): Ga4Row => ({
    key: x.key,
    activeUsers: x.m.activeUsers ?? 0,
    sessions: x.m.sessions ?? 0,
    ...(x.m.screenPageViews !== undefined ? { screenPageViews: x.m.screenPageViews } : {}),
  });
  return {
    propertyId: GA4_PROPERTY_ID,
    range: { start, end },
    totals: {
      activeUsers: totals.activeUsers ?? 0,
      sessions: totals.sessions ?? 0,
      screenPageViews: totals.screenPageViews ?? 0,
      engagementRate: totals.engagementRate ?? 0,
    },
    // GA4 dates come back as YYYYMMDD.
    daily: rowsOf(1).map(toRow).map((d) => ({ ...d, key: d.key.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") })),
    channels: rowsOf(2).map(toRow),
    landingPages: rowsOf(3).map(toRow),
    organicLandingPages: rowsOf(4).map((x) => ({ ...toRow(x), engagedSessions: x.m.engagedSessions ?? 0, keyEvents: x.m.keyEvents ?? 0 })),
  };
}

// ---- Sync ------------------------------------------------------------------------------------

async function acquireLock(): Promise<boolean> {
  try {
    await prisma.setting.create({ data: { key: LOCK_SETTING_KEY, value: { at: new Date().toISOString() } } });
    return true;
  } catch {
    // Held: take it over only if the holder died long ago.
    const stale = await prisma.setting.deleteMany({ where: { key: LOCK_SETTING_KEY, updatedAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } } });
    if (!stale.count) return false;
    try {
      await prisma.setting.create({ data: { key: LOCK_SETTING_KEY, value: { at: new Date().toISOString() } } });
      return true;
    } catch {
      return false;
    }
  }
}

export type SyncSource = "manual" | "scheduled";
export type SyncResult = { ok: boolean; message: string; gscError: string | null; ga4Error: string | null; skipped?: boolean; historyDate?: string | null; pruned?: number };

/**
 * One sync (MASTER_ADMIN check is the caller's job for manual syncs; the
 * scheduled script checks the auto-sync switch). Search Console and GA4
 * succeed or fail independently.
 */
export async function runSync(adminId: string | null, source: SyncSource = "manual"): Promise<SyncResult> {
  const previous = await getSnapshot();
  if (previous.lastSync && Date.now() - new Date(previous.lastSync.at).getTime() < MIN_SYNC_INTERVAL_MS) {
    return { ok: false, skipped: true, message: "A sync ran less than a minute ago. Please wait a moment.", gscError: null, ga4Error: null };
  }
  if (!(await acquireLock())) return { ok: false, skipped: true, message: "A sync is already running.", gscError: null, ga4Error: null };
  const failStreak = (ok: boolean) => (ok ? 0 : (previous.lastSync?.failStreak ?? (previous.lastSync && !previous.lastSync.ok ? 1 : 0)) + 1);
  try {
    let token: { accessToken: string; secrets: string[] };
    try {
      token = await getAccessToken();
    } catch (err) {
      const message = err instanceof SeoIntelError ? err.message : "Could not get a Google access token.";
      await saveSnapshot({ ...previous, lastSync: { ok: false, at: new Date().toISOString(), byId: adminId, gscError: message, ga4Error: message, source, failStreak: failStreak(false) } });
      return { ok: false, message, gscError: message, ga4Error: message };
    }
    const failText = (err: unknown) => (err instanceof SeoIntelError ? err.message : "Unexpected error.");
    const [gsc, ga4] = await Promise.allSettled([syncSearchConsole(token.accessToken, token.secrets), syncGa4(token.accessToken, token.secrets)]);
    const gscError = gsc.status === "rejected" ? failText(gsc.reason) : null;
    const ga4Error = ga4.status === "rejected" ? failText(ga4.reason) : null;
    if (gsc.status === "rejected" && !(gsc.reason instanceof SeoIntelError)) console.error("[seo-intel] gsc sync failed");
    if (ga4.status === "rejected" && !(ga4.reason instanceof SeoIntelError)) console.error("[seo-intel] ga4 sync failed");
    const ok = !gscError && !ga4Error;
    const at = new Date();
    const freshGsc = gsc.status === "fulfilled" ? gsc.value : null;
    const freshGa4 = ga4.status === "fulfilled" ? ga4.value : null;
    await saveSnapshot({
      // A failed half keeps its last good data.
      gsc: freshGsc ?? previous.gsc,
      ga4: freshGa4 ?? previous.ga4,
      lastSync: { ok, at: at.toISOString(), byId: adminId, gscError, ga4Error, source, failStreak: failStreak(ok) },
    });
    // History + retention never fail the sync itself.
    let historyDate: string | null = null;
    let pruned = 0;
    try {
      historyDate = await recordHistory({ gsc: freshGsc, ga4: freshGa4 }, at);
      pruned = await pruneHistory((await getIntelSettings()).historyDays, at);
    } catch {
      console.error("[seo-intel] history/retention step failed");
    }
    return {
      ok,
      message: ok ? "Synced Search Console and GA4." : gscError && ga4Error ? "Sync failed." : "Sync partly failed.",
      gscError,
      ga4Error,
      historyDate,
      pruned,
    };
  } finally {
    await prisma.setting.deleteMany({ where: { key: LOCK_SETTING_KEY } });
  }
}
