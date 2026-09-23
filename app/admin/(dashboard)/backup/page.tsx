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
import { autoVerifyCheap, listArtifacts, type Artifact } from "@/lib/backup/discovery";
import { planBackupCleanup } from "@/lib/backup/cleanup";
import { listReleases, planReleaseCleanup, type Release } from "@/lib/backup/releases";
import { getStorageBreakdown } from "@/lib/backup/storage";
import { listTemp, sweepStaleJobs } from "@/lib/backup/jobs";
import { buildInventory, CLEAN_EXCLUDED_TABLE_DATA } from "@/lib/backup/package";
import { BACKUP_AUDIT_ENTITY_TYPES } from "@/lib/backup/audit";
import { formatBytes } from "@/lib/storage-stats";
import { StudentReportControls } from "./student-report-controls";
import { ArtifactActions, BulkCleanupForm, CreateBackupCard, ReleaseDelete, RestorePanel, SimpleAction, StatusBadge, UploadVerify } from "./_components/client";

export const metadata = { title: "Backup & Disaster Recovery — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const DOWNLOAD_BUTTON =
  "inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)]";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "create", label: "Create Backup" },
  { value: "vps", label: "VPS Backups" },
  { value: "releases", label: "Releases" },
  { value: "verify", label: "Verify" },
  { value: "restore", label: "Restore" },
  { value: "history", label: "History" },
] as const;

const roots = PRODUCTION_ROOTS;

const fmtDate = (d: Date | null | undefined) => (d ? d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

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

async function loadCore(forceVerify: boolean) {
  await sweepStaleJobs(roots).catch(() => undefined);
  let artifacts = await listArtifacts(roots);
  if (forceVerify && (await autoVerifyCheap(roots, artifacts)) > 0) artifacts = await listArtifacts(roots);
  const { releases, currentSha } = await listReleases(roots);
  return { artifacts, releases, currentSha };
}

function ReleaseRows({ releases, canManage }: { releases: Release[]; canManage: boolean }) {
  return (
    <Table head={["Release SHA", "Modified", "Size", "Built", "Status", ""]}>
      {releases.map((r) => (
        <tr key={r.id}>
          <td className="font-mono text-xs">{r.sha.slice(0, 12)}</td>
          <td>{fmtDate(r.mtime)}</td>
          <td>{formatBytes(r.sizeBytes)}</td>
          <td>{r.built ? "Yes" : "No"}</td>
          <td>
            <Badge variant={r.status === "CURRENT" ? "success" : r.status === "ROLLBACK" ? "info" : r.status === "ELIGIBLE" ? "neutral" : "warning"}>
              {r.status === "CURRENT" ? "CURRENT — PROTECTED" : r.status === "ROLLBACK" ? "ROLLBACK — PROTECTED" : r.status.replace(/_/g, " ")}
            </Badge>
            <div className="text-[10px] text-[var(--color-muted-foreground)]">{r.reason}</div>
          </td>
          <td>{canManage && r.status === "ELIGIBLE" ? <ReleaseDelete id={r.id} sha={r.sha} /> : null}</td>
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
    const { artifacts, releases, currentSha } = await loadCore(true);
    const [storage, temp, lastJob] = await Promise.all([getStorageBreakdown(roots, artifacts, releases), listTemp(roots), prisma.backupJob.findFirst({ orderBy: { createdAt: "desc" } })]);
    const backups = artifacts.filter((a) => a.kind !== "MIRROR");
    const backupBytes = artifacts.reduce((s, a) => s + a.sizeBytes, 0);
    const latest = backups[0];
    const latestVerified = backups.find((a) => a.verification === "VALID");
    const relPlan = planReleaseCleanup(releases);
    const bkPlan = planBackupCleanup(artifacts);
    const disk = storage.disk;
    content = (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>VPS Storage</CardTitle>
              <CardDescription>Scanned {fmtDate(storage.scannedAt)} (cached 10 min).</CardDescription>
            </div>
            {canManage ? <SimpleAction action="rescan" label="Rescan" /> : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Total" value={formatBytes(disk?.total ?? null)} />
              <StatCard label="Used" value={formatBytes(disk?.used ?? null)} />
              <StatCard label="Available" value={formatBytes(disk?.avail ?? null)} />
              <StatCard label="Usage" value={disk ? `${Math.round((disk.used / disk.total) * 100)}%` : "—"} />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Storage breakdown</p>
              <ul className="flex flex-col gap-2">
                {storage.rows.map((r) => (
                  <li key={r.key} className="flex flex-col gap-1">
                    <div className="flex flex-wrap justify-between gap-2 text-sm">
                      <span>
                        {r.label}{" "}
                        <Badge variant={r.group === "BACKUP" ? "info" : r.group === "RELEASE" ? "warning" : r.group === "OTHER" ? "neutral" : "primary"}>{r.group}</Badge>
                      </span>
                      <span className="font-medium">{formatBytes(r.bytes)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[var(--color-muted)]">
                      <div className="h-1.5 rounded-full bg-[var(--color-primary)]" style={{ width: `${disk && r.bytes ? Math.max(1, (r.bytes / disk.used) * 100) : 0}%` }} />
                    </div>
                    {r.note ? <span className="text-[10px] text-[var(--color-muted-foreground)]">{r.note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
              <p className="font-medium">Manage storage</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Old releases: <strong>{formatBytes(relPlan.reclaimableBytes)}</strong> reclaimable ({relPlan.candidates.length} releases) — see{" "}
                <a href="/admin/backup?tab=releases" className="text-[var(--color-primary)] hover:underline">
                  Releases
                </a>
                . Old backups: <strong>{formatBytes(bkPlan.reclaimableBytes)}</strong> reclaimable — see{" "}
                <a href="/admin/backup?tab=vps" className="text-[var(--color-primary)] hover:underline">
                  VPS Backups
                </a>
                . Backup temp: {temp.length} workspace(s), {formatBytes(temp.reduce((s, t) => s + t.sizeBytes, 0))}.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Backup Status</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <StatCard label="Recognized backups" value={backups.filter((a) => a.recognized).length} />
              <StatCard label="Backup storage" value={formatBytes(backupBytes)} />
              <StatCard label="Latest backup" value={latest ? fmtDate(latest.mtime) : "—"} />
              <StatCard label="Latest verified" value={latestVerified ? fmtDate(latestVerified.mtime) : "—"} />
              <StatCard label="Last Backup Center job" value={lastJob ? `${lastJob.kind} · ${lastJob.status}` : "—"} />
              <StatCard label="Backup % of disk" value={disk ? `${((backupBytes / disk.total) * 100).toFixed(2)}%` : "—"} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Release Status</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <StatCard label="Production SHA" value={currentSha ? currentSha.slice(0, 12) : "—"} />
              <StatCard label="Retained releases" value={releases.length} />
              <StatCard label="Release storage" value={formatBytes(releases.reduce((s, r) => s + (r.sizeBytes ?? 0), 0))} />
              <StatCard label="Reclaimable (old)" value={formatBytes(relPlan.reclaimableBytes)} />
            </CardContent>
          </Card>
        </div>

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
    const { artifacts } = await loadCore(true);
    const plan = planBackupCleanup(artifacts);
    const temp = await listTemp(roots);
    const backups = artifacts.filter((a) => a.kind !== "MIRROR");
    const total = artifacts.reduce((s, a) => s + a.sizeBytes, 0);
    const largest = [...backups].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    content = (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Recognized backups" value={backups.filter((a) => a.recognized).length} />
          <StatCard label="Backup storage" value={formatBytes(total)} />
          <StatCard label="Largest" value={largest ? formatBytes(largest.sizeBytes) : "—"} />
          <StatCard label="Oldest" value={backups.at(-1) ? fmtDate(backups.at(-1)!.mtime) : "—"} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>VPS Backups</CardTitle>
            <CardDescription>Discovered only in approved backup locations. Unknown files are listed but never deleted.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table head={["Name", "Type", "Modified", "Size", "Format", "Verification", "Actions"]} minWidth={980}>
              {artifacts.map((a) => (
                <tr key={a.id}>
                  <td className="break-all font-mono text-xs">{a.name}</td>
                  <td>{a.category}</td>
                  <td>{fmtDate(a.mtime)}</td>
                  <td>{formatBytes(a.sizeBytes)}</td>
                  <td className="text-xs">{a.format}</td>
                  <td>
                    <StatusBadge status={a.verification} />
                    {plan.protectedIds.includes(a.id) ? <Badge variant="success" className="ml-1">PROTECTED LATEST</Badge> : null}
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
            <CardTitle>Clean Old Backups — Preview</CardTitle>
            <CardDescription>Keeps the newest verified database backup and the newest verified Full Disaster Recovery backup. Unknown, legacy and unverified files are never included automatically.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              <strong>Keep:</strong> {plan.keep.map((k) => `${k.name} (${k.category})`).join(", ") || "—"}
            </p>
            <p>
              <strong>Proposed for deletion ({plan.candidates.length}):</strong>{" "}
              {plan.candidates.map((c) => `${c.name} · ${fmtDate(c.mtime)} · ${formatBytes(c.sizeBytes)}`).join("; ") || "none"}
            </p>
            <p>
              <strong>Needs manual review ({plan.manualOnly.length}):</strong> {plan.manualOnly.map((m) => m.name).join(", ") || "none"}
            </p>
            {canManage ? <BulkCleanupForm kind="backups" previewIds={plan.candidates.map((c) => c.id)} reclaimable={plan.reclaimableBytes} count={plan.candidates.length} /> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Backup Temp Files</CardTitle>
            <CardDescription>Only recognized Backup Center job workspaces; nothing else in /tmp is touched.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>
              {temp.length} workspace(s), {formatBytes(temp.reduce((s, t) => s + t.sizeBytes, 0))} — {temp.filter((t) => t.stale).length} stale, {temp.filter((t) => t.active).length} active.
            </p>
            {canManage ? <SimpleAction action="temp" label="Clean Safe Temp Files" /> : null}
          </CardContent>
        </Card>
      </div>
    );
  } else if (tab === "releases") {
    const { releases, currentSha } = await loadCore(false);
    const plan = planReleaseCleanup(releases);
    content = (
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Release Storage</CardTitle>
            <CardDescription>
              Deployment releases are not backups. Current production ({currentSha?.slice(0, 12) ?? "—"}) and the newest previous successful release are always protected; the production symlink is re-resolved on the server at deletion time.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Releases" value={releases.length} />
              <StatCard label="Release storage" value={formatBytes(releases.reduce((s, r) => s + (r.sizeBytes ?? 0), 0))} />
              <StatCard label="Cleanup candidates" value={plan.candidates.length} />
              <StatCard label="Reclaimable" value={formatBytes(plan.reclaimableBytes)} />
            </div>
            {canManage ? <BulkCleanupForm kind="releases" previewIds={plan.candidates.map((c) => c.id)} reclaimable={plan.reclaimableBytes} count={plan.candidates.length} /> : null}
            <ReleaseRows releases={releases} canManage={canManage} />
          </CardContent>
        </Card>
      </div>
    );
  } else if (tab === "verify") {
    const { artifacts } = await loadCore(true);
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
    const { artifacts } = await loadCore(false);
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
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{fmtDate(j.createdAt)}</td>
                  <td>{j.kind}</td>
                  <td>{j.createdByAdminId ? (admins.get(j.createdByAdminId) ?? "—") : "—"}</td>
                  <td>{formatBytes(j.sizeBytes ? Number(j.sizeBytes) : null)}</td>
                  <td>
                    <Badge variant={j.status === "FAILED" ? "error" : j.status === "RUNNING" ? "warning" : "success"}>{j.status}</Badge>
                    {j.error ? <div className="text-[10px] text-[var(--color-error)]">{j.error}</div> : null}
                  </td>
                  <td className="font-mono text-[10px]">{j.sha256?.slice(0, 16) ?? "—"}</td>
                  <td>{fmtDate(j.downloadedAt)}</td>
                  <td>{fmtDate(j.deletedAt)}</td>
                  <td>{formatBytes(j.storageFreed ? Number(j.storageFreed) : null)}</td>
                </tr>
              ))}
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Backup, Restore &amp; Cleanup Events</CardTitle>
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
            Full/Clean/Database backups, VPS backup inventory, verification, restore, and storage cleanup. The nightly database dump and uploads mirror keep running on their cron schedule.
          </p>
        </div>
        {!canManage ? <Badge>View only</Badge> : null}
      </div>
      <ControlCenterTabs defaultValue="overview" tabs={TABS.map((t) => ({ value: t.value, label: t.label, content: t.value === tab ? content : null }))} />
    </div>
  );
}
