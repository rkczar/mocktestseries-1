"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { LastUpdatedConfig, LastUpdatedMode } from "@/lib/site-last-updated";
import { saveLastUpdatedAction, type LastUpdatedFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} data-testid="last-updated-save">
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

const MODES: { value: LastUpdatedMode; title: string; description: string }[] = [
  { value: "AUTOMATIC", title: "Automatic", description: "Latest successful deployment or public content change." },
  { value: "MANUAL", title: "Manual", description: "Always show the date you pick below." },
];

export function LastUpdatedForm({
  config,
  canManage,
  automatic,
  maxDate,
}: {
  config: LastUpdatedConfig;
  canManage: boolean;
  /** What Automatic mode shows right now, and the two timestamps behind it (already formatted in IST). */
  automatic: { label: string | null; deployedAt: string | null; contentChangedAt: string | null };
  /** Today in IST (YYYY-MM-DD): a manual date can't be in the future. */
  maxDate: string;
}) {
  const [state, formAction] = useActionState<LastUpdatedFormState, FormData>(saveLastUpdatedAction, {});
  const [mode, setMode] = useState<LastUpdatedMode>(config.mode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Last Updated Date</CardTitle>
        <CardDescription>
          &quot;Last Updated: DD Month YYYY&quot; at the very bottom of the site footer, in India Standard Time. Changes apply on the
          next page load — no deployment needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" data-testid="last-updated-form">
          <div className="flex items-center justify-between gap-4 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <label htmlFor="last-updated-show" className="text-sm font-medium text-[var(--color-foreground)]">
                Show Last Updated
              </label>
              <p className="text-xs text-[var(--color-muted-foreground)]">Hide or show the line in the footer.</p>
            </div>
            <Switch id="last-updated-show" name="show" defaultChecked={config.show} disabled={!canManage} />
          </div>

          <fieldset className="flex flex-col gap-2" disabled={!canManage}>
            <legend className="mb-1.5 text-sm font-medium text-[var(--color-foreground)]">Date Mode</legend>
            {MODES.map((m) => (
              <label
                key={m.value}
                className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5"
              >
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={mode === m.value}
                  onChange={() => setMode(m.value)}
                  className="mt-0.5"
                  data-testid={`last-updated-mode-${m.value.toLowerCase()}`}
                />
                <span>
                  <span className="block text-sm font-medium text-[var(--color-foreground)]">{m.title}</span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">{m.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="last-updated-manual-date" className="text-sm font-medium text-[var(--color-foreground)]">
              Manual Date
            </label>
            <Input
              id="last-updated-manual-date"
              name="manualDate"
              type="date"
              max={maxDate}
              defaultValue={config.manualDate}
              disabled={!canManage}
              required={mode === "MANUAL"}
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">Used only in Manual mode.</p>
          </div>

          <div className="rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-xs text-[var(--color-muted-foreground)]" data-testid="last-updated-automatic">
            <p>
              Automatic date now: <span className="font-medium text-[var(--color-foreground)]">{automatic.label ?? "—"}</span>
            </p>
            <p>Latest successful deployment: {automatic.deployedAt ?? "not recorded for this release"}</p>
            <p>Latest public content change: {automatic.contentChangedAt ?? "none recorded"}</p>
          </div>

          {canManage ? (
            <CardFooter className="flex-wrap items-center gap-3 p-0">
              <SubmitButton />
              {state.error ? <p role="status" className="text-xs text-[var(--color-error)]">{state.error}</p> : null}
              {state.success ? <p role="status" className="text-xs text-[var(--color-success)]">Saved.</p> : null}
            </CardFooter>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)]">View only — MASTER_ADMIN can change this setting.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
