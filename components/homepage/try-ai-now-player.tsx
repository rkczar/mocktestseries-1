"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronLeft, ChevronRight, Sparkles, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AiDemoQuestion } from "@/lib/homepage-ai-demo";

/**
 * Anonymous homepage "Try AI Now" mini test. All state (answers, current
 * question, whether the result screen is showing) lives only in this
 * component's memory — nothing is persisted, no Student or TestAttempt row
 * is ever created, and no network request is made while playing: every
 * question's options and cached AI explanation were already fetched
 * server-side (getHomepageAiDemoQuestions), which itself never calls an AI
 * provider. Reloading the page resets the demo, by design.
 */
export function TryAiNowPlayer({ questions }: { questions: AiDemoQuestion[] }) {
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | null>>({});
  const [finished, setFinished] = useState(false);

  const total = questions.length;
  const question = questions[current];
  const answeredCount = Object.values(answers).filter(Boolean).length;

  const score = useMemo(() => {
    let correct = 0;
    for (const q of questions) {
      const selected = answers[q.questionId];
      if (selected && q.options.find((o) => o.label === selected)?.isCorrect) correct += 1;
    }
    return correct;
  }, [answers, questions]);

  if (total === 0) return null;

  if (finished) {
    const incorrect = answeredCount - score;
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-center sm:p-8">
        <Sparkles className="mx-auto h-8 w-8 text-[var(--color-primary)]" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-[var(--color-foreground)]">Your Demo Result</h3>
        <p className="mt-1 text-3xl font-bold text-[var(--color-foreground)]">
          {score} / {total}
        </p>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Correct: {score} · Incorrect: {incorrect}
          {answeredCount < total ? ` · Unattempted: ${total - answeredCount}` : ""}
        </p>

        <p className="mt-4 text-sm text-[var(--color-foreground)]">See how AI can improve your preparation.</p>

        <div className="mt-4 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild>
            <Link href="/login?callbackUrl=%2Fstudent%2Fdashboard">Start Full Practice</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/exams/rajasthan-medical-officer">Explore Rajasthan Medical Officer Tests</Link>
          </Button>
        </div>

        <button
          type="button"
          onClick={() => {
            setAnswers({});
            setCurrent(0);
            setFinished(false);
          }}
          className="mt-4 text-xs text-[var(--color-muted-foreground)] hover:underline"
        >
          Retake demo
        </button>
      </div>
    );
  }

  const selected = answers[question.questionId] ?? null;
  const revealed = Boolean(selected);
  const optionEntries = Object.entries(question.content.optionAnalysis ?? {});

  const goTo = (index: number) => {
    if (index < 0 || index >= total) return;
    setCurrent(index);
  };

  const select = (label: string) => {
    setAnswers((prev) => ({ ...prev, [question.questionId]: label }));
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 sm:p-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-[var(--color-muted-foreground)]">
          Question {current + 1} of {total}
        </span>
        <Badge variant="neutral">{question.code}</Badge>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        <div
          className="h-full rounded-full bg-[var(--color-primary)] transition-all"
          style={{ width: `${(answeredCount / total) * 100}%` }}
        />
      </div>

      <p className="mt-4 whitespace-pre-wrap text-base font-medium text-[var(--color-foreground)]">{question.text}</p>

      <div className="mt-4 flex flex-col gap-2.5">
        {question.options.map((opt) => {
          const isSelected = selected === opt.label;
          const showCorrect = revealed && opt.isCorrect;
          const showWrongPick = revealed && isSelected && !opt.isCorrect;
          return (
            <button
              key={opt.label}
              type="button"
              disabled={revealed}
              onClick={() => select(opt.label)}
              className={cn(
                "flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left text-sm transition-colors disabled:cursor-default",
                showCorrect
                  ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/10"
                  : showWrongPick
                    ? "border-[var(--color-error)]/50 bg-[var(--color-error)]/10"
                    : isSelected
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10"
                      : "border-[var(--color-border)] hover:bg-[var(--color-surface)]"
              )}
            >
              <span className="font-semibold text-[var(--color-foreground)]">{opt.label}.</span>
              <span className="text-[var(--color-foreground)]">{opt.text}</span>
              {showCorrect ? <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden /> : null}
              {showWrongPick ? <XCircle className="ml-auto h-4 w-4 shrink-0 text-[var(--color-error)]" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      {revealed ? (
        <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-info)]/30 bg-[var(--color-info)]/5 p-4 text-sm text-[var(--color-foreground)]">
          <p className="flex items-center gap-1.5 font-semibold text-[var(--color-info)]">
            <Sparkles className="h-4 w-4" aria-hidden /> AI Explanation
          </p>

          {question.content.concept ? (
            <p>
              <span className="font-medium">Why the correct option is correct: </span>
              {question.content.concept}
            </p>
          ) : null}

          {optionEntries.length > 0 ? (
            <div>
              <p className="font-medium">Why the other options are incorrect</p>
              <div className="mt-1 flex flex-col gap-1">
                {optionEntries.map(([label, text]) => (
                  <p key={label}>
                    <span className="font-medium">{label} — </span>
                    {text}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          {question.content.pointsToRemember?.length ? (
            <div>
              <p className="font-medium">Important points</p>
              <ul className="mt-1 list-disc pl-5">
                {question.content.pointsToRemember.map((point, i) => (
                  <li key={i}>{point}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {question.content.memoryTrick ? (
            <p>
              <span className="font-medium">Memory trick: </span>
              {question.content.memoryTrick}
            </p>
          ) : null}

          {question.content.examinerTraps?.length ? (
            <div>
              <p className="font-medium">Examiner trap</p>
              <ul className="mt-1 list-disc pl-5">
                {question.content.examinerTraps.map((trap, i) => (
                  <li key={i}>{trap}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-xs text-[var(--color-muted-foreground)]">Select an option to see the AI explanation.</p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" size="sm" onClick={() => goTo(current - 1)} disabled={current === 0}>
          <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
        </Button>

        <div className="flex flex-wrap justify-center gap-1.5">
          {questions.map((q, i) => {
            const isCurrent = i === current;
            const isAnswered = Boolean(answers[q.questionId]);
            return (
              <button
                key={q.questionId}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Question ${i + 1}`}
                aria-current={isCurrent}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] text-xs font-semibold transition-colors",
                  isCurrent
                    ? "bg-[var(--color-primary)] text-white ring-2 ring-offset-2 ring-[var(--color-primary)]"
                    : isAnswered
                      ? "bg-[var(--color-success)]/80 text-white"
                      : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted-foreground)]"
                )}
              >
                {i + 1}
              </button>
            );
          })}
        </div>

        {current === total - 1 ? (
          <Button size="sm" onClick={() => setFinished(true)}>
            See Result
          </Button>
        ) : (
          <Button size="sm" onClick={() => goTo(current + 1)}>
            Next <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
