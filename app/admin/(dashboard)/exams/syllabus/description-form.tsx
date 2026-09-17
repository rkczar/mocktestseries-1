"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import type { DescriptionFormState } from "./actions";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="compact" variant="outline" disabled={pending}>
      {pending ? "Saving…" : "Save description"}
    </Button>
  );
}

/** Generic syllabus-description editor reused at Exam/Subject/Topic level — differs only by which id field and action are bound to it. */
export function DescriptionForm({
  action,
  idField,
  idValue,
  defaultValue,
  placeholder,
}: {
  action: (prev: DescriptionFormState, formData: FormData) => Promise<DescriptionFormState>;
  idField: string;
  idValue: string;
  defaultValue: string | null;
  placeholder: string;
}) {
  const [state, formAction] = useActionState<DescriptionFormState, FormData>(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name={idField} value={idValue} />
      <textarea
        name="description"
        rows={2}
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
        className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
      />
      <div className="flex items-center gap-2">
        <SaveButton />
        {state.error ? <p className="text-xs text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-xs text-[var(--color-success)]">Saved.</p> : null}
      </div>
    </form>
  );
}
