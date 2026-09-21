"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { AiVariantType } from "@prisma/client";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateVariantAction, retryVariantAction, publishVariantAction, type VariantActionState } from "./actions";

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function GenerateVariantControl({ parentQuestionId, variantType }: { parentQuestionId: string; variantType: AiVariantType }) {
  const [state, formAction] = useActionState<VariantActionState, FormData>(
    generateVariantAction.bind(null, parentQuestionId, variantType),
    {}
  );
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <SubmitButton label={`Generate ${variantType === "AI_SIMILAR" ? "Similar" : "Trap"}`} pendingLabel="Generating…" />
      {state.error ? (
        <p className="flex items-center gap-1 text-xs text-[var(--color-error)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function PublishVariantControl({ variantId, parentQuestionId }: { variantId: string; parentQuestionId: string }) {
  const [state, formAction] = useActionState<VariantActionState, FormData>(
    publishVariantAction.bind(null, variantId, parentQuestionId),
    {}
  );
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <SubmitButton label="Publish to Question Bank" pendingLabel="Publishing…" />
      {state.error ? (
        <p className="flex items-center gap-1 text-xs text-[var(--color-error)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function RetryVariantControl({ variantId, parentQuestionId }: { variantId: string; parentQuestionId: string }) {
  const [state, formAction] = useActionState<VariantActionState, FormData>(
    retryVariantAction.bind(null, variantId, parentQuestionId),
    {}
  );
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <SubmitButton label="Retry" pendingLabel="Retrying…" />
      {state.error ? (
        <p className="flex items-center gap-1 text-xs text-[var(--color-error)]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {state.error}
        </p>
      ) : null}
    </form>
  );
}
