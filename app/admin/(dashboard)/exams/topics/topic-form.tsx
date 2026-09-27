"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createTopicAction, linkTopicAction, type TopicFormState } from "./actions";

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

/**
 * Adds a canonical topic under one of the exam's linked subjects and links
 * it to that exam. A normalized duplicate under the same subject is offered
 * as "Use Existing" (link) instead of being created again.
 */
export function TopicForm({ exams, defaultSubjectId, defaultExamId }: { exams: ExamWithSubjects[]; defaultSubjectId?: string; defaultExamId?: string }) {
  const router = useRouter();
  const [state, formAction] = useActionState<TopicFormState, FormData>(createTopicAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [linked, setLinked] = useState<{ for: TopicFormState; text: string } | null>(null);
  const linkMessage = linked?.for === state ? linked.text : null;
  const [isLinking, startLink] = useTransition();

  const examsWithSubjects = exams.filter((e) => e.subjects.length > 0);
  const defaultExam =
    examsWithSubjects.find((e) => e.id === defaultExamId) ?? examsWithSubjects.find((e) => e.subjects.some((s) => s.id === defaultSubjectId));
  const [examId, setExamId] = useState(defaultExam?.id ?? examsWithSubjects[0]?.id ?? "");
  const exam = useMemo(() => exams.find((e) => e.id === examId), [exams, examId]);
  const subjects = exam?.subjects ?? [];

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  if (examsWithSubjects.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Link or create a subject first under Subjects.</p>;
  }

  const useExisting = () => {
    const existing = state.existing;
    if (!existing || !examId) return;
    startLink(async () => {
      await linkTopicAction(examId, existing.id);
      setLinked({ for: state, text: `Linked existing "${existing.name}" to this exam (no copy created).` });
      formRef.current?.reset();
      router.refresh();
    });
  };

  return (
    <form ref={formRef} action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="examId" value={examId} />
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
        <SelectNative key={examId} id="subjectId" name="subjectId" defaultValue={defaultSubjectId} required>
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
      {state.error ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-error)] sm:col-span-4">
          <span>{state.error}</span>
          {state.existing && !linkMessage ? (
            <Button type="button" size="compact" variant="outline" onClick={useExisting} disabled={isLinking}>
              {isLinking ? "Linking…" : `Use Existing "${state.existing.name}"`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {linkMessage ? <p className="text-sm text-[var(--color-success)] sm:col-span-4">{linkMessage}</p> : null}
      {state.success ? <p className="text-sm text-[var(--color-success)] sm:col-span-4">Topic added.</p> : null}
    </form>
  );
}
