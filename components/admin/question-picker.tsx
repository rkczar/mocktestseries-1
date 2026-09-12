"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export interface PickableQuestion {
  id: string;
  code: string;
  text: string;
  subjectName: string;
  topicName: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
}

function SubmitButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : `Save Selection (${count})`}
    </Button>
  );
}

export function QuestionPicker({
  questions,
  initiallySelected,
  action,
}: {
  questions: PickableQuestion[];
  initiallySelected: string[];
  action: (formData: FormData) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initiallySelected));
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return questions;
    return questions.filter(
      (question) => question.text.toLowerCase().includes(q) || question.code.toLowerCase().includes(q)
    );
  }, [questions, query]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <form action={action} className="flex flex-col gap-4">
      {[...selected].map((id) => (
        <input key={id} type="hidden" name="questionIds" value={id} />
      ))}

      <Input
        placeholder="Search by question text or code…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-sm"
      />

      {questions.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
          No published questions for this exam yet. Add some in Admin → Questions.
        </p>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
          {filtered.map((q) => (
            <label
              key={q.id}
              className="flex cursor-pointer items-start gap-3 border-b border-[var(--color-border)] px-3 py-2.5 last:border-0 hover:bg-[var(--color-surface)]"
            >
              <input
                type="checkbox"
                checked={selected.has(q.id)}
                onChange={() => toggle(q.id)}
                className="mt-1 h-4 w-4"
              />
              <span className="flex-1 text-sm text-[var(--color-foreground)]">
                {q.text.slice(0, 100)}
                <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                  {q.subjectName}
                  {q.topicName ? ` · ${q.topicName}` : ""} · {q.code}
                </span>
              </span>
              <Badge variant={q.difficulty === "EASY" ? "success" : q.difficulty === "HARD" ? "error" : "warning"}>
                {q.difficulty}
              </Badge>
            </label>
          ))}
        </div>
      )}

      <div>
        <SubmitButton count={selected.size} />
      </div>
    </form>
  );
}
