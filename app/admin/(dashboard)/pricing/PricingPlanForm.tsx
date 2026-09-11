"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormTextarea } from "@/components/admin/FormTextarea";
import { SubmitButton } from "@/components/auth/SubmitButton";

import type { FormState } from "./actions";

type PricingPlan = {
  id: string;
  name: string;
  priceInPaise: number;
  period: string;
  description: string;
  features: string[];
  isPopular: boolean;
  isActive: boolean;
  order: number;
  ctaLabel: string;
};

export function PricingPlanForm({
  plan,
  action,
  submitLabel,
}: {
  plan?: PricingPlan;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4">
      {plan ? <input type="hidden" name="id" value={plan.id} /> : null}
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Name" name="name" defaultValue={plan?.name ?? ""} required />
        <FormField label="CTA label" name="ctaLabel" defaultValue={plan?.ctaLabel ?? "Get started"} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField
          label="Price (₹, 0 for free)"
          name="priceInRupees"
          type="number"
          defaultValue={plan ? plan.priceInPaise / 100 : 0}
          required
        />
        <FormField label="Period (e.g. one-time, forever, yearly)" name="period" defaultValue={plan?.period ?? "one-time"} required />
      </div>
      <FormTextarea label="Description" name="description" defaultValue={plan?.description ?? ""} required />
      <FormTextarea
        label="Features (one per line)"
        name="features"
        defaultValue={plan?.features.join("\n") ?? ""}
        rows={5}
      />
      <FormField label="Order" name="order" type="number" defaultValue={plan?.order ?? 0} />
      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
          <input type="checkbox" name="isPopular" defaultChecked={plan?.isPopular ?? false} className="size-4 accent-primary" />
          Most popular
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
          <input type="checkbox" name="isActive" defaultChecked={plan?.isActive ?? true} className="size-4 accent-primary" />
          Active
        </label>
      </div>
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">{submitLabel}</SubmitButton>
    </form>
  );
}
