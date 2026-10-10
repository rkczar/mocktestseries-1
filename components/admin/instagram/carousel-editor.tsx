"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Download, History, Loader2, RotateCcw, Save, Send, Sparkles, Undo2, X } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { InstagramStatusBadge } from "@/components/admin/instagram/status-badge";
import { PublishPanel } from "@/components/admin/instagram/publish-panel";
import {
  aiEditAction,
  backToDraftAction,
  createMostMissedDraftAction,
  createNewVersionAction,
  createPyqDraftAction,
  deleteDraftAction,
  loadQuestionPostAction,
  markReadyAction,
  prefillFromExplanationAction,
  refreshSnapshotAction,
  restoreRevisionAction,
  saveDraftAction,
  setQuestionNumberAction,
  undoAction,
  type Result,
} from "@/app/admin/(dashboard)/instagram/actions";
import type { PostDto, QuestionPostState } from "@/lib/instagram/posts";
import { REVIEW_CHECKLIST } from "@/lib/instagram/quality";
import {
  CONTENT_FIELD_LABELS,
  DEFAULT_LAYOUTS,
  HOOK_STYLE_LABELS,
  LIMITS,
  MODULE_LABELS,
  SLIDE_COUNTS,
  SLIDE_MODULES,
  TEMPLATE_KEYS,
  composeCaption,
  validateModules,
  type PostContent,
  type PostDesign,
  type SlideCount,
  type SlideModule,
  type TemplateKey,
} from "@/lib/instagram/types";

const TEMPLATE_NAMES: Record<TemplateKey, string> = {
  midnight: "Midnight Medical (website)",
  academic: "Clean Academic",
  clinical: "Clinical Green",
  premium: "Premium Dark",
};

export interface EditorTarget {
  questionId: string;
  code: string;
  preview: string;
  /** Which series a NEW draft belongs to. */
  series: "PYQ" | "MOST_MISSED";
  /** Most Missed: the list's query string — the server recomputes the numbers from it. */
  filterQuery?: string;
}

type Tab = "content" | "design" | "ai" | "review" | "history";

interface Draft {
  content: PostContent;
  design: PostDesign;
  hashtagsText: string;
  revisionText: string;
}

function toDraft(p: PostDto): Draft {
  return { content: p.content, design: p.design, hashtagsText: p.content.hashtags.join(" "), revisionText: p.content.quickRevision.join("\n") };
}

function draftPayload(d: Draft): { content: PostContent; design: PostDesign } {
  return {
    content: {
      ...d.content,
      hashtags: d.hashtagsText.split(/[\s,]+/).filter(Boolean),
      quickRevision: d.revisionText.split("\n").map((x) => x.trim()).filter(Boolean),
    },
    design: d.design,
  };
}

function sameDraft(a: Draft, p: PostDto): boolean {
  const x = draftPayload(a);
  const norm = (c: PostContent) => JSON.stringify({ ...c, hashtags: c.hashtags.map((h) => h.replace(/^#/, "").toLowerCase()), origin: null, aiFlags: null });
  return norm(x.content) === norm(p.content) && JSON.stringify(x.design) === JSON.stringify(p.design);
}

const fmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function Counter({ value, max }: { value: number; max: number }) {
  return <span className={cn("text-[11px] tabular-nums", value > max ? "text-[var(--color-error)]" : "text-[var(--color-muted-foreground)]")}>{`${value}/${max}`}</span>;
}

function Field({ label, children, count }: { label: string; children: React.ReactNode; count?: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-xs font-medium text-[var(--color-muted-foreground)]">
        {label}
        {count}
      </span>
      {children}
    </label>
  );
}

/**
 * Admin → Instagram → Carousel Preview. Opens for one question: loads (or
 * creates) its current post, previews slides rendered by the server from
 * the unsaved editor state, and edits content/design locally until Save
 * Draft. AI edits, Undo and Restore are server-side revisions. The original
 * question and answer key are shown read-only and can never be edited here.
 */
export function CarouselEditor({ target, onClose }: { target: EditorTarget | null; onClose: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<QuestionPostState | null>(null);
  const [post, setPost] = useState<PostDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [slide, setSlide] = useState(0);
  const [tab, setTab] = useState<Tab>("content");
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState<null | ((confirm: boolean) => void)>(null);
  const [pending, startTransition] = useTransition();
  const [loading, setLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Which slide index the shown preview image is (it can lag behind `slide` while rendering). */
  const [previewSlide, setPreviewSlide] = useState<number | null>(null);
  const lastRendered = useRef<{ post: PostDto | null; draft: Draft | null }>({ post: null, draft: null });
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [acks, setAcks] = useState<string[]>([]);
  const [qNumber, setQNumber] = useState("");
  const [qVerified, setQVerified] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmNewVersion, setConfirmNewVersion] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const changed = useRef(false);

  const adopt = useCallback((p: PostDto) => {
    setPost(p);
    setDraft(toDraft(p));
    setQNumber(p.questionNumber ? String(p.questionNumber) : "");
    setQVerified(p.questionNumberVerified);
    setSlide((s) => Math.min(s, p.design.modules.length - 1));
  }, []);

  /** A post update coming from the publishing flow (also refreshes this question's version list). */
  const adoptPublished = useCallback(
    (p: PostDto) => {
      adopt(p);
      changed.current = true;
      setState((s) =>
        s
          ? {
              ...s,
              current: p,
              posted: s.posted || p.status === "PUBLISHED",
              history: s.history.map((h) => (h.id === p.id ? { ...h, status: p.status, publishedAt: p.publishedAt, igPermalink: p.igPermalink } : h)),
            }
          : s
      );
    },
    [adopt]
  );

  // Load when opened. The host remounts this component per question (key), so state starts fresh.
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    loadQuestionPostAction(target.questionId).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok) return setMessage({ tone: "error", text: r.error });
      setState(r.data);
      if (r.data.current) adopt(r.data.current);
    });
    return () => {
      cancelled = true;
    };
  }, [target, adopt]);

  const dirty = Boolean(post && draft && !sameDraft(draft, post));
  const editable = Boolean(post && post.isCurrent && (post.status === "DRAFT" || post.status === "READY" || post.status === "FAILED"));
  const moduleError = draft ? validateModules(draft.design.modules) : null;

  // Server-rendered preview of the current slide (debounced).
  useEffect(() => {
    if (!post || !draft || moduleError) return;
    const ctrl = new AbortController();
    // Switching slides renders at once; typing is debounced.
    const contentChanged = lastRendered.current.post !== post || lastRendered.current.draft !== draft;
    const t = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const res = await fetch("/api/admin/instagram/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId: post.id, index: slide, ...draftPayload(draft) }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({ error: "Preview failed." }));
          setPreviewError(j.error ?? "Preview failed.");
          return;
        }
        const blob = await res.blob();
        lastRendered.current = { post, draft };
        setPreviewError(null);
        setPreviewSlide(slide);
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPreviewError("Preview failed.");
      } finally {
        if (!ctrl.signal.aborted) setPreviewBusy(false);
      }
    }, contentChanged ? 450 : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [post, draft, slide, moduleError]);

  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  function close() {
    if (dirty && !window.confirm("You have unsaved changes. Close without saving?")) return;
    if (changed.current) router.refresh();
    onClose();
  }

  /** Runs a post-changing action; on a Ready post asks before sending it back to Draft. */
  function act<T>(call: (confirm: boolean) => Promise<Result<T>>, onOk: (data: T) => void, confirm = false) {
    setMessage(null);
    startTransition(async () => {
      const r = await call(confirm);
      if (!r.ok) {
        if (r.kind === "needs-confirm") {
          setNeedsConfirm(() => (c: boolean) => {
            setNeedsConfirm(null);
            if (c) act(call, onOk, true);
          });
          setMessage({ tone: "info", text: r.error });
          return;
        }
        setMessage({ tone: "error", text: r.error });
        return;
      }
      changed.current = true;
      onOk(r.data);
    });
  }

  function patchContent(p: Partial<PostContent>) {
    setDraft((d) => (d ? { ...d, content: { ...d.content, ...p } } : d));
  }
  function patchDesign(p: Partial<PostDesign>) {
    setDraft((d) => (d ? { ...d, design: { ...d.design, ...p } } : d));
  }
  function setSlideCount(n: SlideCount) {
    patchDesign({ slideCount: n, modules: [...DEFAULT_LAYOUTS[n]] });
    setSlide((s) => Math.min(s, n - 1));
  }
  function setModuleAt(i: number, m: SlideModule) {
    if (!draft) return;
    const modules = [...draft.design.modules];
    modules[i] = m;
    patchDesign({ modules });
  }

  const save = () =>
    post &&
    draft &&
    act(
      (confirm) => saveDraftAction({ postId: post.id, expectedRevision: post.revision, ...draftPayload(draft), confirmReplaceApproved: confirm }),
      (p) => {
        adopt(p);
        setMessage({ tone: "ok", text: `Saved (revision ${p.revision}).` });
      }
    );

  const runAi = (opts: { instruction?: string; fields?: string[]; selected?: boolean }) =>
    post &&
    draft &&
    act(
      (confirm) =>
        aiEditAction({
          postId: post.id,
          expectedRevision: post.revision,
          ...draftPayload(draft),
          instruction: opts.instruction,
          fields: opts.fields,
          selectedModule: opts.selected ? draft.design.modules[slide] : null,
          confirmReplaceApproved: confirm,
        }),
      (r) => {
        adopt(r.post);
        setMessage({ tone: r.rejected.length ? "info" : "ok", text: r.summary });
        if (opts.instruction) setInstruction("");
      }
    );

  const issues = post?.issues ?? [];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const checklistDone = REVIEW_CHECKLIST.every((c) => checklist[c.key]);
  const acksDone = warnings.every((w) => acks.includes(w.code));
  const canMarkReady = Boolean(post && editable && post.status !== "READY" && !dirty && errors.length === 0 && checklistDone && acksDone);

  const modules = draft?.design.modules ?? [];
  const snapshot = post?.snapshot;
  const showCreate = Boolean(state && !state.current);
  const publishedCurrent = post?.status === "PUBLISHED";

  const tabs = useMemo(
    () =>
      [
        { key: "content", label: "Edit Text" },
        { key: "design", label: "Design" },
        { key: "ai", label: "AI Assistant" },
        { key: "review", label: `Review${errors.length ? ` (${errors.length})` : ""}` },
        { key: "history", label: "History" },
      ] as { key: Tab; label: string }[],
    [errors.length]
  );

  return (
    <DialogPrimitive.Root open={Boolean(target)} onOpenChange={(o) => (!o ? close() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          data-testid="carousel-editor"
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--color-card)] sm:inset-4 sm:rounded-[var(--radius-card)] sm:border sm:border-[var(--color-border)] lg:inset-8"
          onEscapeKeyDown={(e) => {
            if (dirty) {
              e.preventDefault();
              close();
            }
          }}
          onInteractOutside={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-base font-semibold text-[var(--color-foreground)]">
                Carousel Preview · <span className="font-mono text-sm">{target?.code}</span>
              </DialogPrimitive.Title>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                {post ? <InstagramStatusBadge status={post.status} posted={state?.posted} /> : state ? <InstagramStatusBadge status="NOT_CREATED" /> : null}
                {post ? <span>{`${post.series === "PYQ" ? "PYQ Series" : "Most Missed MCQ"} · v${post.version} · revision ${post.revision}`}</span> : null}
                {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
              </div>
            </div>
            <button type="button" onClick={close} aria-label="Close" className="rounded-sm p-1 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>

          {message ? (
            <div
              role={message.tone === "error" ? "alert" : "status"}
              data-testid="editor-message"
              className={cn(
                "flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm",
                message.tone === "error" && "border-[var(--color-error)]/40 bg-[var(--color-error)]/10",
                message.tone === "ok" && "border-[var(--color-success)]/40 bg-[var(--color-success)]/10",
                message.tone === "info" && "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10"
              )}
            >
              <span className="flex-1">{message.text}</span>
              {needsConfirm ? (
                <span className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => needsConfirm(true)} data-testid="confirm-back-to-draft">
                    Continue — send back to Draft
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => needsConfirm(false)}>
                    Cancel
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading || (!state && !message) ? (
              <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--color-muted-foreground)]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
              </div>
            ) : null}

            {/* No post yet */}
            {showCreate && target ? (
              <div className="mx-auto flex max-w-xl flex-col gap-4 p-6" data-testid="create-draft-panel">
                <p className="text-sm text-[var(--color-muted-foreground)]">No Instagram post exists for this question yet.</p>
                <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-sm">{target.preview}</p>
                {state && state.history.length ? <p className="text-xs text-[var(--color-muted-foreground)]">{`${state.history.length} earlier version(s) exist.`}</p> : null}
                <Button
                  data-testid="create-draft"
                  disabled={pending}
                  onClick={() =>
                    act(
                      () => (target.series === "MOST_MISSED" ? createMostMissedDraftAction(target.questionId, target.filterQuery ?? "") : createPyqDraftAction(target.questionId)),
                      (r) => {
                        setState((s) => (s ? { ...s, current: r.post } : s));
                        adopt(r.post);
                        setMessage({ tone: r.existed ? "info" : "ok", text: r.existed ? "A post already existed for this question — opened it instead of creating a duplicate." : "Draft created. The question is frozen as a snapshot; generate or write the content next." });
                      }
                    )
                  }
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Create {target.series === "MOST_MISSED" ? "Most Missed" : "PYQ"} Draft
                </Button>
              </div>
            ) : null}

            {post && draft && snapshot ? (
              <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
                {/* Preview column */}
                <div className="flex flex-col gap-3">
                  <div className="relative mx-auto w-full max-w-[440px]">
                    <div
                      className="relative aspect-[4/5] w-full overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-black"
                      data-testid="preview-frame"
                      data-busy={previewBusy || previewSlide !== slide ? "true" : "false"}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {previewUrl ? <img
                          src={previewUrl}
                          alt={previewSlide !== null && modules[previewSlide] ? `Slide ${previewSlide + 1}: ${MODULE_LABELS[modules[previewSlide]]}` : "Slide preview"}
                          data-testid="slide-preview"
                          data-slide={previewSlide ?? ""}
                          className={cn("h-full w-full object-contain transition-opacity", previewSlide !== slide && "opacity-60")}
                        /> : null}
                      {previewBusy ? (
                        <div className="absolute right-2 top-2 rounded-full bg-black/70 p-1.5">
                          <Loader2 className="h-4 w-4 animate-spin text-white" aria-hidden />
                        </div>
                      ) : null}
                      {previewError || moduleError ? (
                        <div className="absolute inset-x-2 bottom-2 rounded-md bg-black/80 px-3 py-2 text-xs text-white" role="alert">
                          {moduleError ?? previewError}
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <Button size="icon" variant="outline" aria-label="Previous slide" disabled={slide === 0} onClick={() => setSlide((s) => Math.max(0, s - 1))}>
                        <ChevronLeft className="h-4 w-4" aria-hidden />
                      </Button>
                      <span className="text-sm tabular-nums" data-testid="slide-counter">{`${slide + 1} / ${modules.length}`}</span>
                      <Button size="icon" variant="outline" aria-label="Next slide" disabled={slide >= modules.length - 1} onClick={() => setSlide((s) => Math.min(modules.length - 1, s + 1))}>
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-center gap-1.5" role="tablist" aria-label="Slides">
                    {modules.map((m, i) => (
                      <button
                        key={`${m}-${i}`}
                        type="button"
                        role="tab"
                        aria-selected={i === slide}
                        onClick={() => setSlide(i)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs",
                          i === slide ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted-foreground)]",
                          errors.some((e) => e.slide === i) && "border-[var(--color-error)] text-[var(--color-error)]"
                        )}
                      >
                        {`${i + 1}. ${MODULE_LABELS[m]}`}
                      </button>
                    ))}
                  </div>
                  {/* Original question (read-only) */}
                  <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm" open>
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Original question (read-only snapshot)</summary>
                    <div className="mt-2 flex flex-col gap-2" data-testid="snapshot">
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        {`${snapshot.examName}${snapshot.paperYear ? ` · ${snapshot.paperYear}` : ""}${snapshot.paperTitle ? ` · ${snapshot.paperTitle}` : ""} · ${snapshot.subjectName}${snapshot.topicName ? ` / ${snapshot.topicName}` : ""}`}
                        {snapshot.importPosition ? ` · stored position ${snapshot.importPosition} (not the printed number)` : ""}
                      </p>
                      <p>{snapshot.text.replace(/<[^>]+>/g, " ")}</p>
                      <ul className="flex flex-col gap-1">
                        {snapshot.options.map((o) => (
                          <li key={o.label} className={cn(o.isCorrect && "font-semibold text-[var(--color-success)]")}>
                            {`${o.label}. ${o.text.replace(/<[^>]+>/g, " ")}${o.isCorrect ? "  ✓" : ""}`}
                          </li>
                        ))}
                      </ul>
                      {post.seriesStats ? (
                        <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="series-stats">
                          {`Most Missed numbers (captured ${fmt(post.seriesStats.capturedAt)}): ${post.seriesStats.wrong} wrong of ${post.seriesStats.attempts} answers (${post.seriesStats.wrongPct.toFixed(1)}%) · ${post.seriesStats.rangeLabel}`}
                        </p>
                      ) : null}
                      {post.sourceChanged ? (
                        <div className="rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 p-2 text-xs">
                          The question changed in the Question Bank after this snapshot.{" "}
                          {editable ? (
                            <button type="button" className="underline" onClick={() => act(() => refreshSnapshotAction(post.id, post.revision), (p) => (adopt(p), setMessage({ tone: "ok", text: "Snapshot refreshed. Review again before marking Ready." })))}>
                              Refresh snapshot
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </details>
                </div>

                {/* Edit column */}
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-wrap gap-1 border-b border-[var(--color-border)]" role="tablist" aria-label="Editor sections">
                    {tabs.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.key}
                        data-testid={`tab-${t.key}`}
                        onClick={() => setTab(t.key)}
                        className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t.key ? "border-[var(--color-primary)] text-[var(--color-foreground)]" : "border-transparent text-[var(--color-muted-foreground)]")}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>

                  {post.isCurrent && post.status !== "DRAFT" ? <PublishPanel post={post} dirty={dirty} onPost={adoptPublished} open={publishOpen} setOpen={setPublishOpen} /> : null}

                  {!editable ? (
                    <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid="readonly-note">
                      {publishedCurrent
                        ? "This post is published and can't be edited. Use Create New Version (History tab) for a new post of this question."
                        : post.status === "PUBLISHING"
                          ? "Publishing is in progress — editing is locked until Instagram confirms the result."
                          : "This version is read-only."}
                    </p>
                  ) : null}

                  {tab === "content" ? (
                    <fieldset disabled={!editable || pending} className="flex flex-col gap-4">
                      {draft.content.hooks.length ? (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Hook options (AI)</span>
                          {draft.content.hooks.map((h) => (
                            <label key={h.style} className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-2 text-sm">
                              <input type="radio" name="hook" checked={draft.content.hookText === h.text} onChange={() => patchContent({ hookText: h.text })} className="mt-1" />
                              <span>
                                <span className="block text-[11px] uppercase tracking-wide text-[var(--color-muted-foreground)]">{HOOK_STYLE_LABELS[h.style]}</span>
                                {h.text}
                              </span>
                            </label>
                          ))}
                        </div>
                      ) : null}
                      <Field label="Hook (shown on the Hook slide)" count={<Counter value={draft.content.hookText.length} max={LIMITS.hook} />}>
                        <Input value={draft.content.hookText} onChange={(e) => patchContent({ hookText: e.target.value })} data-testid="field-hook" />
                      </Field>
                      <Field label="Explanation" count={<Counter value={draft.content.explanation.length} max={LIMITS.explanation} />}>
                        <Textarea rows={4} value={draft.content.explanation} onChange={(e) => patchContent({ explanation: e.target.value })} data-testid="field-explanation" />
                      </Field>
                      <Field label="Memory Trick" count={<Counter value={draft.content.memoryTrick.length} max={LIMITS.memoryTrick} />}>
                        <Textarea rows={2} value={draft.content.memoryTrick} onChange={(e) => patchContent({ memoryTrick: e.target.value })} data-testid="field-trick" />
                      </Field>
                      <Field label="Clinical Pearl" count={<Counter value={draft.content.clinicalPearl.length} max={LIMITS.clinicalPearl} />}>
                        <Textarea rows={2} value={draft.content.clinicalPearl} onChange={(e) => patchContent({ clinicalPearl: e.target.value })} />
                      </Field>
                      <Field label={`Quick Revision (one point per line, max ${LIMITS.quickRevisionItems})`}>
                        <Textarea rows={3} value={draft.revisionText} onChange={(e) => setDraft({ ...draft, revisionText: e.target.value })} />
                      </Field>
                      <div className="flex flex-col gap-1.5">
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={draft.content.showFinalTrick} onChange={(e) => patchContent({ showFinalTrick: e.target.checked })} />
                          Show a final memory line on the Follow slide
                        </label>
                        {draft.content.showFinalTrick ? (
                          <Input value={draft.content.finalTrick} onChange={(e) => patchContent({ finalTrick: e.target.value })} placeholder="e.g. Absence = Ethosuximide" />
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-[var(--color-muted-foreground)]">Caption and hashtags are posted exactly as written below.</span>
                        <Button type="button" size="sm" variant="outline" onClick={() => runAi({ fields: ["caption", "hashtags"] })} data-testid="ai-caption">
                          <Sparkles className="h-4 w-4" aria-hidden /> Generate with AI
                        </Button>
                      </div>
                      <Field label="Instagram caption" count={<Counter value={draft.content.caption.length} max={LIMITS.caption} />}>
                        <Textarea rows={5} value={draft.content.caption} onChange={(e) => patchContent({ caption: e.target.value })} data-testid="field-caption" />
                      </Field>
                      <Field label={`Hashtags (max ${LIMITS.hashtags})`}>
                        <Input value={draft.hashtagsText} onChange={(e) => setDraft({ ...draft, hashtagsText: e.target.value })} />
                      </Field>
                      <details className="text-sm">
                        <summary className="cursor-pointer text-xs text-[var(--color-muted-foreground)]">Caption as it would be posted</summary>
                        <pre className="mt-2 whitespace-pre-wrap rounded-md bg-[var(--color-surface)] p-3 text-xs">{composeCaption(draftPayload(draft).content)}</pre>
                      </details>
                    </fieldset>
                  ) : null}

                  {tab === "design" ? (
                    <fieldset disabled={!editable || pending} className="flex flex-col gap-4">
                      <Field label="Template">
                        <SelectNative value={draft.design.template} onChange={(e) => patchDesign({ template: e.target.value as TemplateKey })} data-testid="design-template">
                          {TEMPLATE_KEYS.map((k) => (
                            <option key={k} value={k}>
                              {TEMPLATE_NAMES[k]}
                            </option>
                          ))}
                        </SelectNative>
                      </Field>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Slides</span>
                        <div className="flex gap-2">
                          {SLIDE_COUNTS.map((n) => (
                            <Button key={n} type="button" size="sm" variant={draft.design.modules.length === n ? "primary" : "outline"} onClick={() => setSlideCount(n)} data-testid={`slides-${n}`}>
                              {n}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Slide order</span>
                        {draft.design.modules.map((m, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="w-6 text-sm tabular-nums">{i + 1}.</span>
                            <SelectNative value={m} onChange={(e) => setModuleAt(i, e.target.value as SlideModule)} disabled={i === draft.design.modules.length - 1}>
                              {SLIDE_MODULES.map((x) => (
                                <option key={x} value={x}>
                                  {MODULE_LABELS[x]}
                                </option>
                              ))}
                            </SelectNative>
                          </div>
                        ))}
                        {moduleError ? <p className="text-xs text-[var(--color-error)]">{moduleError}</p> : null}
                      </div>
                      <Field label={`Question text size ×${draft.design.questionScale.toFixed(2)}`}>
                        <input type="range" min={0.85} max={1.25} step={0.05} value={draft.design.questionScale} onChange={(e) => patchDesign({ questionScale: Number(e.target.value) })} />
                      </Field>
                      <Field label={`Other slides text size ×${draft.design.bodyScale.toFixed(2)}`}>
                        <input type="range" min={0.85} max={1.25} step={0.05} value={draft.design.bodyScale} onChange={(e) => patchDesign({ bodyScale: Number(e.target.value) })} />
                      </Field>
                      <p className="text-xs text-[var(--color-muted-foreground)]">Text never shrinks below phone-readable sizes; if it doesn&apos;t fit, the Review tab reports the slide as too long.</p>
                    </fieldset>
                  ) : null}

                  {tab === "ai" ? (
                    <fieldset disabled={!editable || pending} className="flex flex-col gap-4" data-testid="ai-panel">
                      <p className="text-sm text-[var(--color-muted-foreground)]">
                        The AI only writes hooks, explanation, trick, pearl, revision points, caption and hashtags. The question, options and correct answer are fixed; any output that contradicts the answer key,
                        claims a question is &quot;repeated&quot;, or invents statistics is rejected. Every result needs your review.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="primary" onClick={() => runAi({})} data-testid="ai-generate-all">
                          <Sparkles className="h-4 w-4" aria-hidden /> Generate all content
                        </Button>
                        <Button type="button" variant="outline" onClick={() => runAi({ selected: true })} data-testid="ai-regenerate-slide">
                          <RotateCcw className="h-4 w-4" aria-hidden /> Regenerate slide {slide + 1} ({MODULE_LABELS[modules[slide]]})
                        </Button>
                        <Button type="button" variant="outline" onClick={() => runAi({ fields: ["hooks"] })}>
                          New hooks
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            act(
                              (confirm) => prefillFromExplanationAction({ postId: post.id, expectedRevision: post.revision, ...draftPayload(draft), confirmReplaceApproved: confirm }),
                              (r) => (adopt(r.post), setMessage({ tone: "ok", text: r.summary }))
                            )
                          }
                          disabled={!editable || pending || !snapshot.aiExplanation}
                          title={snapshot.aiExplanation ? "Copy from the question's existing AI explanation (no new AI call)" : "This question has no AI explanation"}
                        >
                          Use existing AI explanation
                        </Button>
                      </div>
                      <Field label="Instruction for the selected slide or a named part (English or Hindi)">
                        <Textarea
                          rows={3}
                          value={instruction}
                          onChange={(e) => setInstruction(e.target.value)}
                          placeholder={'e.g. "Make the hook more attractive" · "Explanation ko aur simple banao" · "Question font size badhao" · "Background light karo"'}
                          data-testid="ai-instruction"
                        />
                      </Field>
                      <div>
                        <Button type="button" onClick={() => instruction.trim() && runAi({ instruction, selected: true })} disabled={!instruction.trim()} data-testid="ai-apply-instruction">
                          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} Apply instruction
                        </Button>
                      </div>
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        Font size and background/theme requests change the design directly (no AI call). Other requests regenerate only the parts they name — or the selected slide&apos;s parts — and the result is saved as a
                        revision you can Undo.
                      </p>
                      {post.content.origin.kind === "ai" ? (
                        <p className="text-xs text-[var(--color-muted-foreground)]">{`Last AI generation: ${post.content.origin.provider ?? ""} ${post.content.origin.model ?? ""} · ${post.content.origin.generatedAt ? fmt(post.content.origin.generatedAt) : ""}`}</p>
                      ) : null}
                    </fieldset>
                  ) : null}

                  {tab === "review" ? (
                    <div className="flex flex-col gap-4" data-testid="review-panel">
                      {dirty ? <p className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2 text-sm">Save your changes first — the checks below are for the saved version.</p> : null}
                      <section className="flex flex-col gap-2">
                        <h3 className="text-sm font-semibold">{`Quality checks — ${errors.length} blocking, ${warnings.length} to confirm`}</h3>
                        {issues.length === 0 ? <p className="text-sm text-[var(--color-success)]">No problems found.</p> : null}
                        <ul className="flex flex-col gap-1.5" data-testid="issue-list">
                          {errors.map((i) => (
                            <li key={i.code} data-code={i.code} className="rounded-md border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 p-2 text-sm">
                              <span className="font-semibold text-[var(--color-error)]">Blocking · </span>
                              {i.message}
                            </li>
                          ))}
                          {warnings.map((i) => (
                            <li key={i.code} data-code={i.code} className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-2 text-sm">
                              <label className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  className="mt-1"
                                  disabled={!editable || post.status === "READY"}
                                  checked={acks.includes(i.code) || (post.status === "READY" && post.acknowledged.includes(i.code))}
                                  onChange={(e) => setAcks((a) => (e.target.checked ? [...a, i.code] : a.filter((x) => x !== i.code)))}
                                />
                                <span>
                                  <span className="font-semibold">I checked this · </span>
                                  {i.message}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </section>

                      {post.series === "PYQ" ? (
                        <section className="flex flex-col gap-2">
                          <h3 className="text-sm font-semibold">Printed question number</h3>
                          <p className="text-xs text-[var(--color-muted-foreground)]">
                            The stored order is not the printed paper number. Enter it from the original paper; it appears on the slide only when marked verified.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Input className="w-24" inputMode="numeric" value={qNumber} onChange={(e) => setQNumber(e.target.value.replace(/\D/g, "").slice(0, 3))} disabled={!editable} data-testid="q-number" />
                            <label className="flex items-center gap-2 text-sm">
                              <input type="checkbox" checked={qVerified} onChange={(e) => setQVerified(e.target.checked)} disabled={!editable} data-testid="q-verified" />
                              Verified against the original paper
                            </label>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!editable || pending || dirty}
                              data-testid="q-save"
                              onClick={() =>
                                act(
                                  (confirm) => setQuestionNumberAction(post.id, post.revision, qNumber ? Number(qNumber) : null, qVerified, confirm),
                                  (p) => (adopt(p), setMessage({ tone: "ok", text: "Question number saved." }))
                                )
                              }
                            >
                              Save number
                            </Button>
                          </div>
                        </section>
                      ) : null}

                      <section className="flex flex-col gap-2">
                        <h3 className="text-sm font-semibold">Admin review</h3>
                        {post.status === "READY" ? (
                          <p className="text-sm text-[var(--color-success)]" data-testid="ready-note">{`Approved (Ready) by ${post.reviewedBy ?? "Admin"} on ${post.reviewedAt ? fmt(post.reviewedAt) : ""}.`}</p>
                        ) : (
                          REVIEW_CHECKLIST.map((c) => (
                            <label key={c.key} className="flex items-start gap-2 text-sm">
                              <input type="checkbox" className="mt-1" disabled={!editable} checked={Boolean(checklist[c.key])} onChange={(e) => setChecklist((s) => ({ ...s, [c.key]: e.target.checked }))} data-testid={`check-${c.key}`} />
                              {c.label}
                            </label>
                          ))
                        )}
                        <div className="flex flex-wrap gap-2">
                          {post.status === "READY" ? (
                            <Button variant="outline" disabled={pending} onClick={() => act(() => backToDraftAction(post.id), (p) => (adopt(p), setMessage({ tone: "info", text: "Back to Draft." })))} data-testid="back-to-draft">
                              Back to Draft
                            </Button>
                          ) : (
                            <Button
                              variant="success"
                              disabled={!canMarkReady || pending}
                              data-testid="mark-ready"
                              onClick={() =>
                                act(
                                  () => markReadyAction({ postId: post.id, expectedRevision: post.revision, checklist, acknowledged: acks }),
                                  (r) => {
                                    adopt(r.post);
                                    if (r.blocked.length || r.missingAcks.length || r.missingChecklist.length) {
                                      setMessage({ tone: "error", text: `Not marked Ready: ${r.blocked.length} blocking issue(s), ${r.missingAcks.length} warning(s) and ${r.missingChecklist.length} checklist item(s) open.` });
                                    } else setMessage({ tone: "ok", text: "Marked Ready. Any later edit sends it back to Draft." });
                                  }
                                )
                              }
                            >
                              Mark Ready
                            </Button>
                          )}
                          {post.status === "READY" || post.status === "FAILED" ? (
                            <Button variant="success" disabled={pending || dirty} onClick={() => setPublishOpen(true)} data-testid="publish-from-review">
                              <Send className="h-4 w-4" aria-hidden /> Publish to Instagram
                            </Button>
                          ) : null}
                        </div>
                      </section>
                    </div>
                  ) : null}

                  {tab === "history" ? (
                    <div className="flex flex-col gap-4" data-testid="history-panel">
                      <section className="flex flex-col gap-2">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                          <History className="h-4 w-4" aria-hidden /> Instagram posts for this question
                        </h3>
                        <ul className="flex flex-col gap-1 text-sm">
                          {(state?.history ?? []).map((h) => (
                            <li key={h.id} className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs">{`v${h.version}`}</span>
                              <InstagramStatusBadge status={h.status} />
                              <span className="text-xs text-[var(--color-muted-foreground)]">{`${h.series === "PYQ" ? "PYQ" : "Most Missed"} · created ${fmt(h.createdAt)}${h.publishedAt ? ` · posted ${fmt(h.publishedAt)}` : ""}${h.supersededAt ? " · superseded" : ""}`}</span>
                              {h.igPermalink ? (
                                <a href={h.igPermalink} target="_blank" rel="noreferrer" className="text-xs underline">
                                  View on Instagram
                                </a>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                        {publishedCurrent ? (
                          confirmNewVersion ? (
                            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2 text-sm">
                              This question was already posted. A new version is a separate post — make sure a second post is intended.
                              <Button size="sm" onClick={() => act(() => createNewVersionAction(post.id), (p) => (adopt(p), setConfirmNewVersion(false), setMessage({ tone: "ok", text: `Version ${p.version} created as a Draft.` })))} data-testid="confirm-new-version">
                                Create version {post.version + 1}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setConfirmNewVersion(false)}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div>
                              <Button size="sm" variant="outline" onClick={() => setConfirmNewVersion(true)} data-testid="new-version">
                                Create New Version
                              </Button>
                            </div>
                          )
                        ) : null}
                      </section>
                      <section className="flex flex-col gap-2">
                        <h3 className="text-sm font-semibold">Revisions of this version</h3>
                        <ul className="flex flex-col gap-1 text-sm" data-testid="revision-list">
                          {post.revisions.map((r) => (
                            <li key={r.revision} className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs">{`r${r.revision}`}</span>
                              <span className="flex-1">{r.note}</span>
                              <span className="text-xs text-[var(--color-muted-foreground)]">{`${r.createdBy} · ${fmt(r.createdAt)}`}</span>
                              {editable && r.revision !== post.revision ? (
                                <Button size="compact" variant="ghost" disabled={pending || dirty} onClick={() => act((confirm) => restoreRevisionAction(post.id, post.revision, r.revision, confirm), (p) => (adopt(p), setMessage({ tone: "ok", text: `Restored revision ${r.revision}.` })))}>
                                  Restore
                                </Button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          {/* Footer */}
          {post && draft ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
              <Button
                variant="outline"
                size="sm"
                disabled={!editable || pending || (!dirty && !post.canUndo)}
                data-testid="undo"
                onClick={() => {
                  if (dirty) {
                    setDraft(toDraft(post));
                    setMessage({ tone: "info", text: "Unsaved changes discarded." });
                    return;
                  }
                  act((confirm) => undoAction(post.id, post.revision, confirm), (p) => (adopt(p), setMessage({ tone: "ok", text: `Undone — back to the previous saved state (revision ${p.revision}).` })));
                }}
              >
                <Undo2 className="h-4 w-4" aria-hidden /> {dirty ? "Discard changes" : "Undo"}
              </Button>
              <Button size="sm" disabled={!editable || pending || !dirty || Boolean(moduleError)} onClick={save} data-testid="save-draft">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} Save Draft
              </Button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {!dirty ? (
                  <a
                    className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 text-xs"
                    href={`/api/admin/instagram/slide?postId=${post.id}&i=${slide}&download=1`}
                    data-testid="download-slide"
                  >
                    <Download className="h-4 w-4" aria-hidden /> Download slide {slide + 1} (JPEG)
                  </a>
                ) : null}
                {editable && (post.status === "DRAFT" || post.status === "READY") ? (
                  confirmDelete ? (
                    <span className="flex items-center gap-2 text-xs">
                      Delete this draft?
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={pending}
                        data-testid="confirm-delete"
                        onClick={() =>
                          act(
                            () => deleteDraftAction(post.id),
                            () => {
                              changed.current = true;
                              router.refresh();
                              onClose();
                            }
                          )
                        }
                      >
                        Delete
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} data-testid="delete-draft">
                      Delete draft
                    </Button>
                  )
                ) : null}
              </div>
            </div>
          ) : null}
          {/* Field-level hint for screen readers about which parts the AI may change. */}
          <span className="sr-only">{`AI-editable fields: ${Object.values(CONTENT_FIELD_LABELS).join(", ")}`}</span>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
