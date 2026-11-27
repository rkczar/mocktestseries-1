"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

const SPLIT_KEY = "mts.importer.verifySplit";
const MIN = 25; // % — neither panel narrower than a quarter

const splitListeners = new Set<() => void>();
function subscribeSplit(l: () => void) {
  splitListeners.add(l);
  return () => splitListeners.delete(l);
}
function readSplit() {
  let kept = 50;
  try {
    kept = Number(sessionStorage.getItem(SPLIT_KEY));
  } catch {} // storage blocked (site data off): fall back to 50 instead of crashing the review page
  return kept >= MIN && kept <= 100 - MIN ? kept : 50;
}

/** Two panels side by side (stacked below md) with a draggable, keyboard-operable divider; the split is kept per tab. */
export function SplitWorkspace({ left, right }: { left: ReactNode; right: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // Kept in sessionStorage so the split survives moving to the next question (each question is its own page).
  const pct = useSyncExternalStore(subscribeSplit, readSplit, () => 50);
  const set = useCallback((v: number) => {
    try {
      sessionStorage.setItem(SPLIT_KEY, String(Math.min(100 - MIN, Math.max(MIN, v))));
    } catch {
      return;
    }
    splitListeners.forEach((l) => l());
  }, []);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    const el = e.currentTarget;
    el.focus(); // preventDefault skips click-focus; keep arrow keys/Enter on the divider
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => set(((ev.clientX - r.left) / r.width) * 100);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("lostpointercapture", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up);
  };
  return (
    <div className="flex flex-col gap-1">
    <div className="hidden justify-end md:flex">
      <Button size="sm" variant="ghost" disabled={pct === 50} onClick={() => set(50)} data-testid="verify-reset-split">
        Reset split (50 / 50)
      </Button>
    </div>
    <div ref={box} className="flex flex-col gap-4 md:flex-row md:gap-0" style={{ ["--split" as string]: `${pct}%` }} data-testid="verify-workspace" data-split={Math.round(pct)}>
      <div className="min-w-0 md:w-[var(--split)] md:pr-2" data-testid="verify-left">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize question preview and source page"
        aria-valuemin={MIN}
        aria-valuemax={100 - MIN}
        aria-valuenow={Math.round(pct)}
        tabIndex={0}
        onPointerDown={drag}
        onDoubleClick={() => set(50)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") set(pct - 5);
          else if (e.key === "ArrowRight") set(pct + 5);
          else if (e.key === "Home" || e.key === "Enter") set(50);
          else return;
          e.preventDefault();
        }}
        className="group hidden w-3 shrink-0 cursor-col-resize touch-none items-center justify-center md:flex focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
        title="Drag to resize · double-click or Enter to reset to 50 / 50"
        data-testid="verify-divider"
      >
        <div className="h-16 w-1 rounded-full bg-[var(--color-border)] group-hover:bg-[var(--color-primary)]" />
      </div>
      <div className="min-w-0 md:flex-1 md:pl-2" data-testid="verify-right">
        {right}
      </div>
    </div>
    </div>
  );
}

const noSubscribe = () => () => {};

type Mode = "width" | "page" | "custom";

/**
 * The FULL original page (never a crop) with zoom, fit, drag-to-pan, fullscreen and page navigation. Opens on the
 * question's mapped page; with no mapping it opens page 1 and says so, without inventing one. Each question is its own
 * page render, so the viewer mounts fresh and re-opens that question's page.
 */
export function SourcePageViewer({ pages, mappedPage, label }: { pages: { id: string; pageNumber: number }[]; mappedPage: number | null; label: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [idx, setIdx] = useState(() => Math.max(0, pages.findIndex((p) => p.pageNumber === mappedPage)));
  const [mode, setMode] = useState<Mode>("width");
  const [z, setZ] = useState(1);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [loaded, setLoaded] = useState<{ id: string; ok: boolean } | null>(null);
  const [full, setFull] = useState(false);
  const canFull = useSyncExternalStore(noSubscribe, () => !!document.fullscreenEnabled, () => false); // iPhone Safari: no element fullscreen
  const page = pages[idx];
  const pid = page?.id;
  const state = !page || !loaded || loaded.id !== page.id ? "loading" : loaded.ok ? "ok" : "error";

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // A cached image can finish before hydration attaches onLoad/onError (React does not replay them), so check it once mounted.
  useEffect(() => {
    const el = img.current;
    if (!pid || !el?.complete) return;
    if (el.naturalWidth > 0) setNat({ w: el.naturalWidth, h: el.naturalHeight });
    setLoaded({ id: pid, ok: el.naturalWidth > 0 });
  }, [pid]);

  const ratio = nat ? nat.w / nat.h : 1 / Math.SQRT2;
  const fitPage = Math.min(box.w, box.h * ratio);
  const width = mode === "width" ? box.w : mode === "page" ? fitPage : box.w * z;
  const zoom = (f: number) => {
    setZ(Math.min(6, Math.max(0.25, (width / (box.w || 1)) * f)));
    setMode("custom");
  };

  // Drag to pan (mouse / pen / touch): moves the scroll position of the frame.
  const pan = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (!el || e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      el.scrollLeft = start.l - (ev.clientX - start.x);
      el.scrollTop = start.t - (ev.clientY - start.y);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  if (!pages.length) {
    return (
      <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="source-missing">
        {label}
      </p>
    );
  }
  const mapped = page.pageNumber === mappedPage;
  return (
    <div ref={frame} className={`flex flex-col gap-2 ${full ? "bg-[var(--color-background)] p-3" : ""}`} data-testid="source-viewer" data-page={page.pageNumber}>
      <div className="flex flex-wrap items-center gap-1 text-xs" role="toolbar" aria-label="Source page tools">
        <Button size="sm" variant="outline" disabled={idx === 0} onClick={() => setIdx(idx - 1)} aria-label="Previous page" data-testid="sv-page-prev">
          ‹
        </Button>
        <label className="flex items-center gap-1">
          <span className="sr-only">Page</span>
          <select className="rounded border border-[var(--color-border)] bg-transparent px-1 py-1" value={idx} onChange={(e) => setIdx(Number(e.target.value))} data-testid="sv-page-select">
            {pages.map((p, i) => (
              <option key={p.id} value={i}>
                Page {p.pageNumber}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="outline" disabled={idx === pages.length - 1} onClick={() => setIdx(idx + 1)} aria-label="Next page" data-testid="sv-page-next">
          ›
        </Button>
        <span className="mx-1" data-testid="sv-indicator">
          Page {page.pageNumber} of {pages.length}
          {mappedPage === null ? " · no page mapping" : mapped ? " · this question's page" : ` · question is on page ${mappedPage}`}
        </span>
        <span className="ml-auto flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => zoom(1 / 1.25)} aria-label="Zoom out" data-testid="sv-zoom-out">
            −
          </Button>
          <span className="self-center tabular-nums" data-testid="sv-zoom">{Math.round((width / (box.w || 1)) * 100)}%</span>
          <Button size="sm" variant="outline" onClick={() => zoom(1.25)} aria-label="Zoom in" data-testid="sv-zoom-in">
            +
          </Button>
          <Button size="sm" variant={mode === "width" ? "primary" : "outline"} onClick={() => setMode("width")} data-testid="sv-fit-width">
            Fit width
          </Button>
          <Button size="sm" variant={mode === "page" ? "primary" : "outline"} onClick={() => setMode("page")} data-testid="sv-fit-page">
            Fit page
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setMode("width"); setZ(1); scroller.current?.scrollTo(0, 0); }} data-testid="sv-reset">
            Reset
          </Button>
          {canFull && (
            <Button size="sm" variant="outline" onClick={() => (full ? document.exitFullscreen() : frame.current?.requestFullscreen())?.catch(() => {})} data-testid="sv-fullscreen">
              {full ? "Exit fullscreen" : "Fullscreen"}
            </Button>
          )}
        </span>
      </div>
      <div
        ref={scroller}
        onPointerDown={pan}
        className={`relative cursor-grab touch-none overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-muted)] active:cursor-grabbing ${full ? "h-[calc(100vh-5rem)]" : "h-[75vh]"}`}
        data-testid="sv-frame"
      >
        {state === "loading" && <p className="absolute inset-0 m-auto h-fit text-center text-sm text-[var(--color-muted-foreground)]">Loading page {page.pageNumber}…</p>}
        {state === "error" ? (
          <p className="p-4 text-sm text-[var(--color-error)]" data-testid="sv-error">
            Page {page.pageNumber} image could not be loaded.
          </p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- private admin route, full page at original resolution
          <img
            key={page.id}
            ref={img}
            src={`/api/admin/ai-importer/pages/${page.id}/image`}
            alt={`Original page ${page.pageNumber}`}
            draggable={false}
            className="mx-auto block max-w-none select-none bg-white"
            style={{ width: width ? `${width}px` : "100%" }}
            onLoad={(e) => {
              setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
              setLoaded({ id: page.id, ok: true });
            }}
            onError={() => setLoaded({ id: page.id, ok: false })}
            data-testid="source-page"
          />
        )}
      </div>
    </div>
  );
}
