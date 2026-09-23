"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck, Download, Trash2, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  backupJobStatusAction,
  cleanTempAction,
  cleanupBackupsAction,
  cleanupReleasesAction,
  createBackupAction,
  deleteArtifactAction,
  deleteReleaseAction,
  rehearseRestoreAction,
  rescanAction,
  restoreProductionAction,
  verifyArtifactAction,
} from "../actions";

function fmt(bytes: number | null | undefined) {
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
    <p className={`text-xs ${ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={ok ? undefined : "alert"} aria-live="polite">
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
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const poll = async () => {
      const r = await backupJobStatusAction(jobId);
      if (cancelled) return;
      if (!r.ok || !r.data) {
        setError(r.error ?? "Status unavailable.");
        return;
      }
      setStatus(r.data.status);
      if (r.data.status === "RUNNING") timer.current = setTimeout(poll, 2500);
      else if (r.data.status === "READY") {
        // A file download (API route), not page navigation.
        const a = document.createElement("a");
        a.href = `/api/admin/backup/jobs/${jobId}/download`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      else if (r.data.status === "FAILED") setError(r.data.error ?? "Backup failed.");
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
    start(async () => {
      const r = await createBackupAction({ kind, saveOnVps: save, passphrase: kind === "FULL" ? pass : undefined, passphraseConfirm: pass2, password });
      setPassword("");
      if (!r.ok || !r.data) return setError(r.error ?? "Could not start.");
      setPass("");
      setPass2("");
      setJobId(r.data.jobId);
      setStatus("RUNNING");
    });
  }

  const running = status === "RUNNING" || pending;
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
        <p className="text-xs text-[var(--color-success)]">
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
  const router = useRouter();
  const [open, setOpen] = useState<"verify" | "delete" | null>(null);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; checks?: CheckList } | null>(null);
  const [pending, start] = useTransition();
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
            <a href={`/api/admin/backup/artifacts/${artifact.id}/download`}>
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
            start(async () => {
              const r = await verifyArtifactAction(artifact.id, pass || undefined);
              setPass("");
              setResult(r.ok && r.data ? { ok: r.data.status === "VALID" || r.data.status === "LEGACY_VERIFIED", text: `${r.data.status}: ${r.data.summary}`, checks: r.data.checks } : { ok: false, text: r.error ?? "Failed" });
              router.refresh();
            });
          }}
        >
          {artifact.kind === "PACKAGE" ? (
            <Input type="password" placeholder="Recovery passphrase (optional, FULL only)" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} className="h-8" aria-label="Recovery passphrase" />
          ) : null}
          <Button type="submit" size="compact" disabled={pending} className="w-fit">
            {pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null} Run verification
          </Button>
        </form>
      ) : null}
      {open === "delete" ? (
        <form
          className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-error)]/40 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await deleteArtifactAction({ id: artifact.id, confirm, password });
              setPassword("");
              setResult({ ok: r.ok, text: r.ok ? `${r.message} Freed ${fmt(r.data?.freed)}.` : (r.error ?? "Failed") });
              if (r.ok) router.refresh();
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
          <Button type="submit" size="compact" variant="danger" disabled={pending} className="w-fit">
            Delete permanently
          </Button>
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
// Bulk cleanup (backups / releases), temp cleanup, rescan
// ---------------------------------------------------------------------------

export function BulkCleanupForm({ kind, previewIds, reclaimable, count }: { kind: "backups" | "releases"; previewIds: string[]; reclaimable: number; count: number }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (count === 0) return <p className="text-xs text-[var(--color-muted-foreground)]">Nothing eligible for cleanup.</p>;
  return (
    <form
      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-error)]/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r =
            kind === "backups"
              ? await cleanupBackupsAction({ previewIds, confirm, password })
              : await cleanupReleasesAction({ previewIds, keepExtra: 0, confirm, password });
          setPassword("");
          if (!r.ok || !r.data) return setMsg({ ok: false, text: r.error ?? "Failed" });
          const d = r.data as { freed: number; deleted: number; remainingBytes: number; remaining?: number };
          setMsg({ ok: true, text: `${r.message} Storage freed: ${fmt(d.freed)}. Remaining ${kind}: ${d.remaining ?? ""} ${fmt(d.remainingBytes)}.` });
          router.refresh();
        });
      }}
    >
      <p className="text-sm">
        Delete <strong>{count}</strong> {kind === "backups" ? "old backup(s)" : "old release(s)"} and reclaim <strong>{fmt(reclaimable)}</strong>.{" "}
        {kind === "releases" ? "The current production release and the rollback release are protected." : "The latest verified backups are protected."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-9 w-40" aria-label="Type DELETE" />
        <Input type="password" placeholder="Your admin password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9 w-56" aria-label="Admin password" />
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
          {kind === "backups" ? "Clean Old Backups" : "Clean Old Releases"}
        </Button>
      </div>
      <Msg ok={msg?.ok ?? false} text={msg?.text ?? null} />
    </form>
  );
}

export function ReleaseDelete({ id, sha }: { id: string; sha: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <Button size="compact" variant="outline" onClick={() => setOpen(!open)} className="w-fit">
        <Trash2 className="h-3 w-3" aria-hidden /> Delete
      </Button>
      {open ? (
        <form
          className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-error)]/40 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await deleteReleaseAction({ id, confirm, password });
              setPassword("");
              setMsg({ ok: r.ok, text: r.ok ? `${r.message} Freed ${fmt(r.data?.freed)}.` : (r.error ?? "Failed") });
              if (r.ok) router.refresh();
            });
          }}
        >
          <p className="text-xs">This deletes an inactive deployment release ({sha.slice(0, 10)}). The current production release is protected.</p>
          <Input placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-8" aria-label="Type DELETE" />
          <Input type="password" placeholder="Your admin password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-8" aria-label="Admin password" />
          <Button type="submit" size="compact" variant="danger" disabled={pending} className="w-fit">
            Delete release
          </Button>
        </form>
      ) : null}
      <Msg ok={msg?.ok ?? false} text={msg?.text ?? null} />
    </div>
  );
}

export function SimpleAction({ action, label }: { action: "temp" | "rescan"; label: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = action === "temp" ? await cleanTempAction() : await rescanAction();
            setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Done") : (r.error ?? "Failed") });
            router.refresh();
          })
        }
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} {label}
      </Button>
      <Msg ok={msg?.ok ?? false} text={msg?.text ?? null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verify (upload) + Restore
// ---------------------------------------------------------------------------

export function UploadVerify() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const input = (e.currentTarget.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
        if (!input) return setMsg({ ok: false, text: "Choose a backup .tar file." });
        if (input.size > 20 * 1024 * 1024) return setMsg({ ok: false, text: "Over 20 MB — copy it to the VPS incoming folder with scp instead (see note)." });
        start(async () => {
          const res = await fetch("/api/admin/backup/upload", { method: "POST", body: input, headers: { "Content-Type": "application/octet-stream" } });
          const j = (await res.json().catch(() => ({}))) as { status?: string; summary?: string; error?: string };
          setMsg(res.ok ? { ok: j.status === "VALID", text: `${j.status}: ${j.summary}` } : { ok: false, text: j.error ?? "Upload failed." });
          router.refresh();
        });
      }}
    >
      <Input type="file" name="file" accept=".tar" className="h-10 max-w-xs" aria-label="Backup file" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />} Upload &amp; Verify
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
  const [pending, start] = useTransition();
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
        <p className="text-sm font-medium">1. Restore rehearsal (safe)</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">Validates manifest, checksums, format and schema, then restores into a throwaway database + folder and compares every table, password hashes, commerce records, settings and files. Production is not touched.</p>
        <Button
          size="sm"
          className="w-fit"
          disabled={pending || !id}
          onClick={() =>
            start(async () => {
              const r = await rehearseRestoreAction({ id, passphrase: pass || undefined });
              setResult(r.ok && r.data ? { ok: r.data.ok, text: r.data.ok ? "Rehearsal passed — this backup restores correctly." : "Rehearsal found problems.", checks: r.data.checks } : { ok: false, text: r.error ?? "Failed" });
            })
          }
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />} Run restore rehearsal
        </Button>
      </div>
      <form
        className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-error)]/50 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await restoreProductionAction({ id, passphrase: pass || undefined, password, confirm });
            setPassword("");
            setResult(r.ok && r.data ? { ok: r.data.ok, text: r.data.ok ? `Production restored. Safety backup of the previous database: ${r.data.safetyDump}` : "Restore finished with failed checks.", checks: r.data.checks } : { ok: false, text: r.error ?? "Failed" });
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
          <Button type="submit" size="sm" variant="danger" disabled={pending || !id}>
            Restore production
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
