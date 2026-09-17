"use client";

import { useActionState, useMemo, useRef, useState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createLiveTestAction, updateLiveTestAction, type LiveTestFormState } from "./actions";

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

export interface ExamTree {
  id: string;
  name: string;
  subjects: {
    id: string;
    name: string;
    topics: { id: string; name: string; subTopics: { id: string; name: string }[] }[];
  }[];
}

export interface BlueprintLine {
  subjectId: string;
  topicId?: string;
  subTopicId?: string;
  difficulty?: Difficulty[];
  count: number;
}

export interface LiveTestInitial {
  examId: string;
  title: string;
  description?: string | null;
  startAt: string; // ISO, for <input type="datetime-local">
  endAt: string;
  studentDurationMinutes: number;
  negativeMarking: number;
  instructions?: string | null;
  accessType: "FREE" | "PAID";
  questionCount: number;
  blueprint: BlueprintLine[];
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

let rowKeySeq = 0;
function newRow(): BlueprintLine & { key: number } {
  return { key: rowKeySeq++, subjectId: "", topicId: "", subTopicId: "", difficulty: [], count: 10 };
}

export function LiveTestForm({
  exams,
  liveTestId,
  initial,
}: {
  exams: ExamTree[];
  liveTestId?: string;
  initial?: LiveTestInitial;
}) {
  const isEdit = Boolean(liveTestId);
  const action = isEdit ? updateLiveTestAction.bind(null, liveTestId!) : createLiveTestAction;
  const [state, formAction] = useActionState<LiveTestFormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);

  const [examId, setExamId] = useState(initial?.examId ?? exams[0]?.id ?? "");
  const [questionCount, setQuestionCount] = useState(initial?.questionCount ?? 50);
  const [startAt, setStartAt] = useState(initial?.startAt ?? "");
  const [endAt, setEndAt] = useState(initial?.endAt ?? "");
  const [rows, setRows] = useState<(BlueprintLine & { key: number })[]>(() =>
    initial?.blueprint && initial.blueprint.length > 0
      ? initial.blueprint.map((l) => ({ ...l, key: rowKeySeq++ }))
      : [newRow()]
  );

  useEffect(() => {
    if (state.success && !isEdit) formRef.current?.reset();
  }, [state.success, isEdit]);

  const exam = useMemo(() => exams.find((e) => e.id === examId), [exams, examId]);
  const subjects = exam?.subjects ?? [];

  const total = rows.reduce((sum, r) => sum + (Number.isFinite(r.count) ? r.count : 0), 0);
  const mismatch = total !== questionCount;
  const windowInvalid = Boolean(startAt && endAt && new Date(endAt).getTime() <= new Date(startAt).getTime());

  function updateRow(key: number, patch: Partial<BlueprintLine>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function toggleDifficulty(key: number, d: Difficulty) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const current = r.difficulty ?? [];
        const next = current.includes(d) ? current.filter((x) => x !== d) : [...current, d];
        return { ...r, difficulty: next };
      })
    );
  }

  const blueprintJson = useMemo(
    () =>
      JSON.stringify(
        rows.map((r) => ({
          subjectId: r.subjectId,
          topicId: r.topicId || undefined,
          subTopicId: r.subTopicId || undefined,
          difficulty: r.difficulty && r.difficulty.length > 0 ? r.difficulty : undefined,
          count: r.count,
        }))
      ),
    [rows]
  );

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="blueprint" value={blueprintJson} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="examId">Exam</Label>
          <SelectNative
            id="examId"
            name="examId"
            value={examId}
            onChange={(e) => {
              setExamId(e.target.value);
              setRows([newRow()]);
            }}
            required
          >
            <option value="" disabled>
              Select exam
            </option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" required defaultValue={initial?.title} placeholder="Live Test — Weekly Mock #1" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="accessType">Access</Label>
          <SelectNative id="accessType" name="accessType" defaultValue={initial?.accessType ?? "FREE"}>
            <option value="FREE">Free</option>
            <option value="PAID">Paid</option>
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="startAt">Starts At</Label>
          <Input
            id="startAt"
            name="startAt"
            type="datetime-local"
            required
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="endAt">Ends At</Label>
          <Input
            id="endAt"
            name="endAt"
            type="datetime-local"
            required
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
          />
          {windowInvalid ? <p className="text-xs text-[var(--color-error)]">Ends At must be after Starts At.</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="studentDurationMinutes">Student Duration (minutes)</Label>
          <Input
            id="studentDurationMinutes"
            name="studentDurationMinutes"
            type="number"
            min={1}
            required
            defaultValue={initial?.studentDurationMinutes ?? 60}
          />
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Per-student cap. A late joiner never gets more time than what remains until Ends At.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="negativeMarking">Negative Marking (per wrong answer)</Label>
          <Input
            id="negativeMarking"
            name="negativeMarking"
            type="number"
            step="0.05"
            min={0}
            max={1}
            defaultValue={initial?.negativeMarking ?? 0.25}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="questionCount">Question Count</Label>
          <Input
            id="questionCount"
            name="questionCount"
            type="number"
            min={1}
            required
            value={questionCount}
            onChange={(e) => setQuestionCount(Math.max(1, Number(e.target.value)))}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="description">Description (optional)</Label>
        <Input id="description" name="description" defaultValue={initial?.description ?? undefined} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="instructions">Instructions (optional)</Label>
        <textarea
          id="instructions"
          name="instructions"
          rows={2}
          defaultValue={initial?.instructions ?? undefined}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        />
      </div>

      <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-[var(--color-foreground)]">Blueprint</p>
          <p className={`text-xs ${mismatch ? "text-[var(--color-error)]" : "text-[var(--color-muted-foreground)]"}`}>
            {total} / {questionCount} questions allocated
          </p>
        </div>

        {rows.map((row) => {
          const subject = subjects.find((s) => s.id === row.subjectId);
          const topics = subject?.topics ?? [];
          const topic = topics.find((t) => t.id === row.topicId);
          const subTopics = topic?.subTopics ?? [];

          return (
            <div key={row.key} className="grid grid-cols-1 gap-3 border-t border-[var(--color-border)] pt-3 sm:grid-cols-5">
              <div className="flex flex-col gap-1.5">
                <Label>Subject</Label>
                <SelectNative
                  value={row.subjectId}
                  onChange={(e) => updateRow(row.key, { subjectId: e.target.value, topicId: "", subTopicId: "" })}
                  required
                >
                  <option value="" disabled>
                    Select subject
                  </option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Topic (optional)</Label>
                <SelectNative
                  value={row.topicId ?? ""}
                  onChange={(e) => updateRow(row.key, { topicId: e.target.value, subTopicId: "" })}
                  disabled={topics.length === 0}
                >
                  <option value="">Any topic</option>
                  {topics.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Sub-topic (optional)</Label>
                <SelectNative
                  value={row.subTopicId ?? ""}
                  onChange={(e) => updateRow(row.key, { subTopicId: e.target.value })}
                  disabled={subTopics.length === 0}
                >
                  <option value="">Any sub-topic</option>
                  {subTopics.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Difficulty</Label>
                <div className="flex items-center gap-2 pt-1.5">
                  {DIFFICULTIES.map((d) => (
                    <label key={d} className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
                      <input
                        type="checkbox"
                        checked={(row.difficulty ?? []).includes(d)}
                        onChange={() => toggleDifficulty(row.key, d)}
                      />
                      {d[0]}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label>Count</Label>
                  <Input
                    type="number"
                    min={1}
                    value={row.count}
                    onChange={(e) => updateRow(row.key, { count: Math.max(1, Number(e.target.value)) })}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={rows.length === 1}
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                  aria-label="Remove row"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>
          );
        })}

        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setRows((prev) => [...prev, newRow()])}>
          <Plus className="h-4 w-4" aria-hidden /> Add Row
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton label={isEdit ? "Save Changes" : "Create Live Test"} pendingLabel={isEdit ? "Saving…" : "Creating…"} />
        {state.error ? (
          <p className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
          </p>
        ) : null}
        {state.success && !isEdit ? <p className="text-sm text-[var(--color-success)]">Live test created as Draft.</p> : null}
        {state.success && isEdit ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      </div>
    </form>
  );
}
