"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormTextarea } from "@/components/admin/FormTextarea";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { updateHomepageContentAction, type FormState } from "./actions";

export function ContentTab({
  content,
}: {
  content: {
    heroEyebrow: string;
    heroHeading: string;
    heroDescription: string;
    finalCtaHeading: string;
    finalCtaBody: string;
    finalCtaNote: string | null;
  };
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    updateHomepageContentAction,
    undefined,
  );

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4">
      <FormField label="Hero eyebrow" name="heroEyebrow" defaultValue={content.heroEyebrow} required />
      <FormTextarea
        label="Hero heading (use a line break for the two-line hero title)"
        name="heroHeading"
        defaultValue={content.heroHeading}
        required
      />
      <FormTextarea
        label="Hero description"
        name="heroDescription"
        defaultValue={content.heroDescription}
        required
      />
      <FormField
        label="Final CTA heading"
        name="finalCtaHeading"
        defaultValue={content.finalCtaHeading}
        required
      />
      <FormTextarea
        label="Final CTA body"
        name="finalCtaBody"
        defaultValue={content.finalCtaBody}
        required
      />
      <FormField
        label="Final CTA note (optional)"
        name="finalCtaNote"
        defaultValue={content.finalCtaNote ?? ""}
      />
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">Save content</SubmitButton>
    </form>
  );
}
