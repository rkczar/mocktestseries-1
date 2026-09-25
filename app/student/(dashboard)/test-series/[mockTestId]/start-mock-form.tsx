"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startMockTestFromDetailsAction, type StartMockTestFormState } from "../actions";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Starting…" : (
        <>
          {label} <ArrowRight className="h-4 w-4" aria-hidden />
        </>
      )}
    </Button>
  );
}

/** Start/Resume on the Mock Test Details page — the server action is the real gate; errors render inline. */
export function StartMockForm({ mockTestId, label }: { mockTestId: string; label: string }) {
  const [state, formAction] = useActionState<StartMockTestFormState, FormData>(startMockTestFromDetailsAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="mockTestId" value={mockTestId} />
      <SubmitButton label={label} />
      {state.error ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
        </p>
      ) : null}
    </form>
  );
}
