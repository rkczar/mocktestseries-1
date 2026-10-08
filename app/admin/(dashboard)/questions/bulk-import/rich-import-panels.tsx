"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia } from "@/components/content/question-media";
import { HumanExplanation } from "@/components/content/human-explanation";
import type { ExplanationView, RichQuestionView } from "@/lib/rich-content-types";
import { AlertCircle, Archive, Download, ImageIcon } from "lucide-react";

/**
 * NEET Phase 3 rich-import UI pieces for the ONE Bulk Import workspace
 * (bulk-import-workspace.tsx). Only RICH runs render any of this; a LEGACY
 * import looks and behaves exactly as before.
 */

export interface RichSummaryData {
  plain: number;
  richV1: number;
  withImages: number;
  questionImages: number;
  optionImages: number;
  explanationImages: number;
  taxonomyProblems: number;
  infos: number;
  multipleCorrectBlocked: number;
  pendingImages: number;
  unusedImages: string[];
  bundle: {
    id: string;
    filename: string;
    status: string;
    errorMessage: string | null;
    imageCount: number;
    processedCount: number;
    invalidCount: number;
    entries: { name: string; status: string; ambiguous: boolean; error: string | null }[];
  } | null;
}

/** Upload helper: chunked ZIP upload → bundle id (or a refusal message from inspection). */
export async function uploadImageBundle(zip: File, onProgress: (text: string) => void): Promise<{ bundleId: string; status: string; errorMessage: string | null; imageCount: number }> {
  const start = await fetch("/api/admin/questions/bulk-import/bundles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: zip.name, size: zip.size }),
  });
  if (!start.ok) throw new Error((await start.json()).error || "Could not start the image bundle upload");
  const { bundleId, chunkBytes, chunkCount } = (await start.json()) as { bundleId: string; chunkBytes: number; chunkCount: number };
  for (let i = 0; i < chunkCount; i++) {
    onProgress(`Uploading image bundle… ${i + 1}/${chunkCount}`);
    const part = zip.slice(i * chunkBytes, (i + 1) * chunkBytes);
    let ok = false;
    // A lost response is safe to retry: chunks are idempotent per index.
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const res = await fetch(`/api/admin/questions/bulk-import/bundles/${bundleId}/chunks/${i}`, { method: "PUT", body: part, headers: { "Content-Type": "application/octet-stream" } });
      if (res.ok) ok = true;
      else if (res.status < 500) throw new Error((await res.json()).error || "Chunk upload failed");
    }
    if (!ok) throw new Error("The image bundle upload failed after 3 attempts. Check the connection and try again.");
  }
  onProgress("Inspecting image bundle…");
  const done = await fetch(`/api/admin/questions/bulk-import/bundles/${bundleId}/complete`, { method: "POST" });
  if (!done.ok) throw new Error((await done.json()).error || "Could not finish the image bundle upload");
  const b = await done.json();
  return { bundleId, status: b.status, errorMessage: b.errorMessage, imageCount: b.imageCount };
}

/** Runs time-bounded processing slices until every referenced image is done. */
export async function processRunImages(runId: string, onProgress: (text: string) => void): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const res = await fetch(`/api/admin/questions/bulk-import/runs/${runId}/process-images`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || "Image processing failed");
    const r = (await res.json()) as { done: boolean; pending: number; ready: number; invalid: number; processedNow: number };
    if (r.done) return;
    onProgress(`Processing images… ${r.ready + r.invalid} done, ${r.pending} to go`);
    if (r.processedNow === 0) await new Promise((resolve) => setTimeout(resolve, 1500)); // another worker holds the lease
  }
}

export function RichUploadHelp() {
  return (
    <div className="rounded-lg bg-[var(--color-muted)] p-4 text-xs text-[var(--color-muted-foreground)]">
      <h4 className="mb-2 text-sm font-medium text-[var(--color-foreground)]">Rich columns (in addition to the standard ones):</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {["Code", "QNo", "Paper Code", "Chapter/Topic", "Question Type", "Content Format", "Question Images", "Option A–D Image", "Correct*", "Explanation", "Explanation Images", "Review Required", "Review Reason", "List I / List II"].map((c) => (
          <div key={c}>{c}</div>
        ))}
      </div>
      <p className="mt-2">
        Content Format <strong>RICH_V1</strong> renders <code>$…$</code>, <code>$$…$$</code>, <code>\ce{"{…}"}</code> and <code>\pu{"{…}"}</code>. Image cells list file names from the ZIP, separated by <code>|</code>, each with optional alt text: <code>Q12-fig.png :: Circuit with two resistors</code>.
        Rich imports are always saved as <strong>DRAFT</strong> and never create Subjects/Topics. See the template for every rule.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline" href="/api/admin/questions/bulk-import/rich-template?file=xlsx">
          <Download className="h-3 w-3" /> Rich XLSX template
        </a>
        <a className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline" href="/api/admin/questions/bulk-import/rich-template?file=zip">
          <Archive className="h-3 w-3" /> Sample image bundle (ZIP)
        </a>
      </div>
      <JsonExamples />
    </div>
  );
}

const JSON_EXAMPLE_LINKS = [
  ["ruhs-mo", "RUHS MO"],
  ["neet-ug-rich", "NEET UG rich"],
  ["with-images", "With images"],
  ["multiple-correct", "Multiple correct"],
  ["match-the-following", "Match the Following"],
] as const;

/** JSON format (docs/JSON-IMPORT.md): example files for both modes; shown under the Rich and Standard help. */
export function JsonExamples() {
  return (
    <div className="mt-3 text-xs text-[var(--color-muted-foreground)]" data-testid="json-examples">
      <p>
        <strong className="text-[var(--color-foreground)]">JSON files</strong> use the same rules in schema <code>mocktestseries.questions/v1</code>. A JSON
        package is one .zip with <code>questions.json</code> and its images (Rich mode).
      </p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {JSON_EXAMPLE_LINKS.map(([id, name]) => (
          <a key={id} className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline" href={`/api/admin/questions/bulk-import/rich-template?file=json&example=${id}`}>
            <Download className="h-3 w-3" /> {name} (.json)
          </a>
        ))}
        <a className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline" href="/api/admin/questions/bulk-import/rich-template?file=json-package">
          <Archive className="h-3 w-3" /> JSON package (.zip)
        </a>
      </div>
    </div>
  );
}

export function RichSummaryCard({ rich, onProcess, processing }: { rich: RichSummaryData; onProcess: () => void; processing: string | null }) {
  const b = rich.bundle;
  return (
    <Card data-testid="rich-summary">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Rich Content</CardTitle>
            <CardDescription>Formats, images and the image bundle of this import. Everything is saved as DRAFT.</CardDescription>
          </div>
          <Badge variant="info">RICH import</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {[
            ["PLAIN", rich.plain, ""],
            ["RICH_V1", rich.richV1, ""],
            ["With Images", rich.withImages, ""],
            ["Question Images", rich.questionImages, ""],
            ["Option Images", rich.optionImages, ""],
            ["Explanation Images", rich.explanationImages, ""],
            ["Taxonomy Problems", rich.taxonomyProblems, rich.taxonomyProblems ? "text-[var(--color-error)]" : ""],
            ["Images To Process", rich.pendingImages, rich.pendingImages ? "text-[var(--color-warning)]" : ""],
            ["Unused Images", rich.unusedImages.length, rich.unusedImages.length ? "text-[var(--color-warning)]" : ""],
            ["Info Notes", rich.infos, ""],
          ].map(([label, value, cls]) => (
            <div key={label as string} className="rounded-lg border border-[var(--color-border)] p-3">
              <div className={`text-xl font-bold text-[var(--color-foreground)] ${cls}`}>{value as number}</div>
              <div className="text-xs text-[var(--color-muted-foreground)]">{label as string}</div>
            </div>
          ))}
        </div>
        {rich.multipleCorrectBlocked > 0 ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>MULTIPLE_CORRECT ENGINE NOT YET ENABLED.</strong> {rich.multipleCorrectBlocked} row(s) request multiple-correct scoring. They are parsed but blocked — never converted to single-correct.
            </AlertDescription>
          </Alert>
        ) : null}
        {b ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ImageIcon className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            <span>
              Image bundle <strong>{b.filename}</strong>: {b.imageCount} image(s), {b.processedCount} processed, {b.invalidCount} invalid
            </span>
            <Badge variant={b.status === "FAILED" ? "error" : b.status === "READY" ? "success" : "neutral"}>{b.status}</Badge>
            {rich.pendingImages > 0 ? (
              <Button size="sm" onClick={onProcess} disabled={!!processing} data-testid="process-images">
                {processing ?? `Process Images (${rich.pendingImages})`}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-[var(--color-muted-foreground)]">No image bundle was uploaded with this import.</p>
        )}
        {b?.status === "FAILED" ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>The image bundle was refused: {b.errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        {rich.unusedImages.length > 0 ? (
          <details className="text-xs text-[var(--color-muted-foreground)]">
            <summary className="cursor-pointer">Warning: {rich.unusedImages.length} image(s) in the bundle are not referenced by any row (not processed)</summary>
            <ul className="mt-1 list-disc pl-5">
              {rich.unusedImages.slice(0, 50).map((n) => (
                <li key={n} className="font-mono">{n}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface PreviewData {
  rowNumber: number;
  severity: string;
  errors: string[];
  warnings: string[];
  infos: string[];
  contentFormat: string | null;
  questionType: string | null;
  text: string;
  options: { label: string; text: string; isCorrect: boolean }[];
  rich: RichQuestionView | null;
  explanation: ExplanationView | null;
  missingImages: string[];
}

/**
 * Row preview through the SAME components the Test Player and Review use
 * (RichText, QuestionMedia, HumanExplanation), fed by the production
 * renderer on the server — not a spreadsheet mock-up.
 */
export function RichPreviewDialog({ rowId, onClose }: { rowId: string; onClose: () => void }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/questions/bulk-import/rows/${rowId}/preview`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error || "Preview failed"))))
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Preview failed"));
    return () => {
      cancelled = true;
    };
  }, [rowId]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preview row {data?.rowNumber ?? ""}</DialogTitle>
        </DialogHeader>
        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
        {!data && !error ? <p className="text-sm text-[var(--color-muted-foreground)]">Rendering…</p> : null}
        {data ? (
          <div className="flex flex-col gap-3" data-testid="rich-preview">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="neutral">{data.contentFormat ?? "?"}</Badge>
              <Badge variant="neutral">{data.questionType ?? "?"}</Badge>
              <Badge variant={data.severity === "ERROR" ? "error" : data.severity === "WARNING" ? "warning" : "success"}>{data.severity}</Badge>
              <Badge variant="neutral">Will be saved as DRAFT</Badge>
            </div>
            {data.missingImages.length ? (
              <p className="text-xs text-[var(--color-warning)]">Not shown (missing or not processed yet): {data.missingImages.join(", ")}</p>
            ) : null}
            <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">
              <RichText text={data.text} html={data.rich?.textHtml} />
            </p>
            {data.rich ? <QuestionMedia assets={data.rich.assets.filter((a) => a.role === "QUESTION")} priority /> : null}
            <ul className="flex flex-col gap-2">
              {data.options.map((o) => (
                <li
                  key={o.label}
                  className={
                    o.isCorrect
                      ? "rounded-[var(--radius-card)] border border-[var(--color-success)] bg-[var(--color-success)]/10 p-3 text-sm"
                      : "rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm"
                  }
                >
                  <span className="font-semibold">{o.label}.</span> <RichText text={o.text} html={data.rich?.optionHtml[o.label]} />
                  {o.isCorrect ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Correct answer</span> : null}
                  {data.rich ? <QuestionMedia className="mt-2" size="option" assets={data.rich.assets.filter((a) => a.role === "OPTION" && a.optionLabel === o.label)} /> : null}
                </li>
              ))}
            </ul>
            {data.explanation ? <HumanExplanation explanation={data.explanation} /> : <p className="text-xs text-[var(--color-muted-foreground)]">No explanation.</p>}
            <MessageList title="Errors" items={data.errors} cls="text-[var(--color-error)]" />
            <MessageList title="Warnings" items={data.warnings} cls="text-[var(--color-warning)]" />
            <MessageList title="Info" items={data.infos} cls="text-[var(--color-muted-foreground)]" />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MessageList({ title, items, cls }: { title: string; items: string[]; cls: string }) {
  if (!items.length) return null;
  return (
    <div className="text-xs">
      <div className="font-semibold text-[var(--color-foreground)]">{title}</div>
      <ul className={`list-disc pl-5 ${cls}`}>
        {items.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

/** Confirmation before importing a RICH run that has WARNING rows (explicit acknowledgement). */
export function RichImportConfirm({ warnings, onCancel, onConfirm }: { warnings: number; onCancel: () => void; onConfirm: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import with warnings?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {warnings} row(s) have warnings (for example a missing explanation, alt text or a review flag). They will be imported as <strong>DRAFT</strong> with editorial stage <strong>NEEDS_REVIEW</strong>. Nothing is published.
          </p>
          <label className="flex items-center gap-2">
            <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid="ack-warnings" />I reviewed the warnings
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onConfirm} disabled={!ack} data-testid="confirm-import">
              Import as Draft
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
