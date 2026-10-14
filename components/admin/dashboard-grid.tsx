"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, LayoutGrid, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DashboardCardSize } from "@/lib/admin-dashboard-layout";
import { resetAdminDashboardLayoutAction, saveAdminDashboardLayoutAction } from "@/app/admin/(dashboard)/dashboard-layout-actions";

export interface DashboardGridItem {
  id: string;
  label: string;
  size: DashboardCardSize;
  node: ReactNode;
}

const SIZE: Record<DashboardCardSize, string> = {
  stat: "",
  half: "col-span-2 sm:col-span-3 lg:col-span-2",
  full: "col-span-full",
};

const REFRESH_MS = 60_000;

/**
 * Admin Dashboard card grid: per-admin drag-and-drop order (Move Up/Down
 * buttons for touch and keyboard users), Save / Reset Default, and a light
 * auto-refresh — router.refresh() every 60 s while the tab is visible and
 * the layout is not being edited (re-runs the server queries; no client
 * polling of individual cards).
 */
export function DashboardGrid({ items, renderedAt }: { items: DashboardGridItem[]; renderedAt: string }) {
  const router = useRouter();
  // The draft order exists only while editing; otherwise the server's (saved) order is shown as-is.
  const [draft, setDraft] = useState<string[] | null>(null);
  const editing = draft !== null;
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const lastRefresh = useRef(0);
  const byId = new Map(items.map((i) => [i.id, i]));
  const serverOrder = items.map((i) => i.id);
  const order = draft ?? serverOrder;
  const setOrder = (fn: (cur: string[]) => string[]) => setDraft((cur) => (cur ? fn(cur) : cur));

  useEffect(() => {
    lastRefresh.current = Date.now();
  }, [renderedAt]);

  useEffect(() => {
    if (editing) return;
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastRefresh.current < REFRESH_MS - 1000) return;
      lastRefresh.current = Date.now();
      startRefresh(() => router.refresh());
    };
    const id = window.setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [editing, router]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const move = (id: string, delta: number) =>
    setOrder((cur) => {
      const from = cur.indexOf(id);
      const to = from + delta;
      return from < 0 || to < 0 || to >= cur.length ? cur : arrayMove(cur, from, to);
    });

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setOrder((cur) => {
      const from = cur.indexOf(String(active.id));
      const to = cur.indexOf(String(over.id));
      return from < 0 || to < 0 ? cur : arrayMove(cur, from, to);
    });
  };

  const save = () =>
    startTransition(async () => {
      const r = await saveAdminDashboardLayoutAction(order).catch(() => ({ ok: false as const, error: "Could not save the layout." }));
      setMessage(r.ok ? { ok: true, text: "Layout saved." } : { ok: false, text: r.error });
      if (r.ok) {
        setDraft(null);
        router.refresh();
      }
    });

  const resetDefault = () =>
    startTransition(async () => {
      const r = await resetAdminDashboardLayoutAction().catch(() => ({ ok: false as const, error: "Could not reset the layout." }));
      setMessage(r.ok ? { ok: true, text: "Default layout restored." } : { ok: false, text: r.error });
      if (r.ok) {
        setDraft(null);
        router.refresh();
      }
    });

  const updated = new Date(renderedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="dashboard-updated">
          Last updated {updated} IST · {editing ? "auto-refresh paused while editing" : "auto-refreshes every 60 s"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" onClick={save} disabled={pending} data-testid="dashboard-save-layout">
                <Save className="h-3.5 w-3.5" aria-hidden /> {pending ? "Saving…" : "Save Layout"}
              </Button>
              <Button size="sm" variant="outline" onClick={resetDefault} disabled={pending} data-testid="dashboard-reset-layout">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset Default Layout
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(null)}
                disabled={pending}
              >
                <X className="h-3.5 w-3.5" aria-hidden /> Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => startRefresh(() => router.refresh())} disabled={refreshing} aria-label="Refresh dashboard">
                <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden /> Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMessage(null);
                  setDraft(serverOrder);
                }}
                data-testid="dashboard-customize"
              >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Customize layout
              </Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">Drag a card by its handle, or use the arrows. Your layout is saved for your admin account only.</p>
      ) : null}
      {message ? (
        <p role="status" className={cn("text-xs", message.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]")}>
          {message.text}
        </p>
      ) : null}

      {editing ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="dashboard-grid" data-editing="true">
              {order.map((id, i) =>
                byId.has(id) ? (
                  <SortableCard key={id} item={byId.get(id)!} first={i === 0} last={i === order.length - 1} onMove={move} />
                ) : null
              )}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="dashboard-grid">
          {order.map((id) =>
            byId.has(id) ? (
              <div key={id} className={cn("min-w-0 [&>*]:h-full", SIZE[byId.get(id)!.size])} data-card-id={id}>
                {byId.get(id)!.node}
              </div>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}

function SortableCard({ item, first, last, onMove }: { item: DashboardGridItem; first: boolean; last: boolean; onMove: (id: string, delta: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative min-w-0 rounded-[var(--radius-card)] outline-dashed outline-1 outline-offset-2 outline-[var(--color-border)]", SIZE[item.size], isDragging && "z-10 opacity-80")}
      data-card-id={item.id}
    >
      <div className="mb-1 flex items-center justify-between gap-1 rounded-[var(--radius-button)] bg-[var(--color-surface)] px-1.5 py-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="flex min-w-0 cursor-grab touch-none items-center gap-1 text-xs font-medium text-[var(--color-foreground)] active:cursor-grabbing"
          aria-label={`Drag ${item.label}`}
        >
          <GripVertical className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{item.label}</span>
        </button>
        <span className="flex shrink-0 gap-0.5">
          <button type="button" className="rounded p-1 hover:bg-[var(--color-muted)] disabled:opacity-30" onClick={() => onMove(item.id, -1)} disabled={first} aria-label={`Move ${item.label} up`}>
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button type="button" className="rounded p-1 hover:bg-[var(--color-muted)] disabled:opacity-30" onClick={() => onMove(item.id, 1)} disabled={last} aria-label={`Move ${item.label} down`}>
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      </div>
      <div className="pointer-events-none select-none [&>*]:h-full" aria-hidden>
        {item.node}
      </div>
    </div>
  );
}
