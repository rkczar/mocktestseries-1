"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createExamAction, type ExamFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create Exam"}
    </Button>
  );
}

export function ExamForm() {
  const [state, formAction] = useActionState<ExamFormState, FormData>(createExamAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Exam Name</Label>
        <Input id="name" name="name" required placeholder="RUHS Medical Officer" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code">Exam Code</Label>
        <Input id="code" name="code" required placeholder="RUHS-MO" className="uppercase" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="year">Exam Year</Label>
        <Input id="year" name="year" type="number" placeholder="2026" />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
        <Label htmlFor="description">Description</Label>
        <Input id="description" name="description" placeholder="Optional" />
      </div>
      <div className="flex items-end sm:col-span-2 lg:col-span-4">
        <SubmitButton />
        {state.error ? <p className="ml-3 text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="ml-3 text-sm text-[var(--color-success)]">Exam created.</p> : null}
      </div>
    </form>
  );
}
