"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { updateMockTestScheduleAction, type ScheduleFormState } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save Schedule"}
    </Button>
  );
}

export function ScheduleForm({
  mockTestId,
  availableFromValue,
  attemptPolicy,
}: {
  mockTestId: string;
  availableFromValue: string;
  attemptPolicy: string;
}) {
  const action = updateMockTestScheduleAction.bind(null, mockTestId);
  const [state, formAction] = useActionState<ScheduleFormState, FormData>(action, {});

  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="availableFrom">Available From (IST)</Label>
        <Input id="availableFrom" name="availableFrom" type="datetime-local" defaultValue={availableFromValue} />
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Leave blank to make available immediately once Published. Once available, the test stays available
          indefinitely — there is no closing time.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="attemptPolicy">Attempt Policy</Label>
        <SelectNative id="attemptPolicy" name="attemptPolicy" defaultValue={attemptPolicy}>
          <option value="MULTIPLE_PRACTICE">Multiple Practice Attempts</option>
          <option value="SINGLE_ATTEMPT">Single Attempt</option>
        </SelectNative>
      </div>
      <div className="flex items-end gap-3 sm:col-span-2">
        <SubmitButton />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Schedule saved.</p> : null}
      </div>
    </form>
  );
}
