"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { updateMockTestDetailsAction, type MockTestFormState } from "./actions";
import { MockTestFields, type CoverageSubject, type MockTestFieldValues } from "./mock-test-fields";

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled}>
      {pending ? "Saving…" : "Save Details"}
    </Button>
  );
}

/** Step 1 (Basic Details) + Step 2 (Coverage) of the canonical Mock Test editor. */
export function MockDetailsForm({
  mockTestId,
  values,
  subjects,
  readOnly,
}: {
  mockTestId: string;
  values: MockTestFieldValues;
  subjects: CoverageSubject[];
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<MockTestFormState, FormData>(updateMockTestDetailsAction.bind(null, mockTestId), {});
  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <fieldset className="contents" disabled={readOnly}>
        <MockTestFields v={values} subjects={subjects} />
      </fieldset>
      <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-3">
        <SaveButton disabled={readOnly} />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved — public and student pages updated.</p> : null}
      </div>
    </form>
  );
}
