"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createTopicAction, type TopicFormState } from "./actions";

interface ExamWithSubjects {
  id: string;
  name: string;
  subjects: { id: string; name: string }[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Adding…" : "Add Topic"}
    </Button>
  );
}

export function TopicForm({ exams, defaultSubjectId }: { exams: ExamWithSubjects[]; defaultSubjectId?: string }) {
  const [state, formAction] = useActionState<TopicFormState, FormData>(createTopicAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  const defaultExam = exams.find((e) => e.subjects.some((s) => s.id === defaultSubjectId));
  const [examId, setExamId] = useState(defaultExam?.id ?? exams[0]?.id ?? "");
  const exam = useMemo(() => exams.find((e) => e.id === examId), [exams, examId]);
  const subjects = exam?.subjects ?? [];

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  const examsWithSubjects = exams.filter((e) => e.subjects.length > 0);
  if (examsWithSubjects.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Create a subject first under Subjects.</p>;
  }

  return (
    <form ref={formRef} action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="topicExamId">Exam</Label>
        <SelectNative id="topicExamId" value={examId} onChange={(e) => setExamId(e.target.value)}>
          {examsWithSubjects.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="subjectId">Subject</Label>
        <SelectNative id="subjectId" name="subjectId" defaultValue={defaultSubjectId} required>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Topic Name</Label>
        <Input id="name" name="name" required placeholder="Cardiovascular System" />
      </div>
      <div className="flex items-end">
        <SubmitButton />
      </div>
      {state.error ? <p className="text-sm text-[var(--color-error)] sm:col-span-4">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-[var(--color-success)] sm:col-span-4">Topic added.</p> : null}
    </form>
  );
}
