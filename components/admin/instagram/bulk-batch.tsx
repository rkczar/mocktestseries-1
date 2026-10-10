"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2, Pause, Play, RefreshCw, Send, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { TEMPLATES } from "@/lib/instagram/templates";
import { smartModules } from "@/lib/instagram/smart-layout";
import { DESIGN_MODE_LABELS, TEMPLATE_KEYS, modeOfTemplate } from "@/lib/instagram/types";
import type { BatchItemView, BatchView } from "@/lib/instagram/batch";
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

/**
 * One Bulk Studio batch: per-post design / generation / review status, bulk
 * design switches, sequential AI generation, and the attended publishing
 * queue (advances only while this page is open and the queue is running).
 */
export function BulkBatch({ initial, publishingEnabled, connected, isMaster, spacingSeconds }: { initial: BatchView; publishingEnabled: boolean; connected: boolean; isMaster: boolean; spacingSeconds: number }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [provider, setProvider] = useState<ProviderChoice>("default");
  const [steps, setSteps] = useState<Record<Step, boolean>>({ content: true, diagram: true, trap: true, captions: true, layout: true });
  const [progress, setProgress] = useState<string | null>(null);
  const [includeReady, setIncludeReady] = useState(false);
  const [queuePick, setQueuePick] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
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
      setMsg(errors.length ? { tone: "error", text: `Finished with ${errors.length} problem(s): ${errors.join(" · ")}` } : { tone: "ok", text: "Generation finished. Review every post, approve diagrams and traps, then Mark Ready." });
      router.refresh();
    });
  };

  const applyDesign = (target: string, postIds?: string[]) =>
    start(async () => {
      const r = await applyDesignToBatchAction({ batchId: view.batch.id, target, postIds, includeReady });
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

  const ready = view.items.filter((i) => i.post?.status === "READY");
  const queueActive = view.batch.status === "QUEUE_RUNNING" || view.batch.status === "QUEUE_PAUSED";
  const counts = view.items.reduce((m, i) => ((m[i.post?.status ?? "?"] = (m[i.post?.status ?? "?"] ?? 0) + 1), m), {} as Record<string, number>);

  return (
    <div className="flex flex-col gap-4" data-testid="bulk-batch" data-status={view.batch.status}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{view.batch.name}</h2>
        <Badge variant="neutral">{`${view.items.length} separate posts`}</Badge>
        {Object.entries(counts).map(([k, v]) => (
          <Badge key={k} variant={k === "READY" ? "success" : k === "PUBLISHED" ? "primary" : "neutral"}>{`${v} ${k.toLowerCase()}`}</Badge>
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
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={includeReady} onChange={(e) => setIncludeReady(e.target.checked)} /> also change approved posts (they go back to Draft)
          </label>
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
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Posts are generated one after another; each step is saved as a revision you can undo. Every result still needs your review and approval.</p>
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
                      disabled={pending || !["DRAFT", "READY", "FAILED"].includes(p.status)}
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
                      Preview · Edit · Review
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
                  {isMaster && !queueActive && p?.status === "READY" ? (
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={queuePick.includes(p.id)} onChange={(e) => setQueuePick((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} aria-label={`Queue ${p.questionCode}`} /> queue
                    </label>
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
          {`The queue publishes approved posts one at a time, at least ${spacingSeconds} s apart, only while this page stays open — nothing is published unattended. Any failure pauses the queue. A post with an unclear result is never retried; use "Check Instagram status".`}
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
            <Button size="sm" variant="outline" disabled={!ready.length} onClick={() => setQueuePick(ready.map((i) => i.postId))}>
              Select all approved ({ready.length})
            </Button>
            <Button size="sm" variant="success" disabled={!queuePick.length || !publishingEnabled || !connected} onClick={() => (setTyped(""), setConfirmOpen(true))} data-testid="queue-open-confirm">
              <Send className="h-4 w-4" aria-hidden /> Publish {queuePick.length} selected…
            </Button>
          </div>
        ) : null}
      </section>

      <DialogPrimitive.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5" data-testid="queue-confirm" aria-describedby={undefined}>
            <DialogPrimitive.Title className="text-base font-semibold">Publish to Instagram?</DialogPrimitive.Title>
            <p className="mt-2 text-sm">{`${queuePick.length} approved post(s) will be published to the live @mocktestseries.in account, one at a time, while this page stays open:`}</p>
            <ol className="mt-2 max-h-48 list-decimal overflow-y-auto pl-5 text-sm">
              {view.items.filter((i) => queuePick.includes(i.postId)).map((i) => (
                <li key={i.id}>{`${i.post?.questionCode} · ${i.post?.design.modules.length} slides`}</li>
              ))}
            </ol>
            <label className="mt-3 flex flex-col gap-1 text-xs">
              Type PUBLISH to confirm
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="queue-typed" autoComplete="off" />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="success"
                disabled={pending || typed.trim().toUpperCase() !== "PUBLISH"}
                data-testid="queue-confirm-button"
                onClick={() =>
                  start(async () => {
                    const r = await confirmQueueAction({ batchId: view.batch.id, postIds: queuePick, confirmed: true, typed });
                    if (!r.ok) return setMsg({ tone: "error", text: r.error });
                    setView(r.data);
                    setConfirmOpen(false);
                    setQueuePick([]);
                    setMsg({ tone: "info", text: "Queue confirmed and running. Keep this page open." });
                  })
                }
              >
                Confirm &amp; start queue
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
