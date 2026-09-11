"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { saveProgressAction, submitAttemptAction } from "@/lib/testing/attemptActions";
import { cn } from "@/lib/utils";

type PlayerQuestion = {
  id: string;
  stem: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
};

type Option = "A" | "B" | "C" | "D";
const OPTIONS: Option[] = ["A", "B", "C", "D"];

function formatClock(totalSeconds: number) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function TestPlayer({
  attemptId,
  title,
  durationMin,
  startedAt,
  questions,
  initialAnswers,
}: {
  attemptId: string;
  testId: string;
  title: string;
  durationMin: number;
  startedAt: string;
  questions: PlayerQuestion[];
  initialAnswers: Record<string, string>;
}) {
  const deadline = useMemo(
    () => new Date(startedAt).getTime() + durationMin * 60_000,
    [startedAt, durationMin],
  );

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [visited, setVisited] = useState<Set<string>>(new Set([questions[0]?.id]));
  // Seeded with the nominal duration (not deadline - Date.now()) so the server-rendered markup
  // matches the client's first render — the effect below corrects it to the real remaining time
  // immediately after mount, once Date.now() is safe to read.
  const [remainingSec, setRemainingSec] = useState(() => durationMin * 60);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, startSubmitTransition] = useTransition();

  const autoSubmitted = useRef(false);
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  const question = questions[index];
  const answeredCount = Object.keys(answers).length;
  const unansweredCount = questions.length - answeredCount;

  const doSubmit = useCallback(() => {
    if (autoSubmitted.current) return;
    autoSubmitted.current = true;
    setSubmitError(null);
    startSubmitTransition(async () => {
      try {
        await submitAttemptAction(attemptId, answersRef.current);
      } catch (error) {
        // A redirect() from the action itself is a special Next.js control-flow signal, not a
        // normal rejection, so it never reaches here — only genuine failures (session expired,
        // a network error) do. Reset the guard so the student (or the timer, if this was an
        // auto-submit) can retry instead of being silently unable to ever submit again.
        autoSubmitted.current = false;
        setSubmitError(error instanceof Error ? error.message : "Could not submit. Please try again.");
      }
    });
  }, [attemptId]);

  // Countdown, ticking once a second; auto-submits the moment time runs out.
  useEffect(() => {
    const tick = () => {
      const secs = Math.round((deadline - Date.now()) / 1000);
      setRemainingSec(secs);
      if (secs <= 0) doSubmit();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, doSubmit]);

  // Debounced autosave — fires ~1s after the last answer change (which also flips the
  // indicator to "saving" via the handlers below), plus a 20s safety-net tick.
  useEffect(() => {
    const timeout = setTimeout(async () => {
      const result = await saveProgressAction(attemptId, answersRef.current);
      setSaveState(result.ok ? "saved" : "error");
    }, 900);
    return () => clearTimeout(timeout);
  }, [answers, attemptId]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const result = await saveProgressAction(attemptId, answersRef.current);
      setSaveState(result.ok ? "saved" : "error");
    }, 20_000);
    return () => clearInterval(interval);
  }, [attemptId]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isSubmitting) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isSubmitting]);

  function goTo(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= questions.length) return;
    setIndex(nextIndex);
    setVisited((prev) => new Set(prev).add(questions[nextIndex].id));
  }

  function selectOption(option: Option) {
    setSaveState("saving");
    setAnswers((prev) => ({ ...prev, [question.id]: option }));
  }

  function clearResponse() {
    setSaveState("saving");
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[question.id];
      return next;
    });
  }

  function toggleMarked() {
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(question.id)) next.delete(question.id);
      else next.add(question.id);
      return next;
    });
  }

  const lowTime = remainingSec <= 5 * 60;

  return (
    <div className="flex min-h-full min-w-0 flex-col bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-6 py-3.5">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-extrabold text-text-heading">{title}</p>
            <p className="text-[12.5px] text-text-faint">
              {saveState === "saving"
                ? "Saving…"
                : saveState === "saved"
                  ? "All changes saved"
                  : saveState === "error"
                    ? "Couldn't save — check your connection"
                    : ""}
            </p>
          </div>
          <div
            className={cn(
              "rounded-[9px] border px-3.5 py-2 font-mono text-[15px] font-bold tabular-nums",
              lowTime
                ? "border-error-border bg-error-tint text-error"
                : "border-border-strong bg-background text-text-heading",
            )}
          >
            {formatClock(remainingSec)}
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1200px] flex-1 grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[1fr_280px]">
        <section className="min-w-0 rounded-xl border border-border bg-surface p-5.5">
          <p className="text-[13px] font-bold text-text-faint">
            Question {index + 1} of {questions.length}
          </p>
          <p className="mt-2 text-[16.5px] leading-relaxed font-semibold text-text-heading">
            {question.stem}
          </p>

          <div className="mt-5 flex flex-col gap-3">
            {OPTIONS.map((opt) => {
              const label = question[`option${opt}` as `option${Option}`];
              const selected = answers[question.id] === opt;
              return (
                <label
                  key={opt}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-[10px] border px-4 py-3 text-[15px] transition-colors",
                    selected
                      ? "border-primary bg-primary-tint text-text-heading"
                      : "border-border-strong bg-background text-text hover:border-primary/60",
                  )}
                >
                  <input
                    type="radio"
                    name={question.id}
                    className="sr-only"
                    checked={selected}
                    onChange={() => selectOption(opt)}
                  />
                  <span
                    className={cn(
                      "flex size-6 flex-none items-center justify-center rounded-full border text-[12.5px] font-bold",
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border-strong text-text-faint",
                    )}
                  >
                    {opt}
                  </span>
                  <span className="pt-0.5">{label}</span>
                </label>
              );
            })}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
              className="rounded-[9px] border border-border-strong px-4 py-2.5 text-sm font-bold text-primary hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={clearResponse}
              disabled={!answers[question.id]}
              className="rounded-[9px] border border-border-strong px-4 py-2.5 text-sm font-bold text-text-muted hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear response
            </button>
            <button
              type="button"
              onClick={() => {
                toggleMarked();
                goTo(index + 1);
              }}
              className="rounded-[9px] border border-brand-accent-border bg-brand-accent-tint px-4 py-2.5 text-sm font-bold text-brand-accent-text hover:bg-brand-accent-tint/70"
            >
              {marked.has(question.id) ? "Unmark & next" : "Mark for review & next"}
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              disabled={index === questions.length - 1}
              className="ml-auto rounded-[9px] bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save & Next
            </button>
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-[13px] font-bold text-text-heading">Question palette</p>
            <div className="mt-3 grid grid-cols-5 gap-2">
              {questions.map((q, i) => {
                const isAnswered = Boolean(answers[q.id]);
                const isMarked = marked.has(q.id);
                const isVisited = visited.has(q.id);
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => goTo(i)}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-[8px] border text-[13px] font-bold transition-colors",
                      i === index && "ring-2 ring-primary ring-offset-1",
                      isMarked
                        ? "border-brand-accent-border bg-brand-accent text-white"
                        : isAnswered
                          ? "border-success-border bg-success text-white"
                          : isVisited
                            ? "border-error-border bg-error-tint text-error"
                            : "border-border-strong bg-background text-text-muted",
                    )}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 flex flex-col gap-1.5 text-[12px] text-text-faint">
              <Legend swatch="bg-success" label="Answered" />
              <Legend swatch="bg-brand-accent" label="Marked for review" />
              <Legend swatch="bg-error-tint border border-error-border" label="Visited, not answered" />
              <Legend swatch="bg-background border border-border-strong" label="Not visited" />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface p-4 text-[13px] text-text-muted">
            <p>
              <span className="font-bold text-text-heading">{answeredCount}</span> answered ·{" "}
              <span className="font-bold text-text-heading">{unansweredCount}</span> remaining
            </p>
          </div>

          <AlertDialog>
            <AlertDialogTrigger
              className="rounded-[9px] bg-primary px-4 py-3 text-[15px] font-bold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Submitting…" : "Submit test"}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Submit this test?</AlertDialogTitle>
                <AlertDialogDescription>
                  {unansweredCount > 0
                    ? `You still have ${unansweredCount} unanswered question${unansweredCount === 1 ? "" : "s"}. Once submitted, you can't change your answers.`
                    : "Once submitted, you can't change your answers."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep working</AlertDialogCancel>
                <AlertDialogAction onClick={doSubmit}>Submit</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {submitError ? <p className="text-[13px] text-error">{submitError}</p> : null}
        </aside>
      </main>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cn("size-3 flex-none rounded-[3px]", swatch)} />
      {label}
    </span>
  );
}
