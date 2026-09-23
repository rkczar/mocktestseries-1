"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { saveAnswerAction, submitAttemptAction } from "../actions";

export interface OmrQuestionRow {
  questionId: string;
  questionNumber: number;
  optionLabels: string[];
  selectedOptionLabel: string | null;
}

export function OmrEntryForm({
  attemptId,
  title,
  questions,
}: {
  attemptId: string;
  title: string;
  questions: OmrQuestionRow[];
}) {
  const [selections, setSelections] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(questions.map((q) => [q.questionId, q.selectedOptionLabel]))
  );
  const [isPending, startTransition] = useTransition();

  const answeredCount = Object.values(selections).filter(Boolean).length;

  const pick = (questionId: string, label: string) => {
    setSelections((prev) => ({ ...prev, [questionId]: prev[questionId] === label ? null : label }));
    startTransition(() => {
      saveAnswerAction(attemptId, questionId, selections[questionId] === label ? null : label, false).catch(() => {});
    });
  };

  const handleSubmit = () => {
    startTransition(() => {
      submitAttemptAction(attemptId);
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{title}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enter the answers you marked on your printed OMR sheet. Question text is not shown here.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Answer Key Entry</CardTitle>
          <CardDescription>
            {answeredCount}/{questions.length} answered
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {questions.map((q) => (
              <div key={q.questionId} className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-sm font-medium text-[var(--color-foreground)]">Q{q.questionNumber}</span>
                <div className="flex flex-wrap gap-1.5">
                  {q.optionLabels.map((label) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => pick(q.questionId, label)}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                        selections[q.questionId] === label
                          ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                          : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSubmit} disabled={isPending} size="lg">
        <CheckCircle2 className="h-4 w-4" aria-hidden /> Submit Answers
      </Button>
    </div>
  );
}
