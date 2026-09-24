"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createMockTestAction, type MockTestFormState } from "./actions";
import { MockTestFields, type CoverageSubject } from "./mock-test-fields";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save Draft & Add Questions"}
    </Button>
  );
}

/**
 * Create form for the canonical Mock Test editor (Steps 1–2). The exam and
 * Test Series are already chosen by /admin/tests/mock/new — reached from
 * Admin → Tests → Create Mock Test or from a Test Series' "Add Mock Test" —
 * so coverage can be picked from that exam's syllabus right away. Questions,
 * schedule, access/result and publishing continue in the editor it opens.
 */
export function MockTestForm({
  examId,
  testSeriesId,
  subjects,
  nextTestNumber,
}: {
  examId: string;
  testSeriesId: string | null;
  subjects: CoverageSubject[];
  nextTestNumber?: number;
}) {
  const [state, formAction] = useActionState<MockTestFormState, FormData>(createMockTestAction, {});

  return (
    <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="examId" value={examId} />
      <input type="hidden" name="testSeriesId" value={testSeriesId ?? ""} />
      <MockTestFields v={{ order: nextTestNumber ?? null }} subjects={subjects} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="accessType">Access</Label>
        <SelectNative id="accessType" name="accessType" defaultValue="PAID">
          <option value="FREE">FREE — anyone signed in</option>
          <option value="PAID">PAID — Complete Series entitlement</option>
        </SelectNative>
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Changeable later in Step 5 — Access &amp; Result.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3 sm:col-span-2 lg:col-span-3">
        <SubmitButton />
        <p className="text-xs text-[var(--color-muted-foreground)]">Created as a Draft — next: add questions, schedule, then publish.</p>
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
      </div>
    </form>
  );
}
