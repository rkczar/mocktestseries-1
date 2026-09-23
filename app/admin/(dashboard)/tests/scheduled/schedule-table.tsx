"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toIstDateTimeLocalValue } from "@/lib/ist-time";
import { updateScheduleRowAction, type ScheduleRowFormState } from "./actions";
import type { MockTestStatus } from "@prisma/client";
import type { MockTestAvailability } from "@/lib/mock-test-schedule";

interface Row {
  id: string;
  title: string;
  order: number;
  status: MockTestStatus;
  availableFrom: Date | null;
  durationMinutes: number;
  availability: MockTestAvailability;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

function ScheduleRow({ row }: { row: Row }) {
  const action = updateScheduleRowAction.bind(null, row.id);
  const [state, formAction] = useActionState<ScheduleRowFormState, FormData>(action, {});

  return (
    <tr className="border-b border-[var(--color-border)] last:border-0">
      <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{row.order}</td>
      <td className="py-2 pr-4 font-medium text-[var(--color-foreground)]">{row.title}</td>
      <td className="py-2 pr-4">
        <Badge variant={row.availability === "AVAILABLE" ? "success" : "info"}>{row.availability}</Badge>
      </td>
      <td className="py-2 pr-4">
        <form action={formAction} className="flex flex-wrap items-center gap-2">
          <Input
            name="availableFrom"
            type="datetime-local"
            defaultValue={row.availableFrom ? toIstDateTimeLocalValue(row.availableFrom) : ""}
            className="w-[190px]"
          />
          <Input name="durationMinutes" type="number" min={1} defaultValue={row.durationMinutes} className="w-20" />
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
            <input type="checkbox" name="publish" defaultChecked={row.status === "PUBLISHED"} />
            Published
          </label>
          <SaveButton />
          {state.error ? <span className="text-xs text-[var(--color-error)]">{state.error}</span> : null}
          {state.success ? <span className="text-xs text-[var(--color-success)]">Saved</span> : null}
        </form>
      </td>
    </tr>
  );
}

export function ScheduleTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No tests in this series yet.</p>;
  }

  return (
    <table className="w-full min-w-[720px] text-left text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
          <th className="py-2 pr-4">No.</th>
          <th className="py-2 pr-4">Test</th>
          <th className="py-2 pr-4">Status</th>
          <th className="py-2 pr-4">Available From (IST) · Duration · Publish</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <ScheduleRow key={row.id} row={row} />
        ))}
      </tbody>
    </table>
  );
}
