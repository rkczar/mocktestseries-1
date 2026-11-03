"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MANUAL_BATCH, type BatchPublishItem, type BatchPublishPreview, type BatchPublishResult, type BatchStatus } from "@/lib/pyq-import-batches-shared";
import type { PaperBatch, PaperAiJob, PaperBatchQuestion, ReviewCheck, MarkReviewedResult } from "@/lib/pyq-import-batches";
import { RetireReplaceLink } from "./remove-from-paper-button";
import { markReviewedAction, previewBatchPublishAction, publishBatchAction, recheckReviewAction } from "./batch-actions";

/**
 * Previous Year Paper → Import Batches + Questions. Selection is only a
 * request: preview, publish and mark-reviewed are all re-validated on the
 * server (lib/pyq-import-batches.ts). Actions work on ONE batch at a time.
 */

type Filter = "ALL" | "DRAFT" | "PUBLISHED" | "REVIEW" | "BLOCKED" | "RETIRED";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "PUBLISHED", label: "Published" },
  { key: "REVIEW", label: "Review required" },
  { key: "BLOCKED", label: "No correct answer" },
  { key: "RETIRED", label: "Retired" },
];

const STATUS_VARIANT: Record<BatchStatus, "success" | "neutral" | "warning" | "error" | "info"> = {
  PUBLISHED: "success",
  "PARTIALLY PUBLISHED": "info",
  DRAFT: "neutral",
  ARCHIVED: "warning",
  RETIRED: "error",
  "ROLLED BACK": "warning",
  "NOT IMPORTED": "neutral",
  FAILED: "error",
};

const Q_STATUS_VARIANT: Record<string, "success" | "neutral" | "warning"> = { PUBLISHED: "success", DRAFT: "neutral", ARCHIVED: "warning" };

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function matches(q: PaperBatchQuestion, f: Filter) {
  switch (f) {
    case "ALL":
      return true;
    case "DRAFT":
      return !q.retired && q.status === "DRAFT";
    case "PUBLISHED":
      return !q.retired && q.status === "PUBLISHED";
    case "REVIEW":
      return q.reviewRequired;
    case "BLOCKED":
      return !q.retired && q.noCorrectAnswer;
    case "RETIRED":
      return q.retired;
  }
}

export function PaperBatches({
  paperId,
  batches,
  aiJobs,
  questions,
  canManage,
}: {
  paperId: string;
  batches: PaperBatch[];
  aiJobs: PaperAiJob[];
  questions: PaperBatchQuestion[];
  canManage: boolean;
}) {
  const router = useRouter();
  const defaultBatch = useMemo(() => {
    const live = batches.filter((b) => b.counts.draft > 0);
    return live.at(-1)?.key ?? "ALL";
  }, [batches]);
  const [batchKey, setBatchKey] = useState<string>(defaultBatch);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // publish dialog
  const [publishOpen, setPublishOpen] = useState(false);
  const [preview, setPreview] = useState<BatchPublishPreview | null>(null);
  const [result, setResult] = useState<BatchPublishResult | null>(null);
  const [requestId, setRequestId] = useState<string>("");

  // review dialog
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checks, setChecks] = useState<ReviewCheck[] | null>(null);
  const [reviewResult, setReviewResult] = useState<MarkReviewedResult | null>(null);

  const batchByKey = useMemo(() => new Map(batches.map((b) => [b.key, b])), [batches]);
  const visible = questions.filter((q) => (batchKey === "ALL" || q.batchKey === batchKey) && matches(q, filter));
  const actionable = batchKey !== "ALL" && canManage;
  const selectable = (q: PaperBatchQuestion) => actionable && !q.retired && q.status === "DRAFT";
  const visibleSelectable = visible.filter(selectable);
  const selectedIds = [...selected].filter((id) => questions.some((q) => q.id === id && q.batchKey === batchKey));
  const selectedFlagged = selectedIds.filter((id) => questions.find((q) => q.id === id)?.reviewRequired);
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every((q) => selected.has(q.id));

  function chooseBatch(key: string) {
    setBatchKey(key);
    setSelected(new Set());
    setError(null);
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllVisible(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const q of visibleSelectable) {
        if (on) next.add(q.id);
        else next.delete(q.id);
      }
      return next;
    });
  }

  function openPublish() {
    setError(null);
    setResult(null);
    setPreview(null);
    setRequestId(crypto.randomUUID());
    setPublishOpen(true);
    startTransition(async () => {
      const r = await previewBatchPublishAction(paperId, batchKey, selectedIds);
      if (r.ok) setPreview(r.data);
      else setError(r.error);
    });
  }

  function confirmPublish() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const r = await publishBatchAction(paperId, batchKey, preview.eligible.map((e) => e.id), requestId);
      if (r.ok) {
        setResult(r.data);
        setSelected(new Set());
        router.refresh();
      } else setError(r.error);
    });
  }

  function openReview() {
    setError(null);
    setChecks(null);
    setReviewResult(null);
    setReviewOpen(true);
    startTransition(async () => {
      const r = await recheckReviewAction(paperId, batchKey, selectedFlagged);
      if (r.ok) setChecks(r.data);
      else setError(r.error);
    });
  }

  function confirmReview() {
    if (!checks) return;
    const ids = checks.filter((c) => c.status === "RESOLVED").map((c) => c.id);
    setError(null);
    startTransition(async () => {
      const r = await markReviewedAction(paperId, batchKey, ids);
      if (r.ok) {
        setReviewResult(r.data);
        setSelected(new Set());
        router.refresh();
      } else setError(r.error);
    });
  }

  const currentBatch = batchKey === "ALL" ? null : batchByKey.get(batchKey) ?? null;
  const resolvedCount = checks?.filter((c) => c.status === "RESOLVED").length ?? 0;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Import Batches</CardTitle>
          <CardDescription>
            Every import of this paper, from its import record. Pick a batch to see, review and publish its questions. Publishing is checked again on the server
            question by question.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {batches.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--color-muted-foreground)]">No imports or questions for this paper yet.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {batches.map((b) => (
                <BatchCard key={b.key} batch={b} active={b.key === batchKey} onSelect={() => chooseBatch(b.key)} />
              ))}
            </div>
          )}
          {aiJobs.length > 0 ? (
            <div className="rounded-md border border-[var(--color-border)] p-3 text-sm">
              <div className="mb-1 text-xs font-medium uppercase text-[var(--color-muted-foreground)]">AI Importer jobs for this paper</div>
              <ul className="flex flex-col gap-1">
                {aiJobs.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/ai-importer?job=${j.id}`} className="text-[var(--color-primary)] hover:underline">
                      {j.title}
                    </Link>
                    <Badge variant="neutral">{j.status}</Badge>
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      {j.extracted} extracted{j.expected != null ? ` of ${j.expected} expected` : ""} · {j.linked} linked to questions ·{" "}
                      {j.runIds.length ? `batch ${j.runIds.map((id) => batchByKey.get(id)?.ordinal ?? "?").join(", ")}` : "not imported into a batch"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Questions in This Paper</CardTitle>
          <CardDescription>
            {questions.length} question{questions.length === 1 ? "" : "s"} linked to this paper
            {currentBatch ? ` · showing ${batchTitle(currentBatch)}` : " · all batches"}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-[var(--color-muted-foreground)]" htmlFor="batch-pick">
              Batch
            </label>
            <select
              id="batch-pick"
              value={batchKey}
              onChange={(e) => chooseBatch(e.target.value)}
              className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-foreground)]"
            >
              <option value="ALL">All batches</option>
              {batches.map((b) => (
                <option key={b.key} value={b.key}>
                  {batchTitle(b)} ({b.counts.linked})
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <Button key={f.key} size="compact" variant={filter === f.key ? "secondary" : "ghost"} onClick={() => setFilter(f.key)}>
                  {f.label}
                </Button>
              ))}
            </div>
          </div>

          {canManage ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] p-2 text-xs">
              {actionable ? (
                <>
                  <span className="text-[var(--color-muted-foreground)]">
                    {selectedIds.length} selected{selectedFlagged.length ? ` · ${selectedFlagged.length} flagged for review` : ""}
                  </span>
                  <Button size="sm" disabled={pending || selectedIds.length === 0} onClick={openPublish}>
                    Publish selected…
                  </Button>
                  <Button size="sm" variant="outline" disabled={pending || selectedFlagged.length === 0} onClick={openReview}>
                    Re-check &amp; mark reviewed…
                  </Button>
                  {selectedIds.length ? (
                    <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                      Clear selection
                    </Button>
                  ) : null}
                </>
              ) : (
                <span className="text-[var(--color-muted-foreground)]">Pick one batch to select and publish its Draft questions.</span>
              )}
            </div>
          ) : null}

          {error && !publishOpen && !reviewOpen ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

          <div className="overflow-x-auto">
            {visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
                {questions.length === 0 ? "No questions linked yet — use \"Add Questions from Question Bank\" above." : "No questions match this batch and filter."}
              </p>
            ) : (
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                    <th className="w-8 py-2 pr-2">
                      {actionable ? (
                        <Checkbox
                          aria-label="Select all Draft questions shown"
                          checked={allVisibleSelected}
                          disabled={visibleSelectable.length === 0}
                          onCheckedChange={(v) => toggleAllVisible(v === true)}
                        />
                      ) : null}
                    </th>
                    <th className="py-2 pr-4">No.</th>
                    <th className="py-2 pr-4">Code</th>
                    <th className="py-2 pr-4">Batch</th>
                    <th className="py-2 pr-4">Subject</th>
                    <th className="py-2 pr-4">Question</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Image</th>
                    <th className="py-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((q) => {
                    const b = batchByKey.get(q.batchKey);
                    return (
                      <tr key={q.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                        <td className="py-2.5 pr-2">
                          {selectable(q) ? <Checkbox aria-label={`Select ${q.code}`} checked={selected.has(q.id)} onCheckedChange={(v) => toggle(q.id, v === true)} /> : null}
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">{q.number ?? "—"}</td>
                        <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-foreground)]">{q.code}</td>
                        <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">{b ? (b.ordinal ? `#${b.ordinal}` : "Manual") : "—"}</td>
                        <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                          {q.subject}
                          {q.topic ? <div className="text-xs">{q.topic}</div> : null}
                        </td>
                        <td className="max-w-[320px] py-2.5 pr-4 text-[var(--color-foreground)]">
                          <div className="truncate">{q.text}</div>
                          {q.reviewDetail ? <div className="mt-0.5 whitespace-normal text-xs text-[var(--color-warning)]">{q.reviewDetail}</div> : null}
                        </td>
                        <td className="py-2.5 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {q.retired ? <Badge variant="error">RETIRED</Badge> : <Badge variant={Q_STATUS_VARIANT[q.status] ?? "neutral"}>{q.status}</Badge>}
                            {q.reviewRequired ? <Badge variant="warning">Review</Badge> : null}
                            {q.noCorrectAnswer && !q.retired ? <Badge variant="warning">No Correct Answer</Badge> : null}
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{q.hasImage ? "Yes" : "—"}</td>
                        <td className="py-2.5 pr-4">
                          <div className="flex items-center justify-end gap-2">
                            {q.retired ? null : (
                              <Button asChild size="compact" variant="outline">
                                <Link href={`/admin/questions?tab=add&id=${q.id}`}>Edit</Link>
                              </Button>
                            )}
                            <RetireReplaceLink questionId={q.id} retired={q.retired} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Publish preview → confirm → result */}
      <Dialog open={publishOpen} onOpenChange={(o) => !pending && setPublishOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{result ? "Publish result" : "Publish selected questions"}</DialogTitle>
            <DialogDescription>
              {currentBatch ? batchTitle(currentBatch) : ""}. {result ? "" : "Only the questions that pass every check are published. Nothing else changes."}
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="mb-2 text-sm text-[var(--color-error)]">{error}</p> : null}
          {!preview && !result && !error ? <p className="text-sm text-[var(--color-muted-foreground)]">Checking {selectedIds.length} questions on the server…</p> : null}
          {result ? (
            <div className="flex flex-col gap-3 text-sm">
              <p className="font-medium text-[var(--color-foreground)]">
                {result.replayed ? "This request had already run — nothing was published twice. " : ""}
                Published {result.publishedCount} question{result.publishedCount === 1 ? "" : "s"}.
              </p>
              <ItemList title="Published" tone="success" items={result.published.map((p) => ({ id: p.id, code: p.code, number: null, reasons: [] }))} />
              <ItemList title="Not published (blocked)" tone="error" items={result.blocked} />
              <ItemList title="Already published" tone="neutral" items={result.alreadyPublished} />
            </div>
          ) : preview ? (
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-[var(--color-foreground)]">
                {preview.requested} selected · <strong>{preview.eligible.length} will be published</strong> · {preview.blocked.length} blocked ·{" "}
                {preview.alreadyPublished.length} already published
              </p>
              <ItemList title="Will be published" tone="success" items={preview.eligible} />
              <ItemList title="Blocked — will stay Draft" tone="error" items={preview.blocked} />
              <ItemList title="Already published" tone="neutral" items={preview.alreadyPublished} />
            </div>
          ) : null}
          <DialogFooter>
            {result ? (
              <Button onClick={() => setPublishOpen(false)}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" disabled={pending} onClick={() => setPublishOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={pending || !preview || preview.eligible.length === 0} onClick={confirmPublish}>
                  {pending && preview ? "Publishing…" : `Publish ${preview?.eligible.length ?? 0} question${preview?.eligible.length === 1 ? "" : "s"}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Review re-check → mark reviewed */}
      <Dialog open={reviewOpen} onOpenChange={(o) => !pending && setReviewOpen(o)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{reviewResult ? "Review result" : "Re-check review flags"}</DialogTitle>
            <DialogDescription>
              Each flagged question&apos;s import row is checked again with today&apos;s import rules. Only flags whose cause is gone can be cleared.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="mb-2 text-sm text-[var(--color-error)]">{error}</p> : null}
          {!checks && !error ? <p className="text-sm text-[var(--color-muted-foreground)]">Re-checking {selectedFlagged.length} questions…</p> : null}
          {reviewResult ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium text-[var(--color-foreground)]">
                Marked {reviewResult.markedCount} reviewed · {reviewResult.skipped.length} left flagged.
              </p>
              {reviewResult.skipped.length ? (
                <ul className="flex flex-col gap-1 text-xs text-[var(--color-muted-foreground)]">
                  {reviewResult.skipped.map((s) => (
                    <li key={s.id}>
                      <span className="font-mono">{s.code ?? s.id}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : checks ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-[var(--color-foreground)]">
                <strong>{resolvedCount} resolved</strong> · {checks.length - resolvedCount} still need review
              </p>
              <ul className="flex flex-col gap-2">
                {checks.map((c) => (
                  <li key={c.id} className="rounded-md border border-[var(--color-border)] p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[var(--color-foreground)]">{c.code}</span>
                      {c.number != null ? <span className="text-[var(--color-muted-foreground)]">No. {c.number}</span> : null}
                      <Badge variant={c.status === "RESOLVED" ? "success" : "warning"}>{c.status.replace(/_/g, " ")}</Badge>
                    </div>
                    <div className="mt-1 text-[var(--color-muted-foreground)]">Flagged for: {c.originalWarning}</div>
                    <div className="text-[var(--color-muted-foreground)]">Why: {c.rootCause}</div>
                    {c.correctedMapping.length ? <div className="text-[var(--color-muted-foreground)]">Now: {c.correctedMapping.join(" · ")}</div> : null}
                    {c.remaining.length ? <div className="text-[var(--color-warning)]">Still present: {c.remaining.join(" · ")}</div> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <DialogFooter>
            {reviewResult ? (
              <Button onClick={() => setReviewOpen(false)}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" disabled={pending} onClick={() => setReviewOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={pending || resolvedCount === 0} onClick={confirmReview}>
                  {pending && checks ? "Saving…" : `Mark ${resolvedCount} reviewed`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function batchTitle(b: PaperBatch) {
  return b.key === MANUAL_BATCH ? "Added without an import" : `Batch #${b.ordinal} — ${b.name}`;
}

function BatchCard({ batch: b, active, onSelect }: { batch: PaperBatch; active: boolean; onSelect: () => void }) {
  const c = b.counts;
  const isRun = b.key !== MANUAL_BATCH;
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border p-3 text-sm ${active ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"}`}
      aria-current={active ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--color-foreground)]">{isRun ? `Batch #${b.ordinal}` : "Manual"}</span>
        {b.label ? <Badge variant="primary">{b.label}</Badge> : null}
        <Badge variant={STATUS_VARIANT[b.status]}>{b.status}</Badge>
      </div>
      <div className="break-words text-xs text-[var(--color-muted-foreground)]">
        {b.name}
        {isRun ? ` · ${fmtDate(b.importedAt)}${b.importedBy ? ` · by ${b.importedBy}` : ""}` : ""}
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs sm:grid-cols-5">
        {isRun ? <Stat label="Rows" value={c.extracted} /> : null}
        <Stat label="Linked" value={c.linked} />
        <Stat label="Draft" value={c.draft} />
        <Stat label="Published" value={c.published} />
        <Stat label="Review" value={c.reviewRequired} warn={c.reviewRequired > 0} />
        {c.retired ? <Stat label="Retired" value={c.retired} /> : null}
        {c.archived ? <Stat label="Archived" value={c.archived} /> : null}
        {c.failed ? <Stat label="Failed rows" value={c.failed} warn /> : null}
        {c.rolledBack ? <Stat label="Rolled back" value={c.rolledBack} /> : null}
      </div>
      {b.failedRows.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-warning)]">Failed rows ({b.failedRows.length})</summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-[var(--color-muted-foreground)]">
            {b.failedRows.map((f) => (
              <li key={f.rowNumber}>
                Row {f.rowNumber}: {f.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {b.history.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-muted-foreground)]">History ({b.history.length})</summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-[var(--color-muted-foreground)]">
            {b.history.map((h, i) => (
              <li key={i}>
                {fmtDate(h.at)} · {h.action === "PUBLISH" ? `published ${h.count}` : `marked ${h.count} reviewed`}
                {h.blocked ? ` (${h.blocked} blocked)` : ""}
                {h.actor ? ` · ${h.actor}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {c.linked > 0 ? (
        <div>
          <Button size="compact" variant={active ? "secondary" : "outline"} onClick={onSelect}>
            {active ? "Showing its questions" : "Show its questions"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <div className="text-[var(--color-muted-foreground)]">{label}</div>
      <div className={`font-medium ${warn ? "text-[var(--color-warning)]" : "text-[var(--color-foreground)]"}`}>{value}</div>
    </div>
  );
}

function ItemList({ title, tone, items }: { title: string; tone: "success" | "error" | "neutral"; items: BatchPublishItem[] }) {
  if (!items.length) return null;
  const color = tone === "success" ? "var(--color-success)" : tone === "error" ? "var(--color-error)" : "var(--color-muted-foreground)";
  return (
    <details open={tone === "error"} className="rounded-md border border-[var(--color-border)] p-2">
      <summary className="cursor-pointer text-xs font-medium" style={{ color }}>
        {title} ({items.length})
      </summary>
      <ul className="mt-1 flex max-h-60 flex-col gap-0.5 overflow-y-auto text-xs text-[var(--color-muted-foreground)]">
        {items.map((it) => (
          <li key={it.id}>
            <span className="font-mono text-[var(--color-foreground)]">{it.code ?? it.id}</span>
            {it.number != null ? ` · No. ${it.number}` : ""}
            {it.reasons.length ? ` — ${it.reasons.map((r) => r.detail).join(" · ")}` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}
