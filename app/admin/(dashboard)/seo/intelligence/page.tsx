import fs from "node:fs";
import Link from "next/link";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst } from "@/lib/ist-time";
import { getConnectionView } from "@/lib/seo-intel/google";
import { getSnapshot, type GscRow, type Ga4Row } from "@/lib/seo-intel/sync";
import { HISTORY_DAYS_MAX, HISTORY_DAYS_MIN, comparisonEntry, getIntelSettings, listHistory, type HistoryEntry } from "@/lib/seo-intel/history";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConnectionControls } from "./connection-controls";
import { IntelSettingsForm } from "./intel-settings-form";

/** Installed copy of ops/seo/mocktestseries-seo-intel.cron (the daily sync does nothing without it). */
const CRON_FILE = "/etc/cron.d/mocktestseries-seo-intel";

export const metadata = { title: "SEO Intelligence — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/** Messages for the ?google=… result of the OAuth callback (fixed text; nothing from the URL is echoed). */
const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Google connected. Run Sync now to load Search Console and GA4 data.",
  state: "The Google sign-in could not be verified (state mismatch). Please start again from this page.",
  expired: "The Google sign-in took longer than 10 minutes. Please start again.",
  "other-admin": "The Google sign-in was started by a different admin. Please start again.",
  denied: "Google access was not granted.",
  "bad-request": "Google returned an invalid response. Please try again.",
  "not-configured": "The SEO Google OAuth client is not installed on the server yet.",
  exchange: "Google refused the sign-in code. Check that the redirect URI and client secret match Google Cloud, then try again.",
  "no-refresh-token":
    "Google did not grant offline access. Remove the app at myaccount.google.com/permissions, then connect again.",
  "missing-scopes": "Both Search Console and Analytics access must be allowed on Google's consent screen. Please connect again and tick both.",
  "id-token": "Google's account details could not be verified. Please try again.",
  forbidden: "Only a Master Admin can connect Google.",
};

const fmt = new Intl.NumberFormat("en-IN");
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
// formatIst already ends with "IST".
const when = (iso: string | null | undefined) => (iso ? formatIst(new Date(iso)) : "—");

function GscTable({ title, rows, label }: { title: string; rows: GscRow[]; label: string }) {
  return (
    <div className="overflow-x-auto">
      <h3 className="mb-2 text-sm font-semibold text-[var(--color-foreground)]">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No rows.</p>
      ) : (
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
              <th className="py-2 pr-4">{label}</th>
              <th className="py-2 pr-4 text-right">Clicks</th>
              <th className="py-2 pr-4 text-right">Impressions</th>
              <th className="py-2 pr-4 text-right">CTR</th>
              <th className="py-2 pr-4 text-right">Position</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-[var(--color-border)] last:border-0">
                <td className="max-w-md truncate py-2 pr-4 text-[var(--color-foreground)]" title={r.key}>
                  {r.key}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt.format(r.clicks)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt.format(r.impressions)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{pct(r.ctr)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{r.position.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Ga4Table({ title, rows, label }: { title: string; rows: Ga4Row[]; label: string }) {
  return (
    <div className="overflow-x-auto">
      <h3 className="mb-2 text-sm font-semibold text-[var(--color-foreground)]">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No rows.</p>
      ) : (
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
              <th className="py-2 pr-4">{label}</th>
              <th className="py-2 pr-4 text-right">Sessions</th>
              <th className="py-2 pr-4 text-right">Active users</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-[var(--color-border)] last:border-0">
                <td className="max-w-md truncate py-2 pr-4 text-[var(--color-foreground)]" title={r.key}>
                  {r.key || "(not set)"}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt.format(r.sessions)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt.format(r.activeUsers)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Single-series daily bar chart (one hue, baseline-anchored bars with rounded
 * tops, 2px gaps, per-bar hover tooltip) with a table view underneath.
 */
function DailyBars({ title, unit, rows }: { title: string; unit: string; rows: { key: string; value: number }[] }) {
  if (rows.length === 0) return null;
  const W = 600;
  const H = 120;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const step = W / rows.length;
  const bw = Math.max(2, step - 2);
  return (
    <figure className="flex flex-col gap-1" data-testid="seo-intel-chart">
      <figcaption className="text-sm font-semibold text-[var(--color-foreground)]">{title}</figcaption>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Peak {fmt.format(max)} {unit}
      </p>
      <svg viewBox={`0 0 ${W} ${H + 1}`} className="h-28 w-full" role="img" aria-label={`${title}, ${rows[0].key} to ${rows[rows.length - 1].key}`} preserveAspectRatio="none">
        {rows.map((r, i) => {
          const h = Math.max(r.value > 0 ? 2 : 0, (r.value / max) * H);
          const x = i * step + 1;
          const y = H - h;
          const rad = Math.min(4, bw / 2, h);
          const d = h === 0 ? "" : `M${x},${H} V${y + rad} Q${x},${y} ${x + rad},${y} H${x + bw - rad} Q${x + bw},${y} ${x + bw},${y + rad} V${H} Z`;
          return (
            <g key={r.key}>
              <rect x={i * step} y={0} width={step} height={H} fill="transparent">
                <title>{`${r.key}: ${fmt.format(r.value)} ${unit}`}</title>
              </rect>
              {d ? (
                <path d={d} fill="var(--color-primary)" pointerEvents="none" />
              ) : null}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--color-border)" strokeWidth={1} />
      </svg>
      <div className="flex justify-between text-xs text-[var(--color-muted-foreground)]">
        <span>{rows[0].key}</span>
        <span>{rows[rows.length - 1].key}</span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-[var(--color-muted-foreground)]">Show as table</summary>
        <table className="mt-2 w-full max-w-sm text-left text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-[var(--color-border)] last:border-0">
                <td className="py-1 pr-4">{r.key}</td>
                <td className="py-1 text-right tabular-nums">{fmt.format(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function Delta({ label, now, then }: { label: string; now: number | undefined; then: number | undefined }) {
  if (now === undefined || then === undefined) return null;
  const diff = now - then;
  const pctText = then > 0 ? ` (${diff >= 0 ? "+" : "−"}${Math.abs((diff / then) * 100).toFixed(1)}%)` : "";
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
      <p className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</p>
      <p className="mt-1 text-sm tabular-nums text-[var(--color-foreground)]">
        {fmt.format(now)}{" "}
        <span className="text-[var(--color-muted-foreground)]">
          {diff === 0 ? "no change" : `${diff > 0 ? "▲ +" : "▼ −"}${fmt.format(Math.abs(diff))}${pctText}`}
        </span>
      </p>
    </div>
  );
}

function CsvLink({ report, label }: { report: string; label: string }) {
  return (
    <a href={`/api/admin/seo-intel/export?report=${report}`} className="text-sm text-[var(--color-primary)] hover:underline" download>
      {label}
    </a>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
      <p className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-[var(--color-foreground)]">{value}</p>
    </div>
  );
}

export default async function SeoIntelligencePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getAdminSession();
  const perms = session?.user?.permissions ?? [];
  if (!perms.includes(PERMISSIONS.SEO_INTEL_VIEW)) return <RestrictedCard title="SEO Intelligence" />;
  const canManage = perms.includes(PERMISSIONS.SEO_INTEL_MANAGE);

  const [conn, snap, sp, intel, history] = await Promise.all([getConnectionView(), getSnapshot(), searchParams, getIntelSettings(), listHistory(90)]);
  const cronInstalled = fs.existsSync(CRON_FILE);
  const compare: HistoryEntry | null = comparisonEntry(history);
  const latest = history[0] ?? null;
  const status = typeof sp.google === "string" ? sp.google : null;
  const reason = typeof sp.reason === "string" ? sp.reason : null;
  const callbackMessage = status === "connected" ? CALLBACK_MESSAGES.connected : status === "error" ? CALLBACK_MESSAGES[reason ?? ""] ?? "Google connection failed." : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/seo" className="text-sm text-[var(--color-primary)] hover:underline">
          ← SEO
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-[var(--color-foreground)]">SEO Intelligence</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Read-only Google Search Console and GA4 data for {conn.siteUrl}, through one shared Google connection. Nothing here changes the
          site&apos;s SEO settings, sitemap or pages.
        </p>
      </div>

      {callbackMessage ? (
        <p
          role="status"
          data-testid="seo-intel-callback"
          className={`rounded-[var(--radius-card)] border p-3 text-sm ${status === "connected" ? "border-[var(--color-success)]/40 text-[var(--color-success)]" : "border-[var(--color-error)]/40 text-[var(--color-error)]"}`}
        >
          {callbackMessage}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Google Connection
            {conn.connected ? (
              conn.needsReconnect ? (
                <Badge variant="error">Needs reconnect</Badge>
              ) : (
                <Badge variant="success">Connected</Badge>
              )
            ) : (
              <Badge variant="neutral">Not connected</Badge>
            )}
            {conn.testMode ? <Badge variant="warning">Test mode — mock Google</Badge> : null}
          </CardTitle>
          <CardDescription>
            {canManage ? "Only Master Admins can connect, disconnect or sync." : "View only — connecting and syncing require MASTER_ADMIN."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="seo-intel-connection">
            <div>
              <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Google account</dt>
              <dd className="text-[var(--color-foreground)]">{conn.accountEmail ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">GA4 property</dt>
              <dd className="text-[var(--color-foreground)]">{conn.ga4PropertyId}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Search Console property</dt>
              <dd className="text-[var(--color-foreground)]">{snap.gsc?.property ?? "Found on first sync"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Connected</dt>
              <dd className="text-[var(--color-foreground)]">
                {conn.connected ? `${when(conn.connectedAt)}${conn.connectedByName ? ` by ${conn.connectedByName}` : ""}` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Last sync</dt>
              <dd className="text-[var(--color-foreground)]">
                {snap.lastSync
                  ? `${when(snap.lastSync.at)} — ${snap.lastSync.ok ? "OK" : "with errors"} (${snap.lastSync.source === "scheduled" ? "daily automatic" : "manual"})`
                  : "Never"}
                {snap.lastSync && (snap.lastSync.failStreak ?? 0) > 1 ? (
                  <span className="block text-[var(--color-error)]" data-testid="seo-intel-fail-streak">
                    {snap.lastSync.failStreak} failed syncs in a row
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">OAuth client</dt>
              <dd className="text-[var(--color-foreground)]">{conn.credentialsConfigured ? `Installed (${conn.clientIdHint})` : "Not installed"}</dd>
            </div>
            {canManage ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Authorized redirect URI (Google Cloud)</dt>
                <dd>
                  <code className="break-all text-xs">{conn.redirectUri}</code>
                </dd>
              </div>
            ) : null}
          </dl>
          {conn.needsReconnect ? (
            <p className="text-sm text-[var(--color-error)]">
              Google rejected the saved connection{conn.needsReconnectReason ? ` (${conn.needsReconnectReason})` : ""}. A Master Admin must reconnect.
            </p>
          ) : null}
          {snap.lastSync && (snap.lastSync.gscError || snap.lastSync.ga4Error) ? (
            <ul className="list-disc pl-5 text-sm text-[var(--color-error)]" data-testid="seo-intel-sync-errors">
              {snap.lastSync.gscError ? <li>Search Console: {snap.lastSync.gscError}</li> : null}
              {snap.lastSync.ga4Error && snap.lastSync.ga4Error !== snap.lastSync.gscError ? <li>GA4: {snap.lastSync.ga4Error}</li> : null}
            </ul>
          ) : null}
          {canManage ? <ConnectionControls credentialsConfigured={conn.credentialsConfigured} connected={conn.connected} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Schedule &amp; Retention
            {intel.autoSyncEnabled ? <Badge variant="success">Daily sync on</Badge> : <Badge variant="neutral">Daily sync off</Badge>}
            {intel.autoSyncEnabled && !cronInstalled ? <Badge variant="warning">Scheduler not installed</Badge> : null}
          </CardTitle>
          <CardDescription>
            Daily automatic sync at 03:10 IST stores one summary per day; history older than {intel.historyDays} days is deleted automatically.
            Scheduler {cronInstalled ? "installed" : "not installed on the server (see ops/SEO-INTELLIGENCE.md)"}.
          </CardDescription>
        </CardHeader>
        {canManage ? (
          <CardContent>
            <IntelSettingsForm autoSyncEnabled={intel.autoSyncEnabled} historyDays={intel.historyDays} min={HISTORY_DAYS_MIN} max={HISTORY_DAYS_MAX} />
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            {history.length
              ? `${history.length} day${history.length === 1 ? "" : "s"} recorded (28-day totals as of each sync).`
              : "No history yet — each day with a successful sync adds one entry."}
          </CardDescription>
        </CardHeader>
        {history.length ? (
          <CardContent className="flex flex-col gap-4" data-testid="seo-intel-history">
            {latest && compare ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  {latest.date} compared with {compare.date}
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="seo-intel-compare">
                  <Delta label="Clicks" now={latest.gsc?.totals.clicks} then={compare.gsc?.totals.clicks} />
                  <Delta label="Impressions" now={latest.gsc?.totals.impressions} then={compare.gsc?.totals.impressions} />
                  <Delta label="Sessions" now={latest.ga4?.totals.sessions} then={compare.ga4?.totals.sessions} />
                  <Delta label="Active users" now={latest.ga4?.totals.activeUsers} then={compare.ga4?.totals.activeUsers} />
                </div>
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4 text-right">Clicks</th>
                    <th className="py-2 pr-4 text-right">Impressions</th>
                    <th className="py-2 pr-4 text-right">CTR</th>
                    <th className="py-2 pr-4 text-right">Sessions</th>
                    <th className="py-2 pr-4 text-right">Active users</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 30).map((h) => (
                    <tr key={h.date} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2 pr-4">{h.date}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{h.gsc ? fmt.format(h.gsc.totals.clicks) : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{h.gsc ? fmt.format(h.gsc.totals.impressions) : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{h.gsc ? pct(h.gsc.totals.ctr) : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{h.ga4 ? fmt.format(h.ga4.totals.sessions) : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{h.ga4 ? fmt.format(h.ga4.totals.activeUsers) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CsvLink report="history" label="Download history (CSV)" />
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Search Console</CardTitle>
          <CardDescription>
            {snap.gsc ? `Web search, ${snap.gsc.range.start} to ${snap.gsc.range.end} (data settles ~3 days late).` : "No data yet — a Master Admin can run Sync now."}
          </CardDescription>
        </CardHeader>
        {snap.gsc ? (
          <CardContent className="flex flex-col gap-6" data-testid="seo-intel-gsc">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Clicks" value={fmt.format(snap.gsc.totals.clicks)} />
              <Stat label="Impressions" value={fmt.format(snap.gsc.totals.impressions)} />
              <Stat label="CTR" value={pct(snap.gsc.totals.ctr)} />
              <Stat label="Avg position" value={snap.gsc.totals.position.toFixed(1)} />
            </div>
            <DailyBars title="Clicks per day" unit="clicks" rows={snap.gsc.daily.map((d) => ({ key: d.key, value: d.clicks }))} />
            <GscTable title="Top queries" rows={snap.gsc.topQueries} label="Query" />
            <GscTable title="Top pages" rows={snap.gsc.topPages} label="Page" />
            <div className="flex flex-wrap gap-4">
              <CsvLink report="queries" label="Download queries (CSV)" />
              <CsvLink report="pages" label="Download pages (CSV)" />
            </div>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Google Analytics 4</CardTitle>
          <CardDescription>
            {snap.ga4 ? `Property ${snap.ga4.propertyId}, ${snap.ga4.range.start} to ${snap.ga4.range.end}.` : "No data yet — a Master Admin can run Sync now."}
          </CardDescription>
        </CardHeader>
        {snap.ga4 ? (
          <CardContent className="flex flex-col gap-6" data-testid="seo-intel-ga4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Active users" value={fmt.format(snap.ga4.totals.activeUsers)} />
              <Stat label="Sessions" value={fmt.format(snap.ga4.totals.sessions)} />
              <Stat label="Page views" value={fmt.format(snap.ga4.totals.screenPageViews)} />
              <Stat label="Engagement rate" value={pct(snap.ga4.totals.engagementRate)} />
            </div>
            <DailyBars title="Sessions per day" unit="sessions" rows={snap.ga4.daily.map((d) => ({ key: d.key, value: d.sessions }))} />
            <Ga4Table title="Channels" rows={snap.ga4.channels} label="Channel" />
            <Ga4Table title="Top landing pages" rows={snap.ga4.landingPages} label="Landing page" />
            <div className="flex flex-wrap gap-4">
              <CsvLink report="channels" label="Download channels (CSV)" />
              <CsvLink report="landing-pages" label="Download landing pages (CSV)" />
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
