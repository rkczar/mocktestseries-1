"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2, Pause, Play, RefreshCw, Send, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { TEMPLATES } from "@/lib/instagram/templates";
import { smartModules } from "@/lib/instagram/smart-layout";
import { DESIGN_MODE_LABELS, TEMPLATE_KEYS, modeOfTemplate } from "@/lib/instagram/types";
import type { BatchItemView, BatchView, BulkPreflightItem } from "@/lib/instagram/batch";
import type { PostDto } from "@/lib/instagram/posts";
import { InstagramStatusBadge } from "@/components/admin/instagram/status-badge";
import { OpenInEditor } from "@/components/admin/instagram/editor-host";
import { ProviderPicker, type ProviderChoice } from "@/components/admin/instagram/ai-studio-panel";
import { aiEditAction, saveDraftAction } from "@/app/admin/(dashboard)/instagram/actions";
import {
  advanceQueueAction,
  aiCaptionsAction,
  aiDiagramAction,
  aiTrapAction,
  applyDesignToBatchAction,
  bulkPreflightAction,
  checkQueueItemAction,
  confirmQueueAction,
  loadBatchAction,
  queueControlAction,
  retryQueueItemAction,
} from "@/app/admin/(dashboard)/instagram/studio-actions";

type Step = "content" | "diagram" | "trap" | "captions" | "layout";
const STEP_LABELS: Record<Step, string> = { content: "Carousel text + pearls + mistakes", diagram: "Medical diagram", trap: "Examiner trap", captions: "3 caption versions", layout: "Smart slide layout" };
const QUEUE_LABEL: Record<string, { label: string; variant: "neutral" | "info" | "success" | "error" | "warning" }> = {
  NONE: { label: "—", variant: "neutral" },
  QUEUED: { label: "Queued", variant: "info" },
  PUBLISHING: { label: "Publishing…", variant: "info" },
  DONE: { label: "Published", variant: "success" },
  FAILED: { label: "Failed (nothing published)", variant: "error" },
  UNCERTAIN: { label: "Unclear — check status", variant: "warning" },
  SKIPPED: { label: "Skipped", variant: "neutral" },
};

function itemSummary(p: PostDto | null) {
  if (!p) return { diagram: "—", trap: "—", caption: false, errors: 0, warnings: 0 };
  return {
    diagram: !p.content.diagram ? "none" : p.content.diagram.reviewed ? "reviewed" : "needs review",
    trap: !p.content.trap ? "none" : p.content.trap.status,
    caption: Boolean(p.content.caption.trim()),
    errors: p.issues.filter((i) => i.severity === "error").length,
    warnings: p.issues.filter((i) => i.severity === "warning").length,
  };
}

/** A draft that can go into the publishing queue: current, unpublished, no blocking issue, not already queued. */
function isCompleted(it: BatchItemView): boolean {
  const p = it.post;
  return Boolean(
    p && p.isCurrent && (p.status === "DRAFT" || p.status === "FAILED") && !p.issues.some((i) => i.severity === "error") && !["QUEUED", "PUBLISHING", "UNCERTAIN", "DONE"].includes(it.queueState)
  );
}

/**
 * One Bulk Studio batch: per-post design / generation status, bulk design
 * switches, sequential AI generation, and publishing: select completed drafts,
 * review them on one final screen, "Confirm & Publish Selected" once, then the
 * attended queue publishes them (advances only while this page is open).
 */
export function BulkBatch({ initial, publishingEnabled, connected, isMaster, spacingSeconds }: { initial: BatchView; publishingEnabled: boolean; connected: boolean; isMaster: boolean; spacingSeconds: number }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [provider, setProvider] = useState<ProviderChoice>("default");
  const [steps, setSteps] = useState<Record<Step, boolean>>({ content: true, diagram: true, trap: true, captions: true, layout: true });
  const [progress, setProgress] = useState<string | null>(null);
  const [queuePick, setQueuePick] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const running = useRef(false);

  // A server refresh (e.g. after the editor closes) brings a new `initial`: adopt it.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setView(initial);
  }

  const reload = useCallback(async () => {
    const r = await loadBatchAction(view.batch.id);
    if (r.ok) setView(r.data);
  }, [view.batch.id]);

  // Attended queue: advance while the page is open, visible and the queue is running.
  useEffect(() => {
    if (view.batch.status !== "QUEUE_RUNNING" || !isMaster) return;
    let stop = false;
    const tick = async () => {
      if (stop || document.visibilityState !== "visible") return;
      const r = await advanceQueueAction(view.batch.id);
      if (!stop && r.ok) setView(r.data);
      if (!r.ok) setMsg({ tone: "error", text: r.error });
    };
    const t = setInterval(tick, 5000);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [view.batch.status, view.batch.id, isMaster]);

  const editable = (p: PostDto | null) => Boolean(p && p.isCurrent && p.status === "DRAFT");

  /** Runs the chosen generation steps for one post, each saved as its own revision. */
  async function generateFor(item: BatchItemView): Promise<string | null> {
    let post = item.post;
    if (!post || !editable(post)) return `${item.post?.questionCode ?? item.postId}: skipped (only Draft posts are generated)`;
    const prov = provider === "default" ? null : provider;
    const base = () => ({ postId: post!.id, expectedRevision: post!.revision, content: post!.content, design: post!.design, provider: prov });
    const order: Step[] = ["content", "diagram", "trap", "captions", "layout"];
    for (const s of order) {
      if (!steps[s]) continue;
      setProgress(`${post.questionCode}: ${STEP_LABELS[s]}…`);
      if (s === "content") {
        const r = await aiEditAction({ ...base() });
        if (!r.ok) return `${post.questionCode}: ${r.error}`;
        post = r.data.post;
      } else if (s === "diagram") {
        const r = await aiDiagramAction({ ...base(), kind: "auto" });
        if (!r.ok) return `${post.questionCode}: diagram — ${r.error}`;
        post = r.data.post;
      } else if (s === "trap") {
        const r = await aiTrapAction({ ...base() });
        if (!r.ok) return `${post.questionCode}: trap — ${r.error}`;
        post = r.data.post;
      } else if (s === "captions") {
        const r = await aiCaptionsAction({ ...base() });
        if (!r.ok) return `${post.questionCode}: captions — ${r.error}`;
        post = r.data.post;
      } else {
        const modules = smartModules(post.content);
        if (JSON.stringify(modules) !== JSON.stringify(post.design.modules)) {
          const r = await saveDraftAction({ postId: post.id, expectedRevision: post.revision, content: post.content, design: { ...post.design, modules, slideCount: modules.length } });
          if (!r.ok) return `${post.questionCode}: layout — ${r.error}`;
          post = r.data;
        }
      }
    }
    return null;
  }

  const runGenerate = (items: BatchItemView[]) => {
    if (running.current) return;
    running.current = true;
    setMsg(null);
    start(async () => {
      const errors: string[] = [];
      for (const it of items) {
        const e = await generateFor(it);
        if (e) errors.push(e);
        await reload();
      }
      running.current = false;
      setProgress(null);
      setMsg(errors.length ? { tone: "error", text: `Finished with ${errors.length} problem(s): ${errors.join(" · ")}` } : { tone: "ok", text: "Generation finished. Preview each post; when they look right, select them and publish with one final confirmation." });
      router.refresh();
    });
  };

  const applyDesign = (target: string, postIds?: string[]) =>
    start(async () => {
      const r = await applyDesignToBatchAction({ batchId: view.batch.id, target, postIds });
      if (!r.ok) return setMsg({ tone: "error", text: r.error });
      setView(r.data.view);
      setMsg({ tone: "ok", text: `Design changed on ${r.data.changed} post(s).${r.data.skipped.length ? ` Skipped: ${r.data.skipped.join(", ")}` : ""}` });
    });

  const queueCtl = (action: "pause" | "resume" | "stop") =>
    start(async () => {
      const r = await queueControlAction({ batchId: view.batch.id, action });
      if (!r.ok) return setMsg({ tone: "error", text: r.error });
      setView(r.data);
    });

  const completed = view.items.filter(isCompleted);
  const openReview = (postIds: string[]) => {
    setQueuePick(postIds);
    setConfirmOpen(true);
  };
  const queueActive = view.batch.status === "QUEUE_RUNNING" || view.batch.status === "QUEUE_PAUSED";
  const counts = view.items.reduce((m, i) => ((m[i.post?.status ?? "?"] = (m[i.post?.status ?? "?"] ?? 0) + 1), m), {} as Record<string, number>);

  return (
    <div className="flex flex-col gap-4" data-testid="bulk-batch" data-status={view.batch.status}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{view.batch.name}</h2>
        <Badge variant="neutral">{`${view.items.length} separate posts`}</Badge>
        {Object.entries(counts).map(([k, v]) => (
          <Badge key={k} variant={k === "PUBLISHED" ? "success" : k === "FAILED" ? "error" : "neutral"}>{`${v} ${k.toLowerCase()}`}</Badge>
        ))}
      </div>

      {msg ? (
        <p role={msg.tone === "error" ? "alert" : "status"} data-testid="batch-message" className={cn("rounded-md px-3 py-2 text-sm", msg.tone === "error" ? "bg-[var(--color-error)]/10" : msg.tone === "ok" ? "bg-[var(--color-success)]/10" : "bg-[var(--color-warning)]/10")}>
          {msg.text}
        </p>
      ) : null}

      {/* Design for all */}
      <section className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
        <h3 className="text-sm font-semibold">Design</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => applyDesign("handwritten")} data-testid="apply-handwritten">
            Apply Handwritten to All
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => applyDesign("professional")} data-testid="apply-professional">
            Apply Professional to All
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => applyDesign("default")} data-testid="apply-default">
            Apply Default to All
          </Button>
        </div>
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Only the design changes — never the medical content. Individual overrides are in each row below.</p>
      </section>

      {/* Generation */}
      <section className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="bulk-generate">
        <h3 className="text-sm font-semibold">Generate with AI</h3>
        <ProviderPicker value={provider} onChange={setProvider} />
        <div className="flex flex-wrap gap-3 text-xs">
          {(Object.keys(STEP_LABELS) as Step[]).map((s) => (
            <label key={s} className="flex items-center gap-1.5">
              <input type="checkbox" checked={steps[s]} onChange={(e) => setSteps({ ...steps, [s]: e.target.checked })} /> {STEP_LABELS[s]}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={pending} onClick={() => runGenerate(view.items.filter((i) => editable(i.post)))} data-testid="generate-all">
            {pending && progress ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />} Generate for all Draft posts
          </Button>
          {progress ? <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="generate-progress">{progress}</span> : null}
        </div>
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Posts are generated one after another; each step is saved as a revision you can undo. Nothing is published until you confirm it on the final review screen.</p>
      </section>

      {/* Items */}
      <ul className="flex flex-col gap-2" data-testid="batch-items">
        {view.items.map((it) => {
          const p = it.post;
          const s = itemSummary(p);
          const q = QUEUE_LABEL[it.queueState];
          return (
            <li key={it.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2.5" data-item={p?.questionCode ?? it.postId} data-queue={it.queueState}>
              <div className="flex flex-wrap items-start gap-3">
                {p ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/admin/instagram/slide?postId=${p.id}&i=0&r=${p.revision}`} alt="" loading="lazy" className="h-20 w-16 shrink-0 rounded border border-[var(--color-border)] object-cover" />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-mono">{`${it.position}. ${p?.questionCode ?? "?"}`}</span>
                    {p ? <InstagramStatusBadge status={p.status} /> : <Badge variant="error">missing</Badge>}
                    {it.queueState !== "NONE" ? <Badge variant={q.variant}>{q.label}</Badge> : null}
                    {p ? <Badge variant="neutral">{`${DESIGN_MODE_LABELS[modeOfTemplate(p.design.template)].split(" ").pop()} · ${TEMPLATES[p.design.template].name} · ${p.design.modules.length} slides`}</Badge> : null}
                  </div>
                  {p ? <p className="mt-1 line-clamp-2 text-sm">{p.snapshot.text.replace(/<[^>]+>/g, " ")}</p> : null}
                  <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">
                    {`Diagram: ${s.diagram} · Trap: ${s.trap} · Caption: ${s.caption ? "yes" : "no"} · ${s.errors} blocking, ${s.warnings} to confirm`}
                  </p>
                  {it.lastError ? <p className="mt-1 text-xs text-[var(--color-error)]">{it.lastError}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {p ? (
                    <SelectNative
                      className="h-8 w-44 text-xs"
                      value={p.design.template}
                      disabled={pending || !["DRAFT", "FAILED"].includes(p.status)}
                      onChange={(e) => applyDesign(e.target.value, [p.id])}
                      aria-label={`Design for ${p.questionCode}`}
                    >
                      {TEMPLATE_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {`${DESIGN_MODE_LABELS[modeOfTemplate(k)].split(" ").pop()} · ${TEMPLATES[k].name}`}
                        </option>
                      ))}
                    </SelectNative>
                  ) : null}
                  {p ? (
                    <OpenInEditor target={{ questionId: p.questionId, code: p.questionCode, preview: p.snapshot.text.replace(/<[^>]+>/g, " ").slice(0, 160), series: p.series }} className="inline-flex h-8 items-center rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 text-xs" testId="open-editor">
                      Preview · Edit
                    </OpenInEditor>
                  ) : null}
                  {p && editable(p) ? (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => runGenerate([it])}>
                      <Sparkles className="h-4 w-4" aria-hidden /> Generate
                    </Button>
                  ) : null}
                  {isMaster && it.queueState === "FAILED" ? (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await retryQueueItemAction({ batchId: view.batch.id, itemId: it.id }); if (r.ok) setView(r.data); else setMsg({ tone: "error", text: r.error }); })} data-testid="retry-item">
                      Safe retry
                    </Button>
                  ) : null}
                  {isMaster && (it.queueState === "UNCERTAIN" || it.queueState === "PUBLISHING") ? (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await checkQueueItemAction({ batchId: view.batch.id, itemId: it.id }); if (r.ok) setView(r.data); else setMsg({ tone: "error", text: r.error }); })} data-testid="check-item">
                      <RefreshCw className="h-4 w-4" aria-hidden /> Check Instagram status
                    </Button>
                  ) : null}
                  {isMaster && !queueActive && p && isCompleted(it) ? (
                    <>
                      <label className="flex items-center gap-1 text-xs">
                        <input type="checkbox" checked={queuePick.includes(p.id)} onChange={(e) => setQueuePick((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} aria-label={`Select ${p.questionCode}`} data-testid="select-item" /> select
                      </label>
                      <Button size="sm" variant="success" disabled={pending || !publishingEnabled || !connected} onClick={() => openReview([p.id])} data-testid="item-publish">
                        <Send className="h-4 w-4" aria-hidden /> Publish to Instagram
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Publishing queue */}
      <section className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="queue">
        <h3 className="text-sm font-semibold">Publishing queue</h3>
        {!isMaster ? <p className="text-xs text-[var(--color-muted-foreground)]">Only a Master Admin can publish.</p> : null}
        {!publishingEnabled || !connected ? (
          <p className="text-xs text-[var(--color-warning)]" data-testid="queue-disabled">
            {!connected ? "Instagram is not connected on the server." : "Direct publishing is turned off (Instagram → Settings)."} Nothing can be queued until it is on.
          </p>
        ) : null}
        <p className="text-[11px] text-[var(--color-muted-foreground)]">
          {`Select completed drafts (no blocking issues), review them together, and confirm once. They are then published one at a time, at least ${spacingSeconds} s apart, only while this page stays open — nothing is published unattended. Editing a post after confirming removes it from the confirmation. Any failure pauses the queue; a post with an unclear result is never retried — use "Check Instagram status".`}
        </p>
        {queueActive ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={view.batch.status === "QUEUE_RUNNING" ? "success" : "warning"} data-testid="queue-status">{view.batch.status === "QUEUE_RUNNING" ? "Running" : "Paused"}</Badge>
            {view.batch.status === "QUEUE_RUNNING" ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => queueCtl("pause")} data-testid="queue-pause">
                <Pause className="h-4 w-4" aria-hidden /> Pause
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => queueCtl("resume")} data-testid="queue-resume">
                <Play className="h-4 w-4" aria-hidden /> Resume
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => queueCtl("stop")} data-testid="queue-stop">
              <Square className="h-4 w-4" aria-hidden /> Stop pending
            </Button>
            {view.nextAllowedAt && view.batch.status === "QUEUE_RUNNING" ? <span className="text-xs text-[var(--color-muted-foreground)]">{`Next post not before ${new Date(view.nextAllowedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST`}</span> : null}
          </div>
        ) : isMaster ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!completed.length} onClick={() => setQueuePick(completed.map((i) => i.postId))} data-testid="select-all-completed">
              Select all completed drafts ({completed.length})
            </Button>
            <Button size="sm" variant="success" disabled={!queuePick.length || !publishingEnabled || !connected} onClick={() => openReview(queuePick)} data-testid="queue-open-confirm">
              <Send className="h-4 w-4" aria-hidden /> {`Publish ${queuePick.length} selected to Instagram`}
            </Button>
          </div>
        ) : null}
      </section>

      {confirmOpen ? (
        <BulkConfirmDialog
          batchId={view.batch.id}
          postIds={queuePick}
          onClose={() => setConfirmOpen(false)}
          onConfirmed={(v) => {
            setView(v);
            setConfirmOpen(false);
            setQueuePick([]);
            setMsg({ tone: "info", text: "Confirmed. Publishing has started — keep this page open until the queue finishes." });
          }}
        />
      ) : null}
    </div>
  );
}


/**
 * The single final review for Bulk Studio: every selected post with its
 * slides, slide count, caption and warnings, then ONE "Confirm & Publish
 * Selected" that authorizes exactly these posts (at these revisions).
 */
function BulkConfirmDialog({ batchId, postIds, onClose, onConfirmed }: { batchId: string; postIds: string[]; onClose: () => void; onConfirmed: (v: BatchView) => void }) {
  const [items, setItems] = useState<BulkPreflightItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    let cancelled = false;
    bulkPreflightAction({ batchId, postIds }).then((r) => {
      if (cancelled) return;
      if (r.ok) setItems(r.data);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [batchId, postIds]);

  const problems = (items ?? []).filter((i) => i.error);
  const ready = Boolean(items && items.length && !problems.length);
  const username = items?.find((i) => i.pre)?.pre?.username ?? "mocktestseries.in";
  const totalWarnings = (items ?? []).reduce((n, i) => n + (i.pre?.warnings.length ?? 0), 0);

  async function confirm() {
    if (!items || sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(null);
    const r = await confirmQueueAction({
      batchId,
      confirmed: true,
      items: items.map((i) => ({ postId: i.postId, revision: i.revision, acknowledged: i.pre?.warnings.map((w) => w.code) ?? [] })),
    }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) {
      // Nothing was queued (the server confirms all or nothing); confirming again is safe.
      sent.current = false;
      return setError(r ? r.error : "No answer from the server. Check your connection and try again — nothing was queued twice.");
    }
    onConfirmed(r.data);
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <DialogPrimitive.Content
          className="fixed inset-x-2 top-4 bottom-4 z-50 mx-auto flex max-w-3xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] sm:inset-x-4"
          data-testid="queue-confirm"
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="border-b border-[var(--color-border)] px-4 py-3">
            <DialogPrimitive.Title className="text-base font-semibold">Publish to Instagram?</DialogPrimitive.Title>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
              <dt className="text-[var(--color-muted-foreground)]">Instagram account</dt>
              <dd className="font-semibold" data-testid="queue-username">{`@${username}`}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Destination</dt>
              <dd>Instagram feed — public carousel posts, one at a time while this page stays open</dd>
              <dt className="text-[var(--color-muted-foreground)]">Posts</dt>
              <dd data-testid="queue-count">{postIds.length}</dd>
            </dl>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!items && !error ? (
              <p className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking every selected post…
              </p>
            ) : null}
            <ol className="flex flex-col gap-3" data-testid="queue-review-list">
              {(items ?? []).map((it, n) => (
                <li key={it.postId} className={cn("rounded-md border p-3", it.error ? "border-[var(--color-error)]/50" : "border-[var(--color-border)]")} data-review-item={it.questionCode}>
                  <p className="text-sm font-semibold">{`${n + 1}. ${it.questionCode}${it.pre ? ` · ${it.pre.slideCount} slides` : ""}`}</p>
                  {it.error ? (
                    <p className="mt-1 text-sm text-[var(--color-error)]" role="alert">
                      {it.error}
                    </p>
                  ) : null}
                  {it.pre ? (
                    <>
                      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                        {Array.from({ length: it.pre.slideCount }, (_, i) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={i} src={`/api/admin/instagram/slide?postId=${it.postId}&i=${i}&r=${it.revision}`} alt={`Slide ${i + 1}`} loading="lazy" className="aspect-[4/5] h-28 w-auto shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] object-cover" />
                        ))}
                      </div>
                      <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--color-surface)] p-2 text-xs" data-testid="queue-caption">{it.pre.caption}</pre>
                      {it.pre.warnings.length ? (
                        <ul className="mt-2 list-disc pl-5 text-xs text-[var(--color-warning)]" data-testid="queue-warnings">
                          {it.pre.warnings.map((w) => (
                            <li key={w.code}>{w.message}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
            {problems.length ? <p className="mt-3 text-sm text-[var(--color-error)]">{`${problems.length} post(s) can't be published. Cancel, fix or deselect them, and try again.`}</p> : null}
            {ready ? (
              <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
                {`By confirming, you confirm that the question text, answer, attribution and all medical content of these ${items!.length} post(s) were checked${totalWarnings ? ", including every warning listed above" : ""}. This one confirmation covers only the posts listed here; editing one afterwards removes it from the confirmation.`}
              </p>
            ) : null}
            {error ? (
              <p className="mt-3 rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 p-2 text-sm" role="alert" data-testid="queue-confirm-error">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
            <Button variant="outline" onClick={onClose} disabled={busy} data-testid="queue-cancel">
              Cancel
            </Button>
            <Button variant="success" disabled={!ready || busy} onClick={confirm} data-testid="queue-confirm-button" className="font-semibold">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} Confirm &amp; Publish Selected
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
