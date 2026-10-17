"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/ai-import/config";
import type { CleanupCategory, CleanupItem, StorageReport } from "@/lib/ai-import/storage";
import { executeCleanupAction, findDuplicatesAction, previewCleanupAction, scanStorageAction } from "../actions";

export function StorageManager({ categories }: { categories: { key: string; label: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(["TEMP_UPLOADS", "WORKER_SCRATCH"]));
  const [preview, setPreview] = useState<{ items: CleanupItem[]; bytes: number } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dups, setDups] = useState<Awaited<ReturnType<typeof findDuplicatesAction>> | null>(null);

  const cats = [...chosen] as CleanupCategory[];
  return (
    <div className="flex flex-col gap-4" data-testid="storage-manager">
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => start(async () => {
          const r = await scanStorageAction();
          if (r.ok) setReport(r.data);
          else setMsg({ ok: false, text: r.error });
        })} data-testid="scan-storage">
          Scan storage
        </Button>
        <Button variant="outline" disabled={pending} onClick={() => start(async () => setDups(await findDuplicatesAction()))} data-testid="find-duplicates">
          Find duplicate files
        </Button>
      </div>
      {msg && <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} data-testid="storage-msg">{msg.text}</p>}
      {report && (
        <Card data-testid="storage-report">
          <CardHeader>
            <CardTitle>Storage report</CardTitle>
            <CardDescription>Scanned {report.scannedAt.slice(0, 19).replace("T", " ")} UTC · recoverable now: {formatBytes(report.recoverableBytes)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <div>Original papers: {report.originals.files} file(s), {formatBytes(report.originals.bytes)} · {report.originals.uploads} upload(s){report.originals.sharedUploads ? ` (${report.originals.sharedUploads} identical re-uploads stored once)` : ""}</div>
            <div>Expired originals: {report.originals.expired} deletable ({formatBytes(report.originals.expiredBytes)}){report.originals.expiredButOpen ? ` · ${report.originals.expiredButOpen} kept because their job is still open` : ""}</div>
            <div>Temporary & intermediate: renders {report.intermediate.renders} ({formatBytes(report.intermediate.rendersBytes)}) · upload chunks {report.intermediate.temp} ({formatBytes(report.intermediate.tempBytes)}) · worker scratch {report.intermediate.work} ({formatBytes(report.intermediate.workBytes)})</div>
            <div>Extracted figure originals: {report.figures.files} ({formatBytes(report.figures.bytes)}) · referenced {report.figures.referenced} · unreferenced {report.figures.unreferenced} ({formatBytes(report.figures.unreferencedBytes)})</div>
            <div>Question media (/media): {report.media.files} file(s), {formatBytes(report.media.bytes)} · {report.media.referencedByQuestions} referenced by questions · {report.media.unreferenced} not referenced by a question</div>
            <div className="text-xs text-[var(--color-muted-foreground)]">{report.media.note}</div>
            <div>Import packages in Bulk Import staging: {report.staging.bundles} ({formatBytes(report.staging.bytes)})</div>
            <div>Last cleanup: {report.lastCleanup ? `${report.lastCleanup.at.slice(0, 16).replace("T", " ")} UTC · ${report.lastCleanup.files} item(s)` : "never"}</div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Clean up</CardTitle>
          <CardDescription>Choose safe categories, preview exactly what would be removed, then type DELETE to confirm.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {categories.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={chosen.has(c.key)} onChange={() => setChosen((s) => (s.has(c.key) ? new Set([...s].filter((x) => x !== c.key)) : new Set([...s, c.key])))} data-testid={`cat-${c.key}`} />
              {c.label}
              {report && <span className="text-xs text-[var(--color-muted-foreground)]">— {report.candidates[c.key as CleanupCategory].count} item(s), {formatBytes(report.candidates[c.key as CleanupCategory].bytes)}</span>}
            </label>
          ))}
          <div>
            <Button variant="outline" disabled={pending || !cats.length} onClick={() => start(async () => {
              setConfirmText("");
              const r = await previewCleanupAction(cats);
              if (r.ok) setPreview(r.data);
              else setMsg({ ok: false, text: r.error });
            })} data-testid="preview-cleanup">
              Preview cleanup
            </Button>
          </div>
          {preview && (
            <div className="flex flex-col gap-2" data-testid="cleanup-preview">
              <p className="text-sm">
                {preview.items.length} item(s) · {formatBytes(preview.bytes)} would be removed.
                {preview.items.some((i) => i.category === "EXPIRED_ORIGINALS") && <span className="text-[var(--color-warning)]"> Expired originals cannot be re-processed or re-rendered after removal.</span>}
              </p>
              <ul className="max-h-64 overflow-auto text-xs">
                {preview.items.map((i) => (
                  <li key={i.key}>
                    {i.category.toLowerCase().replace(/_/g, " ")} · {i.label} · {formatBytes(i.bytes)}
                  </li>
                ))}
              </ul>
              {preview.items.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input className="w-40" placeholder="Type DELETE" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} data-testid="cleanup-confirm" />
                  <Button disabled={pending || confirmText !== "DELETE"} onClick={() => start(async () => {
                    const r = await executeCleanupAction(cats, preview.items.map((i) => i.key), confirmText);
                    if (r.ok) {
                      setMsg({ ok: true, text: `Removed ${r.data.deleted} item(s), ${formatBytes(r.data.bytes)}.${r.data.skipped.length ? ` ${r.data.skipped.length} skipped because they are no longer safe to delete.` : ""}` });
                      setPreview(null);
                      setReport(null);
                      router.refresh();
                    } else setMsg({ ok: false, text: r.error });
                  })} data-testid="cleanup-execute">
                    Delete {preview.items.length} item(s)
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {dups && (
        <Card data-testid="duplicates-report">
          <CardHeader>
            <CardTitle>Duplicate and integrity check</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {dups.ok ? (
              <ul className="flex flex-col gap-1">
                <li>{dups.data.checked} stored file(s) checksummed.</li>
                <li>Files with identical content under different names: {dups.data.duplicateGroups.length}{dups.data.duplicateGroups.map((g) => ` · ${g.keys.length}× ${formatBytes(g.bytes)}`).join("")}</li>
                <li>Uploads sharing one stored file (deduplicated by checksum): {dups.data.sharedUploads.reduce((a, s) => a + s.uploads, 0)}</li>
                <li className={dups.data.integrityErrors.length ? "text-[var(--color-error)]" : ""}>Integrity problems: {dups.data.integrityErrors.length ? dups.data.integrityErrors.join("; ") : "none"}</li>
                <li className="text-xs text-[var(--color-muted-foreground)]">Only byte-identical files count as duplicates; similar-looking images are never merged.</li>
              </ul>
            ) : (
              dups.error
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
