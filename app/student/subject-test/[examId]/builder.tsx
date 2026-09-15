"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, ArrowRight, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { startSubjectTestAction, countAvailableQuestionsAction, type SubjectTestFormState } from "../actions";

interface BuilderSubTopic {
  id: string;
  name: string;
}

interface BuilderTopic {
  id: string;
  name: string;
  subTopics: BuilderSubTopic[];
}

interface BuilderSubject {
  id: string;
  name: string;
  topics: BuilderTopic[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending ? (
        "Building test…"
      ) : (
        <>
          <ArrowRight className="h-4 w-4" aria-hidden /> Start Subject Test
        </>
      )}
    </Button>
  );
}

export function SubjectTestBuilder({
  exam,
  subjects,
  years,
}: {
  exam: { id: string; name: string; instructions: string | null; durationMinutes: number | null };
  subjects: BuilderSubject[];
  years: number[];
}) {
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [year, setYear] = useState("");
  const [topicId, setTopicId] = useState("");
  const [subTopicId, setSubTopicId] = useState("");
  const [count, setCount] = useState(15);
  const [durationMinutes, setDurationMinutes] = useState(exam.durationMinutes ?? 30);
  const [available, setAvailable] = useState<number | null>(null);
  const [state, formAction] = useActionState<SubjectTestFormState, FormData>(startSubjectTestAction, {});

  const currentSubject = useMemo(() => subjects.find((s) => s.id === subjectId), [subjects, subjectId]);
  const currentTopic = useMemo(() => currentSubject?.topics.find((t) => t.id === topicId), [currentSubject, topicId]);
  const currentSubTopic = useMemo(
    () => currentTopic?.subTopics.find((st) => st.id === subTopicId),
    [currentTopic, subTopicId]
  );

  const yearNumber = year ? Number(year) : undefined;

  // Live availability count for the current selection — mirrors exactly what
  // startSubjectTestAction will enforce server-side. `available` only reflects
  // the current selection when subjectId is set; read `effectiveAvailable`.
  useEffect(() => {
    if (!subjectId) return;
    let cancelled = false;
    countAvailableQuestionsAction({
      examId: exam.id,
      subjectId,
      year: yearNumber,
      topicId: topicId || undefined,
      subTopicId: subTopicId || undefined,
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
  }, [exam.id, subjectId, yearNumber, topicId, subTopicId]);

  const effectiveAvailable = subjectId ? available : null;
  const countExceeds = effectiveAvailable !== null && count > effectiveAvailable;

  if (subjects.length === 0) {
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
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="examId" value={exam.id} />

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subjectId">Subject *</Label>
            <SelectNative
              id="subjectId"
              name="subjectId"
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTopicId("");
                setSubTopicId("");
              }}
              required
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="year">Year (optional)</Label>
            <SelectNative id="year" name="year" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">All Years</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="topicId">Topic (optional)</Label>
            <SelectNative
              id="topicId"
              name="topicId"
              value={topicId}
              onChange={(e) => {
                setTopicId(e.target.value);
                setSubTopicId("");
              }}
              disabled={!currentSubject || currentSubject.topics.length === 0}
            >
              <option value="">All Topics</option>
              {(currentSubject?.topics ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subTopicId">Sub-topic (optional)</Label>
            <SelectNative
              id="subTopicId"
              name="subTopicId"
              value={subTopicId}
              onChange={(e) => setSubTopicId(e.target.value)}
              disabled={!currentTopic || currentTopic.subTopics.length === 0}
            >
              <option value="">All Sub-topics</option>
              {(currentTopic?.subTopics ?? []).map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </SelectNative>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="count">Question Count *</Label>
            <Input
              id="count"
              name="count"
              type="number"
              min={1}
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
              required
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {effectiveAvailable === null
                ? "Checking how many questions are available…"
                : effectiveAvailable === 0
                  ? "No published questions match this selection."
                  : countExceeds
                    ? <span className="text-[var(--color-error)]">Only {effectiveAvailable} questions are available — lower the count.</span>
                    : `Up to ${effectiveAvailable} questions are available for this selection.`}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="durationMinutes">Duration (minutes) *</Label>
            <Input
              id="durationMinutes"
              name="durationMinutes"
              type="number"
              min={1}
              max={300}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Math.max(1, Number(e.target.value)))}
              required
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              The timer is enforced server-side and ends automatically.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[var(--color-primary)]/40">
        <CardContent className="flex flex-col gap-3 pt-5">
          {currentSubject && !currentSubTopic && effectiveAvailable !== null && effectiveAvailable > 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              You will answer <span className="font-semibold text-[var(--color-foreground)]">{Math.min(count, effectiveAvailable)}</span>{" "}
              {currentSubject.topics.length > 0 ? "random" : ""} question{Math.min(count, effectiveAvailable) === 1 ? "" : "s"} from{" "}
              <span className="font-semibold text-[var(--color-foreground)]">{currentSubject.name}</span>
              {currentTopic ? ` › ${currentTopic.name}` : ""}
              {yearNumber ? ` (${yearNumber})` : ""}.
            </p>
          ) : null}
          {state.error ? (
            <p className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
            </p>
          ) : null}
          <p className="text-xs text-[var(--color-muted-foreground)]">
            No negative marking for subject tests. If you already have a subject test in progress for this subject, opening
            it again resumes that attempt with your exact previous set of questions.
          </p>
          <SubmitButton />
        </CardContent>
      </Card>

      {exam.instructions ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm font-medium text-[var(--color-foreground)]">Instructions</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-muted-foreground)]">{exam.instructions}</p>
          </CardContent>
        </Card>
      ) : null}
    </form>
  );
}