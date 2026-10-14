"use client";

import { useState } from "react";
import { FileCheck2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/**
 * Checks a downloaded Backup Center package ON THE ADMIN'S DEVICE — nothing
 * is uploaded, so there is no size limit and no network truncation. Reads
 * the outer tar's headers, then hashes every member with the browser's
 * SubtleCrypto and compares against checksums.sha256 and manifest.json;
 * the whole-file SHA-256 is matched against the server's record of the
 * backups it generated. The encrypted .env can only be test-decrypted with
 * the passphrase on the VPS (Restore → rehearsal) or locally with gpg.
 */

export interface KnownBackup {
  fileName: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  kind: string;
  createdAt: string;
}

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

interface TarEntry {
  name: string;
  type: string;
  size: number;
  offset: number;
}

interface ManifestLite {
  format?: string;
  formatVersion?: number;
  backupType?: string;
  createdAt?: string;
  app?: { gitSha?: string | null; version?: string };
  database?: { latestMigration?: string | null; tableCount?: number; rowCounts?: Record<string, number>; excludedTableData?: string[] };
  components?: { path: string; kind: string; bytes: number; sha256: string; description?: string }[];
  persistentAssets?: { key: string; label: string; fileCount: number; bytes: number }[];
  secrets?: { included?: boolean; method?: string | null };
}

const HASH_LIMIT = 1536 * 1024 * 1024; // above this, a member is too large to hash in browser memory

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(blob: Blob) {
  return hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}
const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);

function cString(bytes: Uint8Array) {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes);
}

/** Lists ustar/GNU members without reading their data. Throws with a specific reason on a damaged archive. */
async function listTar(file: File): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= file.size) {
    const h = new Uint8Array(await file.slice(off, off + 512).arrayBuffer());
    if (h.every((b) => b === 0)) return entries;
    // Header checksum: sum of all bytes with the checksum field counted as spaces.
    const stored = parseInt(cString(h.subarray(148, 156)).trim() || "x", 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (!Number.isFinite(stored) || stored !== sum) throw new Error(`Damaged tar header at byte ${off.toLocaleString("en-IN")} (header checksum mismatch).`);
    const size = parseInt(cString(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cString(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${cString(h.subarray(0, 100))}` : cString(h.subarray(0, 100)));
    const dataOff = off + 512;
    if (dataOff + size > file.size) throw new Error(`"${name}" needs ${size.toLocaleString("en-IN")} bytes but the file ends early — the file is incomplete (truncated download or copy).`);
    if (type === "L") longName = new TextDecoder().decode(new Uint8Array(await file.slice(dataOff, dataOff + size).arrayBuffer())).replace(/\0+$/, "");
    else {
      longName = null;
      entries.push({ name: name.replace(/^\.\//, ""), type, size, offset: dataOff });
    }
    off = dataOff + Math.ceil(size / 512) * 512;
  }
  throw new Error("The archive has no end-of-archive marker — the file is incomplete (truncated download or copy).");
}

export function LocalBackupCheck({ known }: { known: KnownBackup[] }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; summary: string; checks: Check[]; manifest: ManifestLite | null } | null>(null);

  async function run(file: File) {
    setBusy(true);
    setResult(null);
    const checks: Check[] = [];
    let manifest: ManifestLite | null = null;
    const done = (ok: boolean, summary: string) => setResult({ ok, summary, checks, manifest });
    try {
      if (!globalThis.crypto?.subtle) return done(false, "This browser cannot compute SHA-256 here (needs HTTPS and a modern browser).");
      const record = known.find((k) => k.fileName === file.name) ?? null;
      if (record?.sizeBytes != null) {
        const same = record.sizeBytes === file.size;
        checks.push({
          label: "File size matches the server's record",
          ok: same,
          detail: same
            ? `${file.size.toLocaleString("en-IN")} bytes`
            : `expected ${record.sizeBytes.toLocaleString("en-IN")} bytes, this file has ${file.size.toLocaleString("en-IN")} — ${file.size < record.sizeBytes ? "the download or copy is incomplete" : "the file was altered"}`,
        });
      }
      if (file.size % 512 !== 0) {
        checks.push({ label: "Whole tar archive", ok: false, detail: `${file.size.toLocaleString("en-IN")} bytes is not a whole number of 512-byte tar blocks — the file is incomplete or not a backup package` });
        return done(false, "Not a complete backup package.");
      }
      setProgress("Reading archive…");
      let entries: TarEntry[];
      try {
        entries = await listTar(file);
      } catch (e) {
        checks.push({ label: "Archive readable", ok: false, detail: e instanceof Error ? e.message : String(e) });
        return done(false, "The archive is damaged or incomplete.");
      }
      checks.push({ label: "Archive readable", ok: true, detail: `${entries.length} entries` });
      const byName = new Map(entries.map((e) => [e.name, e]));
      const text = async (n: string) => {
        const e = byName.get(n);
        return e ? new TextDecoder().decode(new Uint8Array(await file.slice(e.offset, e.offset + e.size).arrayBuffer())) : null;
      };
      const mText = await text("manifest.json");
      try {
        manifest = mText ? (JSON.parse(mText) as ManifestLite) : null;
      } catch {
        manifest = null;
      }
      if (!manifest || manifest.format !== "mocktestseries-backup" || !Array.isArray(manifest.components)) {
        checks.push({ label: "manifest.json", ok: false, detail: mText ? "not a MockTestSeries.in backup manifest" : "missing" });
        return done(false, "This is not a MockTestSeries.in Backup Center package.");
      }
      checks.push({ label: "Manifest", ok: true, detail: `${manifest.backupType} · format v${manifest.formatVersion} · created ${manifest.createdAt}` });

      const sums = new Map(
        ((await text("checksums.sha256")) ?? "")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => [l.slice(66), l.slice(0, 64)] as const)
      );
      checks.push({ label: "checksums.sha256 present", ok: sums.size > 0, detail: `${sums.size} entries` });

      let bad = 0;
      const targets = [...manifest.components.map((c) => ({ path: c.path, sha: c.sha256 as string | null, bytes: c.bytes as number | null })), { path: "manifest.json", sha: null, bytes: null }];
      for (const [i, c] of targets.entries()) {
        const e = byName.get(c.path);
        if (!e) {
          bad++;
          checks.push({ label: c.path, ok: false, detail: "missing from the archive" });
          continue;
        }
        if (c.bytes != null && e.size !== c.bytes) {
          bad++;
          checks.push({ label: c.path, ok: false, detail: `size ${e.size.toLocaleString("en-IN")} ≠ manifest ${c.bytes.toLocaleString("en-IN")}` });
          continue;
        }
        if (e.size > HASH_LIMIT) {
          checks.push({ label: c.path, ok: true, detail: `${fmtBytes(e.size)} — too large to hash in the browser; verify on the VPS` });
          continue;
        }
        setProgress(`Checking ${c.path} (${i + 1}/${targets.length})…`);
        const actual = await sha256(file.slice(e.offset, e.offset + e.size));
        const expected = sums.get(c.path);
        const ok = actual === expected && (c.sha == null || c.sha === actual);
        if (!ok) bad++;
        checks.push({ label: c.path, ok, detail: ok ? `${fmtBytes(e.size)} · SHA-256 OK` : `SHA-256 mismatch — this part of the file is damaged or was modified` });
      }

      if (file.size <= HASH_LIMIT) {
        setProgress("Hashing the whole file…");
        const whole = await sha256(file);
        const match = known.find((k) => k.sha256 === whole);
        if (match) checks.push({ label: "Identical to a backup this server generated", ok: true, detail: `${match.kind} backup of ${new Date(match.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} (SHA-256 ${whole.slice(0, 16)}…)` });
        else if (record?.sha256) checks.push({ label: "Whole-file SHA-256 matches the server's record", ok: false, detail: `expected ${record.sha256.slice(0, 16)}…, got ${whole.slice(0, 16)}…` });
        else checks.push({ label: "Whole-file SHA-256", ok: true, detail: `${whole.slice(0, 16)}… (no server record to compare — e.g. a backup made before this check existed)` });
      }
      const ok = checks.every((c) => c.ok);
      done(ok, ok ? `${manifest.backupType} backup is intact: every component matches its SHA-256 checksum.` : bad ? `${bad} component(s) failed — this copy is damaged.` : "The file does not match the server's record.");
    } catch (e) {
      done(false, `Check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const rc = manifest(result);
  return (
    <div className="flex flex-col gap-3" data-testid="local-backup-check">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = (e.currentTarget.elements.namedItem("localfile") as HTMLInputElement | null)?.files?.[0];
          if (f) void run(f);
        }}
      >
        <Input type="file" name="localfile" accept=".tar" className="h-10 max-w-xs" aria-label="Downloaded backup file" />
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FileCheck2 className="h-3.5 w-3.5" aria-hidden />} {busy ? "Checking…" : "Check file"}
        </Button>
        {progress ? <span className="text-xs text-[var(--color-muted-foreground)]">{progress}</span> : null}
      </form>
      {result ? (
        <div className="flex flex-col gap-2" role={result.ok ? "status" : "alert"} aria-live="polite">
          <p className={`text-sm font-medium ${result.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} data-testid="local-check-summary">
            {result.ok ? "✓ " : "✗ "}
            {result.summary}
          </p>
          <ul className="flex flex-col gap-1 text-xs">
            {result.checks.map((c, i) => (
              <li key={i} className={c.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}>
                {c.ok ? "✓" : "✗"} {c.label}
                {c.detail ? <span className="text-[var(--color-muted-foreground)]"> — {c.detail}</span> : null}
              </li>
            ))}
          </ul>
          {rc ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-xs">
              <p className="mb-2 flex flex-wrap items-center gap-2 font-medium">
                <Badge variant={rc.backupType === "FULL" ? "success" : rc.backupType === "CLEAN" ? "info" : "warning"}>{rc.backupType}</Badge>
                {rc.backupType === "DATABASE" ? "Database only — not a complete disaster recovery backup" : null}
                {rc.backupType === "CLEAN" ? "Portable: no secrets (new .env values needed on restore)" : null}
                {rc.backupType === "FULL" ? `Secrets included, encrypted (${rc.secrets?.method ?? "GnuPG"})` : null}
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                <dt className="text-[var(--color-muted-foreground)]">Created</dt>
                <dd>{rc.createdAt ? new Date(rc.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</dd>
                <dt className="text-[var(--color-muted-foreground)]">App SHA</dt>
                <dd className="font-mono">{rc.app?.gitSha?.slice(0, 12) ?? "—"}</dd>
                <dt className="text-[var(--color-muted-foreground)]">Schema</dt>
                <dd className="break-all font-mono">{rc.database?.latestMigration ?? "—"}</dd>
                <dt className="text-[var(--color-muted-foreground)]">Tables</dt>
                <dd>{rc.database?.tableCount ?? "—"}</dd>
                {(
                  [
                    ["Students", "Student"],
                    ["Questions", "Question"],
                    ["PYQ papers", "PreviousYearPaper"],
                    ["Mock tests", "MockTest"],
                    ["Test attempts", "TestAttempt"],
                    ["Answers", "Answer"],
                    ["Payments", "Payment"],
                    ["Entitlements", "StudentEntitlement"],
                  ] as const
                ).map(([label, t]) => (
                  <div key={t} className="contents">
                    <dt className="text-[var(--color-muted-foreground)]">{label}</dt>
                    <dd>{rc.database?.rowCounts?.[t]?.toLocaleString("en-IN") ?? "—"}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-[var(--color-muted-foreground)]">
                Components: {(rc.components ?? []).map((c) => `${c.path} (${fmtBytes(c.bytes)})`).join(", ")}
                {rc.persistentAssets?.length ? ` · Files: ${rc.persistentAssets.map((a) => `${a.key} ${a.fileCount} files`).join(", ")}` : ""}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function manifest(r: { manifest: ManifestLite | null } | null) {
  return r?.manifest ?? null;
}
