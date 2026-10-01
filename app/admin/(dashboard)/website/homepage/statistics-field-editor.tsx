"use client";

import { useEffect, useState, useTransition } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, arrayMove, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2, RefreshCw, RotateCcw, ChevronDown, Lock } from "lucide-react";
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
import { DEFAULT_STAT_METRICS } from "@/lib/homepage-sections";
import { isValidCustomDisplayValue, MAX_CUSTOM_VALUE_LENGTH, MAX_STAT_LABEL_LENGTH } from "@/lib/homepage-stat-sanitize";
import {
  STAT_FORMATS,
  STAT_FORMAT_LABELS,
  formatStatNumber,
  parseManualNumber,
  withSuffix,
  type StatFormat,
} from "@/lib/homepage-stat-format";
import { saveStatisticsCardsAction, refreshHomepageStatisticsAction } from "./actions";

const DYNAMIC_KEYS = Object.keys(STAT_DATA_SOURCE_LABELS) as StatDynamicKey[];

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function liveCount(metric: StatMetric, liveStats: HomepageStatsSnapshot): number | null {
  return metric.dynamicKey ? (liveStats.values[metric.dynamicKey] ?? 0) : null;
}

/** Exactly what the public card will show — mirrors resolveStatValue in lib/homepage-render.ts. */
function previewValue(metric: StatMetric, liveStats: HomepageStatsSnapshot): string {
  if (metric.mode === "MANUAL") return metric.manualValue?.trim() || "—";
  const format = metric.format ?? "EXACT";
  const numeric = metric.mode === "LIVE" ? (liveCount(metric, liveStats) ?? 0) : parseManualNumber(metric.demoValue);
  if (numeric === null) return metric.demoValue ? withSuffix(metric.demoValue, metric.suffix) : "—";
  return withSuffix(formatStatNumber(numeric, format), metric.suffix);
}

function IconPicker({ value, onChange }: { value?: string; onChange: (icon: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1.5">
      {Object.entries(HOMEPAGE_STAT_ICONS).map(([key, Icon]) => {
        const selected = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={key}
            title={key}
            onClick={() => onChange(key)}
            className={`flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border transition-colors ${
              selected
                ? "border-[var(--color-primary)] bg-[var(--color-card)] text-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

function ModeChangeConfirm({
  open,
  to,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  to: StatMetric["mode"] | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!to) return null;
  const goingToDemo = to === "DEMO";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{goingToDemo ? "Switch to Demo data?" : "Leave Demo data?"}</DialogTitle>
          <DialogDescription>
            {goingToDemo
              ? "Demo data will be displayed publicly for this card instead of the live database value."
              : "Demo data can't be selected again once this card leaves Demo mode."}
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

/** CUSTOM is stored as the codec's MANUAL mode; DEMO is legacy and only offered to a card already using it. */
const MODE_OPTIONS: { mode: StatMetric["mode"]; label: string }[] = [
  { mode: "LIVE", label: "LIVE" },
  { mode: "MANUAL", label: "CUSTOM" },
  { mode: "DEMO", label: "DEMO" },
];

function ModeSelector({ metric, onSelect }: { metric: StatMetric; onSelect: (mode: StatMetric["mode"]) => void }) {
  const options = MODE_OPTIONS.filter((o) => o.mode !== "DEMO" || metric.mode === "DEMO");
  return (
    <div
      role="radiogroup"
      aria-label={`Display mode for ${metric.label || "card"}`}
      className="inline-flex rounded-[var(--radius-button)] border border-[var(--color-border)] p-0.5"
    >
      {options.map(({ mode, label }) => {
        const selected = metric.mode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => !selected && onSelect(mode)}
            className={`min-w-16 rounded-[var(--radius-button)] px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
              selected
                ? "bg-[var(--color-action-fill)] text-[var(--color-action-ink)]"
                : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
      <Label htmlFor={htmlFor} className="text-xs text-[var(--color-muted-foreground)]">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function MetricCard({
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingModeChange, setPendingModeChange] = useState<StatMetric["mode"] | null>(null);
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };

  const isCustom = metric.mode === "MANUAL";
  const count = liveCount(metric, liveStats);
  const labelId = `stat-label-${metric.id}`;
  const customId = `stat-custom-${metric.id}`;
  const customInvalid = isCustom && !isValidCustomDisplayValue(metric.manualValue?.trim());

  const requestModeChange = (next: StatMetric["mode"]) => {
    if ((metric.mode === "DEMO") !== (next === "DEMO")) setPendingModeChange(next);
    else onChange({ ...metric, mode: next });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex min-w-0 flex-col gap-3 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 ${
        metric.enabled ? "" : "border-dashed"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          className="cursor-grab text-[var(--color-muted-foreground)] active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <p className="flex-1 truncate text-sm font-semibold text-[var(--color-foreground)]">{metric.label || "Untitled card"}</p>
        {metric.mode === "LIVE" ? (
          <Badge variant="success">LIVE</Badge>
        ) : metric.mode === "DEMO" ? (
          <Badge variant="warning">DEMO</Badge>
        ) : (
          <Badge variant="info">CUSTOM</Badge>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <FieldRow label="Show Card">
          <div className="flex items-center gap-2">
            <Switch
              checked={metric.enabled}
              onCheckedChange={(checked) => onChange({ ...metric, enabled: checked })}
              aria-label={`Show ${metric.label || "card"} on the homepage`}
            />
            <span className="text-xs text-[var(--color-muted-foreground)]">{metric.enabled ? "ON" : "OFF"}</span>
          </div>
        </FieldRow>

        <FieldRow label="Display Mode">
          <ModeSelector metric={metric} onSelect={requestModeChange} />
        </FieldRow>

        <FieldRow label="Live Value">
          <p
            className="flex flex-wrap items-center gap-1.5 font-mono text-sm tabular-nums text-[var(--color-foreground)]"
            title="Real database value — read-only"
          >
            <Lock className="h-3 w-3 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
            {count === null ? "No data source" : count.toLocaleString("en-IN")}
            <span className="font-sans text-xs text-[var(--color-muted-foreground)]">read-only</span>
          </p>
        </FieldRow>

        <FieldRow label="Public Label" htmlFor={labelId}>
          <Input
            id={labelId}
            value={metric.label}
            maxLength={MAX_STAT_LABEL_LENGTH}
            onChange={(e) => onChange({ ...metric, label: e.target.value })}
            aria-invalid={!metric.label.trim()}
            className="h-9"
          />
        </FieldRow>

        <FieldRow label="Custom Value" htmlFor={customId}>
          <Input
            id={customId}
            value={metric.manualValue ?? ""}
            maxLength={MAX_CUSTOM_VALUE_LENGTH}
            disabled={!isCustom}
            onChange={(e) => onChange({ ...metric, manualValue: e.target.value })}
            placeholder={isCustom ? "e.g. 100+" : "Select CUSTOM to edit"}
            aria-invalid={customInvalid}
            aria-describedby={`${customId}-help`}
            className="h-9"
          />
        </FieldRow>
        <p
          id={`${customId}-help`}
          className={`text-xs ${customInvalid ? "text-[var(--color-error)]" : "text-[var(--color-muted-foreground)]"}`}
        >
          {isCustom
            ? customInvalid
              ? "Enter a value like 100+, 1,500+, 2.8K+, 10K+, 25,000 or 5000."
              : "Shown exactly as typed. Display only: real data and Admin Analytics are unchanged."
            : metric.manualValue
              ? "Custom value is kept but not shown while the card is LIVE."
              : "The homepage shows the live database value."}
        </p>
      </div>

      <div className="rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-center">
        <p className="sr-only">Homepage preview</p>
        <p className="font-mono text-lg font-semibold tabular-nums text-[var(--color-foreground)]">
          {metric.enabled ? previewValue(metric, liveStats) : "Hidden"}
        </p>
        <p className="truncate text-xs text-[var(--color-muted-foreground)]">{metric.label || "Untitled card"}</p>
      </div>

      <button
        type="button"
        onClick={() => setMoreOpen((o) => !o)}
        aria-expanded={moreOpen}
        className="flex items-center gap-1 self-start text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${moreOpen ? "rotate-180" : ""}`} aria-hidden />
        More options
      </button>

      {moreOpen ? (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
          <div className="flex flex-col gap-1.5">
            <Label>Live data source</Label>
            <SelectNative value={metric.dynamicKey ?? ""} onChange={(e) => onChange({ ...metric, dynamicKey: e.target.value as StatDynamicKey })}>
              <option value="" disabled>
                Choose a metric…
              </option>
              {DYNAMIC_KEYS.map((key) => (
                <option key={key} value={key}>
                  {STAT_DATA_SOURCE_LABELS[key]}
                </option>
              ))}
            </SelectNative>
            <p className="text-xs text-[var(--color-muted-foreground)]">Live values updated: {relativeTime(liveStats.computedAt)}</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Live number format</Label>
              <SelectNative value={metric.format ?? "EXACT"} onChange={(e) => onChange({ ...metric, format: e.target.value as StatFormat })}>
                {STAT_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {STAT_FORMAT_LABELS[format]}
                  </option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Live suffix (e.g. &ldquo;+&rdquo;)</Label>
              <Input value={metric.suffix ?? ""} maxLength={6} onChange={(e) => onChange({ ...metric, suffix: e.target.value })} placeholder="+" />
            </div>
          </div>

          {metric.mode === "DEMO" ? (
            <div className="flex flex-col gap-1.5">
              <Label>Demo Value</Label>
              <Input value={metric.demoValue ?? ""} onChange={(e) => onChange({ ...metric, demoValue: e.target.value })} placeholder="12,500+" />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label>Icon</Label>
            <IconPicker value={metric.icon} onChange={(icon) => onChange({ ...metric, icon })} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Description</Label>
            <Input
              value={metric.description ?? ""}
              onChange={(e) => onChange({ ...metric, description: e.target.value })}
              placeholder="Short description shown under the number"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Badge (optional, e.g. &ldquo;New&rdquo;)</Label>
              <Input value={metric.badge ?? ""} onChange={(e) => onChange({ ...metric, badge: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Link (optional)</Label>
              <Input value={metric.link ?? ""} onChange={(e) => onChange({ ...metric, link: e.target.value })} placeholder="/exams/some-exam" />
            </div>
          </div>

          <Button type="button" variant="outline" size="sm" onClick={onRemove} className="self-start">
            <Trash2 className="h-4 w-4" aria-hidden />
            Remove card
          </Button>
        </div>
      ) : null}

      <ModeChangeConfirm
        open={pendingModeChange !== null}
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

type EditorState = { showSection: boolean; metrics: StatMetric[] };

/**
 * Admin → Website → Homepage → Platform Stats. Each card's Show Card,
 * Display Mode (LIVE / CUSTOM), Public Label and Custom Value are edited in
 * place and saved, with the master Show Homepage Stats switch, to the DRAFT
 * in one Save Changes; Publish makes them live. CUSTOM only changes what the
 * homepage displays; the real statistics are never modified.
 */
export function StatisticsFieldEditor({
  sectionId,
  content,
  liveStats,
  sectionEnabled,
  canEdit,
}: {
  sectionId: string;
  content: Record<string, unknown>;
  liveStats: HomepageStatsSnapshot;
  sectionEnabled: boolean;
  canEdit: boolean;
}) {
  const [state, setState] = useState<EditorState>(() => ({ showSection: sectionEnabled, metrics: normalizeStatMetrics(content.metrics) }));
  const [baseline, setBaseline] = useState(() => JSON.stringify(state));
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  // The section header switch saves visibility on its own; adopt its value.
  const [syncedEnabled, setSyncedEnabled] = useState(sectionEnabled);
  if (syncedEnabled !== sectionEnabled) {
    setSyncedEnabled(sectionEnabled);
    setState((s) => ({ ...s, showSection: sectionEnabled }));
    setBaseline((b) => JSON.stringify({ ...(JSON.parse(b) as EditorState), showSection: sectionEnabled }));
  }

  const dirty = JSON.stringify(state) !== baseline;
  const { metrics, showSection } = state;
  const setMetrics = (update: (current: StatMetric[]) => StatMetric[]) => {
    setSaved(false);
    setState((s) => ({ ...s, metrics: update(s.metrics) }));
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

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
    setError(null);
    const submitted = state;
    startTransition(async () => {
      const result = await saveStatisticsCardsAction(sectionId, submitted);
      if (result.error) {
        setError(result.error);
        return;
      }
      setBaseline(JSON.stringify(submitted));
      setSaved(true);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {!canEdit ? (
        <p className="flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
          <Lock className="h-4 w-4 shrink-0" aria-hidden />
          Read-only. Only the Master Admin can change Homepage Stats.
        </p>
      ) : null}

      <fieldset disabled={!canEdit || pending} className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-card)] p-3">
          <div className="flex items-center gap-3">
            <Switch
              id="show-homepage-stats"
              checked={showSection}
              onCheckedChange={(checked) => {
                setSaved(false);
                setState((s) => ({ ...s, showSection: checked }));
              }}
            />
            <div>
              <Label htmlFor="show-homepage-stats">Show Homepage Stats</Label>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {showSection ? "ON: cards with Show Card ON appear on the homepage." : "OFF: the whole stats section is hidden."}
              </p>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => startRefresh(() => refreshHomepageStatisticsAction())}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            Refresh Live Values
          </Button>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={metrics.map((m) => m.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-4">
              {metrics.map((metric) => (
                <MetricCard
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

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" disabled={!dirty} onClick={handleSave}>
            {pending ? "Saving…" : "Save Changes"}
          </Button>
          {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
          {saved && !dirty ? (
            <span className="text-sm text-[var(--color-success)]" role="status">
              Saved to draft. Use Preview to check it, then Publish to make it live.
            </span>
          ) : null}
          <span className="hidden flex-1 sm:block" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setMetrics((current) => [
                ...current,
                { id: generateId(), label: "New Card", icon: "barChart", enabled: true, mode: "MANUAL", manualValue: "", format: "EXACT" },
              ])
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add Card
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRestore(true)}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Restore Default Cards
          </Button>
        </div>
        {error ? (
          <p className="text-sm text-[var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>

      <Dialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore default cards?</DialogTitle>
            <DialogDescription>
              All cards are replaced with the 4 default LIVE cards: Questions Available, Students Joined, Tests Attempted
              and Questions Attempted. Nothing is saved until you click Save Changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setMetrics(() => normalizeStatMetrics(DEFAULT_STAT_METRICS));
                setConfirmRestore(false);
              }}
            >
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
