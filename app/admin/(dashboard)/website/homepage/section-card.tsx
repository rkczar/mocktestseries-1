"use client";

import { useState, useTransition } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { SectionMeta } from "@/lib/homepage-sections";
import type { HomepageStatsSnapshot } from "@/lib/homepage-statistics";
import { SectionContentForm } from "./section-content-form";
import { toggleSectionAction } from "./actions";

export interface SectionCardData {
  id: string;
  meta: SectionMeta;
  isEnabled: boolean;
  content: Record<string, unknown>;
  references: Record<string, unknown>;
}

type RefOption = { id: string; name: string };

export function SectionCard({
  section,
  examOptions,
  paperOptions,
  seriesOptions,
  liveStats,
}: {
  section: SectionCardData;
  examOptions: RefOption[];
  paperOptions: RefOption[];
  seriesOptions: RefOption[];
  liveStats: HomepageStatsSnapshot;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };

  return (
    <Card ref={setNodeRef} style={style} className="p-0">
      <div className="flex items-center gap-3 p-4">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          className="cursor-grab text-[var(--color-muted-foreground)] active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center justify-between text-left"
        >
          <div>
            <p className="text-sm font-semibold text-[var(--color-foreground)]">{section.meta.label}</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">{section.meta.description}</p>
          </div>
          <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--color-muted-foreground)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>

        <Switch
          checked={section.isEnabled}
          disabled={pending}
          onCheckedChange={(checked) => startTransition(() => toggleSectionAction(section.id, checked))}
          aria-label={section.isEnabled ? `Disable ${section.meta.label}` : `Enable ${section.meta.label}`}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {open ? (
        <div className="px-4 pb-4">
          <SectionContentForm
            sectionId={section.id}
            meta={section.meta}
            content={section.content}
            references={section.references}
            examOptions={examOptions}
            paperOptions={paperOptions}
            seriesOptions={seriesOptions}
            liveStats={liveStats}
          />
        </div>
      ) : null}
    </Card>
  );
}
