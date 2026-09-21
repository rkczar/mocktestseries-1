"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, ArrowRight, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { QuestionCountPresets } from "@/components/student/question-count-presets";
import { createCustomModuleAction, countCustomModuleQuestionsAction, getExamSetupAction, type CustomModuleBuilderState } from "./actions";

const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
const ATTEMPT_FILTERS = [
  { value: "", label: "No history filter" },
  { value: "INCORRECT", label: "Only questions I got wrong" },
  { value: "UNATTEMPTED", label: "Only questions I've never attempted" },
  { value: "SAVED", label: "Only my saved questions" },
] as const;

interface Topic {
  id: string;
  name: string;
  subTopics: { id: string; name: string }[];
}
interface Subject {
  id: string;
  name: string;
  topics: Topic[];
}
interface ExamSetup {
  id: string;
  name: string;
  subjects: Subject[];
  years: number[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? "Building module…" : (
        <>
          <ArrowRight className="h-4 w-4" aria-hidden /> Create &amp; Start
        </>
      )}
    </Button>
  );
}

export function CustomModuleBuilder({
  exams,
  initialExam,
}: {
  studentId: string;
  exams: { id: string; name: string }[];
  initialExam: ExamSetup | null;
}) {
  const [examId, setExamId] = useState(initialExam?.id ?? "");
  const [examSetup, setExamSetup] = useState<ExamSetup | null>(initialExam);
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [subTopicId, setSubTopicId] = useState("");
  const [year, setYear] = useState("");
  const [source, setSource] = useState("");
  const [attemptFilter, setAttemptFilter] = useState("");
  const [difficulty, setDifficulty] = useState<string[]>([]);
  const [count, setCount] = useState(15);
  const [durationMinutes, setDurationMinutes] = useState(20);
  const [available, setAvailable] = useState<number | null>(null);
  const [state, formAction] = useActionState<CustomModuleBuilderState, FormData>(createCustomModuleAction, {});
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<{ signature: string; message: string } | null>(null);
  const [confirmPending, startConfirmTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!examId || examSetup?.id === examId) return;
    let cancelled = false;
    getExamSetupAction(examId).then((setup) => {
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
  const topic = useMemo(() => topics.find((t) => t.id === topicId), [topics, topicId]);
  const subTopics = topic?.subTopics ?? [];

  useEffect(() => {
    if (!examId) return;
    let cancelled = false;
    countCustomModuleQuestionsAction({
      examId,
      subjectId: subjectId || undefined,
      topicId: topicId || undefined,
      subTopicId: subTopicId || undefined,
      year: year ? Number(year) : undefined,
      source: (source || undefined) as never,
      difficulty: difficulty.length > 0 ? (difficulty as never) : undefined,
      attemptFilter: (attemptFilter || undefined) as never,
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
  }, [examId, subjectId, topicId, subTopicId, year, source, attemptFilter, difficulty]);

  const countExceeds = available !== null && count > available;

  // The "Only N available — Continue with N?" prompt is keyed to a signature
  // of every filter that affects the pool, so changing anything after
  // dismissing it makes the prompt reappear (derived during render — never a
  // setState-in-effect) instead of staying hidden forever.
  const filterSignature = JSON.stringify([examId, subjectId, topicId, subTopicId, year, source, attemptFilter, difficulty, count]);
  const confirmDismissed = dismissedSignature === filterSignature;
  const activeConfirmError = confirmError?.signature === filterSignature ? confirmError.message : null;

  const handleContinueWithAvailable = () => {
    if (!formRef.current || available === null) return;
    setConfirmError(null);
    const formData = new FormData(formRef.current);
    formData.set("count", String(available));
    startConfirmTransition(async () => {
      const result = await createCustomModuleAction({}, formData);
      if (result?.error) setConfirmError({ signature: filterSignature, message: result.error });
    });
  };

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      <Card>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                setSubTopicId("");
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subjectId">Subject</Label>
            <SelectNative
              id="subjectId"
              name="subjectId"
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTopicId("");
                setSubTopicId("");
              }}
              disabled={subjects.length === 0}
            >
              <option value="">All Subjects</option>
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
              onChange={(e) => {
                setTopicId(e.target.value);
                setSubTopicId("");
              }}
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
            <Label htmlFor="subTopicId">Sub-topic</Label>
            <SelectNative
              id="subTopicId"
              name="subTopicId"
              value={subTopicId}
              onChange={(e) => setSubTopicId(e.target.value)}
              disabled={subTopics.length === 0}
            >
              <option value="">All Sub-topics</option>
              {subTopics.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
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
            <Label htmlFor="attemptFilter">My History</Label>
            <SelectNative id="attemptFilter" name="attemptFilter" value={attemptFilter} onChange={(e) => setAttemptFilter(e.target.value)}>
              {ATTEMPT_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
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
                : available === null
                  ? "Checking how many questions are available…"
                  : available === 0
                    ? "No questions match this selection."
                    : countExceeds
                      ? <span className="text-[var(--color-warning)]">Only {available} questions are available for this selection.</span>
                      : `Up to ${available} questions are available for this selection.`}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="durationMinutes">Duration (minutes, optional)</Label>
            <Input
              id="durationMinutes"
              name="durationMinutes"
              type="number"
              min={1}
              max={300}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Math.max(1, Number(e.target.value)))}
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">The timer is enforced server-side.</p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[var(--color-primary)]/40">
        <CardContent className="flex flex-col gap-3 pt-5">
          {examId && available !== null && available === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
              <ListChecks className="h-4 w-4 shrink-0" aria-hidden /> Try widening your filters.
            </p>
          ) : null}
          {state.error ? (
            <p className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
            </p>
          ) : null}
          <p className="text-xs text-[var(--color-muted-foreground)]">
            This module is private to you. The question set is fixed the moment you create it — refreshing or resuming
            never generates a new set.
          </p>

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
                  {confirmPending ? "Building module…" : `Continue with ${available}`}
                </Button>
              </div>
              {activeConfirmError ? <p className="text-sm text-[var(--color-error)]">{activeConfirmError}</p> : null}
            </div>
          ) : (
            <SubmitButton />
          )}
        </CardContent>
      </Card>
    </form>
  );
}
