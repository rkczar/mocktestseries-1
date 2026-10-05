"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";
import type { AssetView } from "@/lib/rich-content-types";
import { cn } from "@/lib/utils";

/**
 * Ordered images of a RICH_V1 question (question figures, one option's
 * images, or explanation diagrams).
 *
 *  - Stored width/height are set on <img>, so the browser reserves the space
 *    before the file arrives (no layout shift); max-width:100% keeps the
 *    aspect ratio on any screen and small diagrams are never upscaled.
 *  - `darkBacking` puts the figure on a white plate so black-on-transparent
 *    line art stays readable in dark mode. Images are never inverted/recoloured.
 *  - alt="" only for images an admin explicitly marked decorative.
 *  - Tap (or the expand button on an option image) opens a viewer with zoom.
 *    Option images keep pointer-events off, so tapping the picture still
 *    selects the answer exactly like the option text; only the small expand
 *    button opens the viewer, and it never selects.
 * PLAIN questions keep their legacy single `imageUrl` markup instead.
 */
export function QuestionMedia({
  assets,
  size = "question",
  className,
  priority = false,
}: {
  assets: AssetView[];
  size?: "question" | "option" | "explanation";
  className?: string;
  /** The question currently on screen: load now, at high priority. */
  priority?: boolean;
}) {
  const [open, setOpen] = useState<AssetView | null>(null);
  if (assets.length === 0) return null;
  const maxHeight = size === "option" ? OPTION_MAX_HEIGHT_PX : FIGURE_MAX_HEIGHT_PX;
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="question-media">
      {assets.map((a, i) => {
        const img = (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={a.url}
            alt={a.alt}
            width={a.width || undefined}
            height={a.height || undefined}
            loading={priority || size !== "explanation" ? "eager" : "lazy"}
            decoding="async"
            fetchPriority={priority && i === 0 ? "high" : undefined}
            data-dark-backing={a.darkBacking ? "true" : "false"}
            className={cn(
              "block rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain",
              a.width && a.height ? "h-full w-full" : cn("max-w-full", size === "option" ? "max-h-48" : "max-h-[28rem]"),
              size === "option" && "pointer-events-none",
              a.darkBacking && "bg-white p-1.5"
            )}
          />
        );
        const box = reservedBox(a, maxHeight);
        return (
          <figure key={`${a.url}:${i}`} className="m-0 flex max-w-full flex-col items-start gap-1">
            {size === "option" ? (
              <div className="relative block max-w-full" style={box}>
                {img}
                <button
                  type="button"
                  data-testid="media-expand"
                  aria-label={a.alt ? `Enlarge image: ${a.alt}` : "Enlarge image"}
                  className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-card)]/90 text-[var(--color-foreground)] shadow-sm"
                  onClick={(e) => {
                    // Inside an option <label>: never let this tap select the answer.
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(a);
                  }}
                >
                  <Maximize2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="media-expand"
                aria-label={a.alt ? `Enlarge image: ${a.alt}` : "Enlarge image"}
                className="block max-w-full cursor-zoom-in rounded-[var(--radius-card)] p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
                style={box}
                onClick={() => setOpen(a)}
              >
                {img}
              </button>
            )}
            {a.caption ? <figcaption className="text-xs text-[var(--color-muted-foreground)]">{a.caption}</figcaption> : null}
          </figure>
        );
      })}
      {open ? <ImageViewer asset={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

const FIGURE_MAX_HEIGHT_PX = 448;
const OPTION_MAX_HEIGHT_PX = 192;

/**
 * The exact box an image will occupy, known before it loads (on the wrapper,
 * in px — a percentage of a shrink-to-fit option/label would resolve to 0):
 * never wider than its own pixels, never taller than `maxHeight`, shrunk by
 * max-width:100% on narrow screens, always at the stored aspect ratio. So
 * nothing below it moves when the file arrives.
 */
function reservedBox(a: AssetView, maxHeight: number): React.CSSProperties | undefined {
  if (!a.width || !a.height) return undefined;
  const width = Math.min(a.width, Math.round((maxHeight * a.width) / a.height));
  return { width: `${width}px`, maxWidth: "100%", aspectRatio: `${a.width} / ${a.height}` };
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * Full-screen viewer: a native modal <dialog> (focus trapped, Esc closes),
 * portalled to <body> so no click inside it can reach an option <label>.
 * Zoom with +/−, double-tap/double-click, the mouse wheel or a two-finger
 * pinch; pan by scrolling when zoomed. Browser history is not touched (the
 * app router reloads on foreign history entries), so Back behaves as before.
 */
function ImageViewer({ asset, onClose }: { asset: AssetView; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
  const lastTap = useRef(0);
  const lastTouch = useRef(0);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const zoomTo = useCallback((next: number) => {
    const el = scrollRef.current;
    setZoom((current) => {
      const z = clamp(next);
      if (el) {
        // Keep the centre of the view in place while zooming.
        const cx = (el.scrollLeft + el.clientWidth / 2) / current;
        const cy = (el.scrollTop + el.clientHeight / 2) / current;
        requestAnimationFrame(() => {
          el.scrollLeft = cx * z - el.clientWidth / 2;
          el.scrollTop = cy * z - el.clientHeight / 2;
        });
      }
      return z;
    });
  }, []);

  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      data-testid="image-viewer"
      aria-label={asset.alt ? `Image: ${asset.alt}` : "Image"}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      className="m-0 h-[100dvh] max-h-none w-screen max-w-none border-0 bg-black/90 p-0 text-white backdrop:bg-black/80"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 px-3 py-2" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
          <p className="min-w-0 truncate text-sm text-white/80">{asset.alt || "Image"}</p>
          <div className="flex shrink-0 items-center gap-1">
            <ViewerButton label="Zoom out" onClick={() => zoomTo(zoom / 1.5)} disabled={zoom <= MIN_ZOOM}>
              <Minus className="h-5 w-5" aria-hidden />
            </ViewerButton>
            <span className="w-12 text-center text-xs tabular-nums text-white/80" data-testid="viewer-zoom" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <ViewerButton label="Zoom in" onClick={() => zoomTo(zoom * 1.5)} disabled={zoom >= MAX_ZOOM}>
              <Plus className="h-5 w-5" aria-hidden />
            </ViewerButton>
            <ViewerButton label="Reset zoom" onClick={() => zoomTo(1)} disabled={zoom === 1}>
              <RotateCcw className="h-5 w-5" aria-hidden />
            </ViewerButton>
            <ViewerButton label="Close image" onClick={onClose} testId="viewer-close">
              <X className="h-6 w-6" aria-hidden />
            </ViewerButton>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto overscroll-contain"
          style={{ touchAction: "pan-x pan-y" }}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            zoomTo(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
          }}
          onPointerDown={(e) => {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.current.size === 2) pinchStart.current = { dist: distance(), zoom };
          }}
          onPointerMove={(e) => {
            if (!pointers.current.has(e.pointerId)) return;
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.current.size === 2 && pinchStart.current && pinchStart.current.dist > 0) {
              zoomTo((pinchStart.current.zoom * distance()) / pinchStart.current.dist);
            }
          }}
          onPointerUp={(e) => {
            pointers.current.delete(e.pointerId);
            if (pointers.current.size < 2) pinchStart.current = null;
            if (e.pointerType === "touch") {
              const now = Date.now();
              lastTouch.current = now;
              if (now - lastTap.current < 300) zoomTo(zoom > 1 ? 1 : 2.5);
              lastTap.current = now;
            }
          }}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            pinchStart.current = null;
          }}
          onDoubleClick={() => {
            // A touch double-tap also fires dblclick: it was already handled above.
            if (Date.now() - lastTouch.current < 700) return;
            zoomTo(zoom > 1 ? 1 : 2.5);
          }}
        >
          <div className="flex min-h-full min-w-full items-center justify-center p-3" style={{ width: `${zoom * 100}%`, height: zoom > 1 ? `${zoom * 100}%` : undefined }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.url}
              alt={asset.alt}
              width={asset.width || undefined}
              height={asset.height || undefined}
              draggable={false}
              data-testid="viewer-image"
              className={cn("max-h-full max-w-full select-none object-contain", asset.darkBacking && "rounded bg-white p-2")}
              style={zoom > 1 ? { maxHeight: "none", width: "100%", height: "auto" } : { maxHeight: "calc(100dvh - 5rem)" }}
            />
          </div>
        </div>
      </div>
    </dialog>,
    document.body
  );
}

function ViewerButton({ label, onClick, disabled, children, testId }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/10 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Conservative preloading: the question after the current one, never a paper.
// ---------------------------------------------------------------------------

const preloaded = new Set<string>();
const PRELOAD_MEMORY = 400;

/**
 * Warms the HTTP cache for a few image URLs (the next question's figures and
 * option images). Each URL is requested at most once per page; with nginx's
 * immutable caching a revisit never refetches.
 */
export function preloadImages(urls: string[]) {
  if (typeof window === "undefined") return;
  for (const url of urls) {
    if (preloaded.has(url)) continue;
    if (preloaded.size >= PRELOAD_MEMORY) preloaded.clear();
    preloaded.add(url);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
  }
}
