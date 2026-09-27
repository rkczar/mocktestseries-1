"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createSubjectAction, linkTaxonomyAction, type SubjectFormState } from "./actions";

function SubmitButton({ compact }: { compact?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size={compact ? "sm" : "default"} disabled={pending}>
      {pending ? "Adding…" : "Create New Subject"}
    </Button>
  );
}

/**
 * Create New Subject. The server refuses a normalized duplicate and returns
 * the existing canonical record, shown here with a "Use Existing" button
 * that links it to the exam instead of creating a copy.
 */
export function SubjectForm({
  exams,
  defaultExamId,
  fixedExamId,
}: {
  exams?: { id: string; name: string }[];
  defaultExamId?: string;
  /** Exam context is fixed (Syllabus page): no exam picker. */
  fixedExamId?: string;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState<SubjectFormState, FormData>(createSubjectAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [examId, setExamId] = useState(fixedExamId ?? defaultExamId ?? exams?.[0]?.id ?? "");
  // Tied to the form state it answers, so a new submit clears it without an effect.
  const [linked, setLinked] = useState<{ for: SubjectFormState; text: string } | null>(null);
  const linkMessage = linked?.for === state ? linked.text : null;
  const [isLinking, startLink] = useTransition();

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  if (!fixedExamId && (!exams || exams.length === 0)) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Create an exam first under Manage Exams.</p>;
  }

  const useExisting = () => {
    if (!state.existing || !examId) return;
    const existing = state.existing;
    startLink(async () => {
      const res = await linkTaxonomyAction({ examId, subjectIds: [existing.id] });
      setLinked({ for: state, text: res.error ?? `Linked existing "${existing.name}" to this exam (no copy created).` });
      formRef.current?.reset();
      router.refresh();
    });
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      className={fixedExamId ? "flex flex-wrap items-end gap-2" : "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"}
    >
      {fixedExamId ? (
        <input type="hidden" name="examId" value={fixedExamId} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="examId">Exam</Label>
          <SelectNative id="examId" name="examId" value={examId} onChange={(e) => setExamId(e.target.value)} required>
            {exams!.map((exam) => (
              <option key={exam.id} value={exam.id}>
                {exam.name}
              </option>
            ))}
          </SelectNative>
        </div>
      )}
      <div className={fixedExamId ? "" : "flex flex-col gap-1.5 sm:col-span-2"}>
        {fixedExamId ? null : <Label htmlFor="name">Subject Name</Label>}
        <Input
          id={fixedExamId ? undefined : "name"}
          name="name"
          required
          placeholder="Anatomy"
          className={fixedExamId ? "max-w-xs" : undefined}
          aria-label="Subject name"
        />
      </div>
      <div className="flex items-end">
        <SubmitButton compact={Boolean(fixedExamId)} />
      </div>
      {state.error ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-error)] sm:col-span-4">
          <span>{state.error}</span>
          {state.existing && examId && !linkMessage ? (
            <Button type="button" size="compact" variant="outline" onClick={useExisting} disabled={isLinking}>
              {isLinking ? "Linking…" : `Use Existing "${state.existing.name}"`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {linkMessage ? <p className="text-sm text-[var(--color-success)] sm:col-span-4">{linkMessage}</p> : null}
      {state.success ? <p className="text-sm text-[var(--color-success)] sm:col-span-4">Subject created and linked.</p> : null}
    </form>
  );
}
