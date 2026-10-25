"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Image as ImageIcon, Music, Trash2, Upload, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { removeAssetAction, setPdfPagesAction } from "@/app/admin/(dashboard)/video-studio/actions";
import { mediaUrl, uploadToJob } from "@/components/admin/video-studio/upload";
import type { JobAsset } from "@/lib/video-studio/assets";

const ICON = { pdf: FileText, image: ImageIcon, video: Video, music: Music } as const;

/** Parses "1-3, 5" into page numbers. */
export function parsePages(s: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b) && p <= max; p++) if (p >= 1) out.add(p);
  }
  return [...out].sort((x, y) => x - y).slice(0, 20);
}

export function AssetsPanel({
  jobId,
  assets,
  canUse,
  accept,
  hint,
  pagesEditable,
  testId = "assets-panel",
}: {
  jobId: string;
  assets: JobAsset[];
  canUse: boolean;
  accept: string;
  hint: string;
  pagesEditable: boolean;
  testId?: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [pages, setPages] = useState<Record<string, string>>({});

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const f of Array.from(files)) {
      try {
        setBusy(`${f.name}: 0%`);
        await uploadToJob(jobId, f, (p) => setBusy(`${f.name}: ${p}%`));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed.");
        break;
      }
    }
    setBusy(null);
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {canUse ? (
        <div className="flex flex-wrap items-center gap-3">
          <input ref={input} type="file" accept={accept} multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} data-testid="asset-input" />
          <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden /> Upload files
          </Button>
          <span className="text-xs text-[var(--color-muted-foreground)]">{hint}</span>
        </div>
      ) : null}
      {busy ? <p className="text-xs" role="status" data-testid="upload-progress">Uploading {busy}</p> : null}
      {error ? <p className="text-xs text-[var(--color-error)]" role="alert" data-testid="upload-error">{error}</p> : null}
      {assets.length ? (
        <ul className="flex flex-col gap-2">
          {assets.map((a) => {
            const Icon = ICON[a.kind];
            return (
              <li key={a.key} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-sm" data-asset={a.kind} data-state={a.state}>
                {a.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaUrl(jobId, a.key)} alt="" className="h-12 w-12 rounded object-cover" />
                ) : (
                  <Icon className="h-5 w-5 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{a.name}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    {(a.bytes / 1024 / 1024).toFixed(1)} MB
                    {a.pages ? ` · ${a.pages} page(s)` : ""}
                    {a.durationSec ? ` · ${a.durationSec.toFixed(1)} s` : ""}
                    {a.video ? ` · ${a.video.width}×${a.video.height}` : ""}
                    {a.state === "processing" ? " · waiting to be checked" : a.state === "failed" ? ` · not usable: ${a.error}` : ""}
                  </p>
                  {a.kind === "pdf" && pagesEditable && canUse ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Input
                        aria-label="Pages to use"
                        className="h-7 w-44 text-xs"
                        placeholder={`All (up to 20 of ${a.pages})`}
                        value={pages[a.key] ?? (a.selectedPages?.length ? a.selectedPages.join(", ") : "")}
                        onChange={(e) => setPages((p) => ({ ...p, [a.key]: e.target.value }))}
                        data-testid="pdf-pages"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const r = await setPdfPagesAction(jobId, a.key, parsePages(pages[a.key] ?? "", a.pages ?? 0));
                            if (!r.ok) setError(r.error);
                            router.refresh();
                          })
                        }
                      >
                        Use pages
                      </Button>
                    </div>
                  ) : a.kind === "pdf" && a.selectedPages?.length ? (
                    <p className="text-xs">Pages: {a.selectedPages.join(", ")}</p>
                  ) : null}
                </div>
                {canUse && !a.key.startsWith("inputs/pdfpage-") ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Remove ${a.name}`}
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await removeAssetAction(jobId, a.key);
                        if (!r.ok) setError(r.error);
                        router.refresh();
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-[var(--color-muted-foreground)]">No files yet.</p>
      )}
    </div>
  );
}
