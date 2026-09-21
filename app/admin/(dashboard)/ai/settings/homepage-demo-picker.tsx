"use client";

import { useActionState, useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HOMEPAGE_DEMO_MAX } from "@/lib/ai-demo-constants";
import { saveHomepageDemoSelectionAction, type SettingsFormState } from "./actions";
import { SubmitButton, SaveFeedback } from "./shared-controls";

export interface EligibleDemoQuestion {
  questionId: string;
  code: string;
  text: string;
  examName: string;
  subjectName: string;
}

export function HomepageDemoPicker({ eligible, selectedIds }: { eligible: EligibleDemoQuestion[]; selectedIds: string[] }) {
  const [state, formAction] = useActionState<SettingsFormState, FormData>(saveHomepageDemoSelectionAction, {});
  const [checked, setChecked] = useState<Set<string>>(new Set(selectedIds));

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < HOMEPAGE_DEMO_MAX) {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Homepage AI Demo Questions</CardTitle>
        <CardDescription>
          Pick up to {HOMEPAGE_DEMO_MAX} questions anonymous homepage visitors can browse in &quot;Ask AI in Action&quot;. Only
          questions with a completed, admin-reviewed, non-stale AI explanation are eligible — nothing here ever triggers a live AI
          call for an anonymous visitor. ({checked.size}/{HOMEPAGE_DEMO_MAX} selected)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {eligible.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">
            No eligible questions yet — mark an AI Solution &quot;Reviewed&quot; on the AI Solutions page first.
          </p>
        ) : (
          <form action={formAction} className="flex flex-col gap-1">
            {eligible.map((q) => (
              <label
                key={q.questionId}
                className="flex items-start gap-3 rounded-[var(--radius-button)] border border-transparent px-2 py-2 text-sm hover:border-[var(--color-border)]"
              >
                <input
                  type="checkbox"
                  name="questionId"
                  value={q.questionId}
                  checked={checked.has(q.questionId)}
                  onChange={() => toggle(q.questionId)}
                  disabled={!checked.has(q.questionId) && checked.size >= HOMEPAGE_DEMO_MAX}
                  className="mt-1"
                />
                <span className="flex flex-col">
                  <span className="flex items-center gap-2">
                    <Badge variant="neutral">{q.code}</Badge>
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      {q.examName} · {q.subjectName}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-1 text-[var(--color-foreground)]">{q.text}</span>
                </span>
              </label>
            ))}

            {state.error ? <p className="mt-2 text-sm text-[var(--color-error)]">{state.error}</p> : null}

            <CardFooter className="flex-wrap items-center gap-3 px-0 pb-0 pt-4">
              <SubmitButton pendingLabel="Saving…">Save Selection</SubmitButton>
              <SaveFeedback state={state} />
            </CardFooter>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
