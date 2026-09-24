"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateTestSeriesAction, type TestSeriesFormState } from "./actions";

function SaveButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save Series"}</Button>;
}

const textareaClass =
  "w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)]";

export function SeriesSettingsForm({
  series,
}: {
  series: { id: string; name: string; slug: string | null; description: string | null; instructions: string | null; testCount: number; order: number };
}) {
  const [state, formAction] = useActionState<TestSeriesFormState, FormData>(updateTestSeriesAction.bind(null, series.id), {});
  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="s-name">Series name (public H1)</Label>
        <Input id="s-name" name="name" required defaultValue={series.name} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="s-testCount">Planned mocks</Label>
        <Input id="s-testCount" name="testCount" type="number" min={0} defaultValue={series.testCount} />
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Shown as “N Mock Tests Planned” — never as available.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="s-order">Display order</Label>
        <Input id="s-order" name="order" type="number" min={0} defaultValue={series.order} />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="s-slug">Slug</Label>
        <Input id="s-slug" name="slug" defaultValue={series.slug ?? ""} placeholder="ruhs-mo-2026-mock-test-series" />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
        <Label htmlFor="s-description">Public description (hero text on the series page)</Label>
        <textarea id="s-description" name="description" rows={2} defaultValue={series.description ?? ""} className={textareaClass} />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
        <Label htmlFor="s-instructions">Series instructions</Label>
        <textarea id="s-instructions" name="instructions" rows={2} defaultValue={series.instructions ?? ""} className={textareaClass} />
      </div>
      <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-4">
        <SaveButton />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved — public pages updated.</p> : null}
      </div>
    </form>
  );
}
