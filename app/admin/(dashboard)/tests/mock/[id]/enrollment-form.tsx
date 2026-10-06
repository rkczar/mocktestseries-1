"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateMockTestEnrollmentAction, type ScheduleFormState } from "../actions";

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled}>
      {pending ? "Saving…" : "Save Enrollment"}
    </Button>
  );
}

/** Live CBT → Enrollment (Enabled / Opens / Closes / public count) + share link. */
export function EnrollmentForm({
  mockTestId,
  values,
  enrolledCount,
  shareUrl,
  readOnly,
}: {
  mockTestId: string;
  values: { enrollmentEnabled: boolean; showEnrolledCount: boolean; opensAtValue: string; closesAtValue: string };
  enrolledCount: number;
  shareUrl: string;
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState<ScheduleFormState, FormData>(updateMockTestEnrollmentAction.bind(null, mockTestId), {});
  const [copied, setCopied] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-foreground)]" data-testid="admin-enrolled-count">
        Enrolled Students: <strong>{enrolledCount.toLocaleString("en-IN")}</strong>
      </p>
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2" disabled={readOnly}>
        <label className="flex items-start gap-2 text-sm text-[var(--color-foreground)] sm:col-span-2">
          <input type="checkbox" name="enrollmentEnabled" defaultChecked={values.enrollmentEnabled} className="mt-1" />
          <span>
            <span className="font-medium">Enrollment Enabled</span>
            <span className="block text-xs text-[var(--color-muted-foreground)]">
              On: students must enroll on the test page before they can start (enrolling never starts the test). Off: normal Mock Test behaviour.
            </span>
          </span>
        </label>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="enrollmentOpensAt">Enrollment Opens (IST)</Label>
          <Input id="enrollmentOpensAt" name="enrollmentOpensAt" type="datetime-local" defaultValue={values.opensAtValue} />
          <p className="text-[11px] text-[var(--color-muted-foreground)]">Blank = open now.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="enrollmentClosesAt">Enrollment Closes (IST)</Label>
          <Input id="enrollmentClosesAt" name="enrollmentClosesAt" type="datetime-local" defaultValue={values.closesAtValue} />
          <p className="text-[11px] text-[var(--color-muted-foreground)]">Blank = when the test window closes (late joiners can enroll and start while it is live).</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)] sm:col-span-2">
          <input type="checkbox" name="showEnrolledCount" defaultChecked={values.showEnrolledCount} />
          Show &quot;X students enrolled&quot; on the student test page (a count only — never names)
        </label>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="shareUrl">Shareable campaign link</Label>
        <div className="flex gap-2">
          <Input id="shareUrl" readOnly value={shareUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Opens the test page; signed-out visitors log in or register and return to this test.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton disabled={readOnly} />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      </div>
    </form>
  );
}
