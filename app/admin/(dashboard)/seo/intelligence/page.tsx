import Link from "next/link";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst } from "@/lib/ist-time";
import { getConnectionView } from "@/lib/seo-intel/google";
import { getSnapshot, type GscRow, type Ga4Row } from "@/lib/seo-intel/sync";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConnectionControls } from "./connection-controls";

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
const when = (iso: string | null | undefined) => (iso ? `${formatIst(new Date(iso))} IST` : "—");

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

  const [conn, snap, sp] = await Promise.all([getConnectionView(), getSnapshot(), searchParams]);
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
                {snap.lastSync ? `${when(snap.lastSync.at)} — ${snap.lastSync.ok ? "OK" : "with errors"}` : "Never"}
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
            <GscTable title="Top queries" rows={snap.gsc.topQueries} label="Query" />
            <GscTable title="Top pages" rows={snap.gsc.topPages} label="Page" />
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
            <Ga4Table title="Channels" rows={snap.ga4.channels} label="Channel" />
            <Ga4Table title="Top landing pages" rows={snap.ga4.landingPages} label="Landing page" />
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
