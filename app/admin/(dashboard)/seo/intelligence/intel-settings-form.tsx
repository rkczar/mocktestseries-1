"use client";

import { useActionState } from "react";
import { PendingSubmitButton } from "@/components/ui/pending-submit-button";
import { Input } from "@/components/ui/input";
import { saveIntelSettingsAction, type SeoIntelActionState } from "./actions";

/** MASTER_ADMIN only (rendered for SEO_INTEL_MANAGE; the action re-checks it). */
export function IntelSettingsForm({ autoSyncEnabled, historyDays, min, max }: { autoSyncEnabled: boolean; historyDays: number; min: number; max: number }) {
  const [state, action] = useActionState<SeoIntelActionState, FormData>(saveIntelSettingsAction, {});
  return (
    <form action={action} className="flex flex-col gap-3" data-testid="seo-intel-settings-form">
      <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
        <input type="checkbox" name="autoSyncEnabled" defaultChecked={autoSyncEnabled} className="h-4 w-4" />
        Daily automatic sync (03:10 IST)
      </label>
      <label className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-foreground)]">
        Keep daily history for
        <Input name="historyDays" type="number" min={min} max={max} step={1} defaultValue={historyDays} required className="h-8 w-24" aria-label="History retention in days" />
        days
      </label>
      <div>
        <PendingSubmitButton size="sm" variant="secondary" pendingLabel="Saving…">
          Save
        </PendingSubmitButton>
      </div>
      {state.message ? (
        <p role="status" className={`text-sm ${state.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
