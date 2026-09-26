"use client";

import { useState, useTransition } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, RotateCcw, Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { studentDashboardBlock, type StudentDashboardLayout } from "@/lib/student-dashboard-blocks";
import { restoreDefaultStudentDashboardLayoutAction, saveStudentDashboardLayoutAction } from "./actions";

const GROUP_LABEL = { overview: "Overview", practice: "Practice & Tests", pyq: "Previous Year Papers", recent: "Recent Activity", account: "Account" } as const;

/**
 * Student Dashboard Manager — show/hide and reorder the registered dashboard
 * blocks. Read-only (no drag, no switches, no buttons) without
 * WEBSITE_MANAGE; the server actions re-check that permission regardless.
 */
export function StudentDashboardManager({ initialLayout, canManage }: { initialLayout: StudentDashboardLayout; canManage: boolean }) {
  const [layout, setLayout] = useState(initialLayout);
  const [saved, setSaved] = useState(initialLayout);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(layout) !== JSON.stringify(saved);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!canManage || !over || active.id === over.id) return;
    setLayout((current) => {
      const from = current.findIndex((b) => b.id === active.id);
      const to = current.findIndex((b) => b.id === over.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
    setMessage(null);
  };

  const toggle = (id: string, visible: boolean) => {
    setLayout((current) => current.map((b) => (b.id === id ? { ...b, visible } : b)));
    setMessage(null);
  };

  const run = (fn: () => Promise<{ ok: true; layout: StudentDashboardLayout } | { ok: false; error: string }>, okText: string) => {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (result.ok) {
          setLayout(result.layout);
          setSaved(result.layout);
          setMessage({ tone: "ok", text: okText });
        } else {
          setMessage({ tone: "error", text: result.error });
        }
      } catch {
        setMessage({ tone: "error", text: "You don't have permission to change the Student Dashboard." });
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Student Dashboard</CardTitle>
        <CardDescription>
          Choose which sections students see on their dashboard and in what order. Changes apply on the next dashboard load —
          no redeploy. Hiding a section never grants or removes access to anything; each section still shows only what the
          student is allowed to see.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!canManage ? (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm text-[var(--color-muted-foreground)]">
            View only — only a Master Admin can change the Student Dashboard layout.
          </p>
        ) : null}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={layout.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col gap-2" data-testid="dashboard-blocks">
              {layout.map((b, i) => (
                <BlockRow key={b.id} id={b.id} index={i} visible={b.visible} canManage={canManage && !pending} onToggle={toggle} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={pending || !dirty} onClick={() => run(() => saveStudentDashboardLayoutAction(layout), "Layout saved.")}>
              <Save className="h-4 w-4" aria-hidden /> {pending ? "Saving…" : "Save Layout"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => restoreDefaultStudentDashboardLayoutAction(), "Default layout restored.")}
            >
              <RotateCcw className="h-4 w-4" aria-hidden /> Restore Default
            </Button>
            {dirty ? <span className="text-xs text-[var(--color-warning)]">Unsaved changes</span> : null}
          </div>
        ) : null}
        {message ? (
          <p role="status" className={message.tone === "ok" ? "text-sm text-[var(--color-success)]" : "text-sm text-[var(--color-error)]"}>
            {message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BlockRow({
  id,
  index,
  visible,
  canManage,
  onToggle,
}: {
  id: string;
  index: number;
  visible: boolean;
  canManage: boolean;
  onToggle: (id: string, visible: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !canManage });
  const meta = studentDashboardBlock(id as Parameters<typeof studentDashboardBlock>[0]);
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };

  return (
    <li ref={setNodeRef} style={style} data-block-id={id} className="list-none">
      <div className={`flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 ${visible ? "" : "opacity-60"}`}>
        {canManage ? (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag to reorder ${meta.label}`}
            className="cursor-grab touch-none text-[var(--color-muted-foreground)] active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <span className="w-4 text-center text-xs text-[var(--color-muted-foreground)]">{index + 1}</span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--color-foreground)]">
            {meta.label} <code className="ml-1 text-[11px] font-normal text-[var(--color-muted-foreground)]">{id}</code>
          </p>
          <p className="text-xs text-[var(--color-muted-foreground)]">{meta.description}</p>
        </div>
        <Badge className="hidden shrink-0 sm:inline-flex">{GROUP_LABEL[meta.group]}</Badge>
        <Switch
          checked={visible}
          disabled={!canManage}
          onCheckedChange={(checked) => onToggle(id, checked)}
          aria-label={visible ? `Hide ${meta.label}` : `Show ${meta.label}`}
        />
      </div>
    </li>
  );
}
