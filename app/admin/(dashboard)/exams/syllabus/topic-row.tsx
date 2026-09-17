"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown as ChevronDownIcon } from "lucide-react";
import { TopicDeleteButton } from "../topics/topic-delete-button";
import { SubTopicsDialog } from "../topics/sub-topics-dialog";
import { MoveButtons } from "./move-buttons";
import { DescriptionForm } from "./description-form";
import { moveTopicAction, updateTopicSyllabusDescriptionAction } from "./actions";

interface TopicRowProps {
  examId: string;
  subjectId: string;
  topic: {
    id: string;
    name: string;
    syllabusDescription: string | null;
    subTopics: { id: string; name: string }[];
    _count: { questions: number };
  };
  isFirst: boolean;
  isLast: boolean;
}

export function TopicRow({ examId, subjectId, topic, isFirst, isLast }: TopicRowProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-[var(--radius-button)] border border-[var(--color-border)]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? (
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
          )}
          <span className="truncate text-sm text-[var(--color-foreground)]">{topic.name}</span>
          <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">{topic._count.questions} Qs</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <SubTopicsDialog topicId={topic.id} topicName={topic.name} initialSubTopics={topic.subTopics} />
          <MoveButtons
            label={topic.name}
            disableUp={isFirst}
            disableDown={isLast}
            onMove={(direction) => moveTopicAction(examId, subjectId, topic.id, direction)}
          />
          <TopicDeleteButton topicId={topic.id} />
        </div>
      </div>
      {open ? (
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          <DescriptionForm
            action={updateTopicSyllabusDescriptionAction}
            idField="topicId"
            idValue={topic.id}
            defaultValue={topic.syllabusDescription}
            placeholder="What this chapter/topic covers (shown on the public syllabus)…"
          />
        </div>
      ) : null}
    </div>
  );
}
