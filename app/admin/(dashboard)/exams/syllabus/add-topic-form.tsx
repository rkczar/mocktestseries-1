"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTopicAction, linkTopicAction, type TopicFormState } from "../topics/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="compact" variant="outline" disabled={pending}>
      {pending ? "Adding…" : "Add Chapter/Topic"}
    </Button>
  );
}

export function AddTopicForm({ subjectId, examId }: { subjectId: string; examId: string }) {
  const router = useRouter();
  const [state, formAction] = useActionState<TopicFormState, FormData>(createTopicAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [linkedFor, setLinkedFor] = useState<{ for: TopicFormState; text: string } | null>(null);
  const linked = linkedFor?.for === state ? linkedFor.text : null;
  const [isLinking, startLink] = useTransition();

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  const useExisting = () => {
    const existing = state.existing;
    if (!existing) return;
    startLink(async () => {
      await linkTopicAction(examId, existing.id);
      setLinkedFor({ for: state, text: `Linked existing "${existing.name}".` });
      formRef.current?.reset();
      router.refresh();
    });
  };

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="subjectId" value={subjectId} />
      <input type="hidden" name="examId" value={examId} />
      <Input name="name" required placeholder="Chapter / Topic name" className="max-w-xs" aria-label="Chapter or topic name" />
      <SubmitButton />
      {state.error ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-error)]">
          {state.error}
          {state.existing && !linked ? (
            <Button type="button" size="compact" variant="outline" onClick={useExisting} disabled={isLinking}>
              {isLinking ? "Linking…" : "Use Existing"}
            </Button>
          ) : null}
        </p>
      ) : null}
      {linked ? <p className="text-xs text-[var(--color-success)]">{linked}</p> : null}
    </form>
  );
}
