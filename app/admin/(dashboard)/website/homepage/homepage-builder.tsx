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
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { SectionCard, type SectionCardData } from "./section-card";
import { reorderSectionsAction } from "./actions";

type RefOption = { id: string; name: string };

export function HomepageBuilder({
  initialSections,
  examOptions,
  paperOptions,
  seriesOptions,
}: {
  initialSections: SectionCardData[];
  examOptions: RefOption[];
  paperOptions: RefOption[];
  seriesOptions: RefOption[];
}) {
  const [sections, setSections] = useState(initialSections);
  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setSections((current) => {
      const oldIndex = current.findIndex((s) => s.id === active.id);
      const newIndex = current.findIndex((s) => s.id === over.id);
      const next = arrayMove(current, oldIndex, newIndex);
      startTransition(() => reorderSectionsAction(next.map((s) => s.id)));
      return next;
    });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-3">
          {sections.map((section) => (
            <SectionCard
              key={section.id}
              section={section}
              examOptions={examOptions}
              paperOptions={paperOptions}
              seriesOptions={seriesOptions}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
