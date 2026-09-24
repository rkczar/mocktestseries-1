"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createMockTestAction, type MockTestFormState } from "./actions";
import { MockTestFields, type CoverageSubject } from "./mock-test-fields";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save Draft & Add Questions"}
    </Button>
  );
}

/**
 * Creates a Mock Test as a DRAFT and opens its editor (questions, schedule,
 * resources, publish). When rendered inside a Test Series, the exam/series
 * are fixed so coverage can be picked from that exam's syllabus right away.
 */
export function MockTestForm({
  exams,
  testSeries,
  defaultExamId,
  defaultTestSeriesId,
  lockToSeries = false,
  subjects = [],
  nextTestNumber,
}: {
  exams: { id: string; name: string }[];
  testSeries: { id: string; name: string; examId: string }[];
  defaultExamId?: string;
  defaultTestSeriesId?: string;
  lockToSeries?: boolean;
  subjects?: CoverageSubject[];
  nextTestNumber?: number;
}) {
  const [state, formAction] = useActionState<MockTestFormState, FormData>(createMockTestAction, {});

  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {lockToSeries ? (
        <>
          <input type="hidden" name="examId" value={defaultExamId} />
          <input type="hidden" name="testSeriesId" value={defaultTestSeriesId} />
        </>
      ) : (
        <>
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
            <Label htmlFor="testSeriesId">Test Series</Label>
            <SelectNative id="testSeriesId" name="testSeriesId" defaultValue={defaultTestSeriesId ?? ""}>
              <option value="">Standalone mock test</option>
              {testSeries.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="hidden lg:block" />
        </>
      )}
      <MockTestFields v={{ order: nextTestNumber ?? null }} subjects={subjects} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="availableFrom">Release date (IST, optional)</Label>
        <Input id="availableFrom" name="availableFrom" type="datetime-local" />
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Blank = available as soon as it is published.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="attemptPolicy">Attempt policy</Label>
        <SelectNative id="attemptPolicy" name="attemptPolicy" defaultValue="MULTIPLE_PRACTICE">
          <option value="MULTIPLE_PRACTICE">Multiple practice attempts</option>
          <option value="SINGLE_ATTEMPT">Single attempt</option>
        </SelectNative>
      </div>
      <div className="flex flex-wrap items-end gap-3 sm:col-span-2 lg:col-span-3">
        <SubmitButton />
        <p className="text-xs text-[var(--color-muted-foreground)]">Created as a Draft — publish after assigning questions.</p>
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
      </div>
    </form>
  );
}
