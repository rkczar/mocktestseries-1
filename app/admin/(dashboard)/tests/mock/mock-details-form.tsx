"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { updateMockTestDetailsAction, type MockTestFormState } from "./actions";
import { MockTestFields, type CoverageSubject, type MockTestFieldValues } from "./mock-test-fields";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save Details"}
    </Button>
  );
}

export function MockDetailsForm({ mockTestId, values, subjects }: { mockTestId: string; values: MockTestFieldValues; subjects: CoverageSubject[] }) {
  const [state, formAction] = useActionState<MockTestFormState, FormData>(updateMockTestDetailsAction.bind(null, mockTestId), {});
  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <MockTestFields v={values} subjects={subjects} />
      <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-3">
        <SaveButton />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved — public and student pages updated.</p> : null}
      </div>
    </form>
  );
}
