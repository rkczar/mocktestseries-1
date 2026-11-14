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
 *  6. Practice Mode ("Show answer after each question", INSTANT): tapping an
 *     option IS the check. It never goes through the save queue: the tap is
 *     sent to revealAnswerAction, the server commits + locks that first
 *     answer and only then returns the correct label for THAT question. The
 *     same question then shows its review state; nothing auto-advances.
 *  7. MULTIPLE_CORRECT (NEET Phase 4) is a capability branch, not a fork:
 *     checkboxes instead of radios, the whole label set is one queued value
 *     (latest set wins, same seq rule), and in Practice Mode the set is
 *     committed by an explicit "Check answer" (one tap can't be the answer).
 *     SINGLE_CORRECT / MATCH_THE_FOLLOWING keep the radio path above unchanged.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { LanguageChoice, LanguageSwitch, useTestLanguage, type TestLanguage } from "@/components/student/test-language";
import type { HindiView } from "@/lib/test-player-data";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Flag, Infinity as InfinityIcon, LogOut, Maximize, X, XCircle } from "lucide-react";
import { exitExamFullscreen, fullscreenSupported, requestExamFullscreen, useFullscreen } from "@/components/student/exam-fullscreen";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { TextSizeControl } from "@/components/theme/text-size-control";
import { SaveQuestionButton } from "@/components/student/save-question-button";
import { ReportQuestionDialog } from "@/components/student/report-question-dialog";
import { WhatsAppShareButton } from "@/components/student/whatsapp-share-button";
import { QuestionBottomNav } from "@/components/student/question-bottom-nav";
import { useAskAi } from "@/components/student/explanation-panel";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia, preloadImages } from "@/components/content/question-media";
import { HumanExplanation } from "@/components/content/human-explanation";
import { MatchLists } from "@/components/content/match-lists";
import type { ExplanationView, MatchView, RenderedHtml, RichQuestionView } from "@/lib/rich-content-types";
import { cn } from "@/lib/utils";
import { AnswerSaveQueue, type SaveStatus } from "@/lib/answer-save-queue";
import {
  attemptHeartbeatAction,
  revealAnswerAction,
  revealAnswerLabelsAction,
  saveAnswerAction,
  saveAnswerLabelsAction,
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
  /** Present only once the server has revealed this question (INSTANT mode); the explanation travels only here. */
  reveal: { correctLabel: string; correctLabels?: string[]; explanation?: ExplanationView } | null;
  selectedOptionLabel: string | null;
  markForReview: boolean;
  saved: boolean;
  /**
   * "Show answer after each question" only: the admin WhatsApp share text
   * (question + options, never the answer). Shown once the answer is committed.
   */
  shareText?: string | null;
  /** RICH_V1 only: server-rendered text/options + question/option images. Absent for PLAIN. */
  rich?: RichQuestionView;
  /** Advanced types only (NEET Phase 4); absent = SINGLE_CORRECT. */
  questionType?: "MULTIPLE_CORRECT" | "MATCH_THE_FOLLOWING";
  /** MULTIPLE_CORRECT only: the saved label set. */
  selectedLabels?: string[];
  /** Withdrawn by the official answer key: original content with a WITHDRAWN label; never answerable or scored. */
  withdrawn?: true;
  /** MATCH_THE_FOLLOWING only: List I / List II. */
  match?: MatchView;
  /** Bilingual exams only: the Hindi version (presentation only — same labels, same answer). */
  hi?: HindiView;
}

/** The question as shown in the chosen language. Ids and labels never change, so answers and state are untouched. */
function inLanguage(q: PlayerQuestion, lang: TestLanguage): PlayerQuestion {
  if (lang !== "hi" || !q.hi) return q;
  const hi = q.hi;
  // Match the Following: the Hindi text carries its own Hindi List I / List II; the English lists (matchSpec) would repeat them.
  // shortcut: assumes every bilingual match question's textHi includes its lists (all 11 FSO rows, 2026-11-13); revisit if matchSpec gains Hindi.
  return { ...q, text: hi.text, options: q.options.map((o) => ({ ...o, text: hi.options[o.label] ?? o.text })), ...(hi.rich ? { rich: hi.rich } : {}), match: undefined };
}

interface QuestionState {
  selected: string | null;
  marked: boolean;
  visited: boolean;
  /** MULTIPLE_CORRECT only: the selected set, in option order. */
  labels?: string[];
}

interface RevealState {
  correctLabel: string;
  /** MULTIPLE_CORRECT only: the full correct set. */
  correctLabels?: string[];
  explanation?: ExplanationView;
}

const isAnswered = (s: QuestionState | undefined) => !!s && (!!s.selected || (s.labels?.length ?? 0) > 0);

type Status = "current" | "answered-marked" | "marked" | "answered" | "visited" | "not-visited" | "withdrawn";

const SAVE_TIMEOUT_MS = 12_000;
const SUBMIT_FLUSH_TIMEOUT_MS = 10_000;
/** Renews this device's lease on the attempt (lib/attempt-device-lease.ts, lease = 3 min). */
const HEARTBEAT_MS = 60_000;
const OTHER_DEVICE_NOTICE =
  "This test is now open on another device, so this device has stopped saving. Your saved answers are safe. Continue on the other device, or close it there and reload here after a few minutes.";

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
type PendingAnswers = Record<string, { selected: string | null; marked: boolean; labels?: string[] }>;
const pendingKey = (attemptId: string) => `mts-pending-answers:${attemptId}`;

function readPending(attemptId: string): PendingAnswers {
  try {
    return JSON.parse(window.sessionStorage.getItem(pendingKey(attemptId)) ?? "{}") as PendingAnswers;
  } catch {
    return {};
  }
}

/**
 * The attempt was closed by an admin content correction (engine code RESET):
 * stop saving, drop this attempt's unsent answers (they belong to the old
 * questions) and show the reset notice, from where the student starts fresh.
 */
function leaveResetAttempt(attemptId: string, router: { replace: (href: string) => void }, queue: { stop: () => void } | null) {
  queue?.stop();
  try {
    window.sessionStorage.removeItem(pendingKey(attemptId));
  } catch {
    // storage unavailable — nothing to clear
  }
  router.replace(`/student/attempt/${attemptId}`);
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
  withdrawn: "border border-dashed border-[var(--color-muted-foreground)] bg-[var(--color-surface)] text-[var(--color-muted-foreground)] line-through",
};

type Problem =
  | { kind: "save-failed"; message: string }
  | { kind: "submit-failed" }
  | { kind: "expired" }
  | { kind: "other-device"; message: string }
  | { kind: "unsaved-before-submit" };

export function TestPlayer({
  attemptId,
  title,
  initialRemainingSeconds,
  instantMode = false,
  questions,
  bilingual = false,
}: {
  attemptId: string;
  title: string;
  /** The exam is BILINGUAL and this attempt carries Hindi versions: language choice + switch are shown. */
  bilingual?: boolean;
  /** null = unlimited time (no countdown, no time-based auto-submit). */
  initialRemainingSeconds: number | null;
  instantMode?: boolean;
  questions: PlayerQuestion[];
}) {
  const router = useRouter();
  const language = useTestLanguage(bilingual);
  const [current, setCurrent] = useState(0);
  const [remaining, setRemaining] = useState(initialRemainingSeconds);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // ---- Distraction-free exam mode (Phase 10): fullscreen + leave/back/close guards. UI only — never touches
  // answers, the timer or submission; leaving never submits (the attempt stays resumable until its deadline).
  const fullscreen = useFullscreen();
  const [fsNoticeHidden, setFsNoticeHidden] = useState(false);
  const [fsDenied, setFsDenied] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const leavingRef = useRef(false);
  const leaveOpenRef = useRef(false);
  const [, startSubmitTransition] = useTransition();
  const [states, setStates] = useState<Record<string, QuestionState>>(() =>
    Object.fromEntries(
      questions.map((q, i) => [
        q.questionId,
        {
          selected: q.selectedOptionLabel,
          marked: q.markForReview,
          visited: i === 0,
          ...(q.questionType === "MULTIPLE_CORRECT" ? { labels: q.selectedLabels ?? [] } : {}),
        },
      ])
    )
  );
  const [reveals, setReveals] = useState<Record<string, RevealState>>(() =>
    Object.fromEntries(questions.filter((q) => q.reveal).map((q) => [q.questionId, q.reveal as RevealState]))
  );
  /** Practice Mode: the one option tap waiting for the server to commit + reveal it. */
  const [checking, setChecking] = useState<{ questionId: string; label: string } | null>(null);
  const checkingRef = useRef(false);
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
        send: async (questionId, value, seq) =>
          value.labels
            ? saveAnswerLabelsAction(attemptId, questionId, value.labels, value.marked, seq)
            : saveAnswerAction(attemptId, questionId, value.selected, value.marked, seq),
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
          if (code === "OTHER_DEVICE") {
            // Another device holds this test: stop here, keep unsaved answers on this device, never submit.
            setProblem({ kind: "other-device", message: OTHER_DEVICE_NOTICE });
          } else if (code === "EXPIRED") {
            setProblem({ kind: "expired" });
            finishRef.current("auto");
          } else if (code === "ACCESS_REVOKED") {
            // Access ended (no plan / trial / grace): the server re-renders this page as the lock screen.
            router.refresh();
          } else if (code === "RESET") {
            leaveResetAttempt(attemptId, router, queueRef.current);
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

  // RICH_V1 media: warm the cache for the NEXT question's figures and option
  // images only (never the whole paper). PLAIN questions have no `rich`, so
  // this does nothing for them. Explanation images are never in the payload.
  useEffect(() => {
    const next = questions[current + 1]?.rich;
    if (next) preloadImages(next.assets.map((a) => a.url));
    const nextMatch = questions[current + 1]?.match;
    if (nextMatch) preloadImages([...nextMatch.listI, ...nextMatch.listII].flatMap((i) => i.assets.map((a) => a.url)));
  }, [current, questions]);

  // ---- One Active Test Device: keep this device's lease alive ----------------
  // Side effect in an effect (never in a state updater — ops/TEST-ENGINE.md #1).
  // Network failures are ignored; only an explicit OTHER_DEVICE stops the tab.
  useEffect(() => {
    const beat = () => {
      if (submittedRef.current) return;
      attemptHeartbeatAction(attemptId)
        .then((result) => {
          if (!result.ok && result.code === "OTHER_DEVICE") {
            queueRef.current?.stop();
            setProblem({ kind: "other-device", message: OTHER_DEVICE_NOTICE });
          } else if (!result.ok && result.code === "RESET") {
            leaveResetAttempt(attemptId, router, queueRef.current);
          }
        })
        .catch(() => {});
    };
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [attemptId, router]);

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
      const labels = Array.isArray(answer.labels) ? { labels: answer.labels } : {};
      next[questionId] = { ...next[questionId], selected: answer.selected, marked: answer.marked, ...labels };
      getQueue().enqueue(questionId, { selected: answer.selected, marked: answer.marked, ...labels });
    }
    queueMicrotask(() => commitStates(next));
    // Mount-only: replays the previous page load's unsaved answers exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retry immediately when the connection comes back; warn before leaving with unsaved answers.
  useEffect(() => {
    const onOnline = () => retryAllSaves();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Phase 10: warn for the whole active attempt (browsers show their own generic text), not only while saves are pending.
      if (!submittedRef.current && !leavingRef.current) e.preventDefault();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [retryAllSaves]);

  // Resume on the same question after a reload / accidental exit (this tab only; answers + time come from the server).
  useEffect(() => {
    try {
      const i = Number(window.sessionStorage.getItem(`mts-q:${attemptId}`));
      if (Number.isInteger(i) && i > 0 && i < questions.length) queueMicrotask(() => setCurrent(i));
    } catch {
      // Storage blocked: start at question 1 as before.
    }
    // Mount-only restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(`mts-q:${attemptId}`, String(current));
    } catch {
      // Storage blocked: nothing to remember.
    }
  }, [attemptId, current]);

  // Browser Back: one guard history entry; Back shows the Leave dialog and re-arms the guard ONCE. A second Back
  // while the dialog is already open is let through (never a history trap).
  useEffect(() => {
    leaveOpenRef.current = leaveOpen;
  }, [leaveOpen]);
  useEffect(() => {
    window.history.pushState(window.history.state, "", window.location.href);
    const onPop = () => {
      if (submittedRef.current || leavingRef.current || leaveOpenRef.current) return;
      window.history.pushState(window.history.state, "", window.location.href);
      setLeaveError(null);
      setLeaveOpen(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** "Yes, Leave Exam": save what is pending, then leave WITHOUT submitting (today's leave behaviour). */
  const leaveExam = useCallback(async () => {
    if (leavingRef.current || submittedRef.current) return;
    setLeaveBusy(true);
    setLeaveError(null);
    const flushed = await getQueue().flush(SUBMIT_FLUSH_TIMEOUT_MS);
    if (!flushed) {
      setLeaveBusy(false);
      setLeaveError("Some answers are still being saved. Check your connection and try again — they are kept on this device.");
      return;
    }
    leavingRef.current = true;
    exitExamFullscreen();
    router.push("/student/dashboard");
  }, [getQueue, router]);

  /** Links inside question content open in a new tab instead of leaving the exam. */
  const keepLinksInNewTab = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.target === "_blank" || (a.getAttribute("href") ?? "").startsWith("#")) return;
    e.preventDefault();
    window.open(a.href, "_blank", "noopener,noreferrer");
  };

  // After Previous / Next from the bottom bar, bring the new question's heading back into view — only when the
  // student had scrolled past it (deep in a long question), so a press from the top doesn't jump.
  const cardRef = useRef<HTMLDivElement>(null);
  const firstQuestionRender = useRef(true);
  useEffect(() => {
    if (firstQuestionRender.current) {
      firstQuestionRender.current = false;
      return;
    }
    const card = cardRef.current;
    if (card && card.getBoundingClientRect().top < 64) card.scrollIntoView({ block: "start", behavior: "instant" });
  }, [current]);

  // ---- Answer + navigation handlers (pure state, side effects after) ---------
  const setAnswer = (questionId: string, patch: Partial<Pick<QuestionState, "selected" | "marked" | "labels">>) => {
    if (submittedRef.current || (reveals[questionId] && (patch.selected !== undefined || patch.labels !== undefined))) return;
    if (questions.find((q) => q.questionId === questionId)?.withdrawn) return; // never answerable, never saved
    const prev = statesRef.current[questionId];
    const next = { ...prev, ...patch };
    const sameLabels = (next.labels ?? []).join() === (prev.labels ?? []).join();
    if (next.selected === prev.selected && next.marked === prev.marked && sameLabels) return; // idempotent
    commitStates({ ...statesRef.current, [questionId]: next });
    // A MULTIPLE_CORRECT question always sends its whole set (also for a mark-only change).
    getQueue().enqueue(questionId, { selected: next.selected, marked: next.marked, ...(next.labels ? { labels: next.labels } : {}) });
  };

  /** MULTIPLE_CORRECT: toggle one option in the set (kept in option order). */
  const toggleLabel = (q: PlayerQuestion, label: string) => {
    const current = statesRef.current[q.questionId]?.labels ?? [];
    const chosen = new Set(current);
    if (chosen.has(label)) chosen.delete(label);
    else chosen.add(label);
    setAnswer(q.questionId, { labels: q.options.map((o) => o.label).filter((l) => chosen.has(l)) });
  };

  const goTo = (index: number) => {
    if (index < 0 || index >= questions.length) return;
    setCurrent(index);
    const questionId = questions[index].questionId;
    if (!statesRef.current[questionId]?.visited) {
      commitStates({ ...statesRef.current, [questionId]: { ...statesRef.current[questionId], visited: true } });
    }
  };

  /**
   * Practice Mode: the student tapped an option. The server commits that
   * answer and locks it in the same conditional update that stamps
   * revealedAt (first commit wins — a second tab or a double tap gets the
   * already-frozen answer back), and only then returns the correct label for
   * this one question. Until it confirms, nothing is revealed and nothing is
   * written to local answer state, so a failed check leaves the question
   * open to try again.
   */
  const checkAnswer = (questionId: string, label: string) => {
    if (submittedRef.current || checkingRef.current || reveals[questionId]) return;
    checkingRef.current = true;
    setChecking({ questionId, label });
    setRevealError(null);
    withTimeout(revealAnswerAction(attemptId, questionId, label, getQueue().nextSeq()), SAVE_TIMEOUT_MS)
      .then((result) => {
        if (result.ok) {
          setReveals((prev) => ({
            ...prev,
            [questionId]: { correctLabel: result.correctLabel, ...(result.explanation ? { explanation: result.explanation } : {}) },
          }));
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
        if (result.code === "OTHER_DEVICE") {
          queueRef.current?.stop();
          setProblem({ kind: "other-device", message: OTHER_DEVICE_NOTICE });
          return;
        }
        if (result.code === "RESET") {
          leaveResetAttempt(attemptId, router, queueRef.current);
          return;
        }
        if (result.code === "NOT_EDITABLE") {
          router.replace(`/student/attempt/${attemptId}/result`);
          return;
        }
        if (result.code === "ACCESS_REVOKED") {
          router.refresh();
          return;
        }
        setRevealError({ questionId, message: result.message });
      })
      .catch(() => setRevealError({ questionId, message: "Could not check the answer. Tap an option to try again." }))
      .finally(() => {
        checkingRef.current = false;
        setChecking(null);
      });
  };

  /**
   * Practice Mode, MULTIPLE_CORRECT: one tap can't be the answer, so the
   * student commits the whole set with "Check answer". The server freezes
   * that set with the reveal (first commit wins) and only then returns the
   * full correct set.
   */
  const checkMultiAnswer = (questionId: string) => {
    const labels = statesRef.current[questionId]?.labels ?? [];
    if (submittedRef.current || checkingRef.current || reveals[questionId] || labels.length === 0) return;
    checkingRef.current = true;
    setChecking({ questionId, label: "" });
    setRevealError(null);
    withTimeout(revealAnswerLabelsAction(attemptId, questionId, labels, getQueue().nextSeq()), SAVE_TIMEOUT_MS)
      .then((result) => {
        if (result.ok) {
          setReveals((prev) => ({
            ...prev,
            [questionId]: {
              correctLabel: "",
              correctLabels: result.correctLabels,
              ...(result.explanation ? { explanation: result.explanation } : {}),
            },
          }));
          getQueue().drop(questionId);
          commitStates({ ...statesRef.current, [questionId]: { ...statesRef.current[questionId], labels: result.selectedLabels } });
          return;
        }
        if (result.code === "EXPIRED") {
          setProblem({ kind: "expired" });
          finishRef.current("auto");
          return;
        }
        if (result.code === "OTHER_DEVICE") {
          queueRef.current?.stop();
          setProblem({ kind: "other-device", message: OTHER_DEVICE_NOTICE });
          return;
        }
        if (result.code === "RESET") {
          leaveResetAttempt(attemptId, router, queueRef.current);
          return;
        }
        if (result.code === "NOT_EDITABLE") {
          router.replace(`/student/attempt/${attemptId}/result`);
          return;
        }
        if (result.code === "ACCESS_REVOKED") {
          router.refresh();
          return;
        }
        setRevealError({ questionId, message: result.message });
      })
      .catch(() => setRevealError({ questionId, message: "Could not check the answer. Try again." }))
      .finally(() => {
        checkingRef.current = false;
        setChecking(null);
      });
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

  const question = inLanguage(questions[Math.min(current, questions.length - 1)], language.lang);
  const state = states[question.questionId] ?? { selected: null, marked: false, visited: true };
  const reveal = reveals[question.questionId] ?? null;
  const checkingHere = checking?.questionId === question.questionId ? checking.label : null;
  /** Withdrawn in the official key: shown as printed, but nothing can be selected, marked, checked or saved. */
  const withdrawn = question.withdrawn === true;
  /** Practice Mode question waiting for its first committed answer: options are the check action. */
  const practiceOpen = instantMode && !reveal && !question.malformed && !withdrawn;
  const qSave = saveStatus[question.questionId];
  const isLast = current === questions.length - 1;

  const minutes = remaining === null ? 0 : Math.floor(remaining / 60);
  const seconds = remaining === null ? 0 : remaining % 60;
  const timeLow = remaining !== null && remaining <= 60;

  const answeredCount = questions.filter((q) => isAnswered(states[q.questionId])).length;
  const withdrawnCount = questions.filter((q) => q.withdrawn).length;
  const scoredTotal = questions.length - withdrawnCount;
  const multi = question.questionType === "MULTIPLE_CORRECT";
  const markedCount = questions.filter((q) => states[q.questionId]?.marked).length;
  const unsavedCount = Object.values(saveStatus).filter((s) => s !== "saving").length;

  function statusFor(q: PlayerQuestion, i: number): Status {
    if (i === current) return "current";
    if (q.withdrawn) return "withdrawn";
    const s = states[q.questionId];
    if (!s) return "not-visited";
    if (s.marked && isAnswered(s)) return "answered-marked";
    if (s.marked) return "marked";
    if (isAnswered(s)) return "answered";
    if (s.visited) return "visited";
    return "not-visited";
  }

  return (
    <div className="flex min-h-screen flex-col" data-testid="test-player" data-question-index={current} data-fullscreen={fullscreen ? "on" : "off"} onClickCapture={keepLinksInNewTab}>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:gap-4 sm:px-6">
        <span className="hidden shrink-0 text-xs font-semibold tracking-tight text-[var(--color-muted-foreground)] sm:inline" aria-hidden>
          MockTestSeries
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-foreground)]">{title}</p>
        <div className="flex shrink-0 items-center gap-2">
          {bilingual ? <LanguageSwitch lang={language.lang} onChange={language.choose} /> : null}
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLeaveError(null);
              setLeaveOpen(true);
            }}
            data-testid="leave-exam"
            aria-label={fullscreen ? "Leave full screen" : "Leave exam"}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{fullscreen ? "Leave Full Screen" : "Leave Exam"}</span>
          </Button>
        </div>
      </header>
      {fullscreen === false && !fsNoticeHidden && !submitting ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-card)] px-4 py-2 sm:px-6" data-testid="fullscreen-notice">
          <p className="text-sm text-[var(--color-foreground)]">
            {fullscreenSupported() && !fsDenied
              ? "Full screen is off. Your test continues — your answers and remaining time are safe."
              : "Full screen isn't available in this browser. Your test continues here — your answers and remaining time are safe."}
          </p>
          <div className="flex items-center gap-2">
            {fullscreenSupported() && !fsDenied ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void requestExamFullscreen().then((r) => setFsDenied(r !== "ok"))}
                data-testid="enter-fullscreen"
              >
                <Maximize className="h-4 w-4" aria-hidden /> Enter full screen
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => setFsNoticeHidden(true)} aria-label="Dismiss full screen notice">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      {bilingual && !language.chosen ? (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-card)] px-4 py-4 sm:px-6" data-testid="language-gate">
          <LanguageChoice lang={language.lang} chosen={false} onChoose={language.choose} />
        </div>
      ) : null}

      {problem ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 px-4 py-3 sm:px-6">
          <p className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
            {problem.kind === "submit-failed"
              ? "Your test could not be submitted. Your saved answers are kept — try again, or reload and submit."
              : problem.kind === "expired"
                ? "Time is up — submitting your test."
                : problem.kind === "other-device"
                  ? problem.message
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
          <div ref={cardRef} className="scroll-mt-20 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
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

            {withdrawn ? (
              <div role="note" data-testid="withdrawn-question" className="mb-4 rounded-[var(--radius-card)] border-2 border-[var(--color-warning)] bg-[var(--color-warning)]/10 p-3 text-sm text-[var(--color-foreground)]">
                <p className="font-bold uppercase tracking-wide text-[var(--color-warning)]">Withdrawn question</p>
                <p className="mt-1">
                  This question was withdrawn in the official answer key. It is shown as printed for the record — it cannot be
                  answered and is not counted in your score or maximum marks.
                </p>
              </div>
            ) : null}
            <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">
              <RichText text={question.text} html={question.rich?.textHtml} />
            </p>
            {question.imageUrl && !question.rich?.assets.some((a) => a.role === "QUESTION") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={question.imageUrl}
                alt=""
                className="mt-3 max-h-72 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
              />
            ) : null}
            {question.rich ? <QuestionMedia key={question.questionId} className="mt-3" priority assets={question.rich.assets.filter((a) => a.role === "QUESTION")} /> : null}
            {question.match && !question.malformed ? <MatchLists key={`m-${question.questionId}`} className="mt-4" match={question.match} /> : null}

            {question.malformed ? (
              <div role="alert" data-testid="malformed-question" className="mt-5 rounded-[var(--radius-card)] border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 p-4 text-sm text-[var(--color-foreground)]">
                This question could not be displayed correctly and cannot be answered. Please report it and continue with
                the next question — the rest of your test is unaffected.
              </div>
            ) : multi ? (
              <MultiCorrectOptions
                question={question}
                position={current + 1}
                labels={state.labels ?? []}
                correctLabels={reveal?.correctLabels ?? null}
                disabled={!!reveal || !!checking || submitting || withdrawn}
                onToggle={(label) => (withdrawn ? undefined : toggleLabel(question, label))}
              />
            ) : (
              <div className="mt-5 flex flex-col gap-2.5" role="radiogroup" aria-label={`Question ${current + 1} options`}>
                {question.options.map((opt, idx) => {
                  const selected = (checkingHere ?? state.selected) === opt.label;
                  const isCorrect = reveal ? opt.label === reveal.correctLabel : false;
                  const isWrongPick = reveal ? selected && !isCorrect : false;
                  return (
                    <label
                      key={`${question.questionId}:${idx}:${opt.label}`}
                      data-testid="option"
                      data-label={opt.label}
                      className={cn(
                        "flex items-start gap-3 rounded-[var(--radius-card)] border p-3 transition-colors",
                        reveal || checkingHere || withdrawn ? "cursor-default" : "cursor-pointer",
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
                        disabled={!!reveal || !!checking || submitting || withdrawn}
                        // Practice Mode commits on the tap itself (also a tap on an option a
                        // legacy attempt pre-selected without checking). Exam Mode only selects.
                        onClick={practiceOpen ? () => checkAnswer(question.questionId, opt.label) : undefined}
                        onChange={practiceOpen || withdrawn ? () => {} : () => setAnswer(question.questionId, { selected: opt.label })}
                      />
                      <span className="min-w-0 text-sm text-[var(--color-foreground)]">
                        <span className="font-semibold">{opt.label}.</span> <RichText text={opt.text} html={question.rich?.optionHtml[opt.label]} />
                        {opt.imageUrl && !question.rich?.assets.some((a) => a.role === "OPTION" && a.optionLabel === opt.label) ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={opt.imageUrl}
                            alt=""
                            className="pointer-events-none mt-2 max-h-48 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                          />
                        ) : null}
                        {question.rich ? (
                          <QuestionMedia
                            className="mt-2"
                            size="option"
                            priority
                            assets={question.rich.assets.filter((a) => a.role === "OPTION" && a.optionLabel === opt.label)}
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

            {instantMode && !question.malformed && !withdrawn && multi ? (
              <div className="mt-4 flex flex-col gap-2" data-testid="instant-panel">
                {reveal ? (
                  <RevealedReviewTools
                    key={question.questionId}
                    questionId={question.questionId}
                    correctOption={null}
                    correctOptionHtml={null}
                    explanation={reveal.explanation ?? null}
                    shareText={question.shareText ?? null}
                    askAi={false}
                    result={<MultiRevealResult selected={state.labels ?? []} correct={reveal.correctLabels ?? []} />}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      data-testid="check-answer"
                      size="sm"
                      onClick={() => checkMultiAnswer(question.questionId)}
                      disabled={!!checking || submitting || (state.labels ?? []).length === 0}
                    >
                      {checkingHere !== null ? "Checking…" : "Check answer"}
                    </Button>
                    <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="practice-hint" aria-live="polite">
                      Select every correct option, then check. Your checked answer is final.
                    </p>
                  </div>
                )}
                {revealError?.questionId === question.questionId ? (
                  <p className="text-sm text-[var(--color-error)]">{revealError.message}</p>
                ) : null}
              </div>
            ) : instantMode && !question.malformed && !withdrawn ? (
              <div className="mt-4 flex flex-col gap-2" data-testid="instant-panel">
                {reveal ? (
                  <RevealedReviewTools
                    key={`${question.questionId}:${language.lang}`}
                    questionId={question.questionId}
                    lang={language.lang}
                    correctOption={question.options.find((o) => o.label === reveal.correctLabel) ?? null}
                    correctOptionHtml={question.rich?.optionHtml[reveal.correctLabel] ?? null}
                    explanation={reveal.explanation ?? null}
                    shareText={question.shareText ?? null}
                    askAi={!question.questionType}
                    result={
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
                      </p>
                    }
                  />
                ) : (
                  <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="practice-hint" aria-live="polite">
                    {checkingHere ? "Checking your answer…" : "Select an option to check your answer. Your first answer is final."}
                  </p>
                )}
                {revealError?.questionId === question.questionId ? (
                  <p className="text-sm text-[var(--color-error)]">{revealError.message}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Previous / Save & Next (Submit Test on the last question) live in the sticky bottom bar (QuestionBottomNav) below. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => setAnswer(question.questionId, multi ? { labels: [], marked: false } : { selected: null, marked: false })}
              disabled={!!reveal || !!checking || submitting || question.malformed || withdrawn}
            >
              Clear Response
            </Button>
            <Button
              variant="outline"
              disabled={submitting || !!checkingHere || withdrawn}
              onClick={() => {
                setAnswer(question.questionId, { marked: !state.marked });
                goTo(current + 1);
              }}
            >
              <Flag className="h-4 w-4" aria-hidden /> Mark for Review & Next
            </Button>
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
              {withdrawnCount ? (
                <span className="flex items-center gap-1.5" data-testid="legend-withdrawn">
                  <span className="h-2.5 w-2.5 rounded-full border border-dashed border-[var(--color-muted-foreground)]" /> Withdrawn — not scored ({withdrawnCount})
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-5 lg:grid-cols-6" data-testid="palette">
              {questions.map((q, i) => (
                <button
                  key={q.questionId}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Go to question ${i + 1}${q.withdrawn ? " (withdrawn)" : ""}`}
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

      <QuestionBottomNav
        testId="player-nav"
        positionTestId="player-nav-position"
        className="mx-0 px-4 sm:px-6"
        index={current}
        total={questions.length}
        onPrevious={() => goTo(current - 1)}
        previousDisabled={current === 0}
        onNext={isLast ? () => setConfirmOpen(true) : () => goTo(current + 1)}
        nextDisabled={isLast ? submitting : false}
        next={
          isLast ? (
            "Submit Test"
          ) : (
            <>
              {instantMode ? "Next" : "Save & Next"} <ChevronRight className="h-4 w-4" aria-hidden />
            </>
          )
        }
      />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[var(--color-warning)]" aria-hidden /> Submit test?
            </DialogTitle>
            <DialogDescription>
              You have answered {answeredCount} of {scoredTotal} questions.
              {withdrawnCount ? ` ${withdrawnCount} withdrawn question(s) are not scored.` : ""}
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

      <Dialog open={leaveOpen} onOpenChange={(o) => !leaveBusy && setLeaveOpen(o)}>
        <DialogContent data-testid="leave-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[var(--color-warning)]" aria-hidden /> Are you sure you want to leave the exam?
            </DialogTitle>
            <DialogDescription>
              Leaving the exam may end your current test session. Your saved answers, remaining time and submission status will be handled
              according to the exam rules.
            </DialogDescription>
          </DialogHeader>
          {leaveError ? (
            <p role="alert" className="text-sm text-[var(--color-error)]">
              {leaveError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" autoFocus disabled={leaveBusy} data-testid="leave-continue">
                No, Continue Exam
              </Button>
            </DialogClose>
            <Button variant="danger" onClick={() => void leaveExam()} disabled={leaveBusy} data-testid="leave-confirm">
              {leaveBusy ? "Saving…" : "Yes, Leave Exam"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * "Show answer after each question": the review tools for ONE question the
 * server has already revealed (the student's tap committed and locked it).
 * Reuses the Review page's own pieces — the correct-answer line, the Ask AI
 * hook (explanation + variants; the server authorizes it through the
 * same answer-reveal rule and AI quota, and nothing is fetched until the
 * student taps it) and the WhatsApp share button (question + options only).
 * Save / Report stay in the question header for every mode.
 */
function RevealedReviewTools({
  questionId,
  correctOption,
  correctOptionHtml,
  explanation,
  shareText,
  askAi = true,
  result,
  lang,
}: {
  questionId: string;
  /** Bilingual exams: Ask AI answers in the language the question is being read in. */
  lang?: TestLanguage;
  correctOption: PlayerOption | null;
  /** RICH_V1 only: the correct option's rendered text. */
  correctOptionHtml: RenderedHtml | null;
  /** The human explanation, released by the server with this reveal (snapshot v2 only). */
  explanation: ExplanationView | null;
  shareText: string | null;
  /** False for advanced question types (NEET Phase 4): Ask AI only explains single-correct questions. */
  askAi?: boolean;
  /** The Correct / Incorrect line — shares its row with the AI actions. */
  result: React.ReactNode;
}) {
  const { actions: askAiActions, usageNotice, panel: askAiPanel } = useAskAi(questionId, "practice_player", undefined, lang);
  return (
    <div className="flex flex-col gap-3" data-testid="revealed-review-tools">
      {/* Correct ✓ on the left, the AI actions on the right — wrapping under it on narrow screens. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {result}
        {askAi ? askAiActions : null}
      </div>
      {askAi ? usageNotice : null}
      {correctOption ? (
        <p className="text-sm font-medium text-[var(--color-success)]">
          Correct Answer: {correctOption.label}. <RichText text={correctOption.text} html={correctOptionHtml} />
        </p>
      ) : null}
      {explanation ? <HumanExplanation explanation={explanation} /> : null}
      {/* Wrapped so the shared button (flex-1 in the Review header) sizes to its label here. */}
      {shareText ? (
        <div className="flex">
          <WhatsAppShareButton text={shareText} />
        </div>
      ) : null}
      {askAi ? askAiPanel : null}
    </div>
  );
}

/**
 * MULTIPLE_CORRECT options (NEET Phase 4): real checkboxes in a labelled group,
 * so assistive technology announces a multi-select, never a radio group. Same
 * option card styling as the radio path. After an authorized reveal each
 * option shows one of: selected + correct, selected but wrong, correct but missed.
 */
function MultiCorrectOptions({
  question,
  position,
  labels,
  correctLabels,
  disabled,
  onToggle,
}: {
  question: PlayerQuestion;
  position: number;
  labels: string[];
  /** Present only after the server revealed this question. */
  correctLabels: string[] | null;
  disabled: boolean;
  onToggle: (label: string) => void;
}) {
  const hintId = `multi-hint-${question.questionId}`;
  return (
    <div className="mt-5 flex flex-col gap-2.5" role="group" aria-label={`Question ${position} options`} aria-describedby={hintId} data-testid="multi-options">
      <p id={hintId} className="text-xs font-medium text-[var(--color-muted-foreground)]">
        More than one option may be correct. Select all that apply.
      </p>
      {question.options.map((opt, idx) => {
        const selected = labels.includes(opt.label);
        const correct = correctLabels ? correctLabels.includes(opt.label) : false;
        const state = !correctLabels ? null : selected && correct ? "hit" : selected ? "wrong" : correct ? "missed" : null;
        return (
          <label
            key={`${question.questionId}:${idx}:${opt.label}`}
            data-testid="option"
            data-label={opt.label}
            data-state={state ?? undefined}
            className={cn(
              "flex items-start gap-3 rounded-[var(--radius-card)] border p-3 transition-colors",
              disabled ? "cursor-default" : "cursor-pointer",
              state === "hit"
                ? "border-[var(--color-success)] bg-[var(--color-success)]/10"
                : state === "missed"
                  ? "border-dashed border-[var(--color-success)] bg-[var(--color-success)]/5"
                  : state === "wrong"
                    ? "border-[var(--color-error)] bg-[var(--color-error)]/10"
                    : selected
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10"
                      : "border-[var(--color-border)] hover:bg-[var(--color-surface)]"
            )}
          >
            <input
              type="checkbox"
              name={`q-${question.questionId}`}
              value={opt.label}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
              checked={selected}
              disabled={disabled}
              onChange={() => onToggle(opt.label)}
            />
            <span className="min-w-0 text-sm text-[var(--color-foreground)]">
              <span className="font-semibold">{opt.label}.</span> <RichText text={opt.text} html={question.rich?.optionHtml[opt.label]} />
              {opt.imageUrl && !question.rich?.assets.some((a) => a.role === "OPTION" && a.optionLabel === opt.label) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={opt.imageUrl}
                  alt=""
                  className="pointer-events-none mt-2 max-h-48 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                />
              ) : null}
              {question.rich ? (
                <QuestionMedia
                  className="mt-2"
                  size="option"
                  priority
                  assets={question.rich.assets.filter((a) => a.role === "OPTION" && a.optionLabel === opt.label)}
                />
              ) : null}
            </span>
            {state === "hit" ? <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-[var(--color-success)]" aria-label="Correct, selected" /> : null}
            {state === "wrong" ? <XCircle className="ml-auto h-5 w-5 shrink-0 text-[var(--color-error)]" aria-label="Selected, not correct" /> : null}
            {state === "missed" ? (
              <span className="ml-auto shrink-0 text-xs font-medium text-[var(--color-success)]">Missed</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

/** MULTIPLE_CORRECT reveal line: all-or-nothing verdict plus both sets. */
function MultiRevealResult({ selected, correct }: { selected: string[]; correct: string[] }) {
  const right = selected.length === correct.length && selected.every((l) => correct.includes(l));
  return (
    <div className="flex flex-col gap-1" data-testid="reveal-result">
      <p className={cn("flex items-center gap-2 text-sm font-semibold", right ? "text-[var(--color-success)]" : "text-[var(--color-error)]")}>
        {right ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
        {right ? "Correct" : "Incorrect"}
      </p>
      <p className="text-sm text-[var(--color-foreground)]">
        Your answer: {selected.join(", ") || "—"} · <span className="font-medium text-[var(--color-success)]">Correct answer: {correct.join(", ")}</span>
      </p>
    </div>
  );
}
