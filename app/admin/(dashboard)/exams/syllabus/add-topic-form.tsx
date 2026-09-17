"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTopicAction, type TopicFormState } from "../topics/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="compact" variant="outline" disabled={pending}>
      {pending ? "Adding…" : "Add Chapter/Topic"}
    </Button>
  );
}

export function AddTopicForm({ subjectId }: { subjectId: string }) {
  const [state, formAction] = useActionState<TopicFormState, FormData>(createTopicAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="subjectId" value={subjectId} />
      <Input name="name" required placeholder="Chapter / Topic name" className="max-w-xs" />
      <SubmitButton />
      {state.error ? <p className="text-xs text-[var(--color-error)]">{state.error}</p> : null}
    </form>
  );
}
