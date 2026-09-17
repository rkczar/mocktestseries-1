"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSubjectAction, type SubjectFormState } from "../subjects/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Adding…" : "Add Subject"}
    </Button>
  );
}

export function AddSubjectForm({ examId }: { examId: string }) {
  const [state, formAction] = useActionState<SubjectFormState, FormData>(createSubjectAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="examId" value={examId} />
      <Input name="name" required placeholder="Subject name (e.g. Physics)" className="max-w-xs" />
      <SubmitButton />
      {state.error ? <p className="text-xs text-[var(--color-error)]">{state.error}</p> : null}
    </form>
  );
}
