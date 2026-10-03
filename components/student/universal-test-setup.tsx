"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, ArrowRight, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { QuestionCountPresets } from "@/components/student/question-count-presets";
import { AttemptModeFields } from "@/components/student/test-mode-fields";
import { PRACTICE_TIME_MODES } from "@/lib/attempt-config";

/**
 * UniversalTestSetup — the ONE pre-test configuration form for configurable
 * practice (Custom Module and Subject Test). It only collects choices; the
 * server action re-validates every value, resolves the question set, freezes
 * it plus durationMode / answerMode onto a TestAttempt, and the attempt then
 * runs in the one universal player (app/student/attempt/[attemptId]/run).
 *
 * Formal tests (Mock Test, full Previous Year Paper) never use this form:
 * their question set is admin-defined. Their Pre-Test Setup
 * (components/student/pre-test-setup.tsx) shares the same answer review →
 * duration fields (components/student/test-mode-fields.tsx).
 */

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

interface Topic {
  id: string;
  name: string;
}
interface Subject {
  id: string;
  name: string;
  topics: Topic[];
}
export interface TestSetupExam {
  id: string;
  name: string;
  subjects: Subject[];
  years: number[];
}

export interface TestSetupFormState {
  error?: string;
}

export interface TestSetupCountFilters {
  examId: string;
  subjectId?: string;
  topicId?: string;
  year?: number;
  source?: never;
  difficulty?: never;
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? pendingLabel : (
        <>
          <ArrowRight className="h-4 w-4" aria-hidden /> {label}
        </>
      )}
    </Button>
  );
}

export function UniversalTestSetup({
  exams,
  initialExam,
  examLocked = false,
  subjectRequired = false,
  initialSubjectId,
  action,
  countAction,
  setupAction,
  submitLabel,
  pendingLabel,
  footnote,
}: {
  exams: { id: string; name: string }[];
  initialExam: TestSetupExam | null;
  /** Subject Test: the exam is fixed by the page, not chosen here. */
  examLocked?: boolean;
  /** Subject Test: a subject must be chosen (no "All Subjects"). */
  subjectRequired?: boolean;
  initialSubjectId?: string;
  action: (prev: TestSetupFormState, formData: FormData) => Promise<TestSetupFormState>;
  countAction: (filters: TestSetupCountFilters) => Promise<number>;
  setupAction?: (examId: string) => Promise<{ subjects: Subject[]; years: number[] } | null>;
  submitLabel: string;
  pendingLabel: string;
  footnote: React.ReactNode;
}) {
  const [examId, setExamId] = useState(initialExam?.id ?? "");
  const [examSetup, setExamSetup] = useState<TestSetupExam | null>(initialExam);
  const [subjectId, setSubjectId] = useState(
    initialSubjectId ?? (subjectRequired ? (initialExam?.subjects[0]?.id ?? "") : "")
  );
  const [topicId, setTopicId] = useState("");
  const [year, setYear] = useState("");
  const [source, setSource] = useState("");
  const [difficulty, setDifficulty] = useState<string[]>([]);
  const [count, setCount] = useState(10);
  const [available, setAvailable] = useState<number | null>(null);
  const [state, formAction] = useActionState<TestSetupFormState, FormData>(action, {});
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<{ signature: string; message: string } | null>(null);
  const [confirmPending, startConfirmTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!examId || examSetup?.id === examId || !setupAction) return;
    let cancelled = false;
    setupAction(examId).then((setup) => {
      if (!cancelled && setup) setExamSetup({ id: examId, name: exams.find((e) => e.id === examId)?.name ?? "", ...setup });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  const activeSetup = examId && examSetup?.id === examId ? examSetup : null;
  const subjects = useMemo(() => activeSetup?.subjects ?? [], [activeSetup]);
  const subject = useMemo(() => subjects.find((s) => s.id === subjectId), [subjects, subjectId]);
  const topics = useMemo(() => subject?.topics ?? [], [subject]);
  const selectionReady = !!examId && (!subjectRequired || !!subjectId);

  useEffect(() => {
    if (!selectionReady) return;
    let cancelled = false;
    countAction({
      examId,
      subjectId: subjectId || undefined,
      topicId: topicId || undefined,
      year: year ? Number(year) : undefined,
      source: (source || undefined) as never,
      difficulty: difficulty.length > 0 ? (difficulty as never) : undefined,
    })
      .then((n) => {
        if (!cancelled) setAvailable(n);
      })
      .catch(() => {
        if (!cancelled) setAvailable(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionReady, examId, subjectId, topicId, year, source, difficulty]);

  const countExceeds = available !== null && count > available;

  // The "Only N available — Continue with N?" prompt is keyed to a signature
  // of every filter that affects the pool, so changing anything after
  // dismissing it makes the prompt reappear (derived during render — never a
  // setState-in-effect) instead of staying hidden forever.
  const filterSignature = JSON.stringify([examId, subjectId, topicId, year, source, difficulty, count]);
  const confirmDismissed = dismissedSignature === filterSignature;
  const activeConfirmError = confirmError?.signature === filterSignature ? confirmError.message : null;

  const handleContinueWithAvailable = () => {
    if (!formRef.current || available === null) return;
    setConfirmError(null);
    const formData = new FormData(formRef.current);
    formData.set("count", String(available));
    startConfirmTransition(async () => {
      const result = await action({}, formData);
      if (result?.error) setConfirmError({ signature: filterSignature, message: result.error });
    });
  };

  if (subjectRequired && activeSetup && subjects.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-[var(--color-muted-foreground)]">
          <ListChecks className="mx-auto mb-2 h-8 w-8" aria-hidden />
          No subjects have been added to this exam yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      <Card>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {examLocked ? (
            <input type="hidden" name="examId" value={examId} />
          ) : (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="examId">Exam *</Label>
              <SelectNative
                id="examId"
                name="examId"
                value={examId}
                onChange={(e) => {
                  setExamId(e.target.value);
                  setSubjectId("");
                  setTopicId("");
                }}
                required
              >
                <option value="" disabled>
                  Select exam
                </option>
                {exams.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectNative>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subjectId">Subject{subjectRequired ? " *" : ""}</Label>
            <SelectNative
              id="subjectId"
              name="subjectId"
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTopicId("");
              }}
              disabled={subjects.length === 0}
              required={subjectRequired}
            >
              {subjectRequired ? null : <option value="">All Subjects</option>}
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="topicId">Topic</Label>
            <SelectNative
              id="topicId"
              name="topicId"
              value={topicId}
              onChange={(e) => setTopicId(e.target.value)}
              disabled={topics.length === 0}
            >
              <option value="">All Topics</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="year">Year</Label>
            <SelectNative id="year" name="year" value={year} onChange={(e) => setYear(e.target.value)} disabled={!activeSetup || activeSetup.years.length === 0}>
              <option value="">All Years</option>
              {(activeSetup?.years ?? []).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="source">Source</Label>
            <SelectNative id="source" name="source" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Question Bank + PYQ</option>
              <option value="QUESTION_BANK">Question Bank only</option>
              <option value="PYQ">Previous Year Papers only</option>
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Difficulty</Label>
            <div className="flex items-center gap-3 pt-1.5">
              {DIFFICULTIES.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
                  <input
                    type="checkbox"
                    name="difficulty"
                    value={d}
                    checked={difficulty.includes(d)}
                    onChange={() =>
                      setDifficulty((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
                    }
                  />
                  {d[0] + d.slice(1).toLowerCase()}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Question Count *</Label>
            <QuestionCountPresets count={count} onChange={setCount} inputName="count" />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {!examId
                ? "Select an exam to see how many questions match."
                : !selectionReady
                  ? "Select a subject to see how many questions match."
                  : available === null
                    ? "Checking how many questions are available…"
                    : available === 0
                      ? "No questions match this selection."
                      : countExceeds
                        ? <span className="text-[var(--color-warning)]">Only {available} questions are available for this selection.</span>
                        : `Up to ${available} questions are available for this selection.`}
            </p>
          </div>

          <AttemptModeFields timeModes={PRACTICE_TIME_MODES} defaultTimeMode="PER_QUESTION" questionCount={count} />
        </CardContent>
      </Card>

      <Card className="border-[var(--color-primary)]/40">
        <CardContent className="flex flex-col gap-3 pt-5">
          {selectionReady && available !== null && available === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
              <ListChecks className="h-4 w-4 shrink-0" aria-hidden /> Try widening your filters.
            </p>
          ) : null}
          {state.error ? (
            <p className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
            </p>
          ) : null}
          <p className="text-xs text-[var(--color-muted-foreground)]">{footnote}</p>

          {available === 0 ? null : countExceeds && !confirmDismissed ? (
            <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-3">
              <p className="text-sm text-[var(--color-foreground)]">
                Only {available} question{available === 1 ? "" : "s"} {available === 1 ? "is" : "are"} currently available for
                this selection. Would you like to continue with all {available}?
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setDismissedSignature(filterSignature)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={confirmPending} onClick={handleContinueWithAvailable}>
                  {confirmPending ? pendingLabel : `Continue with ${available}`}
                </Button>
              </div>
              {activeConfirmError ? <p className="text-sm text-[var(--color-error)]">{activeConfirmError}</p> : null}
            </div>
          ) : (
            <SubmitButton label={submitLabel} pendingLabel={pendingLabel} />
          )}
        </CardContent>
      </Card>
    </form>
  );
}
