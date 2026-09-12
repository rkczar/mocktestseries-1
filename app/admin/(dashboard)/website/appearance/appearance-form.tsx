"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import type { ResolvedAppearance } from "@/lib/appearance";
import { saveAppearanceAction, type AppearanceFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save Appearance"}</Button>;
}

function ColorField({ id, label, defaultValue }: { id: string; label: string; defaultValue: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={id}
          type="color"
          defaultValue={defaultValue}
          className="h-10 w-12 cursor-pointer rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)]"
        />
        <span className="text-xs text-[var(--color-muted-foreground)]">{defaultValue}</span>
      </div>
    </div>
  );
}

export function AppearanceForm({ appearance }: { appearance: ResolvedAppearance }) {
  const [state, formAction] = useActionState<AppearanceFormState, FormData>(saveAppearanceAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-8">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">Colors</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <ColorField id="primary" label="Primary" defaultValue={appearance.colors.primary} />
          <ColorField id="secondary" label="Secondary" defaultValue={appearance.colors.secondary} />
          <ColorField id="accent" label="Accent" defaultValue={appearance.colors.accent} />
          <ColorField id="success" label="Success" defaultValue={appearance.colors.success} />
          <ColorField id="error" label="Error" defaultValue={appearance.colors.error} />
          <ColorField id="warning" label="Warning" defaultValue={appearance.colors.warning} />
          <ColorField id="info" label="Info" defaultValue={appearance.colors.info} />
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">Typography</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="headingFont">Heading font stack</Label>
            <Input id="headingFont" name="headingFont" defaultValue={appearance.fonts.heading} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bodyFont">Body font stack</Label>
            <Input id="bodyFont" name="bodyFont" defaultValue={appearance.fonts.body} />
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-foreground)]">Buttons &amp; Components</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="buttonRadius">Button radius</Label>
            <SelectNative id="buttonRadius" name="buttonRadius" defaultValue={appearance.buttonStyle.radius}>
              <option value="0rem">Square</option>
              <option value="0.375rem">Slightly rounded</option>
              <option value="0.5rem">Rounded</option>
              <option value="1rem">Pill</option>
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cardRadius">Card radius</Label>
            <SelectNative id="cardRadius" name="cardRadius" defaultValue={appearance.componentStyle.cardRadius}>
              <option value="0rem">Square</option>
              <option value="0.5rem">Rounded</option>
              <option value="0.75rem">Soft</option>
              <option value="1.25rem">Extra soft</option>
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shadowIntensity">Shadow intensity</Label>
            <SelectNative id="shadowIntensity" name="shadowIntensity" defaultValue={appearance.componentStyle.shadowIntensity}>
              <option value="none">None</option>
              <option value="sm">Subtle</option>
              <option value="md">Medium</option>
            </SelectNative>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved — live across the site immediately.</p> : null}
      </div>
    </form>
  );
}
