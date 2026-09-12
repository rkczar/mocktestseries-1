"use client";

import { useActionState, useMemo, useRef, useState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createCustomModuleAction, type CustomModuleFormState } from "./actions";

export interface ExamTree {
  id: string;
  name: string;
  subjects: { id: string; name: string; topics: { id: string; name: string }[] }[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create Custom Module"}
    </Button>
  );
}

export function CustomModuleForm({ exams }: { exams: ExamTree[] }) {
  const [state, formAction] = useActionState<CustomModuleFormState, FormData>(createCustomModuleAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [examId, setExamId] = useState(exams[0]?.id ?? "");
  const [mode, setMode] = useState<"MANUAL" | "RULE_BASED">("MANUAL");
  const [ruleSubjectId, setRuleSubjectId] = useState("");

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  const exam = useMemo(() => exams.find((e) => e.id === examId), [exams, examId]);
  const subjects = exam?.subjects ?? [];
  const topics = useMemo(() => subjects.find((s) => s.id === ruleSubjectId)?.topics ?? [], [subjects, ruleSubjectId]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="examId">Exam</Label>
          <SelectNative id="examId" name="examId" value={examId} onChange={(e) => setExamId(e.target.value)} required>
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
          <Input id="title" name="title" required placeholder="Anatomy Revision" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="accessType">Access</Label>
          <SelectNative id="accessType" name="accessType" defaultValue="FREE">
            <option value="FREE">Free</option>
            <option value="PAID">Paid</option>
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="durationMinutes">Duration (minutes, optional)</Label>
          <Input id="durationMinutes" name="durationMinutes" type="number" min={1} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="negativeMarking">Negative Marking</Label>
          <Input id="negativeMarking" name="negativeMarking" type="number" step="0.05" min={0} max={1} defaultValue={0} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="selectionMode">Question Selection</Label>
          <SelectNative
            id="selectionMode"
            name="selectionMode"
            value={mode}
            onChange={(e) => setMode(e.target.value as "MANUAL" | "RULE_BASED")}
          >
            <option value="MANUAL">Manual — pick questions after creating</option>
            <option value="RULE_BASED">Rule-based — auto-select by filters</option>
          </SelectNative>
        </div>
      </div>

      {mode === "RULE_BASED" ? (
        <div className="grid grid-cols-1 gap-4 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ruleSubjectId">Subject (optional)</Label>
            <SelectNative
              id="ruleSubjectId"
              name="ruleSubjectId"
              value={ruleSubjectId}
              onChange={(e) => setRuleSubjectId(e.target.value)}
            >
              <option value="">Any subject</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ruleTopicId">Topic (optional)</Label>
            <SelectNative id="ruleTopicId" name="ruleTopicId" defaultValue="">
              <option value="">Any topic</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ruleDifficulty">Difficulty (optional)</Label>
            <SelectNative id="ruleDifficulty" name="ruleDifficulty" defaultValue="">
              <option value="">Any difficulty</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ruleCount">Number of Questions</Label>
            <Input id="ruleCount" name="ruleCount" type="number" min={1} defaultValue={20} />
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="description">Description (optional)</Label>
        <Input id="description" name="description" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="instructions">Instructions (optional)</Label>
        <textarea
          id="instructions"
          name="instructions"
          rows={2}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        />
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Module created as Draft.</p> : null}
      </div>
    </form>
  );
}
