"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type CropBox = { x: number; y: number; w: number; h: number };

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const pct = (n: number) => Math.round(n * 1000) / 10;

/**
 * Crop editor on the ORIGINAL page image: drag on the page to draw the box (or type it in percent), then
 * save. The page image itself is never changed — the server cuts a new crop from the original page.
 */
export function CropEditor({ pageUrl, pageNumber, initial, busy, saveLabel, onSave, onCancel }: { pageUrl: string; pageNumber: number; initial: CropBox | null; busy: boolean; saveLabel: string; onSave: (box: CropBox) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<CropBox | null>(initial);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const setField = (k: keyof CropBox, v: string) => {
    const n = Number(v) / 100;
    if (!Number.isFinite(n)) return;
    setBox((b) => ({ ...(b ?? { x: 0, y: 0, w: 0.2, h: 0.2 }), [k]: clamp(n) }));
  };
  const usable = !!box && box.w >= 0.01 && box.h >= 0.01 && box.x + box.w <= 1.0001 && box.y + box.h <= 1.0001;
  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--color-border)] p-2" data-testid="crop-editor">
      <p className="text-xs text-[var(--color-muted-foreground)]">Page {pageNumber}: drag on the page to draw a box around the whole figure (with its labels), or type the box below. The original page is not changed.</p>
      <div
        ref={ref}
        className="relative w-full max-w-xl touch-none select-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = at(e);
          setBox({ ...drag.current, w: 0, h: 0 });
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const p = at(e);
          const s = drag.current;
          setBox({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        data-testid="crop-editor-page"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={pageUrl} alt={`Page ${pageNumber}`} draggable={false} className="w-full rounded border border-[var(--color-border)] bg-white" />
        {box && <span className="pointer-events-none absolute border-2 border-[var(--color-primary)] bg-[var(--color-primary)]/10" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} data-testid="crop-editor-box" />}
      </div>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <label key={k} className="flex flex-col gap-1">
            <span>{k === "x" ? "Left %" : k === "y" ? "Top %" : k === "w" ? "Width %" : "Height %"}</span>
            <Input className="h-8 w-20" inputMode="decimal" value={box ? String(pct(box[k])) : ""} onChange={(e) => setField(k, e.target.value)} data-testid={`crop-editor-${k}`} />
          </label>
        ))}
        <Button size="sm" disabled={busy || !usable} onClick={() => box && onSave(box)} data-testid="crop-editor-save">
          {saveLabel}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {box && !usable && <p className="text-xs text-[var(--color-error)]">The box must lie on the page and be at least 1% wide and high.</p>}
    </div>
  );
}
