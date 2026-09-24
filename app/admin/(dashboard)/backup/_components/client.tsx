"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck, Download, Trash2, RefreshCw, Upload, X, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { createOperationGuard, type OperationResult, type ServerResult } from "@/lib/backup/operation";
import type { MaintenanceOutcome } from "@/lib/backup/maintenance";
import {
  backupJobStatusAction,
  cleanTempAction,
  cleanupBackupsAction,
  cleanupReleasesAction,
  createBackupAction,
  deleteArtifactAction,
  deleteReleaseAction,
  rehearseRestoreAction,
  refreshStorageAction,
  restoreProductionAction,
  saveRetentionAction,
  verifyArtifactAction,
} from "../actions";

export function fmt(bytes: number | null | undefined) {
  if (bytes == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 10 ? 0 : 1)} ${u[i]}`;
}

function Msg({ ok, text }: { ok: boolean; text: string | null }) {
  if (!text) return null;
  return (
    <p className={`text-xs ${ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={ok ? "status" : "alert"} aria-live="polite">
      {text}
    </p>
  );
}

type CheckList = { label: string; ok: boolean; detail?: string }[];

function Checks({ checks }: { checks: CheckList }) {
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {checks.map((c, i) => (
        <li key={i} className={c.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}>
          {c.ok ? "✓" : "✗"} {c.label}
          {c.detail ? <span className="text-[var(--color-muted-foreground)]"> — {c.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Operation plumbing: one result banner for the page + a per-control hook.
//
// The banner lives above the tabs, so a result stays visible even when the
// control that produced it unmounts (a deleted release's row disappears on
// refresh). Loading state is per control and always cleared in `finally`;
// router.refresh() is fired AFTER the result is in and is never awaited by
// the button, so a slow re-render can't keep anything "Processing…".
// ---------------------------------------------------------------------------

interface Banner {
  title: string;
  ok: boolean;
  message: string;
  outcome?: MaintenanceOutcome;
  kind?: "releases" | "backups" | "temp";
  footer?: string;
}

const BannerContext = createContext<(b: Banner | null) => void>(() => undefined);

export function BackupOpsProvider({ children }: { children: React.ReactNode }) {
  const [banner, setBanner] = useState<Banner | null>(null);
  return (
    <BannerContext.Provider value={setBanner}>
      {banner ? <ResultBanner banner={banner} onClose={() => setBanner(null)} /> : null}
      {children}
    </BannerContext.Provider>
  );
}

function ResultBanner({ banner, onClose }: { banner: Banner; onClose: () => void }) {
  const o = banner.outcome;
  const deletedNoun = banner.kind === "releases" ? "release(s)" : banner.kind === "backups" ? "backup(s)" : "item(s)";
  return (
    <div
      className={`flex flex-col gap-2 rounded-[var(--radius-card)] border p-4 text-sm ${banner.ok ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/5" : "border-[var(--color-error)]/50 bg-[var(--color-error)]/5"}`}
      role={banner.ok ? "status" : "alert"}
      aria-live="polite"
      data-testid="backup-op-banner"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          {banner.ok ? <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" aria-hidden /> : <AlertTriangle className="h-4 w-4 text-[var(--color-error)]" aria-hidden />}
          {banner.title}
        </p>
        <button type="button" onClick={onClose} className="rounded p-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <p className="text-xs">{banner.message}</p>
      {o && o.outcome === "DELETED" ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-[var(--color-muted-foreground)]">Deleted</dt>
            <dd className="font-medium">
              {o.deleted.length} {deletedNoun}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-muted-foreground)]">Storage before</dt>
            <dd className="font-medium">{fmt(o.storageBefore)}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-muted-foreground)]">Storage after</dt>
            <dd className="font-medium">{fmt(o.storageAfter)}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-muted-foreground)]">Storage reclaimed</dt>
            <dd className="font-medium">{fmt(o.reclaimed)}</dd>
          </div>
        </dl>
      ) : null}
      {o && o.deleted.length ? <p className="break-all font-mono text-[10px] text-[var(--color-muted-foreground)]">{o.deleted.map((d) => (banner.kind === "releases" ? d.label.slice(0, 12) : d.label)).join(" · ")}</p> : null}
      {banner.footer ? <p className="text-xs text-[var(--color-muted-foreground)]">{banner.footer}</p> : null}
    </div>
  );
}

/** Per-control operation state: duplicate-submit guard, finally-cleared busy flag, banner + refresh. */
function useOp() {
  const router = useRouter();
  const setBanner = useContext(BannerContext);
  const [busy, setBusy] = useState(false);
  const [guard] = useState(() => createOperationGuard(setBusy));
  const execute = useCallback(
    <T,>(opts: { run: () => Promise<ServerResult<T>>; reconcile?: () => Promise<ServerResult<{ exists: boolean }>>; timeoutMs?: number; banner?: (r: OperationResult<T>) => Banner | null }) =>
      guard<T>(opts, (r) => {
        const b = opts.banner?.(r);
        if (b) setBanner(b);
        // Fire-and-forget: the button is already usable; the list/totals update when the refresh lands.
        if (r.refresh) router.refresh();
      }),
    [guard, router, setBanner]
  );
  return { busy, execute };
}

async function reconcile(kind: "release" | "backup", id: string): Promise<ServerResult<{ exists: boolean }>> {
  const res = await fetch(`/api/admin/backup/reconcile?kind=${kind}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
  return (await res.json()) as ServerResult<{ exists: boolean }>;
}

const DESTRUCTIVE_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Create backup
// ---------------------------------------------------------------------------

export function CreateBackupCard({ kind, title, description, canManage }: { kind: "FULL" | "CLEAN" | "DATABASE"; title: string; description: string; canManage: boolean }) {
  const router = useRouter();
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, execute } = useOp();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let misses = 0;
    const poll = async () => {
      let r: Awaited<ReturnType<typeof backupJobStatusAction>> | null = null;
      try {
        r = await backupJobStatusAction(jobId);
      } catch {
        r = null;
      }
      if (cancelled) return;
      if (!r || !r.ok || !r.data) {
        // Transient network trouble: keep polling a while, then stop with a clear message.
        if (++misses < 5) {
          timer.current = setTimeout(poll, 4000);
          return;
        }
        setStatus(null);
        setError(r?.error ?? "Lost contact with the server. The backup may still finish — check History.");
        return;
      }
      misses = 0;
      setStatus(r.data.status);
      if (r.data.status === "RUNNING") timer.current = setTimeout(poll, 2500);
      else if (r.data.status === "READY") {
        // A streamed file download (API route), not page navigation — the page stays interactive.
        const a = document.createElement("a");
        a.href = `/api/admin/backup/jobs/${jobId}/download`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (r.data.status === "FAILED") setError(r.data.error ?? "Backup failed.");
      else router.refresh();
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, router]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    void execute({
      run: () => createBackupAction({ kind, saveOnVps: save, passphrase: kind === "FULL" ? pass : undefined, passphraseConfirm: pass2, password }),
      timeoutMs: 60_000,
    }).then((r) => {
      setPassword("");
      if (!r) return;
      if (!r.ok || !r.data) return setError(r.message);
      setPass("");
      setPass2("");
      setJobId(r.data.jobId);
      setStatus("RUNNING");
    });
  }

  const running = status === "RUNNING" || busy;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div>
        <p className="font-medium text-[var(--color-foreground)]">{title}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">{description}</p>
      </div>
      <fieldset disabled={!canManage || running} className="flex flex-col gap-3">
        {kind === "FULL" ? (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bk-pass">Backup Recovery Passphrase (min 12 characters)</Label>
              <Input id="bk-pass" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bk-pass2">Confirm passphrase</Label>
              <Input id="bk-pass2" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
            </div>
            <p className="text-[11px] text-[var(--color-warning)]">
              If this Backup Recovery Passphrase is lost, the encrypted recovery payload may be unrecoverable. It is never stored anywhere.
            </p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bk-pw">Your admin password (re-authentication)</Label>
              <Input id="bk-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        ) : null}
        <label className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Also save a copy on the VPS (default off — download only)
        </label>
        <Button type="submit" size="sm" className="w-fit">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
          {running ? "Generating…" : `Download ${kind === "FULL" ? "Full Backup" : kind === "CLEAN" ? "Clean Backup" : "Database Backup"}`}
        </Button>
      </fieldset>
      {status && status !== "RUNNING" && !error ? (
        <p className="text-xs text-[var(--color-success)]" role="status">
          {status === "READY" ? "Ready — your download has started." : status === "SAVED" ? "Saved on the VPS (see VPS Backups)." : status === "DOWNLOADED" ? "Downloaded and removed from the VPS." : status}
        </p>
      ) : null}
      <Msg ok={false} text={error} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Artifact actions (verify / download / delete)
// ---------------------------------------------------------------------------

export function ArtifactActions({
  artifact,
  canManage,
  isProtected,
}: {
  artifact: { id: string; name: string; category: string; sizeBytes: number; mtime: string; verification: string | null; deletable: boolean; kind: string; protectedReason: string | null };
  canManage: boolean;
  isProtected: boolean;
}) {
  const [open, setOpen] = useState<"verify" | "delete" | null>(null);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; checks?: CheckList } | null>(null);
  const verifyOp = useOp();
  const deleteOp = useOp();
  if (!canManage) return <span className="text-xs text-[var(--color-muted-foreground)]">View only</span>;
  const downloadable = artifact.kind !== "MIRROR" && artifact.kind !== "UNKNOWN";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {downloadable ? (
          <Button size="compact" variant="outline" onClick={() => setOpen(open === "verify" ? null : "verify")}>
            <ShieldCheck className="h-3 w-3" aria-hidden /> Verify
          </Button>
        ) : null}
        {downloadable ? (
          <Button size="compact" variant="outline" asChild>
            {/* Plain streamed attachment: the browser's download manager handles it, the page stays interactive. */}
            <a href={`/api/admin/backup/artifacts/${artifact.id}/download`} download>
              <Download className="h-3 w-3" aria-hidden /> Download
            </a>
          </Button>
        ) : null}
        {artifact.deletable && !isProtected ? (
          <Button size="compact" variant="outline" onClick={() => setOpen(open === "delete" ? null : "delete")}>
            <Trash2 className="h-3 w-3" aria-hidden /> Delete
          </Button>
        ) : (
          <span className="text-[10px] text-[var(--color-muted-foreground)]">{isProtected ? "Protected latest verified" : artifact.protectedReason}</span>
        )}
      </div>
      {open === "verify" ? (
        <form
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyOp
              .execute({ run: () => verifyArtifactAction(artifact.id, pass || undefined), timeoutMs: 10 * 60_000 })
              .then((r) => {
                setPass("");
                if (!r) return;
                setResult(r.ok && r.data ? { ok: r.data.status === "VALID" || r.data.status === "LEGACY_VERIFIED", text: `${r.data.status}: ${r.data.summary}`, checks: r.data.checks } : { ok: false, text: r.message });
              });
          }}
        >
          {artifact.kind === "PACKAGE" ? (
            <Input type="password" placeholder="Recovery passphrase (optional, FULL only)" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} className="h-8" aria-label="Recovery passphrase" />
          ) : null}
          <Button type="submit" size="compact" disabled={verifyOp.busy} className="w-fit">
            {verifyOp.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null} {verifyOp.busy ? "Verifying…" : "Run verification"}
          </Button>
        </form>
      ) : null}
      {open === "delete" ? (
        <form
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-error)]/40 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void deleteOp
              .execute({
                run: () => deleteArtifactAction({ id: artifact.id, confirm, password }),
                reconcile: () => reconcile("backup", artifact.id),
                timeoutMs: DESTRUCTIVE_TIMEOUT_MS,
                banner: (r) => (r.ok ? { title: r.data?.outcome === "DELETED" || r.kind === "reconciled-done" ? "Backup deleted" : "Nothing to delete", ok: true, message: r.message, outcome: r.data, kind: "backups" } : null),
              })
              .then((r) => {
                setPassword("");
                if (!r) return;
                if (r.ok) {
                  setOpen(null);
                  setConfirm("");
                  setResult(null);
                } else setResult({ ok: false, text: r.message });
              });
          }}
        >
          <p className="text-xs">
            <strong>{artifact.name}</strong> · {artifact.category} · {new Date(artifact.mtime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {fmt(artifact.sizeBytes)} ·{" "}
            {artifact.verification ?? "not verified"}
          </p>
          <p className="text-xs text-[var(--color-error)]">This permanently deletes this backup copy from the VPS. It does not delete the live website or production database.</p>
          <Input placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-8" aria-label="Type DELETE" />
          <Input type="password" placeholder="Your admin password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-8" aria-label="Admin password" />
          <div className="flex gap-2">
            <Button type="submit" size="compact" variant="danger" disabled={deleteOp.busy} className="w-fit">
              {deleteOp.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null} {deleteOp.busy ? "Deleting…" : "Delete permanently"}
            </Button>
            <Button type="button" size="compact" variant="outline" disabled={deleteOp.busy} onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {result ? (
        <div className="flex flex-col gap-1">
          <Msg ok={result.ok} text={result.text} />
          {result.checks ? <Checks checks={result.checks} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk cleanup (backups / releases), release delete, temp cleanup, storage refresh
// ---------------------------------------------------------------------------

export function BulkCleanupForm({ kind, previewIds, reclaimable, count, protectedSummary }: { kind: "backups" | "releases"; previewIds: string[]; reclaimable: number; count: number; protectedSummary: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, execute } = useOp();
  const label = kind === "backups" ? "Clean Old Backups" : "Clean Old Releases";
  if (count === 0) return <p className="text-xs text-[var(--color-muted-foreground)]">Nothing eligible for cleanup.</p>;
  if (!open)
    return (
      <Button size="sm" variant="danger" className="w-fit" onClick={() => setOpen(true)}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden /> {label}…
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-error)]/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        void execute({
          run: () => (kind === "backups" ? cleanupBackupsAction({ previewIds, confirm, password }) : cleanupReleasesAction({ previewIds, confirm, password })),
          timeoutMs: DESTRUCTIVE_TIMEOUT_MS,
          banner: (r) =>
            r.ok
              ? { title: "Cleanup Complete", ok: true, message: r.message, outcome: r.data, kind, footer: `Protected: ${protectedSummary}. No live application data affected.` }
              : r.kind === "unknown"
                ? { title: "Cleanup result unknown", ok: false, message: r.message }
                : null,
        }).then((r) => {
          setPassword("");
          if (!r) return;
          if (r.ok) {
            setOpen(false);
            setConfirm("");
          } else setMsg(r.message);
        });
      }}
    >
      <p className="text-sm">
        Delete <strong>{count}</strong> {kind === "backups" ? "old backup(s)" : "old release(s)"} and reclaim <strong>{fmt(reclaimable)}</strong>. Protected: {protectedSummary}.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9 w-40" aria-label="Type DELETE" />
        <Input type="password" placeholder="Your admin password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9 w-56" aria-label="Admin password" />
        <Button type="submit" size="sm" variant="danger" disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
          {busy ? "Cleaning…" : label}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <Msg ok={false} text={msg} />
    </form>
  );
}

export function ReleaseDelete({ id, sha, sizeBytes }: { id: string; sha: string; sizeBytes: number | null }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, execute } = useOp();
  return (
    <div className="flex flex-col gap-1">
      {!open ? (
        <Button size="compact" variant="outline" onClick={() => setOpen(true)} className="w-fit">
          <Trash2 className="h-3 w-3" aria-hidden /> Delete
        </Button>
      ) : (
        <form
          className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-error)]/40 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            void execute({
              run: () => deleteReleaseAction({ id, confirm, password }),
              reconcile: () => reconcile("release", id),
              timeoutMs: DESTRUCTIVE_TIMEOUT_MS,
              banner: (r) =>
                r.ok
                  ? {
                      title: r.data?.outcome === "NOTHING" ? "Release already gone" : "Release deleted",
                      ok: true,
                      message: r.message,
                      outcome: r.data,
                      kind: "releases",
                      footer: "Current production and the protected rollback release were not touched. No live application data affected.",
                    }
                  : null,
            }).then((r) => {
              setPassword("");
              if (!r) return;
              if (r.ok) {
                setOpen(false);
                setConfirm("");
              } else setMsg(r.message);
            });
          }}
        >
          <p className="text-xs">
            Delete inactive release <span className="font-mono">{sha.slice(0, 12)}</span> ({fmt(sizeBytes)}). Current production and rollback releases are protected.
          </p>
          <Input placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-8" aria-label="Type DELETE" />
          <Input type="password" placeholder="Your admin password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-8" aria-label="Admin password" />
          <div className="flex gap-2">
            <Button type="submit" size="compact" variant="danger" disabled={busy} className="w-fit">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null} {busy ? "Deleting…" : "Delete release"}
            </Button>
            <Button type="button" size="compact" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <Msg ok={false} text={msg} />
    </div>
  );
}

export function SimpleAction({ action, label }: { action: "temp" | "refresh"; label: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { busy, execute } = useOp();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setMsg(null);
          void execute<unknown>({
            run: () => (action === "temp" ? cleanTempAction() : refreshStorageAction()),
            timeoutMs: 75_000,
            banner: (r) => (action === "temp" && r.ok ? { title: "Temp cleanup complete", ok: true, message: r.message, outcome: r.data as MaintenanceOutcome, kind: "temp" } : null),
          }).then((r) => {
            if (r) setMsg({ ok: r.ok, text: r.message });
          });
        }}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} {busy ? (action === "temp" ? "Cleaning…" : "Scanning…") : label}
      </Button>
      <Msg ok={msg?.ok ?? false} text={msg?.text ?? null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retention settings
// ---------------------------------------------------------------------------

export function RetentionForm({
  initial,
  canManage,
}: {
  initial: { rollbackReleasesToKeep: number; dbBackupsToKeep: number; fullBackupsToKeep: number; cleanBackupsToKeep: number; autoCleanup: boolean };
  canManage: boolean;
}) {
  const [v, setV] = useState(initial);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { busy, execute } = useOp();
  const enablingAuto = v.autoCleanup && !initial.autoCleanup;
  const num = (key: keyof typeof v, label: string, hint: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`ret-${key}`}>{label}</Label>
      <select
        id={`ret-${key}`}
        value={String(v[key])}
        onChange={(e) => setV({ ...v, [key]: Number(e.target.value) })}
        className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <span className="text-[10px] text-[var(--color-muted-foreground)]">{hint}</span>
    </div>
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        void execute({ run: () => saveRetentionAction({ ...v, password: enablingAuto ? password : undefined }), timeoutMs: 30_000 }).then((r) => {
          setPassword("");
          if (r) setMsg({ ok: r.ok, text: r.message });
        });
      }}
    >
      <fieldset disabled={!canManage || busy} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Current Production</span>
          <span className="flex h-9 items-center text-sm">
            <Badge variant="success">Always Protected</Badge>
          </span>
          <span className="text-[10px] text-[var(--color-muted-foreground)]">Never counted in the number below.</span>
        </div>
        {num("rollbackReleasesToKeep", "Rollback Releases to Keep", `Current + ${v.rollbackReleasesToKeep} previous = ${v.rollbackReleasesToKeep + 1} protected releases`)}
        {num("dbBackupsToKeep", "DB Backups to Keep", "Newest verified database backups protected")}
        {num("fullBackupsToKeep", "Full Disaster Backups to Keep", "Newest verified Full backups protected")}
        {num("cleanBackupsToKeep", "Clean Portable Backups to Keep", "Newest verified Clean backups protected")}
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="mt-1" checked={v.autoCleanup} onChange={(e) => setV({ ...v, autoCleanup: e.target.checked })} />
          <span>
            Automatic Retention Cleanup <Badge variant={v.autoCleanup ? "warning" : "neutral"}>{v.autoCleanup ? "ON" : "OFF"}</Badge>
            <span className="block text-[10px] text-[var(--color-muted-foreground)]">
              Daily at 03:30 UTC, deletes only items already listed as cleanup candidates. Never current/rollback releases, protected verified backups, unknown or unverified files, uploads, the database or source.
            </span>
          </span>
        </label>
        {enablingAuto ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="ret-pw">Admin password (required to enable)</Label>
            <Input id="ret-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9" />
          </div>
        ) : null}
      </fieldset>
      {canManage ? (
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={busy} className="w-fit">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} {busy ? "Saving…" : "Save retention"}
          </Button>
          <Msg ok={msg?.ok ?? false} text={msg?.text ?? null} />
        </div>
      ) : (
        <p className="text-xs text-[var(--color-muted-foreground)]">View only — retention changes are limited to Master Admin.</p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Verify (upload) + Restore
// ---------------------------------------------------------------------------

export function UploadVerify() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { busy, execute } = useOp();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const input = (e.currentTarget.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
        if (!input) return setMsg({ ok: false, text: "Choose a backup .tar file." });
        if (input.size > 20 * 1024 * 1024) return setMsg({ ok: false, text: "Over 20 MB — copy it to the VPS incoming folder with scp instead (see note)." });
        setMsg(null);
        void execute<{ status?: string; summary?: string }>({
          run: async () => {
            const res = await fetch("/api/admin/backup/upload", { method: "POST", body: input, headers: { "Content-Type": "application/octet-stream" } });
            const j = (await res.json().catch(() => ({}))) as { status?: string; summary?: string; error?: string };
            return res.ok ? { ok: true, message: `${j.status}: ${j.summary}`, data: j } : { ok: false, error: j.error ?? "Upload failed." };
          },
          timeoutMs: 10 * 60_000,
        }).then((r) => {
          if (r) setMsg({ ok: r.ok && r.data?.status === "VALID", text: r.message });
        });
      }}
    >
      <Input type="file" name="file" accept=".tar" className="h-10 max-w-xs" aria-label="Backup file" />
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />} {busy ? "Verifying…" : "Upload & Verify"}
      </Button>
      <Msg ok={msg?.ok ?? false} text={msg?.text ?? null} />
    </form>
  );
}

export function RestorePanel({ packages }: { packages: { id: string; name: string; category: string; verification: string | null }[] }) {
  const [id, setId] = useState(packages[0]?.id ?? "");
  const [pass, setPass] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; checks?: CheckList } | null>(null);
  const rehearseOp = useOp();
  const restoreOp = useOp();
  const busy = rehearseOp.busy || restoreOp.busy;
  if (packages.length === 0) return <p className="text-sm text-[var(--color-muted-foreground)]">No Backup Center packages on the VPS yet. Create one with “Save a copy on VPS”, upload one in Verify, or scp it into the incoming folder.</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rs-pkg">Backup package</Label>
          <select id="rs-pkg" value={id} onChange={(e) => setId(e.target.value)} className="h-10 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm">
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.category} · {p.verification ?? "not verified"}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rs-pass">Recovery passphrase (FULL backups)</Label>
          <Input id="rs-pass" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
        <p className="text-sm font-medium">1. Restore preview / rehearsal (safe)</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">Validates manifest, checksums, format and schema, then restores into a throwaway database + folder and compares every table, password hashes, commerce records, settings and files. Production is not touched.</p>
        <Button
          size="sm"
          className="w-fit"
          disabled={busy || !id}
          onClick={() => {
            setResult(null);
            void rehearseOp.execute({ run: () => rehearseRestoreAction({ id, passphrase: pass || undefined }), timeoutMs: 15 * 60_000 }).then((r) => {
              if (!r) return;
              setResult(r.ok && r.data ? { ok: r.data.ok, text: r.data.ok ? "Rehearsal passed — this backup restores correctly." : "Rehearsal found problems.", checks: r.data.checks } : { ok: false, text: r.message });
            });
          }}
        >
          {rehearseOp.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />} {rehearseOp.busy ? "Rehearsing…" : "Run restore rehearsal"}
        </Button>
      </div>
      <form
        className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-error)]/50 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          void restoreOp.execute({ run: () => restoreProductionAction({ id, passphrase: pass || undefined, password, confirm }), timeoutMs: 30 * 60_000 }).then((r) => {
            setPassword("");
            if (!r) return;
            setResult(r.ok && r.data ? { ok: r.data.ok, text: r.data.ok ? `Production restored. Safety backup of the previous database: ${r.data.safetyDump}` : "Restore finished with failed checks.", checks: r.data.checks } : { ok: false, text: r.message });
          });
        }}
      >
        <p className="text-sm font-medium text-[var(--color-error)]">2. Restore over PRODUCTION</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Replaces the ENTIRE live database with the backup&apos;s (all students, questions, attempts, payments, settings) and adds/overwrites persistent files. Only allowed when the backup&apos;s schema matches
          this release. A safety dump of the current database is taken first. Run a rehearsal before this.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Type RESTORE PRODUCTION" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9 w-60" aria-label="Type RESTORE PRODUCTION" />
          <Input type="password" placeholder="Your admin password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9 w-56" aria-label="Admin password" />
          <Button type="submit" size="sm" variant="danger" disabled={busy || !id}>
            {restoreOp.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null} {restoreOp.busy ? "Restoring…" : "Restore production"}
          </Button>
        </div>
      </form>
      {result ? (
        <div className="flex flex-col gap-1">
          <Msg ok={result.ok} text={result.text} />
          {result.checks ? <Checks checks={result.checks} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: string | null }) {
  const v = status === "VALID" ? "success" : status === "LEGACY_VERIFIED" ? "info" : status === "CORRUPT" || status === "INVALID" ? "error" : status === "INCOMPATIBLE" ? "warning" : "neutral";
  return <Badge variant={v}>{(status ?? "NOT VERIFIED").replace(/_/g, " ")}</Badge>;
}
