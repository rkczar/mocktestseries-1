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
import { GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectNative } from "@/components/ui/select-native";
import { normalizeUpcomingExams, type UpcomingExamConfig } from "@/lib/homepage-field-codec";
import { updateSectionContentAction } from "./actions";

type RefOption = { id: string; name: string };

function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function ExamRow({
  config,
  examName,
  onChange,
  onRemove,
}: {
  config: UpcomingExamConfig;
  examName: string;
  onChange: (next: UpcomingExamConfig) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: config.id });
  const [open, setOpen] = useState(false);
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };

  return (
    <div ref={setNodeRef} style={style} className="rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-3 p-3">
        <button type="button" {...attributes} {...listeners} aria-label="Drag to reorder" className="cursor-grab text-[var(--color-muted-foreground)] active:cursor-grabbing">
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <Switch checked={config.enabled} onCheckedChange={(checked) => onChange({ ...config, enabled: checked })} aria-label={config.enabled ? `Disable ${examName}` : `Enable ${examName}`} />
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex-1 text-left text-sm font-medium text-[var(--color-foreground)]">
          {examName}
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${examName}`} className="text-[var(--color-muted-foreground)] hover:text-[var(--color-error)]">
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] p-3">
          <div className="flex flex-col gap-1.5">
            <Label>Marketing description override (optional)</Label>
            <Input value={config.descriptionOverride ?? ""} onChange={(e) => onChange({ ...config, descriptionOverride: e.target.value })} placeholder="Uses the exam's own description if left blank" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>CTA text (optional)</Label>
              <Input value={config.ctaText ?? ""} onChange={(e) => onChange({ ...config, ctaText: e.target.value })} placeholder="Uses the section's default CTA if left blank" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>CTA link (optional)</Label>
              <Input value={config.ctaHref ?? ""} onChange={(e) => onChange({ ...config, ctaHref: e.target.value })} placeholder="#featured-exam" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function UpcomingExamsFieldEditor({
  sectionId,
  content,
  references,
  examOptions,
}: {
  sectionId: string;
  content: Record<string, unknown>;
  references: Record<string, unknown>;
  examOptions: RefOption[];
}) {
  const [configs, setConfigs] = useState<UpcomingExamConfig[]>(() => normalizeUpcomingExams(content.exams, references.examIds));
  const [addExamId, setAddExamId] = useState("");
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const examById = new Map(examOptions.map((e) => [e.id, e.name]));
  const availableToAdd = examOptions.filter((e) => !configs.some((c) => c.examId === e.id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setConfigs((current) => {
      const oldIndex = current.findIndex((c) => c.id === active.id);
      const newIndex = current.findIndex((c) => c.id === over.id);
      return arrayMove(current, oldIndex, newIndex);
    });
  };

  const handleSave = () => {
    startTransition(async () => {
      await updateSectionContentAction(sectionId, { ...content, exams: configs }, references);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {configs.length === 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">No exams selected yet.</p> : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={configs.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {configs.map((config) => (
              <ExamRow
                key={config.id}
                config={config}
                examName={examById.get(config.examId) ?? "Unknown exam"}
                onChange={(next) => setConfigs((current) => current.map((c) => (c.id === next.id ? next : c)))}
                onRemove={() => setConfigs((current) => current.filter((c) => c.id !== config.id))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {availableToAdd.length > 0 ? (
        <div className="flex items-center gap-2">
          <SelectNative value={addExamId} onChange={(e) => setAddExamId(e.target.value)} className="max-w-xs">
            <option value="">Add an exam…</option>
            {availableToAdd.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </SelectNative>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!addExamId}
            onClick={() => {
              if (!addExamId) return;
              setConfigs((current) => [...current, { id: generateId(), examId: addExamId, enabled: true }]);
              setAddExamId("");
            }}
          >
            Add
          </Button>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={pending} onClick={handleSave}>
          {pending ? "Saving…" : "Save Section"}
        </Button>
        {saved ? <span className="text-sm text-[var(--color-success)]">Saved to draft.</span> : null}
      </div>
    </div>
  );
}
