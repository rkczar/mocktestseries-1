"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { saveAnswerAction, submitAttemptAction } from "../actions";

export interface PlayerOption {
  label: string;
  text: string;
  imageUrl: string | null;
}

export interface PlayerQuestion {
  questionId: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: PlayerOption[];
  selectedOptionLabel: string | null;
  markForReview: boolean;
}

interface QuestionState {
  selected: string | null;
  marked: boolean;
  visited: boolean;
}

type Status = "current" | "answered-marked" | "marked" | "answered" | "visited" | "not-visited";

const STATUS_STYLES: Record<Status, string> = {
  current: "bg-[var(--color-primary)] text-white ring-2 ring-offset-2 ring-[var(--color-primary)]",
  "answered-marked": "bg-[var(--color-info)] text-white",
  marked: "bg-[var(--color-warning)] text-white",
  answered: "bg-[var(--color-success)] text-white",
  visited: "border border-[var(--color-error)]/40 bg-[var(--color-error)]/15 text-[var(--color-error)]",
  "not-visited": "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted-foreground)]",
};

export function TestPlayer({
  attemptId,
  title,
  initialRemainingSeconds,
  questions,
}: {
  attemptId: string;
  title: string;
  initialRemainingSeconds: number;
  questions: PlayerQuestion[];
}) {
  const [current, setCurrent] = useState(0);
  const [remaining, setRemaining] = useState(initialRemainingSeconds);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [states, setStates] = useState<Record<string, QuestionState>>(() =>
    Object.fromEntries(
      questions.map((q, i) => [q.questionId, { selected: q.selectedOptionLabel, marked: q.markForReview, visited: i === 0 }])
    )
  );
  const submittedRef = useRef(false);

  const doSubmit = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    startTransition(() => {
      submitAttemptAction(attemptId);
    });
  }, [attemptId]);

  useEffect(() => {
    if (remaining <= 0) {
      doSubmit();
      return;
    }
    const timer = setInterval(() => setRemaining((r) => (r <= 1 ? 0 : r - 1)), 1000);
    return () => clearInterval(timer);
  }, [remaining, doSubmit]);

  const persist = useCallback(
    (questionId: string, selected: string | null, marked: boolean) => {
      startTransition(() => {
        saveAnswerAction(attemptId, questionId, selected, marked).catch(() => {});
      });
    },
    [attemptId]
  );

  const updateState = (questionId: string, patch: Partial<Pick<QuestionState, "selected" | "marked">>) => {
    setStates((prev) => {
      const next = { ...prev[questionId], ...patch };
      persist(questionId, next.selected, next.marked);
      return { ...prev, [questionId]: next };
    });
  };

  const goTo = (index: number) => {
    if (index < 0 || index >= questions.length) return;
    setCurrent(index);
    const q = questions[index];
    setStates((prev) => (prev[q.questionId].visited ? prev : { ...prev, [q.questionId]: { ...prev[q.questionId], visited: true } }));
  };

  const question = questions[current];
  const state = states[question.questionId];

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const timeLow = remaining <= 60;

  const answeredCount = questions.filter((q) => states[q.questionId]?.selected).length;
  const markedCount = questions.filter((q) => states[q.questionId]?.marked).length;

  function statusFor(q: PlayerQuestion, i: number): Status {
    if (i === current) return "current";
    const s = states[q.questionId];
    if (s.marked && s.selected) return "answered-marked";
    if (s.marked) return "marked";
    if (s.selected) return "answered";
    if (s.visited) return "visited";
    return "not-visited";
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:px-6">
        <p className="truncate text-sm font-semibold text-[var(--color-foreground)]">{title}</p>
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold tabular-nums",
            timeLow ? "bg-[var(--color-error)]/15 text-[var(--color-error)]" : "bg-[var(--color-primary)]/15 text-[var(--color-primary)]"
          )}
        >
          <Clock className="h-4 w-4" aria-hidden />
          {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 p-4 sm:px-6 lg:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-4">
          <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--color-muted-foreground)]">
                Question {current + 1} of {questions.length}
              </span>
              <span className="rounded-full bg-[var(--color-border)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-foreground)]">
                {question.difficulty}
              </span>
            </div>

            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--color-foreground)]">{question.text}</p>
            {question.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={question.imageUrl}
                alt=""
                className="mt-3 max-h-72 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
              />
            ) : null}

            <div className="mt-5 flex flex-col gap-2.5">
              {question.options.map((opt) => {
                const selected = state.selected === opt.label;
                return (
                  <label
                    key={opt.label}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border p-3 transition-colors",
                      selected
                        ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10"
                        : "border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                    )}
                  >
                    <input
                      type="radio"
                      name={`q-${question.questionId}`}
                      className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
                      checked={selected}
                      onChange={() => updateState(question.questionId, { selected: opt.label })}
                    />
                    <span className="text-sm text-[var(--color-foreground)]">
                      <span className="font-semibold">{opt.label}.</span> {opt.text}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => goTo(current - 1)} disabled={current === 0}>
                <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
              </Button>
              <Button variant="outline" onClick={() => updateState(question.questionId, { selected: null, marked: false })}>
                Clear Response
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  updateState(question.questionId, { marked: !state.marked });
                  goTo(current + 1);
                }}
              >
                <Flag className="h-4 w-4" aria-hidden /> Mark for Review & Next
              </Button>
              {current === questions.length - 1 ? (
                <Button onClick={() => setConfirmOpen(true)}>Submit Test</Button>
              ) : (
                <Button onClick={() => goTo(current + 1)}>
                  Save & Next <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </div>
        </div>

        <aside className="flex flex-col gap-4">
          <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4">
            <div className="mb-3 grid grid-cols-1 gap-2 text-xs text-[var(--color-muted-foreground)]">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-success)]" /> Answered ({answeredCount})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-warning)]" /> Marked for review ({markedCount})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-error)]/40" /> Visited, not answered
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border border-[var(--color-border)]" /> Not visited
              </span>
            </div>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-5 lg:grid-cols-6">
              {questions.map((q, i) => (
                <button
                  key={q.questionId}
                  type="button"
                  onClick={() => goTo(i)}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] text-xs font-semibold transition-colors",
                    STATUS_STYLES[statusFor(q, i)]
                  )}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>

          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Submit Test
          </Button>
        </aside>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[var(--color-warning)]" aria-hidden /> Submit test?
            </DialogTitle>
            <DialogDescription>
              You have answered {answeredCount} of {questions.length} questions. Once submitted, you cannot change your answers.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep Reviewing</Button>
            </DialogClose>
            <Button variant="danger" onClick={doSubmit} disabled={isPending}>
              {isPending ? "Submitting…" : "Submit Test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
