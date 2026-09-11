"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { SubmitButton } from "@/components/auth/SubmitButton";

import type { FormState } from "./actions";

type Announcement = {
  id: string;
  tag: string | null;
  message: string;
  linkLabel: string | null;
  linkHref: string | null;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
};

function toDateInput(date: Date | null) {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

export function AnnouncementForm({
  announcement,
  action,
  submitLabel,
}: {
  announcement?: Announcement;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4">
      {announcement ? <input type="hidden" name="id" value={announcement.id} /> : null}
      <FormField label="Tag (optional, e.g. New)" name="tag" defaultValue={announcement?.tag ?? ""} />
      <FormField label="Message" name="message" defaultValue={announcement?.message ?? ""} required />
      <FormField
        label="Link label (optional)"
        name="linkLabel"
        defaultValue={announcement?.linkLabel ?? ""}
      />
      <FormField label="Link href (optional)" name="linkHref" defaultValue={announcement?.linkHref ?? ""} />
      <div className="grid grid-cols-2 gap-4">
        <FormField
          label="Starts (optional)"
          name="startsAt"
          type="date"
          defaultValue={toDateInput(announcement?.startsAt ?? null)}
        />
        <FormField
          label="Ends (optional)"
          name="endsAt"
          type="date"
          defaultValue={toDateInput(announcement?.endsAt ?? null)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={announcement?.isActive ?? true}
          className="size-4 accent-primary"
        />
        Active
      </label>
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">{submitLabel}</SubmitButton>
    </form>
  );
}
