"use client";

import { Maximize, Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DiagramEdge } from "@/lib/diagram/types";

import { type LaneInfo, type LayoutNode, LANE_WIDTH, NODE_HEIGHT, NODE_WIDTH } from "./layout";
import { STATUS_META } from "./statusMeta";

const STATUS_STROKE: Record<string, string> = {
  ACTIVE: "var(--success)",
  COMING_SOON: "var(--brand-accent)",
  DRAFT: "var(--text-faint)",
  IN_DEVELOPMENT: "var(--brand-accent)",
  BROKEN: "var(--error)",
  DISCONNECTED: "var(--error)",
  NEEDS_REVIEW: "var(--text-faint)",
};

const KIND_LABEL: Record<string, string> = {
  page: "",
  api: "API",
  missing: "Missing",
  planned: "Planned",
};

const MIN_SCALE = 0.3;
const MAX_SCALE = 1.8;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function edgePath(s: { x: number; y: number }, t: { x: number; y: number }) {
  if (t.x >= s.x + NODE_WIDTH) {
    const sx = s.x + NODE_WIDTH;
    const sy = s.y + NODE_HEIGHT / 2;
    const tx = t.x;
    const ty = t.y + NODE_HEIGHT / 2;
    const dx = Math.max(40, (tx - sx) / 2);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }
  const sx = s.x + NODE_WIDTH / 2;
  const sy = s.y + NODE_HEIGHT;
  const tx = t.x + NODE_WIDTH / 2;
  const ty = t.y;
  const bow = 46;
  return `M ${sx} ${sy} C ${sx} ${sy + bow}, ${tx} ${ty - bow}, ${tx} ${ty}`;
}

export function DiagramCanvas({
  nodes,
  lanes,
  edges,
  selectedId,
  onSelect,
  dimmedIds,
  showGlobalNav,
}: {
  nodes: LayoutNode[];
  lanes: LaneInfo[];
  edges: DiagramEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  dimmedIds: Set<string>;
  showGlobalNav: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 0.85, tx: 30, ty: 20 });
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(null);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const contentWidth = lanes.length * LANE_WIDTH + 60;
  const contentHeight = Math.max(400, ...nodes.map((n) => n.y + NODE_HEIGHT + 60));

  const visibleEdges = useMemo(
    () => edges.filter((e) => (showGlobalNav || e.kind !== "global-nav") && nodeById.has(e.source) && nodeById.has(e.target)),
    [edges, showGlobalNav, nodeById],
  );

  const connected = useMemo(() => {
    if (!selectedId) return null;
    const inc = new Set<string>();
    const out = new Set<string>();
    for (const e of visibleEdges) {
      if (e.target === selectedId) inc.add(e.source);
      if (e.source === selectedId) out.add(e.target);
    }
    return { inc, out };
  }, [selectedId, visibleEdges]);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    const v = viewRef.current;
    const newScale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
    const worldX = (px - v.tx) / v.scale;
    const worldY = (py - v.ty) / v.scale;
    setView({ scale: newScale, tx: px - worldX * newScale, ty: py - worldY * newScale });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.08 : 1 / 1.08, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setView((v) => ({ ...v, tx: dragRef.current!.startTx + dx, ty: dragRef.current!.startTy + dy }));
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function handleBackgroundPointerDown(e: React.PointerEvent) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, startTx: view.tx, startTy: view.ty };
  }

  function fitToScreen() {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const scale = clamp(Math.min((width - 40) / contentWidth, (height - 40) / contentHeight), MIN_SCALE, 1);
    setView({ scale, tx: (width - contentWidth * scale) / 2, ty: 20 });
  }

  function resetView() {
    setView({ scale: 0.85, tx: 30, ty: 20 });
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={handleBackgroundPointerDown}
      className="relative h-[560px] w-full touch-none overflow-hidden rounded-xl border border-border bg-background sm:h-[620px]"
      role="application"
      aria-label="Website diagram canvas — drag to pan, scroll to zoom"
    >
      <div
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, transformOrigin: "0 0" }}
        className="absolute left-0 top-0 will-change-transform"
      >
        {lanes.map((lane) => (
          <div
            key={lane.key}
            style={{ left: lane.x - 14, width: LANE_WIDTH - 20, height: contentHeight }}
            className="absolute top-0 rounded-lg border border-dashed border-border-subtle bg-surface/40"
          >
            <p className="sticky top-2 mx-2 truncate rounded-md bg-surface px-2 py-1 text-[11px] font-extrabold tracking-wide text-text-faint uppercase">
              {lane.label}
            </p>
          </div>
        ))}

        <svg
          width={contentWidth}
          height={contentHeight}
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
        >
          {visibleEdges.map((edge) => {
            const s = nodeById.get(edge.source)!;
            const t = nodeById.get(edge.target)!;
            const isBroken = edge.kind === "broken";
            const isGlobal = edge.kind === "global-nav";
            const isHighlighted =
              selectedId && (edge.source === selectedId || edge.target === selectedId);
            const faded =
              dimmedIds.has(edge.source) ||
              dimmedIds.has(edge.target) ||
              (selectedId && !isHighlighted);
            return (
              <path
                key={edge.id}
                d={edgePath(s, t)}
                fill="none"
                stroke={isBroken ? "var(--error)" : isHighlighted ? "var(--primary)" : "var(--border-strong)"}
                strokeWidth={isHighlighted ? 2.4 : 1.6}
                strokeDasharray={isBroken || isGlobal ? "5 4" : undefined}
                opacity={faded ? 0.12 : isBroken ? 0.85 : isGlobal ? 0.45 : 0.65}
              />
            );
          })}
        </svg>

        {nodes.map((node) => {
          const isSelected = node.id === selectedId;
          const isDimmed = dimmedIds.has(node.id) || (selectedId ? !isSelected && !connected?.inc.has(node.id) && !connected?.out.has(node.id) : false);
          const meta = STATUS_META[node.status];
          const Icon = meta.icon;
          const stroke = STATUS_STROKE[node.status];
          const isPlanned = node.kind === "planned";
          const isMissing = node.kind === "missing";
          return (
            <button
              key={node.id}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onSelect(node.id)}
              style={{
                left: node.x,
                top: node.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                borderColor: stroke,
                opacity: isDimmed ? 0.28 : 1,
              }}
              className={`absolute flex flex-col justify-center rounded-[10px] border-[1.5px] bg-surface px-3 py-1.5 text-left shadow-sm transition-[opacity,box-shadow] duration-150 hover:shadow-md ${
                isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
              } ${isPlanned || isMissing ? "border-dashed" : ""}`}
              title={node.route ?? node.label}
            >
              <span className="flex items-center gap-1.5">
                <Icon className="size-3.5 flex-none" style={{ color: stroke }} strokeWidth={2.2} />
                <span className="truncate text-[13px] font-bold text-text-heading">{node.label}</span>
              </span>
              <span className="mt-0.5 truncate font-mono text-[10.5px] text-text-faint">
                {node.route ?? "not yet built"}
                {KIND_LABEL[node.kind] ? ` · ${KIND_LABEL[node.kind]}` : ""}
              </span>
            </button>
          );
        })}
      </div>

      <div className="absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-border bg-surface p-1 shadow-sm">
        <button
          type="button"
          onClick={() => zoomAt(1.2, containerRef.current!.clientWidth / 2, containerRef.current!.clientHeight / 2)}
          className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-accent hover:text-primary"
          aria-label="Zoom in"
        >
          <Plus className="size-4" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => zoomAt(1 / 1.2, containerRef.current!.clientWidth / 2, containerRef.current!.clientHeight / 2)}
          className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-accent hover:text-primary"
          aria-label="Zoom out"
        >
          <Minus className="size-4" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={fitToScreen}
          className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-accent hover:text-primary"
          aria-label="Fit to screen"
        >
          <Maximize className="size-4" strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={resetView}
          className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-accent hover:text-primary"
          aria-label="Reset view"
        >
          <RotateCcw className="size-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
