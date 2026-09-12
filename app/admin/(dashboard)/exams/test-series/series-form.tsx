"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createTestSeriesAction, type TestSeriesFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add Test Series"}</Button>;
}

export function SeriesForm({ exams, defaultExamId }: { exams: { id: string; name: string }[]; defaultExamId?: string }) {
  const [state, formAction] = useActionState<TestSeriesFormState, FormData>(createTestSeriesAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  if (exams.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Create an exam first under Manage Exams.</p>;
  }

  return (
    <form ref={formRef} action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="examId">Exam</Label>
        <SelectNative id="examId" name="examId" defaultValue={defaultExamId} required>
          {exams.map((exam) => (
            <option key={exam.id} value={exam.id}>{exam.name}</option>
          ))}
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Series Name</Label>
        <Input id="name" name="name" required placeholder="50 Mock Tests" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="testCount">Number of Tests</Label>
        <Input id="testCount" name="testCount" type="number" defaultValue={0} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="description">Description</Label>
        <Input id="description" name="description" placeholder="Optional" />
      </div>
      <div className="flex items-end sm:col-span-2 lg:col-span-4">
        <SubmitButton />
        {state.error ? <p className="ml-3 text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="ml-3 text-sm text-[var(--color-success)]">Test series added.</p> : null}
      </div>
    </form>
  );
}
