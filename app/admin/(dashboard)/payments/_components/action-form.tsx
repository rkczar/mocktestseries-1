"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FormState } from "../actions";

function Submit({ label, disabled, variant }: { label: string; disabled?: boolean; variant?: "primary" | "outline" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant ?? "primary"} disabled={pending || disabled}>
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {label}
    </Button>
  );
}

/**
 * Thin client wrapper around a payments Server Action. `readOnly` (FULL_ADMIN)
 * disables every control in the UI; the action itself still rejects with
 * FORBIDDEN server-side if called anyway.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  readOnly,
  variant,
  className,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children?: ReactNode;
  submitLabel: string;
  readOnly?: boolean;
  variant?: "primary" | "outline" | "danger";
  className?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className ?? "flex flex-col gap-3"}>
      <fieldset disabled={readOnly} className="contents">
        {children}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Submit label={submitLabel} disabled={readOnly} variant={variant} />
        {state.error ? (
          <p className="text-xs text-[var(--color-error)]" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.success ? (
          <p className="text-xs text-[var(--color-success)]" aria-live="polite">
            {state.success}
          </p>
        ) : null}
      </div>
    </form>
  );
}
