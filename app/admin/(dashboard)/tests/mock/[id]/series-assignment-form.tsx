"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { setMockSeriesAssignmentAction, type MockTestFormState } from "../actions";

export interface SeriesOption {
  id: string;
  name: string;
  status: string;
  /** Purchasable plans that unlock a PAID mock in this series (empty = none). */
  plans: string[];
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending || disabled}>
      {pending ? "Saving…" : "Save Assignment"}
    </Button>
  );
}

/** Test Series / Course Assignment — Standalone (default) or an explicit series of this exam. */
export function SeriesAssignmentForm({
  mockTestId,
  currentSeriesId,
  options,
  accessType,
  readOnly,
}: {
  mockTestId: string;
  currentSeriesId: string | null;
  options: SeriesOption[];
  accessType: "FREE" | "PAID";
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<MockTestFormState, FormData>(setMockSeriesAssignmentAction.bind(null, mockTestId), {});
  const [mode, setMode] = useState<"STANDALONE" | "SERIES">(currentSeriesId ? "SERIES" : "STANDALONE");
  const [seriesId, setSeriesId] = useState(currentSeriesId ?? "");
  const picked = options.find((o) => o.id === seriesId) ?? null;
  const unchanged = (mode === "STANDALONE" && !currentSeriesId) || (mode === "SERIES" && seriesId === currentSeriesId);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2" disabled={readOnly}>
        <legend className="sr-only">Test Series assignment</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="assignment" value="STANDALONE" checked={mode === "STANDALONE"} onChange={() => setMode("STANDALONE")} />
          Standalone / No Test Series
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="assignment" value="SERIES" checked={mode === "SERIES"} onChange={() => setMode("SERIES")} disabled={options.length === 0} />
          Assign to Test Series {options.length === 0 ? <span className="text-xs text-[var(--color-muted-foreground)]">(this exam has no Test Series yet)</span> : null}
        </label>
        {mode === "SERIES" ? (
          <SelectNative name="testSeriesId" value={seriesId} onChange={(e) => setSeriesId(e.target.value)} className="max-w-md" aria-label="Test Series">
            <option value="" disabled>
              Select a Test Series of this exam
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {o.status}
              </option>
            ))}
          </SelectNative>
        ) : null}
      </fieldset>
      {mode === "SERIES" && picked ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {picked.plans.length > 0
            ? `Covered by: ${picked.plans.join(", ")}. Students who own it get this mock automatically — no per-mock access is created.`
            : "No purchasable plan covers this series — a PAID mock here still can't be unlocked by students."}
          {picked.id !== currentSeriesId ? " It is appended as the series' next Test Number." : ""}
        </p>
      ) : null}
      {mode === "SERIES" && picked && accessType === "PAID" && picked.plans.length > 0 && picked.id !== currentSeriesId ? (
        <p className="text-xs text-[var(--color-warning)]">This is a PAID mock: joining a paid series makes it part of that paid plan.</p>
      ) : null}
      {readOnly ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">View only — only a Master Admin can change the assignment.</p>
      ) : (
        <div className="flex items-center gap-3">
          <SaveButton disabled={unchanged || (mode === "SERIES" && !seriesId)} />
          {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
          {state.success ? <p className="text-sm text-[var(--color-success)]">Assignment saved — access updates immediately.</p> : null}
        </div>
      )}
    </form>
  );
}
