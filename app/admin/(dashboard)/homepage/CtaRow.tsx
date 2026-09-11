"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { updateCtaButtonAction, type FormState } from "./actions";

const VARIANTS = [
  { value: "primary", label: "Primary" },
  { value: "secondary", label: "Secondary" },
  { value: "accent", label: "Accent" },
  { value: "ghost", label: "Ghost" },
];

export function CtaRow({
  slot,
  label,
  cta,
}: {
  slot: string;
  label: string;
  cta: { label: string; href: string; variant: string; isActive: boolean } | null;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(updateCtaButtonAction, undefined);

  return (
    <form
      action={formAction}
      className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] items-end gap-3 rounded-[10px] border border-border bg-surface p-4"
    >
      <input type="hidden" name="slot" value={slot} />
      <p className="col-span-full text-[13px] font-bold text-text-heading">{label}</p>
      <FormField label="Label" name="label" defaultValue={cta?.label ?? ""} required />
      <FormField label="Link (href)" name="href" defaultValue={cta?.href ?? ""} required />
      <FormSelect label="Style" name="variant" defaultValue={cta?.variant ?? "primary"} options={VARIANTS} />
      <label className="flex items-center gap-2 pb-2.5 text-sm font-semibold text-text-muted">
        <input type="checkbox" name="isActive" defaultChecked={cta?.isActive ?? true} className="size-4 accent-primary" />
        Active
      </label>
      <SubmitButton className="w-fit px-5">Save</SubmitButton>
      {state?.error ? <p className="col-span-full text-sm text-error">{state.error}</p> : null}
    </form>
  );
}
