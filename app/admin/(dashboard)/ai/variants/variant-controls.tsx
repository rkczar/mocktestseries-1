"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateMissingVariantsAction, archiveVariantAction, publishVariantAction, type VariantActionState } from "./actions";

function SubmitButton({ label, pendingLabel, variant }: { label: string; pendingLabel: string; variant?: "outline" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function ActionResult({ state }: { state: VariantActionState }) {
  if (state.error) {
    return (
      <p className="flex items-center gap-1 text-xs text-[var(--color-error)]">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {state.error}
      </p>
    );
  }
  return state.success ? <p className="text-xs text-[var(--color-success)]">{state.success}</p> : null;
}

export function GenerateMissingControl({ parentQuestionId }: { parentQuestionId: string }) {
  const [state, formAction] = useActionState<VariantActionState, FormData>(generateMissingVariantsAction.bind(null, parentQuestionId), {});
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <SubmitButton label="Generate missing variants" pendingLabel="Generating…" />
      <ActionResult state={state} />
    </form>
  );
}

export function ArchiveVariantControl({ variantId, parentQuestionId }: { variantId: string; parentQuestionId: string }) {
  const [state, formAction] = useActionState<VariantActionState, FormData>(archiveVariantAction.bind(null, variantId, parentQuestionId), {});
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <SubmitButton label="Archive" pendingLabel="Archiving…" variant="outline" />
      <ActionResult state={state} />
    </form>
  );
}

export function PublishVariantControl({ variantId, parentQuestionId, label }: { variantId: string; parentQuestionId: string; label: string }) {
  const [state, formAction] = useActionState<VariantActionState, FormData>(publishVariantAction.bind(null, variantId, parentQuestionId), {});
  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <SubmitButton label={label} pendingLabel="Saving…" variant="outline" />
      <ActionResult state={state} />
    </form>
  );
}
