"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import type { QuestionSyncState } from "@/app/admin/(dashboard)/tests/mock/actions";

export interface MockPickableQuestion {
  id: string;
  code: string;
  text: string;
  subjectId: string;
  subjectName: string;
  topicId: string | null;
  topicName: string | null;
  subTopicName: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  isPyq: boolean;
  paperLabel: string | null;
}

function SaveButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : `Save Questions (${count})`}
    </Button>
  );
}

/**
 * Mock Test question assignment: filter the exam's published questions by
 * subject / topic / difficulty / source (PYQ or not) / text, select one by
 * one or every filtered result at once, then reorder or remove from the
 * ordered "Selected" list. The saved order is the order students see.
 */
export function MockQuestionPicker({
  questions,
  initiallySelected,
  target,
  action,
}: {
  questions: MockPickableQuestion[];
  initiallySelected: string[];
  target: number | null;
  action: (prev: QuestionSyncState, formData: FormData) => Promise<QuestionSyncState>;
}) {
  const [state, formAction] = useActionState<QuestionSyncState, FormData>(action, {});
  const [selected, setSelected] = useState<string[]>(initiallySelected);
  const [q, setQ] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [source, setSource] = useState("");
  const [limit, setLimit] = useState(100);

  const byId = useMemo(() => new Map(questions.map((x) => [x.id, x])), [questions]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const subjects = useMemo(() => [...new Map(questions.map((x) => [x.subjectId, x.subjectName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [questions]);
  const topics = useMemo(
    () =>
      [...new Map(questions.filter((x) => x.topicId && (!subjectId || x.subjectId === subjectId)).map((x) => [x.topicId!, x.topicName ?? ""])).entries()].sort((a, b) =>
        a[1].localeCompare(b[1])
      ),
    [questions, subjectId]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return questions.filter(
      (x) =>
        (!subjectId || x.subjectId === subjectId) &&
        (!topicId || x.topicId === topicId) &&
        (!difficulty || x.difficulty === difficulty) &&
        (!source || (source === "PYQ" ? x.isPyq : !x.isPyq)) &&
        (!needle || x.text.toLowerCase().includes(needle) || x.code.toLowerCase().includes(needle))
    );
  }, [questions, q, subjectId, topicId, difficulty, source]);

  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectAllFiltered = () => setSelected((prev) => [...prev, ...filtered.map((x) => x.id).filter((id) => !prev.includes(id))]);
  const clearFiltered = () => {
    const drop = new Set(filtered.map((x) => x.id));
    setSelected((prev) => prev.filter((id) => !drop.has(id)));
  };
  const move = (i: number, d: -1 | 1) =>
    setSelected((prev) => {
      const j = i + d;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const count = selected.length;
  const targetTone = target === null ? "neutral" : count === target ? "success" : count > target ? "warning" : "info";

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {selected.map((id) => (
        <input key={id} type="hidden" name="questionIds" value={id} />
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={targetTone}>
          Selected {count}
          {target !== null ? ` / Target ${target}` : ""}
        </Badge>
        <SaveButton count={count} />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved {state.count} questions in this order.</p> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* LEFT: search & add */}
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-sm font-medium text-[var(--color-foreground)]">Add Questions</p>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Search text or code" value={q} onChange={(e) => setQ(e.target.value)} className="col-span-2" />
            <SelectNative
              aria-label="Subject"
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTopicId("");
              }}
            >
              <option value="">All subjects</option>
              {subjects.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </SelectNative>
            <SelectNative aria-label="Topic" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">All topics</option>
              {topics.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </SelectNative>
            <SelectNative aria-label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option value="">Any difficulty</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </SelectNative>
            <SelectNative aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">PYQ + Non-PYQ</option>
              <option value="PYQ">PYQ only</option>
              <option value="BANK">Non-PYQ only</option>
            </SelectNative>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <span>{filtered.length} match</span>
            <Button type="button" size="compact" variant="outline" onClick={selectAllFiltered} disabled={filtered.length === 0}>
              Select all {filtered.length}
            </Button>
            <Button type="button" size="compact" variant="ghost" onClick={clearFiltered} disabled={filtered.length === 0}>
              Deselect filtered
            </Button>
          </div>
          <div className="max-h-[480px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
            {filtered.slice(0, limit).map((x) => (
              <label
                key={x.id}
                className="flex cursor-pointer gap-3 border-b border-[var(--color-border)] px-3 py-2 last:border-0 hover:bg-[color-mix(in_srgb,var(--color-foreground)_4%,transparent)]"
              >
                <input type="checkbox" checked={selectedSet.has(x.id)} onChange={() => toggle(x.id)} className="mt-1" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm text-[var(--color-foreground)]">{x.text}</span>
                  <span className="mt-0.5 block text-[11px] text-[var(--color-muted-foreground)]">
                    {x.code} · {x.subjectName}
                    {x.topicName ? ` › ${x.topicName}` : ""}
                    {x.subTopicName ? ` › ${x.subTopicName}` : ""} · {x.difficulty}
                    {x.isPyq ? ` · PYQ${x.paperLabel ? ` ${x.paperLabel}` : ""}` : ""}
                  </span>
                </span>
              </label>
            ))}
            {filtered.length > limit ? (
              <button type="button" className="w-full py-2 text-xs text-[var(--color-primary)]" onClick={() => setLimit((n) => n + 200)}>
                Show more ({filtered.length - limit} hidden)
              </button>
            ) : null}
            {filtered.length === 0 ? <p className="p-4 text-center text-xs text-[var(--color-muted-foreground)]">No questions match.</p> : null}
          </div>
        </div>

        {/* RIGHT: ordered selection */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-[var(--color-foreground)]">Selected — in test order</p>
            {count > 0 ? (
              <Button type="button" size="compact" variant="ghost" onClick={() => setSelected([])}>
                Remove all
              </Button>
            ) : null}
          </div>
          <ol className="max-h-[560px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
            {selected.map((id, i) => {
              const x = byId.get(id);
              return (
                <li key={id} className="flex items-start gap-2 border-b border-[var(--color-border)] px-3 py-2 last:border-0">
                  <span className="w-7 shrink-0 pt-0.5 text-xs tabular-nums text-[var(--color-muted-foreground)]">{i + 1}.</span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm text-[var(--color-foreground)]">{x ? x.text : "(question no longer published — will be dropped on save)"}</span>
                    {x ? <span className="block text-[11px] text-[var(--color-muted-foreground)]">{x.code} · {x.subjectName}</span> : null}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === selected.length - 1}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Remove" onClick={() => toggle(id)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </li>
              );
            })}
            {count === 0 ? <li className="p-4 text-center text-xs text-[var(--color-muted-foreground)]">No questions selected yet.</li> : null}
          </ol>
        </div>
      </div>
    </form>
  );
}
