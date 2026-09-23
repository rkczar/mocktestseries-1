"use client";

import { useActionState, useRef, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createMockTestAction, type MockTestFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create Mock Test"}
    </Button>
  );
}

export function MockTestForm({
  exams,
  testSeries,
  defaultExamId,
  defaultTestSeriesId,
}: {
  exams: { id: string; name: string }[];
  testSeries: { id: string; name: string; examId: string }[];
  defaultExamId?: string;
  defaultTestSeriesId?: string;
}) {
  const [state, formAction] = useActionState<MockTestFormState, FormData>(createMockTestAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="examId">Exam</Label>
        <SelectNative id="examId" name="examId" required defaultValue={defaultExamId ?? ""}>
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
        <Label htmlFor="testSeriesId">Test Series (optional)</Label>
        <SelectNative id="testSeriesId" name="testSeriesId" defaultValue={defaultTestSeriesId ?? ""}>
          <option value="">Standalone mock test</option>
          {testSeries.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required placeholder="Full Length Mock Test 1" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="durationMinutes">Duration (minutes)</Label>
        <Input id="durationMinutes" name="durationMinutes" type="number" min={1} required defaultValue={180} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="negativeMarking">Negative Marking (per wrong answer)</Label>
        <Input id="negativeMarking" name="negativeMarking" type="number" step="0.05" min={0} max={1} defaultValue={0.25} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="accessType">Access</Label>
        <SelectNative id="accessType" name="accessType" defaultValue="FREE">
          <option value="FREE">Free</option>
          <option value="PAID">Paid</option>
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="availableFrom">Available From (IST, optional)</Label>
        <Input id="availableFrom" name="availableFrom" type="datetime-local" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="attemptPolicy">Attempt Policy</Label>
        <SelectNative id="attemptPolicy" name="attemptPolicy" defaultValue="MULTIPLE_PRACTICE">
          <option value="MULTIPLE_PRACTICE">Multiple Practice Attempts</option>
          <option value="SINGLE_ATTEMPT">Single Attempt</option>
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
        <Label htmlFor="description">Description (optional)</Label>
        <Input id="description" name="description" />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
        <Label htmlFor="instructions">Instructions (optional)</Label>
        <textarea
          id="instructions"
          name="instructions"
          rows={2}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        />
      </div>
      <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-3">
        <SubmitButton />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Mock test created — add questions from its detail page.</p> : null}
      </div>
    </form>
  );
}
