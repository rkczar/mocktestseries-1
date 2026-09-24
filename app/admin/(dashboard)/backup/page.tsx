import { Download } from "lucide-react";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PRODUCTION_ROOTS } from "@/lib/backup/roots";
import { autoVerifyCheap, listArtifacts, resolveArtifact, type Artifact } from "@/lib/backup/discovery";
import { planBackupCleanup, retentionClass } from "@/lib/backup/cleanup";
import { listReleases, planReleaseCleanup, RELEASE_STATUS_LABEL, type Release } from "@/lib/backup/releases";
import { buildStorageView, fmtBytes, getStorageSnapshot, releaseSizeMap, type StorageRow, type StorageView } from "@/lib/backup/storage";
import { listTemp, sweepStaleJobs } from "@/lib/backup/jobs";
import { buildInventory, CLEAN_EXCLUDED_TABLE_DATA, groupComponentSizes, readPackageManifest, type ComponentSizes } from "@/lib/backup/package";
import { BACKUP_AUDIT_ENTITY_TYPES } from "@/lib/backup/audit";
import { getRetentionSettings, type RetentionSettings } from "@/lib/backup/settings";
import { StudentReportControls } from "./student-report-controls";
import { ArtifactActions, BackupOpsProvider, BulkCleanupForm, CreateBackupCard, ReleaseDelete, RestorePanel, RetentionForm, SimpleAction, StatusBadge, UploadVerify } from "./_components/client";

export const metadata = { title: "Backup & Disaster Recovery — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const DOWNLOAD_BUTTON =
  "inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)]";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "create", label: "Create Backup" },
  { value: "vps", label: "VPS Backups" },
  { value: "releases", label: "Releases" },
  { value: "retention", label: "Retention" },
  { value: "verify", label: "Verify" },
  { value: "restore", label: "Restore" },
  { value: "history", label: "History" },
] as const;

const roots = PRODUCTION_ROOTS;

const fmtDate = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtAge = (ms: number) => (!Number.isFinite(ms) ? "never" : ms < 90_000 ? "just now" : ms < 3600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3600_000)} h ago`);

function serializeArtifact(a: Artifact) {
  return { id: a.id, name: a.name, category: a.category, sizeBytes: a.sizeBytes, mtime: a.mtime.toISOString(), verification: a.verification, deletable: a.deletable, kind: a.kind, protectedReason: a.protectedReason };
}

function Table({ head, children, minWidth = 720 }: { head: string[]; children: React.ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm [&_td]:py-2 [&_td]:pr-3 [&_td]:align-top [&_tr]:border-b [&_tr]:border-[var(--color-border)]" style={{ minWidth }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="py-2 pr-3 text-xs font-medium uppercase text-[var(--color-muted-foreground)]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/**
 * Everything a tab needs, all cheap: readdir/stat listings, df, one small
 * query, and the persisted storage snapshot (a stale snapshot refreshes in
 * the background; only a first-ever visit waits, and at most a few seconds).
 */
async function loadCore(opts: { verify: boolean; storageWaitMs?: number }) {
  const settings = await getRetentionSettings();
  await sweepStaleJobs(roots).catch(() => undefined);
  let artifacts = await listArtifacts(roots);
  if (opts.verify && (await autoVerifyCheap(roots, artifacts)) > 0) artifacts = await listArtifacts(roots);
  const snapshot = await getStorageSnapshot(roots, { waitMs: opts.storageWaitMs ?? 0 });
  const { releases, currentSha } = await listReleases(roots, { sizes: releaseSizeMap(snapshot), rollbackToKeep: settings.rollbackReleasesToKeep });
  return { settings, artifacts, snapshot, releases, currentSha };
}

function protectedReleaseSummary(s: RetentionSettings) {
  return `Current + ${s.rollbackReleasesToKeep} Rollback`;
}

function StorageBar({ bytes, used }: { bytes: number | null; used: number | null }) {
  const pct = used && bytes ? Math.max(0.5, (bytes / used) * 100) : 0;
  return (
    <div className="h-1.5 rounded-full bg-[var(--color-muted)]">
      <div className="h-1.5 rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function PartitionRow({ row, used }: { row: StorageRow; used: number | null }) {
  const pct = used && row.bytes != null ? ` · ${((row.bytes / used) * 100).toFixed(1)}%` : "";
  const head = (
    <div className="flex flex-wrap justify-between gap-2 text-sm">
      <span>{row.label}</span>
      <span className="font-medium">
        {fmtBytes(row.bytes)}
        <span className="text-xs font-normal text-[var(--color-muted-foreground)]">{pct}</span>
      </span>
    </div>
  );
  return (
    <li className="flex flex-col gap-1">
      {row.children?.length ? (
        <details>
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{head}</summary>
          <ul className="mt-1 flex flex-col gap-1 border-l border-[var(--color-border)] pl-3">
            {row.children.map((c) => (
              <li key={c.key} className="flex flex-wrap justify-between gap-2 text-xs">
                <span>
                  {c.label}
                  {c.note ? <span className="block text-[10px] text-[var(--color-muted-foreground)]">{c.note}</span> : null}
                </span>
                <span>{fmtBytes(c.bytes)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        head
      )}
      <StorageBar bytes={row.bytes} used={used} />
      {row.note ? <span className="text-[10px] text-[var(--color-muted-foreground)]">{row.note}</span> : null}
    </li>
  );
}

function HealthBadge({ health }: { health: StorageView["health"] }) {
  return <Badge variant={health === "HEALTHY" ? "success" : health === "WARNING" ? "warning" : health === "CRITICAL" ? "error" : "neutral"}>{health}</Badge>;
}

function ComponentSizeList({ sizes }: { sizes: ComponentSizes }) {
  const rows: [string, number | null][] = [
    ["Database", sizes.database],
    ["Application Source", sizes.source],
    ["Persistent Assets", sizes.assets],
    ["Encrypted Configuration", sizes.encryptedConfig],
    ["Other Required Data", sizes.other],
    ["Final Archive Size", sizes.archive],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-3">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <dt className="text-[var(--color-muted-foreground)]">{k}</dt>
          <dd className={k === "Final Archive Size" ? "font-medium" : undefined}>{fmtBytes(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReleaseRows({ releases, canManage }: { releases: Release[]; canManage: boolean }) {
  return (
    <Table head={["Release SHA", "Created", "Size", "Source", "Build (.next)", "Dependencies", "Status", "Cleanup", ""]} minWidth={1080}>
      {releases.map((r) => (
        <tr key={r.id}>
          <td className="font-mono text-xs">{r.sha.slice(0, 12)}</td>
          <td>{fmtDate(r.mtime)}</td>
          <td>{fmtBytes(r.sizeBytes)}</td>
          <td>{fmtBytes(r.sourceBytes)}</td>
          <td>{fmtBytes(r.buildBytes)}</td>
          <td>{fmtBytes(r.depsBytes)}</td>
          <td>
            <Badge variant={r.status === "CURRENT" ? "success" : r.status === "ROLLBACK" ? "info" : r.status === "ELIGIBLE" ? "neutral" : "warning"}>{RELEASE_STATUS_LABEL[r.status]}</Badge>
            <div className="text-[10px] text-[var(--color-muted-foreground)]">{r.reason}</div>
          </td>
          <td className="text-xs">{r.status === "ELIGIBLE" ? "Eligible" : r.status === "UNRECOGNIZED" ? "Manual review" : "Protected"}</td>
          <td>{canManage && r.status === "ELIGIBLE" ? <ReleaseDelete id={r.id} sha={r.sha} sizeBytes={r.sizeBytes} /> : null}</td>
        </tr>
      ))}
    </Table>
  );
}

export default async function BackupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getAdminSession();
  const perms = session?.user?.permissions ?? [];
  if (!perms.includes(PERMISSIONS.BACKUP_VIEW)) return <RestrictedCard title="Backup & Disaster Recovery" />;
  const canManage = perms.includes(PERMISSIONS.BACKUP_MANAGE);
  const isMasterAdmin = session?.user?.role === "MASTER_ADMIN";
  const canDownloadSystemReport = perms.includes(PERMISSIONS.SETTINGS_MANAGE);

  const sp = await searchParams;
  const rawTab = typeof sp.tab === "string" ? sp.tab : "overview";
  const tab = TABS.some((t) => t.value === rawTab) ? rawTab : "overview";

  let content: React.ReactNode = null;

  if (tab === "overview") {
    const { settings, artifacts, snapshot, releases, currentSha } = await loadCore({ verify: true, storageWaitMs: 8_000 });
    const relPlan = planReleaseCleanup(releases);
    const bkPlan = planBackupCleanup(artifacts, settings);
    const [view, temp, lastJob] = await Promise.all([
      buildStorageView(roots, { snapshot, releases, artifacts, releaseReclaimable: relPlan.reclaimableBytes, backupReclaimable: bkPlan.reclaimableBytes }),
      listTemp(roots),
      prisma.backupJob.findFirst({ orderBy: { createdAt: "desc" } }),
    ]);
    const backups = artifacts.filter((a) => a.kind !== "MIRROR");
    const latestVerified = backups.find((a) => a.verification === "VALID");
    const disk = view.disk;
    const reclaimable = relPlan.reclaimableBytes + bkPlan.reclaimableBytes;
    const cache = view.partition.find((r) => r.key === "cache")?.bytes ?? null;
    const logs = view.partition.find((r) => r.key === "logs")?.bytes ?? null;
    const other = view.partition.find((r) => r.key === "other")?.bytes ?? null;
    const uploads = view.partition.find((r) => r.key === "uploads")?.bytes ?? null;
    const database = view.partition.find((r) => r.key === "database")?.bytes ?? null;
    const figures: [string, number | null, string?][] = [
      ["Actual App Source", view.actualSource?.bytes ?? null, "Tracked source files of the production commit"],
      ["Current Release", view.releases.current],
      ["Protected Rollback Release", view.releases.rollback],
      ["Old Releases", view.releases.old],
      ["All Releases Combined", view.releases.all],
      ["Reclaimable Release Storage", view.releases.reclaimable],
      ["Database", database, view.databaseLogical != null ? `Live DB ${fmtBytes(view.databaseLogical)}` : undefined],
      ["Database Backups", view.backups.db],
      ["Full Disaster Backups", view.backups.full],
      ["Clean Portable Backups", view.backups.clean],
      ["Persistent Uploads", uploads],
      ["Next.js Build Data", view.nextBuild, "All .next dirs (inside releases + working copy)"],
      ["Dependencies / node_modules", view.dependencies, "All node_modules (inside releases + working copy)"],
      ["Safe Cache / Temp", cache],
      ["Logs", logs],
      ["Other / Unclassified", other],
    ];
    content = (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                Storage Health <HealthBadge health={view.health} />
              </CardTitle>
              <CardDescription>
                Disk figures are live (df). Directory sizes from the storage scan {fmtAge(view.snapshotAgeMs)}
                {view.snapshotAt ? ` (${fmtDate(view.snapshotAt)})` : ""}. Thresholds: Warning ≥ 75% used, Critical ≥ 90%. Nothing is ever deleted automatically because of disk usage.
              </CardDescription>
            </div>
            {canManage ? <SimpleAction action="refresh" label="Refresh Storage" /> : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <StatCard label="VPS Total" value={fmtBytes(disk?.total)} />
              <StatCard label="VPS Used" value={fmtBytes(disk?.used)} />
              <StatCard label="VPS Available" value={fmtBytes(disk?.avail)} />
              <StatCard label="VPS Usage" value={disk ? `${disk.usedPct.toFixed(0)}%` : "—"} />
              <StatCard label="Reclaimable" value={fmtBytes(reclaimable)} />
              <StatCard label="Health" value={view.health} />
            </div>
            {!view.snapshotAt ? <p className="text-sm text-[var(--color-warning)]">The first storage scan is still running in the background — directory sizes appear when it finishes. Refresh the page in a minute.</p> : null}
            {view.insights.length ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {view.insights.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : null}
            {view.scanErrors.length ? <p className="text-xs text-[var(--color-warning)]">Not measured in the last scan: {view.scanErrors.join("; ")}.</p> : null}
            {view.releases.unmeasured ? <p className="text-xs text-[var(--color-muted-foreground)]">{view.releases.unmeasured} release(s) were created after the last scan — use Refresh Storage to measure them.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Storage Breakdown</CardTitle>
            <CardDescription>Measured values. Next.js build data and dependencies are cross-cutting totals already included in the releases and working copy.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              {figures.map(([label, bytes, hint]) => (
                <div key={label} className="flex flex-col">
                  <span className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</span>
                  <span className="font-semibold">{fmtBytes(bytes)}</span>
                  {hint ? <span className="text-[10px] text-[var(--color-muted-foreground)]">{hint}</span> : null}
                </div>
              ))}
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Where the used disk goes (non-overlapping; click a row to expand)</p>
              <ul className="flex flex-col gap-3">
                {view.partition.map((r) => (
                  <PartitionRow key={r.key} row={r} used={disk?.used ?? null} />
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Actual App Source — {fmtBytes(view.actualSource?.bytes)}</CardTitle>
            <CardDescription>
              Actual App Source represents the application source code. Production releases may be much larger because they contain build output and dependencies, and multiple historical releases duplicate
              these files.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Measured from the {view.actualSource?.files ?? 0} tracked files of commit <span className="font-mono">{(view.actualSource?.sha ?? currentSha ?? "HEAD").slice(0, 12)}</span>. Excludes node_modules, .next, release
              copies, backups, caches, temp files, logs and Git object storage.
            </p>
            {view.actualSource?.breakdown.length ? (
              <details>
                <summary className="cursor-pointer text-sm text-[var(--color-primary)]">Source breakdown</summary>
                <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  {view.actualSource.breakdown.map((b) => (
                    <li key={b.path} className="flex justify-between gap-2">
                      <span className="font-mono">{b.path}</span>
                      <span>
                        {fmtBytes(b.bytes)} <span className="text-[var(--color-muted-foreground)]">· {b.files} files</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Release Status</CardTitle>
              <CardDescription>Release Retention: Current Production always protected · Rollback Releases to Keep: {settings.rollbackReleasesToKeep}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <StatCard label="Production SHA" value={currentSha ? currentSha.slice(0, 12) : "—"} />
              <StatCard label="Releases on disk" value={releases.length} />
              <StatCard label="Release storage" value={fmtBytes(view.releases.all)} />
              <StatCard label="Reclaimable (old)" value={fmtBytes(relPlan.reclaimableBytes)} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Backup Status</CardTitle>
              <CardDescription>
                Protected: {settings.dbBackupsToKeep} latest verified DB · {settings.fullBackupsToKeep} latest verified Full · {settings.cleanBackupsToKeep} latest verified Clean. Auto cleanup:{" "}
                {settings.autoCleanup ? "ON" : "OFF"}.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <StatCard label="Recognized backups" value={backups.filter((a) => a.recognized).length} />
              <StatCard label="Backup storage" value={fmtBytes(view.backups.total)} />
              <StatCard label="Latest verified" value={latestVerified ? fmtDate(latestVerified.mtime) : "—"} />
              <StatCard label="Last Backup Center job" value={lastJob ? `${lastJob.kind} · ${lastJob.status}` : "—"} />
            </CardContent>
          </Card>
        </div>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Manage storage: old releases in{" "}
          <a href="/admin/backup?tab=releases" className="text-[var(--color-primary)] hover:underline">
            Releases
          </a>
          , old backups and temp files ({temp.length} workspace(s), {fmtBytes(temp.reduce((s, t) => s + t.sizeBytes, 0))}) in{" "}
          <a href="/admin/backup?tab=vps" className="text-[var(--color-primary)] hover:underline">
            VPS Backups
          </a>
          , policy in{" "}
          <a href="/admin/backup?tab=retention" className="text-[var(--color-primary)] hover:underline">
            Retention
          </a>
          .
        </p>

        <Card>
          <CardHeader>
            <CardTitle>Live System Report</CardTitle>
            <CardDescription>Human-readable snapshot of website structure, routes and status. A report — not a backup.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {canDownloadSystemReport ? (
              <>
                <a href="/api/admin/system-report?format=md" download className={DOWNLOAD_BUTTON}>
                  <Download className="h-3.5 w-3.5" aria-hidden /> Download Markdown
                </a>
                <a href="/api/admin/system-report?format=txt" download className={DOWNLOAD_BUTTON}>
                  <Download className="h-3.5 w-3.5" aria-hidden /> Download TXT
                </a>
              </>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">Requires the Settings permission (Master Admin by default).</p>
            )}
          </CardContent>
        </Card>
        {isMasterAdmin ? (
          <Card>
            <CardHeader>
              <CardTitle>Sensitive Data Export</CardTitle>
              <CardDescription>MASTER_ADMIN only. Per-student operational export — never a backup, never includes password hashes, OTP secrets or session tokens.</CardDescription>
            </CardHeader>
            <CardContent>
              <StudentReportControls />
            </CardContent>
          </Card>
        ) : null}
      </div>
    );
  } else if (tab === "create") {
    const inventory = buildInventory("FULL");
    content = (
      <div className="flex flex-col gap-6">
        {!canManage ? <p className="text-sm text-[var(--color-muted-foreground)]">View only — creating backups is limited to Master Admin.</p> : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <CardContent className="pt-5">
              <CreateBackupCard
                kind="FULL"
                title="Full Disaster Recovery"
                description="Everything needed to rebuild MockTestSeries.in on a fresh VPS: complete database, exact production source, persistent files, infrastructure templates, and the .env encrypted with your Backup Recovery Passphrase."
                canManage={canManage}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <CreateBackupCard
                kind="CLEAN"
                title="Clean Portable"
                description="Same as Full minus disposable operational logs (see exclusion manifest) and WITHOUT secrets — for moving/sharing the application safely."
                canManage={canManage}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <CreateBackupCard kind="DATABASE" title="Database Only" description="DATABASE ONLY — NOT A COMPLETE DISASTER RECOVERY BACKUP. Consistent pg_dump of the full production database with manifest + checksums." canManage={canManage} />
            </CardContent>
          </Card>
        </div>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Backups are generated in a private temp workspace, verified by checksum, streamed to your device, and removed from the VPS after a complete download. Only one backup is generated at a time, and generation refuses to start if disk space is insufficient.
        </p>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Clean Backup Exclusion Manifest</CardTitle>
            <CardDescription>Exactly what a Clean Portable backup omits. Live production rows are never modified — the omission applies to the backup copy only.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table head={["Table", "Category", "Reason"]} minWidth={520}>
              {CLEAN_EXCLUDED_TABLE_DATA.map((t) => (
                <tr key={t.table}>
                  <td className="font-mono text-xs">{t.table}</td>
                  <td>{t.category}</td>
                  <td>{t.reason}</td>
                </tr>
              ))}
              <tr>
                <td className="font-mono text-xs">.env secrets</td>
                <td>SECRETS</td>
                <td>Not included in Clean backups (template only)</td>
              </tr>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Persistent State Inventory (Full Disaster Recovery)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table head={["Component", "Status", "Where / how"]} minWidth={640}>
              {inventory.map((i) => (
                <tr key={i.item}>
                  <td>{i.item}</td>
                  <td>
                    <Badge variant={i.status === "INCLUDED" ? "success" : i.status === "REGENERABLE" ? "info" : i.status === "EXCLUDED BY DESIGN" ? "neutral" : "warning"}>{i.status}</Badge>
                  </td>
                  <td className="text-xs text-[var(--color-muted-foreground)]">{i.note}</td>
                </tr>
              ))}
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  } else if (tab === "vps") {
    const { settings, artifacts } = await loadCore({ verify: true });
    const plan = planBackupCleanup(artifacts, settings);
    const temp = await listTemp(roots);
    const backups = artifacts.filter((a) => a.kind !== "MIRROR");
    const total = artifacts.reduce((s, a) => s + a.sizeBytes, 0);
    const largest = [...backups].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    // Component sizes straight from each package's manifest.json (first tar member — cheap).
    const componentSizes = new Map<string, ComponentSizes>();
    for (const a of artifacts.filter((x) => x.kind === "PACKAGE").slice(0, 25)) {
      const file = await resolveArtifact(roots, a.id).then((r) => r.file).catch(() => null);
      const m = file ? await readPackageManifest(file) : null;
      if (m) componentSizes.set(a.id, groupComponentSizes(m.components, a.sizeBytes));
    }
    content = (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Recognized backups" value={backups.filter((a) => a.recognized).length} />
          <StatCard label="Backup storage" value={fmtBytes(total)} />
          <StatCard label="Largest" value={largest ? fmtBytes(largest.sizeBytes) : "—"} />
          <StatCard label="Oldest" value={backups.at(-1) ? fmtDate(backups.at(-1)!.mtime) : "—"} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>VPS Backups</CardTitle>
            <CardDescription>Discovered only in approved backup locations. Unknown files are listed but never deleted. Downloads stream directly to your device.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table head={["Name", "Type", "Modified", "Size", "Format", "Verification", "Actions"]} minWidth={980}>
              {artifacts.map((a) => (
                <tr key={a.id}>
                  <td className="break-all font-mono text-xs">
                    {a.name}
                    {componentSizes.has(a.id) ? (
                      <details className="mt-1 font-sans">
                        <summary className="cursor-pointer text-[11px] text-[var(--color-primary)]">Component sizes</summary>
                        <ComponentSizeList sizes={componentSizes.get(a.id)!} />
                      </details>
                    ) : null}
                  </td>
                  <td>{a.category}</td>
                  <td>{fmtDate(a.mtime)}</td>
                  <td>{fmtBytes(a.sizeBytes)}</td>
                  <td className="text-xs">{a.format}</td>
                  <td>
                    <StatusBadge status={a.verification} />
                    {plan.protectedIds.includes(a.id) ? (
                      <Badge variant="success" className="ml-1">
                        PROTECTED LATEST
                      </Badge>
                    ) : null}
                    {a.verificationDetail ? <div className="text-[10px] text-[var(--color-muted-foreground)]">{a.verificationDetail}</div> : null}
                  </td>
                  <td>
                    <ArtifactActions artifact={serializeArtifact(a)} canManage={canManage} isProtected={plan.protectedIds.includes(a.id)} />
                  </td>
                </tr>
              ))}
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Clean Old Backups — Cleanup Preview</CardTitle>
            <CardDescription>
              Keeps the newest {settings.dbBackupsToKeep} verified database, {settings.fullBackupsToKeep} verified Full and {settings.cleanBackupsToKeep} verified Clean backup(s). Unknown, uploaded, legacy and unverified
              files are never included. The preview deletes nothing.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              <strong>Protected backups ({plan.keep.length}):</strong> {plan.keep.map((k) => `${k.name} (${k.category})`).join(", ") || "—"}
            </p>
            <p>
              <strong>Cleanup candidates ({plan.candidates.length}, {fmtBytes(plan.reclaimableBytes)}):</strong>{" "}
              {plan.candidates.map((c) => `${c.name} · ${fmtDate(c.mtime)} · ${fmtBytes(c.sizeBytes)}`).join("; ") || "none"}
            </p>
            <p>
              <strong>Expected storage reclaimed:</strong> {fmtBytes(plan.reclaimableBytes)}
            </p>
            <p>
              <strong>Needs manual review ({plan.manualOnly.length}):</strong> {plan.manualOnly.map((m) => m.name).join(", ") || "none"}
            </p>
            {canManage ? (
              <BulkCleanupForm
                kind="backups"
                previewIds={plan.candidates.map((c) => c.id)}
                reclaimable={plan.reclaimableBytes}
                count={plan.candidates.length}
                protectedSummary={`latest verified backups (${plan.keep.length})`}
              />
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Safe Temp Files</CardTitle>
            <CardDescription>Only recognized Backup Center job workspaces that are stale (inactive for over an hour); an active backup&apos;s workspace and anything else in /tmp is never touched.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>
              {temp.length} workspace(s), {fmtBytes(temp.reduce((s, t) => s + t.sizeBytes, 0))} — {temp.filter((t) => t.stale).length} stale ({fmtBytes(temp.filter((t) => t.stale).reduce((s, t) => s + t.sizeBytes, 0))}),{" "}
              {temp.filter((t) => t.active).length} active.
            </p>
            {canManage ? <SimpleAction action="temp" label="Clean Safe Temp Files" /> : null}
          </CardContent>
        </Card>
      </div>
    );
  } else if (tab === "releases") {
    const { settings, releases, currentSha } = await loadCore({ verify: false });
    const plan = planReleaseCleanup(releases);
    const protectedBytes = plan.protected.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
    const all = releases.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
    content = (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Release Retention</CardTitle>
            <CardDescription>
              Deployment releases are not backups. Current production ({currentSha?.slice(0, 12) ?? "—"}) resolves from the production symlink and PM2 on the server at deletion time; the browser only sends an opaque
              release id.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Current Production</dt>
                <dd className="font-medium">Always Protected</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Rollback Releases to Keep</dt>
                <dd className="font-medium">
                  {settings.rollbackReleasesToKeep}{" "}
                  <a href="/admin/backup?tab=retention" className="text-xs font-normal text-[var(--color-primary)] hover:underline">
                    change
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-[var(--color-muted-foreground)]">Protected total</dt>
                <dd className="font-medium">Current + {settings.rollbackReleasesToKeep} previous = {settings.rollbackReleasesToKeep + 1} releases</dd>
              </div>
            </dl>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="All Releases Total" value={fmtBytes(all)} />
              <StatCard label="Protected Release Storage" value={fmtBytes(protectedBytes)} />
              <StatCard label="Old Release Storage" value={fmtBytes(plan.reclaimableBytes)} />
              <StatCard label="Potentially Reclaimable" value={fmtBytes(plan.reclaimableBytes)} />
            </div>
            {releases.some((r) => r.sizeBytes == null) ? <p className="text-xs text-[var(--color-muted-foreground)]">Some releases were created after the last storage scan — Refresh Storage on the Overview tab to measure them.</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Clean Old Releases — Cleanup Preview</CardTitle>
            <CardDescription>The preview deletes nothing. Cleanup re-checks every release on the server and deletes only ones that are still cleanup-eligible and were in this preview.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              <strong>Protected releases ({plan.protected.length}):</strong> {plan.protected.map((r) => `${r.sha.slice(0, 12)} (${RELEASE_STATUS_LABEL[r.status]})`).join(", ") || "—"}
            </p>
            <p>
              <strong>Cleanup candidates ({plan.candidates.length}):</strong> {plan.candidates.map((r) => `${r.sha.slice(0, 12)} · ${fmtBytes(r.sizeBytes)}`).join("; ") || "none"}
            </p>
            <p>
              <strong>Exact total size / expected storage reclaimed:</strong> {fmtBytes(plan.reclaimableBytes)}
            </p>
            {plan.manualReview.length ? (
              <p>
                <strong>Manual review ({plan.manualReview.length}):</strong> {plan.manualReview.map((r) => r.sha).join(", ")}
              </p>
            ) : null}
            {canManage ? (
              <BulkCleanupForm kind="releases" previewIds={plan.candidates.map((c) => c.id)} reclaimable={plan.reclaimableBytes} count={plan.candidates.length} protectedSummary={protectedReleaseSummary(settings)} />
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Release Inventory</CardTitle>
          </CardHeader>
          <CardContent>
            <ReleaseRows releases={releases} canManage={canManage} />
          </CardContent>
        </Card>
      </div>
    );
  } else if (tab === "retention") {
    const { settings, artifacts, releases } = await loadCore({ verify: false });
    const relPlan = planReleaseCleanup(releases);
    const bkPlan = planBackupCleanup(artifacts, settings);
    content = (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Retention Policy</CardTitle>
            <CardDescription>
              Changing a number never deletes anything by itself — it changes what the Cleanup Previews propose. Manual cleanup is the default mode; automatic cleanup is OFF unless a Master Admin enables it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RetentionForm initial={settings} canManage={canManage} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>What the current policy protects</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>
              <strong>Releases:</strong> {relPlan.protected.map((r) => `${r.sha.slice(0, 12)} (${RELEASE_STATUS_LABEL[r.status]})`).join(", ") || "—"} · {relPlan.candidates.length} cleanup candidate(s),{" "}
              {fmtBytes(relPlan.reclaimableBytes)}
            </p>
            <p>
              <strong>Backups:</strong>{" "}
              {bkPlan.keep.map((k) => `${k.name} (${retentionClass(k) === "DB" ? "DB" : retentionClass(k) === "FULL" ? "Full" : "Clean"})`).join(", ") || "no verified backups yet"} · {bkPlan.candidates.length} cleanup
              candidate(s), {fmtBytes(bkPlan.reclaimableBytes)}
            </p>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Never deleted by retention: current production, configured rollback releases, protected verified backups, an active backup or deployment, unknown or unverified files, uploads, the database, the source repo.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  } else if (tab === "verify") {
    const { artifacts } = await loadCore({ verify: true });
    content = (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Verify a backup from your device</CardTitle>
            <CardDescription>
              Upload a Backup Center .tar (up to 20 MB through the browser). Larger packages: copy with scp into the VPS backup “incoming” folder — they appear under VPS Backups automatically. Verification never restores anything.
            </CardDescription>
          </CardHeader>
          <CardContent>{canManage ? <UploadVerify /> : <p className="text-sm text-[var(--color-muted-foreground)]">View only.</p>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Verify a VPS backup</CardTitle>
            <CardDescription>Checks manifest, format version, SHA-256 checksums, database payload, source/assets archives, encrypted secrets and schema compatibility.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table head={["Backup", "Type", "Verification", "Verified", ""]} minWidth={760}>
              {artifacts
                .filter((a) => a.kind !== "MIRROR" && a.kind !== "UNKNOWN")
                .map((a) => (
                  <tr key={a.id}>
                    <td className="break-all font-mono text-xs">{a.name}</td>
                    <td>{a.category}</td>
                    <td>
                      <StatusBadge status={a.verification} />
                    </td>
                    <td>{fmtDate(a.verifiedAt)}</td>
                    <td>
                      <ArtifactActions artifact={{ ...serializeArtifact(a), deletable: false, protectedReason: "" }} canManage={canManage} isProtected={false} />
                    </td>
                  </tr>
                ))}
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  } else if (tab === "restore") {
    const { artifacts } = await loadCore({ verify: false });
    const packages = artifacts.filter((a) => a.kind === "PACKAGE").map((a) => ({ id: a.id, name: a.name, category: a.category, verification: a.verification }));
    content = (
      <Card>
        <CardHeader>
          <CardTitle>Safe Restore Center</CardTitle>
          <CardDescription>
            Select → validate manifest → verify checksums/format → check schema compatibility → passphrase (Full) → rehearsal → strong confirmation → restore → post-restore checks. For a brand-new VPS, follow README-RESTORE.md inside the package.
          </CardDescription>
        </CardHeader>
        <CardContent>{canManage ? <RestorePanel packages={packages} /> : <p className="text-sm text-[var(--color-muted-foreground)]">View only — restore is limited to Master Admin.</p>}</CardContent>
      </Card>
    );
  } else if (tab === "history") {
    const [jobs, logs] = await Promise.all([
      prisma.backupJob.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.auditLog.findMany({ where: { entityType: { in: BACKUP_AUDIT_ENTITY_TYPES } }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    const admins = new Map((await prisma.adminUser.findMany({ where: { id: { in: jobs.map((j) => j.createdByAdminId).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
    content = (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Backup Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <Table head={["Created", "Type", "By", "Size", "Status", "SHA-256", "Downloaded", "Removed from VPS", "Freed"]} minWidth={1000}>
              {jobs.map((j) => {
                const comps = (j.summary as { componentBytes?: { kind: "database" | "source" | "assets" | "config" | "secrets" | "docs"; bytes: number }[] } | null)?.componentBytes;
                return (
                  <tr key={j.id}>
                    <td>{fmtDate(j.createdAt)}</td>
                    <td>{j.kind}</td>
                    <td>{j.createdByAdminId ? (admins.get(j.createdByAdminId) ?? "—") : "—"}</td>
                    <td>
                      {fmtBytes(j.sizeBytes ? Number(j.sizeBytes) : null)}
                      {comps?.length ? (
                        <details>
                          <summary className="cursor-pointer text-[11px] text-[var(--color-primary)]">Components</summary>
                          <ComponentSizeList sizes={groupComponentSizes(comps, j.sizeBytes ? Number(j.sizeBytes) : null)} />
                        </details>
                      ) : null}
                    </td>
                    <td>
                      <Badge variant={j.status === "FAILED" ? "error" : j.status === "RUNNING" ? "warning" : "success"}>{j.status}</Badge>
                      {j.error ? <div className="text-[10px] text-[var(--color-error)]">{j.error}</div> : null}
                    </td>
                    <td className="font-mono text-[10px]">{j.sha256?.slice(0, 16) ?? "—"}</td>
                    <td>{fmtDate(j.downloadedAt)}</td>
                    <td>{fmtDate(j.deletedAt)}</td>
                    <td>{fmtBytes(j.storageFreed ? Number(j.storageFreed) : null)}</td>
                  </tr>
                );
              })}
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Backup, Restore, Retention &amp; Cleanup Events</CardTitle>
          </CardHeader>
          <CardContent>
            <Table head={["When", "Admin", "Event", "Details"]} minWidth={760}>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDate(l.createdAt)}</td>
                  <td>{l.actor?.name ?? "System"}</td>
                  <td className="font-mono text-xs">{l.action}</td>
                  <td>
                    <code className="block max-w-[480px] truncate text-[10px] text-[var(--color-muted-foreground)]" title={JSON.stringify(l.metadata)}>
                      {l.metadata ? JSON.stringify(l.metadata) : "—"}
                    </code>
                  </td>
                </tr>
              ))}
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Backup &amp; Disaster Recovery</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Full/Clean/Database backups, VPS backup inventory, verification, restore, retention and storage cleanup. The nightly database dump and uploads mirror keep running on their cron schedule.
          </p>
        </div>
        {!canManage ? <Badge>View only</Badge> : null}
      </div>
      <BackupOpsProvider>
        <ControlCenterTabs defaultValue="overview" tabs={TABS.map((t) => ({ value: t.value, label: t.label, content: t.value === tab ? content : null }))} />
      </BackupOpsProvider>
    </div>
  );
}
