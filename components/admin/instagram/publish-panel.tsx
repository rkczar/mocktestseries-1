"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, Send, TriangleAlert, X } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getPublishingSwitchAction,
  publishPostAction,
  publishPreflightAction,
  publishStatusAction,
  reconcilePublishAction,
} from "@/app/admin/(dashboard)/instagram/actions";
import type { PostDto } from "@/lib/instagram/posts";
import type { PublishFormat, PublishStage, PublishView } from "@/lib/instagram/publish-view";
import type { PublishPreflight } from "@/lib/instagram/publish";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) + " IST";

const STAGE_TEXT: Record<PublishStage, string> = {
  PREPARING: "Checking the Instagram account…",
  MEDIA_READY: "Slide images prepared…",
  CONTAINERS: "Uploading slides to Instagram…",
  PROCESSING: "Instagram is processing the slides…",
  PUBLISH_REQUESTED: "Publishing…",
  PUBLISHED: "Published",
  FAILED: "Failed",
  UNKNOWN: "Waiting for confirmation from Instagram",
};

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-key`;
}

/**
 * Publish to Instagram — the publishing status of a post (in progress,
 * published, failed). The button and the single final confirmation are in
 * PublishButton. The server re-checks everything (role, quality gate, switch,
 * duplicates); these components only drive the flow.
 */
export function PublishPanel({ post, onPost }: { post: PostDto; onPost: (p: PostDto) => void }) {
  const [view, setView] = useState<PublishView>(post.publish);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const polling = useRef(false);

  // Adopt a newer server view whenever the post prop changes (render-time adjustment, no effect).
  const [seen, setSeen] = useState(post.publish);
  if (seen !== post.publish) {
    setSeen(post.publish);
    setView(post.publish);
  }

  // Poll while a job runs (also after reopening the editor or a page reload).
  useEffect(() => {
    if (view.status !== "PUBLISHING" || polling.current) return;
    polling.current = true;
    let stop = false;
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 2500));
        if (stop) break;
        const r = await publishStatusAction(post.id).catch(() => null);
        if (!r || !r.ok) continue;
        setView(r.data.view);
        if (r.data.view.status !== "PUBLISHING") {
          onPost(r.data.post);
          break;
        }
      }
      polling.current = false;
    };
    tick();
    return () => {
      stop = true;
      polling.current = false;
    };
  }, [view.status, post.id, onPost]);

  async function checkStatus() {
    setChecking(true);
    setError(null);
    const r = await reconcilePublishAction(post.id);
    setChecking(false);
    if (!r.ok) return setError(r.error);
    setView(r.data.view);
    onPost(r.data.post);
  }

  if (view.status === "DRAFT" && !error) return null;

  return (
    <section className="flex flex-col gap-2" data-testid="publish-panel" data-publish-status={view.status} data-publish-stage={view.stage ?? ""}>
      {view.status === "PUBLISHING" ? (
        <div className={cn("rounded-md border p-3 text-sm", view.needsReconcile ? "border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10" : "border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10")} role="status" data-testid="publishing-state">
          {view.needsReconcile ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 font-semibold">
                <TriangleAlert className="h-4 w-4" aria-hidden /> Publishing outcome not confirmed yet
              </p>
              <p>{view.publishError ?? "The publishing worker stopped before Instagram confirmed the result. Check the status before doing anything else — the post is not retried automatically."}</p>
              <div>
                <Button size="sm" variant="outline" onClick={checkStatus} disabled={checking} data-testid="check-status">
                  {checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Check status with Instagram
                </Button>
              </div>
            </div>
          ) : (
            <p className="flex items-center gap-2 font-semibold" data-testid="publishing-message">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Publishing to Instagram…{" "}
              <span className="font-normal text-[var(--color-muted-foreground)]">{view.stage ? STAGE_TEXT[view.stage] : ""}</span>
            </p>
          )}
        </div>
      ) : null}

      {view.status === "PUBLISHED" ? (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--color-success)]/50 bg-[var(--color-success)]/10 p-3 text-sm" data-testid="published-state">
          <p className="flex items-center gap-2 font-semibold text-[var(--color-success)]">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Successfully published to Instagram
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-[var(--color-muted-foreground)]">Instagram Media ID</dt>
            <dd className="font-mono" data-testid="published-media-id">{view.igMediaId ?? "—"}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Post URL</dt>
            <dd className="break-all" data-testid="published-permalink">{view.igPermalink ?? "—"}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Published</dt>
            <dd data-testid="published-at">{view.publishedAt ? fmt(view.publishedAt) : "—"}</dd>
          </dl>
          {view.publishError ? <p className="text-xs">{view.publishError}</p> : null}
          <div className="flex flex-wrap gap-2">
            {view.igPermalink ? (
              <a href={view.igPermalink} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] bg-[var(--color-success)] px-3 text-xs font-semibold text-white" data-testid="view-on-instagram">
                <ExternalLink className="h-4 w-4" aria-hidden /> View on Instagram
              </a>
            ) : (
              <Button size="sm" variant="outline" onClick={checkStatus} disabled={checking} data-testid="fetch-permalink">
                <RefreshCw className="h-4 w-4" aria-hidden /> Get Instagram link
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {view.status === "FAILED" ? (
        <div className="flex flex-col gap-1 rounded-md border border-[var(--color-error)]/50 bg-[var(--color-error)]/10 p-3 text-sm" role="alert" data-testid="failed-state">
          <p className="flex items-center gap-2 font-semibold text-[var(--color-error)]">
            <TriangleAlert className="h-4 w-4" aria-hidden /> Publishing failed — nothing was posted
          </p>
          <p data-testid="publish-error">{view.publishError ?? "Unknown error."}</p>
          <p className="text-xs text-[var(--color-muted-foreground)]">The draft is unchanged. Fix the cause, then publish again — it is safe because Instagram confirmed nothing went live.</p>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-[var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}

    </section>
  );
}

/**
 * The one "Publish to Instagram" button (Draft or Failed posts) and its single
 * final confirmation. There is no separate approval: the dialog shows what
 * will be posted plus any warnings, and "Confirm & Publish" starts it.
 */
export function PublishButton({
  post,
  dirty,
  onPost,
  open,
  setOpen,
  size,
}: {
  post: PostDto;
  dirty: boolean;
  onPost: (p: PostDto) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  size?: "sm";
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    getPublishingSwitchAction().then((r) => setEnabled(r.ok ? r.data.enabled : false));
  }, []);
  const publishable = post.isCurrent && (post.status === "DRAFT" || post.status === "FAILED");
  const blocking = post.issues.filter((i) => i.severity === "error").length;
  const canPublish = publishable && !dirty && blocking === 0 && enabled === true;
  // A request to open (e.g. "Publish to Instagram" on a Drafts row) for a post that can't be published
  // is dropped, so the dialog never pops up later on its own; the reason stays visible next to the button.
  useEffect(() => {
    if (open && enabled !== null && !canPublish) setOpen(false);
  }, [open, enabled, canPublish, setOpen]);
  if (!publishable) return null;

  const reason = dirty
    ? "Save your changes first."
    : blocking
      ? `Fix ${blocking} blocking issue(s) first (Checks tab).`
      : enabled === false
        ? "Direct publishing is turned off in Admin → Instagram → Settings."
        : null;

  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        {reason ? <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="publish-blocked-reason">{reason}</span> : null}
        <Button variant="success" size={size} disabled={!canPublish} onClick={() => setOpen(true)} data-testid="publish-open" className="font-semibold">
          <Send className="h-4 w-4" aria-hidden /> {post.status === "FAILED" ? "Retry: Publish to Instagram" : "Publish to Instagram"}
        </Button>
      </span>
      {open && canPublish ? (
        <ConfirmPublishDialog
          post={post}
          onClose={() => setOpen(false)}
          onStarted={() => {
            setOpen(false);
            // Lock the editor at once (the post is PUBLISHING now); the status panel then polls.
            publishStatusAction(post.id).then((r) => r.ok && onPost(r.data.post));
          }}
        />
      ) : null}
    </>
  );
}

function ConfirmPublishDialog({ post, onClose, onStarted }: { post: PostDto; onClose: () => void; onStarted: (v: PublishView) => void }) {
  const [format, setFormat] = useState<PublishFormat>(post.design.modules.length >= 2 ? "CAROUSEL" : "IMAGE");
  type Pre = PublishPreflight & { enabled: boolean; configured: boolean };
  const [checked, setChecked] = useState<{ format: PublishFormat; pre: Pre | null; error: string | null } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const pre = checked?.format === format ? checked.pre : null;
  const error = sendError ?? (checked?.format === format ? checked.error : null);
  const [busy, setBusy] = useState(false);
  // One key per dialog: a repeated click/retry of the same confirmation can never start a second job.
  const key = useRef(newKey());
  const sent = useRef(false);

  useEffect(() => {
    let cancelled = false;
    publishPreflightAction(post.id, post.revision, format).then((r) => {
      if (cancelled) return;
      setChecked(r.ok ? { format, pre: r.data, error: null } : { format, pre: null, error: r.error });
    });
    return () => {
      cancelled = true;
    };
  }, [post.id, post.revision, format]);

  async function confirm() {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    setSendError(null);
    // The warnings this dialog showed are what the confirmation acknowledges (the server re-checks them).
    const acknowledged = pre ? pre.warnings.map((w) => w.code) : [];
    const r = await publishPostAction({ postId: post.id, expectedRevision: post.revision, requestKey: key.current, format, confirmed: true, acknowledged }).catch(() => null);
    if (!r) {
      // Network trouble: the same key is safe to send again; the server returns the running job if it got the first one.
      sent.current = false;
      setBusy(false);
      setSendError("No answer from the server. Check your connection and press Confirm again — it will not publish twice.");
      return;
    }
    if (!r.ok) {
      setBusy(false);
      setSendError(r.error);
      return;
    }
    onStarted(r.data.view);
  }

  const slides = format === "IMAGE" ? 1 : post.design.modules.length;
  const ready = pre && pre.enabled && pre.configured && !error;

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/70" />
        <DialogPrimitive.Content
          data-testid="publish-confirm"
          aria-describedby={undefined}
          className="fixed inset-x-2 top-4 bottom-4 z-[60] mx-auto flex max-w-2xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] sm:inset-x-4"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <DialogPrimitive.Title className="text-base font-semibold">Publish to Instagram?</DialogPrimitive.Title>
            <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="p-1 text-[var(--color-muted-foreground)]">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-[var(--color-muted-foreground)]">Instagram account</dt>
              <dd className="font-semibold" data-testid="confirm-username">@{pre?.username ?? "…"}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Destination</dt>
              <dd data-testid="confirm-destination">{`Instagram feed — public ${format === "IMAGE" ? "single-image post" : "carousel post"}, live immediately`}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Question</dt>
              <dd className="font-mono text-xs">{`${post.questionCode} · v${post.version} · revision ${post.revision}`}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Number of slides</dt>
              <dd data-testid="confirm-slide-count">{slides}</dd>
            </dl>
            <fieldset className="mt-3 flex flex-wrap gap-4" disabled={busy}>
              <label className="flex items-center gap-2">
                <input type="radio" name="format" checked={format === "CAROUSEL"} onChange={() => setFormat("CAROUSEL")} data-testid="format-carousel" />
                Carousel ({post.design.modules.length} slides)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="format" checked={format === "IMAGE"} onChange={() => setFormat("IMAGE")} data-testid="format-image" />
                Single image (slide 1 only)
              </label>
            </fieldset>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-2" data-testid="confirm-preview">
              {Array.from({ length: slides }, (_, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={`${format}-${i}`} src={`/api/admin/instagram/slide?postId=${post.id}&i=${i}&r=${post.revision}`} alt={`Slide ${i + 1}`} className="aspect-[4/5] h-44 w-auto shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] object-cover" loading="lazy" />
              ))}
            </div>
            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Caption</h3>
            <pre className="mt-1 whitespace-pre-wrap rounded-md bg-[var(--color-surface)] p-3 text-xs" data-testid="confirm-caption">{post.content.caption || "(no caption)"}</pre>
            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Hashtags</h3>
            <p className="mt-1 text-xs" data-testid="confirm-hashtags">{post.content.hashtags.join(" ") || "(none)"}</p>
            {pre ? <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">{`Caption with hashtags: ${pre.caption.length} / 2200 characters.`}</p> : null}
            {pre && pre.warnings.length ? (
              <section className="mt-3 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3" data-testid="confirm-warnings">
                <h3 className="text-xs font-semibold uppercase tracking-wide">{`Check before publishing (${pre.warnings.length})`}</h3>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {pre.warnings.map((w) => (
                    <li key={w.code} data-code={w.code}>
                      {w.message}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {pre ? (
              <section className="mt-3 text-xs" data-testid="confirm-covers">
                <p className="font-semibold">By confirming, you confirm that:</p>
                <ul className="mt-1 list-disc pl-5 text-[var(--color-muted-foreground)]">
                  {pre.checklist.map((c) => (
                    <li key={c.key}>{c.label}</li>
                  ))}
                  {pre.warnings.length ? <li>You checked every warning listed above.</li> : null}
                </ul>
              </section>
            ) : null}
            {pre && !pre.enabled ? <p className="mt-3 text-sm text-[var(--color-error)]">Direct publishing is turned off in Settings.</p> : null}
            {pre && !pre.configured ? <p className="mt-3 text-sm text-[var(--color-error)]">No Instagram token is installed on the server.</p> : null}
            {error ? (
              <p className="mt-3 rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 p-2 text-sm" role="alert" data-testid="confirm-error">
                {error}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">This posts publicly to Instagram right away. It can&apos;t be undone from here.</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
            <Button variant="outline" onClick={onClose} disabled={busy} data-testid="publish-cancel">
              Cancel
            </Button>
            <Button variant="success" onClick={confirm} disabled={!ready || busy} data-testid="publish-confirm-button" className="font-semibold">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} Confirm &amp; Publish
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
