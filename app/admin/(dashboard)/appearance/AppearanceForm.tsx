"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { BODY_FONTS, DISPLAY_FONTS, type AppearanceDTO } from "@/lib/appearance";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { updateAppearanceAction, type FormState } from "./actions";

function ColorField({ label, name, defaultValue }: { label: string; name: string; defaultValue: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-bold text-text-muted">{label}</span>
      <div className="flex items-center gap-2.5">
        <input
          type="color"
          name={name}
          defaultValue={defaultValue}
          className="size-10 flex-none cursor-pointer rounded-[8px] border border-border-strong bg-transparent p-0.5"
        />
        <span className="font-mono text-sm text-text-faint">{defaultValue}</span>
      </div>
    </label>
  );
}

export function AppearanceForm({ appearance }: { appearance: AppearanceDTO }) {
  const [state, formAction] = useActionState<FormState, FormData>(updateAppearanceAction, undefined);

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <ColorField label="Primary (buttons, links, header)" name="primaryColor" defaultValue={appearance.primaryColor} />
        <ColorField label="Accent (eyebrows, highlights)" name="accentColor" defaultValue={appearance.accentColor} />
        <ColorField label="Success" name="successColor" defaultValue={appearance.successColor} />
        <ColorField label="Error" name="errorColor" defaultValue={appearance.errorColor} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormSelect
          label="Display / heading font"
          name="fontDisplay"
          defaultValue={appearance.fontDisplay}
          options={Object.keys(DISPLAY_FONTS).map((f) => ({ value: f, label: f }))}
        />
        <FormSelect
          label="Body / UI font"
          name="fontBody"
          defaultValue={appearance.fontBody}
          options={Object.keys(BODY_FONTS).map((f) => ({ value: f, label: f }))}
        />
      </div>

      <FormField
        label="Button corner radius (px)"
        name="buttonRadiusPx"
        type="number"
        defaultValue={appearance.buttonRadiusPx}
      />

      <p className="text-xs text-text-faint">
        Applies to the public site only — this doesn&apos;t change the Admin Panel&apos;s own
        layout or container widths.
      </p>

      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">Save appearance</SubmitButton>
    </form>
  );
}
