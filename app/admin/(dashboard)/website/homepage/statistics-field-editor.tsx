"use client";

import { useState, useTransition } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectNative } from "@/components/ui/select-native";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { normalizeStatMetrics, STAT_DATA_SOURCE_LABELS, type StatMetric, type StatDynamicKey } from "@/lib/homepage-field-codec";
import type { HomepageStatsSnapshot } from "@/lib/homepage-statistics";
import { HOMEPAGE_STAT_ICONS } from "@/lib/homepage-icons";
import { updateSectionContentAction, refreshHomepageStatisticsAction } from "./actions";

const DYNAMIC_KEYS = Object.keys(STAT_DATA_SOURCE_LABELS) as StatDynamicKey[];

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function ModeBadge({ mode }: { mode: StatMetric["mode"] }) {
  if (mode === "LIVE") return <Badge variant="success">LIVE ●</Badge>;
  if (mode === "DEMO") return <Badge variant="warning">DEMO</Badge>;
  return <Badge variant="info">MANUAL</Badge>;
}

function ModeChangeConfirm({
  open,
  from,
  to,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  from: StatMetric["mode"] | null;
  to: StatMetric["mode"] | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!from || !to) return null;
  const goingToDemo = to === "DEMO";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{goingToDemo ? "Switch to Demo data?" : "Switch back to Live data?"}</DialogTitle>
          <DialogDescription>
            {goingToDemo
              ? "Demo data will be displayed publicly for this card instead of the live database value."
              : "This card will return to real database data."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" size="sm" onClick={onConfirm}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MetricRow({
  metric,
  liveStats,
  onChange,
  onRemove,
}: {
  metric: StatMetric;
  liveStats: HomepageStatsSnapshot;
  onChange: (next: StatMetric) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: metric.id });
  const [open, setOpen] = useState(false);
  const [pendingModeChange, setPendingModeChange] = useState<StatMetric["mode"] | null>(null);
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };

  const requestModeChange = (next: StatMetric["mode"]) => {
    const isDemoTransition = (metric.mode === "DEMO") !== (next === "DEMO");
    if (isDemoTransition) {
      setPendingModeChange(next);
    } else {
      onChange({ ...metric, mode: next });
    }
  };

  return (
    <div ref={setNodeRef} style={style} className="rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-3 p-3">
        <button type="button" {...attributes} {...listeners} aria-label="Drag to reorder" className="cursor-grab text-[var(--color-muted-foreground)] active:cursor-grabbing">
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <Switch
          checked={metric.enabled}
          onCheckedChange={(checked) => onChange({ ...metric, enabled: checked })}
          aria-label={metric.enabled ? `Disable ${metric.label}` : `Enable ${metric.label}`}
        />
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex-1 text-left text-sm font-medium text-[var(--color-foreground)]">
          {metric.label || "Untitled card"}
        </button>
        <ModeBadge mode={metric.mode} />
        <button type="button" onClick={onRemove} aria-label={`Remove ${metric.label}`} className="text-[var(--color-muted-foreground)] hover:text-[var(--color-error)]">
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Display Label</Label>
              <Input value={metric.label} onChange={(e) => onChange({ ...metric, label: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Icon</Label>
              <SelectNative value={metric.icon ?? ""} onChange={(e) => onChange({ ...metric, icon: e.target.value })}>
                <option value="">None</option>
                {Object.keys(HOMEPAGE_STAT_ICONS).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </SelectNative>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Description</Label>
            <Input value={metric.description ?? ""} onChange={(e) => onChange({ ...metric, description: e.target.value })} placeholder="Short description shown under the number" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Badge (optional, e.g. &ldquo;New&rdquo;)</Label>
              <Input value={metric.badge ?? ""} onChange={(e) => onChange({ ...metric, badge: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Link (optional — makes this a clickable custom card)</Label>
              <Input value={metric.link ?? ""} onChange={(e) => onChange({ ...metric, link: e.target.value })} placeholder="/exams/some-exam" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Data Mode</Label>
            <div className="flex flex-wrap gap-4">
              {(["LIVE", "DEMO", "MANUAL"] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-1.5 text-sm text-[var(--color-foreground)]">
                  <input type="radio" name={`mode-${metric.id}`} checked={metric.mode === mode} onChange={() => requestModeChange(mode)} />
                  {mode === "LIVE" ? "Live Data" : mode === "DEMO" ? "Demo Data" : "Manual Display"}
                </label>
              ))}
            </div>
          </div>

          {metric.mode === "LIVE" ? (
            <div className="flex flex-col gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-card)] p-3">
              <div className="flex flex-col gap-1.5">
                <Label>Metric</Label>
                <SelectNative
                  value={metric.dynamicKey ?? ""}
                  onChange={(e) => onChange({ ...metric, dynamicKey: e.target.value as StatDynamicKey })}
                >
                  <option value="" disabled>
                    Choose a metric…
                  </option>
                  {DYNAMIC_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {STAT_DATA_SOURCE_LABELS[key]}
                    </option>
                  ))}
                </SelectNative>
              </div>
              {metric.dynamicKey ? (
                <div className="text-xs text-[var(--color-muted-foreground)]">
                  <p>
                    Data Source: <span className="text-[var(--color-foreground)]">{STAT_DATA_SOURCE_LABELS[metric.dynamicKey]}</span>
                  </p>
                  <p>
                    Current Live Value:{" "}
                    <span className="font-mono text-[var(--color-foreground)]">{liveStats.values[metric.dynamicKey]}</span>
                  </p>
                  <p>Last Updated: {relativeTime(liveStats.computedAt)}</p>
                </div>
              ) : null}
            </div>
          ) : metric.mode === "DEMO" ? (
            <div className="flex flex-col gap-1.5">
              <Label>Demo Value</Label>
              <Input value={metric.demoValue ?? ""} onChange={(e) => onChange({ ...metric, demoValue: e.target.value })} placeholder="12,500+" />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Demo values are never shown publicly as &ldquo;demo&rdquo; unless the section&apos;s mode-badge setting is turned on.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label>Display Value</Label>
              <Input value={metric.manualValue ?? ""} onChange={(e) => onChange({ ...metric, manualValue: e.target.value })} placeholder="50,000+" />
            </div>
          )}
        </div>
      ) : null}

      <ModeChangeConfirm
        open={pendingModeChange !== null}
        from={metric.mode}
        to={pendingModeChange}
        onConfirm={() => {
          if (pendingModeChange) onChange({ ...metric, mode: pendingModeChange });
          setPendingModeChange(null);
        }}
        onCancel={() => setPendingModeChange(null)}
      />
    </div>
  );
}

function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

export function StatisticsFieldEditor({
  sectionId,
  content,
  references,
  liveStats,
}: {
  sectionId: string;
  content: Record<string, unknown>;
  references: Record<string, unknown>;
  liveStats: HomepageStatsSnapshot;
}) {
  const [metrics, setMetrics] = useState<StatMetric[]>(() => normalizeStatMetrics(content.metrics));
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [saved, setSaved] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setMetrics((current) => {
      const oldIndex = current.findIndex((m) => m.id === active.id);
      const newIndex = current.findIndex((m) => m.id === over.id);
      return arrayMove(current, oldIndex, newIndex);
    });
  };

  const handleSave = () => {
    startTransition(async () => {
      await updateSectionContentAction(sectionId, { ...content, metrics }, references);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--color-muted-foreground)]">Drag to reorder. Toggle to show/hide on the public homepage.</p>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => startRefresh(() => refreshHomepageStatisticsAction())}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          Refresh Statistics
        </Button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={metrics.map((m) => m.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {metrics.map((metric) => (
              <MetricRow
                key={metric.id}
                metric={metric}
                liveStats={liveStats}
                onChange={(next) => setMetrics((current) => current.map((m) => (m.id === next.id ? next : m)))}
                onRemove={() => setMetrics((current) => current.filter((m) => m.id !== metric.id))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setMetrics((current) => [
              ...current,
              { id: generateId(), label: "New Card", enabled: true, mode: "MANUAL", manualValue: "" },
            ])
          }
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add Card
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={handleSave}>
          {pending ? "Saving…" : "Save Section"}
        </Button>
        {saved ? <span className="text-sm text-[var(--color-success)]">Saved to draft.</span> : null}
      </div>
    </div>
  );
}
