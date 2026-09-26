"use client";

/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH.
 * Mock, PYQ, Subject Test and Custom Module depend on this player.
 * Do not create test-type-specific player forks.
 * Changes require focused test-engine regression verification: option
 * selection, answer persistence, navigation, attempt snapshots, timer,
 * submission and answer reveal (see ops/TEST-ENGINE.md).
 *
 * The ONE student test player for every attemptable test type (Mock, PYQ,
 * Custom Module, Subject Test, Grand/Live). Test types only supply data.
 *
 * Invariants (each one was a production failure — see ops/TEST-ENGINE.md):
 *  1. React state updates are pure. Nothing (no save, no transition) is ever
 *     started from inside a setState updater — React may re-run updaters
 *     during render, which turned one click into an endless save loop that
 *     froze option selection and Save & Next.
 *  2. Selecting an option updates the UI immediately; persistence is async.
 *  3. Saves go through a per-question queue: one request in flight per
 *     question, latest value wins, every request carries a monotonic `seq`
 *     the server uses to reject stale writes, bounded by a timeout, retried
 *     with backoff, and kept in sessionStorage until the server accepts it.
 *  4. Navigation (Next / Previous / palette) is purely local and never waits
 *     on the network, so it cannot hang.
 *  5. The countdown is derived from a fixed deadline, not decremented state.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, Flag, Infinity as InfinityIcon, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { TextSizeControl } from "@/components/theme/text-size-control";
import { SaveQuestionButton } from "@/components/student/save-question-button";
import { ReportQuestionDialog } from "@/components/student/report-question-dialog";
import { cn } from "@/lib/utils";
import { AnswerSaveQueue, type SaveStatus } from "@/lib/answer-save-queue";
import {
  revealAnswerAction,
  saveAnswerAction,
  submitAttemptAction,
  toggleSaveQuestionAction,
  reportAttemptQuestionAction,
} from "../actions";

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
  /** Snapshot failed validation (too few / duplicate options): shown as a skippable notice. */
  malformed: boolean;
  /** Present only once the server has revealed this question (INSTANT mode). */
  reveal: { correctLabel: string } | null;
  selectedOptionLabel: string | null;
  markForReview: boolean;
  saved: boolean;
}

interface QuestionState {
  selected: string | null;
  marked: boolean;
  visited: boolean;
}

interface RevealState {
  correctLabel: string;
}

type Status = "current" | "answered-marked" | "marked" | "answered" | "visited" | "not-visited";

const SAVE_TIMEOUT_MS = 12_000;
const SUBMIT_FLUSH_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Answers not yet accepted by the server, kept per attempt in sessionStorage
 * so a reload (e.g. after deploy skew: an old page calling a previous
 * build's Server Action id) replays them instead of losing them. The server
 * still validates every replayed save (ownership, IN_PROGRESS, window, seq).
 */
type PendingAnswers = Record<string, { selected: string | null; marked: boolean }>;
const pendingKey = (attemptId: string) => `mts-pending-answers:${attemptId}`;

function readPending(attemptId: string): PendingAnswers {
  try {
    return JSON.parse(window.sessionStorage.getItem(pendingKey(attemptId)) ?? "{}") as PendingAnswers;
  } catch {
    return {};
  }
}

function writePending(attemptId: string, pending: PendingAnswers) {
  try {
    if (Object.keys(pending).length === 0) window.sessionStorage.removeItem(pendingKey(attemptId));
    else window.sessionStorage.setItem(pendingKey(attemptId), JSON.stringify(pending));
  } catch {
    // storage unavailable — the on-screen banner still offers retry
  }
}

const STATUS_STYLES: Record<Status, string> = {
  current: "bg-[var(--color-primary)] text-white ring-2 ring-offset-2 ring-[var(--color-primary)]",
  "answered-marked": "bg-[var(--color-info)] text-white",
  marked: "bg-[var(--color-warning)] text-white",
  answered: "bg-[var(--color-success)] text-white",
  visited: "border border-[var(--color-error)]/40 bg-[var(--color-error)]/15 text-[var(--color-error)]",
  "not-visited": "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted-foreground)]",
};

type Problem =
  | { kind: "save-failed"; message: string }
  | { kind: "submit-failed" }
  | { kind: "expired" }
  | { kind: "unsaved-before-submit" };

export function TestPlayer({
  attemptId,
  title,
  initialRemainingSeconds,
  instantMode = false,
  questions,
}: {
  attemptId: string;
  title: string;
  /** null = unlimited time (no countdown, no time-based auto-submit). */
  initialRemainingSeconds: number | null;
  instantMode?: boolean;
  questions: PlayerQuestion[];
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(0);
  const [remaining, setRemaining] = useState(initialRemainingSeconds);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [, startSubmitTransition] = useTransition();
  const [states, setStates] = useState<Record<string, QuestionState>>(() =>
    Object.fromEntries(
      questions.map((q, i) => [q.questionId, { selected: q.selectedOptionLabel, marked: q.markForReview, visited: i === 0 }])
    )
  );
  const [reveals, setReveals] = useState<Record<string, RevealState>>(() =>
    Object.fromEntries(questions.filter((q) => q.reveal).map((q) => [q.questionId, q.reveal as RevealState]))
  );
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<{ questionId: string; message: string } | null>(null);
  const [saveStatus, setSaveStatus] = useState<Record<string, SaveStatus>>({});
  const [problem, setProblem] = useState<Problem | null>(null);

  // Canonical answer state for event handlers (mirrors `states`), so handlers
  // never compute from a stale render closure and never need an updater.
  const statesRef = useRef(states);
  const submittedRef = useRef(false);
  const finishRef = useRef<(reason: "manual" | "auto") => void>(() => {});
  const queueRef = useRef<AnswerSaveQueue | null>(null);

  const commitStates = useCallback((next: Record<string, QuestionState>) => {
    statesRef.current = next;
    setStates(next);
  }, []);

  /** The save queue lives outside React state (created once, used only from handlers/effects). */
  const getQueue = useCallback((): AnswerSaveQueue => {
    if (!queueRef.current) {
      queueRef.current = new AnswerSaveQueue({
        send: async (questionId, value, seq) => saveAnswerAction(attemptId, questionId, value.selected, value.marked, seq),
        onStatus: (questionId, status) =>
          setSaveStatus((prev) => {
            if ((prev[questionId] ?? null) === status) return prev;
            const next = { ...prev };
            if (status) next[questionId] = status;
            else delete next[questionId];
            return next;
          }),
        onPendingChange: (questionId, value) => {
          const pending = readPending(attemptId);
          if (value) pending[questionId] = value;
          else delete pending[questionId];
          writePending(attemptId, pending);
        },
        onExhausted: () =>
          setProblem((p) => p ?? { kind: "save-failed", message: "Some answers could not be saved yet. They are kept on this device." }),
        onFatal: (code) => {
          if (code === "EXPIRED") {
            setProblem({ kind: "expired" });
            finishRef.current("auto");
          } else {
            router.replace(`/student/attempt/${attemptId}/result`);
          }
        },
        timeoutMs: SAVE_TIMEOUT_MS,
      });
    }
    return queueRef.current;
  }, [attemptId, router]);

  const retryAllSaves = useCallback(() => {
    setProblem(null);
    getQueue().retryAll();
  }, [getQueue]);

  // ---- Submit ---------------------------------------------------------------
  const doSubmit = useCallback(() => {
    startSubmitTransition(async () => {
      try {
        await submitAttemptAction(attemptId);
        // A successful submit redirects; if the router somehow didn't navigate, do it.
        setTimeout(() => {
          if (window.location.pathname.endsWith("/run")) router.replace(`/student/attempt/${attemptId}/result`);
        }, 4000);
      } catch {
        submittedRef.current = false;
        setSubmitting(false);
        setProblem({ kind: "submit-failed" });
      }
    });
  }, [attemptId, router]);

  const finish = useCallback(
    async (reason: "manual" | "auto", force = false) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setSubmitting(true);
      setConfirmOpen(false);
      const flushed = await getQueue().flush(SUBMIT_FLUSH_TIMEOUT_MS);
      if (!flushed && reason === "manual" && !force) {
        // Never silently submit over answers the server hasn't accepted.
        submittedRef.current = false;
        setSubmitting(false);
        setProblem({ kind: "unsaved-before-submit" });
        return;
      }
      doSubmit();
    },
    [doSubmit, getQueue]
  );

  useEffect(() => {
    finishRef.current = (reason) => void finish(reason);
  }, [finish]);

  // Stop the queue's retry timers when the player unmounts.
  useEffect(() => () => queueRef.current?.stop(), []);

  // ---- Timer (deadline-based; unlimited = no timer) --------------------------
  useEffect(() => {
    if (initialRemainingSeconds === null) return;
    const deadline = Date.now() + initialRemainingSeconds * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        clearInterval(timer);
        finishRef.current("auto");
      }
    };
    const timer = setInterval(tick, 1000);
    if (initialRemainingSeconds <= 0) queueMicrotask(tick);
    return () => clearInterval(timer);
  }, [initialRemainingSeconds]);

  // ---- Replay answers a previous page load could not save --------------------
  useEffect(() => {
    const pending = readPending(attemptId);
    const known = new Set(questions.map((q) => q.questionId));
    const entries = Object.entries(pending).filter(([questionId]) => known.has(questionId));
    if (entries.length === 0) return;
    const next = { ...statesRef.current };
    for (const [questionId, answer] of entries) {
      if (questions.find((q) => q.questionId === questionId)?.reveal) continue; // frozen by the server
      next[questionId] = { ...next[questionId], selected: answer.selected, marked: answer.marked };
      getQueue().enqueue(questionId, { selected: answer.selected, marked: answer.marked });
    }
    queueMicrotask(() => commitStates(next));
    // Mount-only: replays the previous page load's unsaved answers exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retry immediately when the connection comes back; warn before leaving with unsaved answers.
  useEffect(() => {
    const onOnline = () => retryAllSaves();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!submittedRef.current && queueRef.current && !queueRef.current.idle()) e.preventDefault();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [retryAllSaves]);

  // ---- Answer + navigation handlers (pure state, side effects after) ---------
  const setAnswer = (questionId: string, patch: Partial<Pick<QuestionState, "selected" | "marked">>) => {
    if (submittedRef.current || (reveals[questionId] && patch.selected !== undefined)) return;
    const prev = statesRef.current[questionId];
    const next = { ...prev, ...patch };
    if (next.selected === prev.selected && next.marked === prev.marked) return; // idempotent
    commitStates({ ...statesRef.current, [questionId]: next });
    getQueue().enqueue(questionId, { selected: next.selected, marked: next.marked });
  };

  const goTo = (index: number) => {
    if (index < 0 || index >= questions.length) return;
    setCurrent(index);
    const questionId = questions[index].questionId;
    if (!statesRef.current[questionId]?.visited) {
      commitStates({ ...statesRef.current, [questionId]: { ...statesRef.current[questionId], visited: true } });
    }
  };

  const checkAnswer = (questionId: string) => {
    const selected = statesRef.current[questionId]?.selected;
    if (!selected || revealing || reveals[questionId]) return;
    setRevealing(questionId);
    setRevealError(null);
    withTimeout(revealAnswerAction(attemptId, questionId, selected, getQueue().nextSeq()), SAVE_TIMEOUT_MS)
      .then((result) => {
        if (result.ok) {
          setReveals((prev) => ({ ...prev, [questionId]: { correctLabel: result.correctLabel } }));
          // The server's frozen choice is the truth; any queued older save is now moot.
          getQueue().drop(questionId);
          commitStates({ ...statesRef.current, [questionId]: { ...statesRef.current[questionId], selected: result.selectedOptionLabel } });
          return;
        }
        if (result.code === "EXPIRED") {
          setProblem({ kind: "expired" });
          finishRef.current("auto");
          return;
        }
        setRevealError({ questionId, message: result.message });
      })
      .catch(() => setRevealError({ questionId, message: "Could not check the answer. Please try again." }))
      .finally(() => setRevealing(null));
  };

  if (questions.length === 0) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
        <AlertTriangle className="h-8 w-8 text-[var(--color-warning)]" aria-hidden />
        <p className="text-[var(--color-foreground)]">This test has no questions to show. Please start it again from your dashboard.</p>
        <Button asChild>
          <Link href="/student/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  const question = questions[Math.min(current, questions.length - 1)];
  const state = states[question.questionId] ?? { selected: null, marked: false, visited: true };
  const reveal = reveals[question.questionId] ?? null;
  const qSave = saveStatus[question.questionId];
  const isLast = current === questions.length - 1;

  const minutes = remaining === null ? 0 : Math.floor(remaining / 60);
  const seconds = remaining === null ? 0 : remaining % 60;
  const timeLow = remaining !== null && remaining <= 60;

  const answeredCount = questions.filter((q) => states[q.questionId]?.selected).length;
  const markedCount = questions.filter((q) => states[q.questionId]?.marked).length;
  const unsavedCount = Object.values(saveStatus).filter((s) => s !== "saving").length;

  function statusFor(q: PlayerQuestion, i: number): Status {
    if (i === current) return "current";
    const s = states[q.questionId];
    if (!s) return "not-visited";
    if (s.marked && s.selected) return "answered-marked";
    if (s.marked) return "marked";
    if (s.selected) return "answered";
    if (s.visited) return "visited";
    return "not-visited";
  }

  return (
    <div className="flex min-h-screen flex-col" data-testid="test-player" data-question-index={current}>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:gap-4 sm:px-6">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-foreground)]">{title}</p>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <TextSizeControl />
          <div
            data-testid="timer"
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold tabular-nums",
              timeLow ? "bg-[var(--color-error)]/15 text-[var(--color-error)]" : "bg-[var(--color-primary)]/15 text-[var(--color-primary)]"
            )}
          >
            {remaining === null ? (
              <>
                <InfinityIcon className="h-4 w-4" aria-hidden /> No time limit
              </>
            ) : (
              <>
                <Clock className="h-4 w-4" aria-hidden />
                {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
              </>
            )}
          </div>
        </div>
      </header>

      {problem ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-4 py-3 sm:px-6">
          <p className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
            {problem.kind === "submit-failed"
              ? "Your test could not be submitted. Your saved answers are kept — try again, or reload and submit."
              : problem.kind === "expired"
                ? "Time is up — submitting your test."
                : problem.kind === "unsaved-before-submit"
                  ? "Some answers are not saved yet. Retry saving, or submit with the answers already saved."
                  : problem.message}
          </p>
          <div className="flex flex-wrap gap-2">
            {problem.kind === "save-failed" || problem.kind === "unsaved-before-submit" ? (
              <Button size="sm" variant="outline" onClick={retryAllSaves}>
                Retry saving
              </Button>
            ) : null}
            {problem.kind === "unsaved-before-submit" ? (
              <Button size="sm" variant="danger" onClick={() => void finish("manual", true)}>
                Submit anyway
              </Button>
            ) : null}
            {problem.kind === "submit-failed" ? (
              <Button size="sm" variant="danger" onClick={() => void finish("manual", true)}>
                Try submit again
              </Button>
            ) : null}
            {problem.kind !== "expired" ? (
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload &amp; Sync
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 p-4 sm:px-6 lg:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-4">
          <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-[var(--color-muted-foreground)]" data-testid="question-position">
                Question {current + 1} of {questions.length}
                <span className="ml-2 text-xs" data-testid="save-status" aria-live="polite">
                  {qSave === "saving" ? "Saving…" : qSave === "retrying" ? "Retrying save…" : qSave === "failed" ? "Not saved yet" : ""}
                </span>
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {question.difficulty ? (
                  <span className="rounded-full bg-[var(--color-border)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-foreground)]">
                    {question.difficulty}
                  </span>
                ) : null}
                <SaveQuestionButton
                  key={question.questionId}
                  initialSaved={question.saved}
                  onToggle={toggleSaveQuestionAction.bind(null, question.questionId)}
                />
                <ReportQuestionDialog onSubmit={reportAttemptQuestionAction.bind(null, attemptId, question.questionId)} />
              </div>
            </div>

            <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">{question.text}</p>
            {question.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={question.imageUrl}
                alt=""
                className="mt-3 max-h-72 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
              />
            ) : null}

            {question.malformed ? (
              <div role="alert" data-testid="malformed-question" className="mt-5 rounded-[var(--radius-card)] border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 p-4 text-sm text-[var(--color-foreground)]">
                This question could not be displayed correctly and cannot be answered. Please report it and continue with
                the next question — the rest of your test is unaffected.
              </div>
            ) : (
              <div className="mt-5 flex flex-col gap-2.5" role="radiogroup" aria-label={`Question ${current + 1} options`}>
                {question.options.map((opt, idx) => {
                  const selected = state.selected === opt.label;
                  const isCorrect = reveal ? opt.label === reveal.correctLabel : false;
                  const isWrongPick = reveal ? selected && !isCorrect : false;
                  return (
                    <label
                      key={`${question.questionId}:${idx}:${opt.label}`}
                      data-testid="option"
                      data-label={opt.label}
                      className={cn(
                        "flex items-start gap-3 rounded-[var(--radius-card)] border p-3 transition-colors",
                        reveal ? "cursor-default" : "cursor-pointer",
                        isCorrect
                          ? "border-[var(--color-success)] bg-[var(--color-success)]/10"
                          : isWrongPick
                            ? "border-[var(--color-error)] bg-[var(--color-error)]/10"
                            : selected
                              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10"
                              : "border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                      )}
                    >
                      <input
                        type="radio"
                        name={`q-${question.questionId}`}
                        value={opt.label}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                        checked={selected}
                        disabled={!!reveal || submitting}
                        onChange={() => setAnswer(question.questionId, { selected: opt.label })}
                      />
                      <span className="min-w-0 text-sm text-[var(--color-foreground)]">
                        <span className="font-semibold">{opt.label}.</span> {opt.text}
                        {opt.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={opt.imageUrl}
                            alt=""
                            className="pointer-events-none mt-2 max-h-48 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                          />
                        ) : null}
                      </span>
                      {isCorrect ? <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-[var(--color-success)]" aria-label="Correct answer" /> : null}
                      {isWrongPick ? <XCircle className="ml-auto h-5 w-5 shrink-0 text-[var(--color-error)]" aria-label="Your answer" /> : null}
                    </label>
                  );
                })}
              </div>
            )}

            {instantMode && !question.malformed ? (
              <div className="mt-4 flex flex-col gap-2" data-testid="instant-panel">
                {reveal ? (
                  <p
                    data-testid="reveal-result"
                    className={cn(
                      "flex items-center gap-2 text-sm font-semibold",
                      state.selected === reveal.correctLabel ? "text-[var(--color-success)]" : "text-[var(--color-error)]"
                    )}
                  >
                    {state.selected === reveal.correctLabel ? (
                      <>
                        <CheckCircle2 className="h-4 w-4" aria-hidden /> Correct
                      </>
                    ) : (
                      <>
                        <XCircle className="h-4 w-4" aria-hidden /> Incorrect — correct answer: {reveal.correctLabel}
                      </>
                    )}
                    <span className="font-normal text-[var(--color-muted-foreground)]">· Full explanation in Review after you submit.</span>
                  </p>
                ) : (
                  <div>
                    <Button
                      variant="outline"
                      onClick={() => checkAnswer(question.questionId)}
                      disabled={!state.selected || revealing === question.questionId || submitting}
                    >
                      {revealing === question.questionId ? "Checking…" : "Check Answer"}
                    </Button>
                    <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">Checking locks your answer for this question.</p>
                  </div>
                )}
                {revealError?.questionId === question.questionId ? (
                  <p className="text-sm text-[var(--color-error)]">{revealError.message}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => goTo(current - 1)} disabled={current === 0}>
                <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
              </Button>
              <Button
                variant="outline"
                onClick={() => setAnswer(question.questionId, { selected: null, marked: false })}
                disabled={!!reveal || submitting || question.malformed}
              >
                Clear Response
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  setAnswer(question.questionId, { marked: !state.marked });
                  goTo(current + 1);
                }}
              >
                <Flag className="h-4 w-4" aria-hidden /> Mark for Review & Next
              </Button>
              {isLast ? (
                <Button onClick={() => setConfirmOpen(true)} disabled={submitting}>
                  Submit Test
                </Button>
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
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-5 lg:grid-cols-6" data-testid="palette">
              {questions.map((q, i) => (
                <button
                  key={q.questionId}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Go to question ${i + 1}`}
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

          <Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={submitting}>
            {submitting ? "Submitting…" : "Submit Test"}
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
              You have answered {answeredCount} of {questions.length} questions.
              {unsavedCount > 0 ? ` ${unsavedCount} answer(s) are still being saved.` : ""} Once submitted, you cannot change your
              answers.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Keep Reviewing</Button>
            </DialogClose>
            <Button variant="danger" onClick={() => void finish("manual")} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit Test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
