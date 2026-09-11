"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { FormTextarea } from "@/components/admin/FormTextarea";
import { SubmitButton } from "@/components/auth/SubmitButton";

import type { FormState } from "./actions";

type Question = {
  id: string;
  examId: string;
  code: string;
  paperYear: number;
  questionNumber: number | null;
  subject: { name: string } | null;
  topic: string | null;
  subTopic: string | null;
  stem: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: string;
  explanation: string | null;
  source: string | null;
  difficulty: string | null;
  status: "DRAFT" | "PUBLISHED";
};

const ANSWER_OPTIONS = ["A", "B", "C", "D"].map((v) => ({ value: v, label: v }));
const STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft" },
  { value: "PUBLISHED", label: "Published" },
];

export function QuestionForm({
  question,
  exams,
  action,
  submitLabel,
}: {
  question?: Question;
  exams: { id: string; title: string }[];
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4">
      {question ? <input type="hidden" name="id" value={question.id} /> : null}
      <div className="grid grid-cols-3 gap-4">
        <FormSelect
          label="Exam"
          name="examId"
          defaultValue={question?.examId ?? exams[0]?.id}
          options={exams.map((e) => ({ value: e.id, label: e.title }))}
        />
        <FormField label="Question code" name="code" defaultValue={question?.code ?? ""} required />
        <FormField label="Exam year" name="paperYear" type="number" defaultValue={question?.paperYear ?? new Date().getFullYear()} required />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <FormField label="Subject" name="subject" defaultValue={question?.subject?.name ?? ""} required />
        <FormField label="Topic" name="topic" defaultValue={question?.topic ?? ""} required />
        <FormField label="Sub-topic (optional)" name="subTopic" defaultValue={question?.subTopic ?? ""} />
      </div>
      <FormTextarea label="Question" name="stem" defaultValue={question?.stem ?? ""} required />
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Option A" name="optionA" defaultValue={question?.optionA ?? ""} required />
        <FormField label="Option B" name="optionB" defaultValue={question?.optionB ?? ""} required />
        <FormField label="Option C" name="optionC" defaultValue={question?.optionC ?? ""} required />
        <FormField label="Option D" name="optionD" defaultValue={question?.optionD ?? ""} required />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <FormSelect label="Correct answer" name="correctAnswer" defaultValue={question?.correctAnswer ?? "A"} options={ANSWER_OPTIONS} />
        <FormField label="Question number (optional)" name="questionNumber" type="number" defaultValue={question?.questionNumber ?? ""} />
        <FormSelect label="Status" name="status" defaultValue={question?.status ?? "DRAFT"} options={STATUS_OPTIONS} />
      </div>
      <FormTextarea label="Explanation (optional)" name="explanation" defaultValue={question?.explanation ?? ""} />
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Source (optional)" name="source" defaultValue={question?.source ?? ""} />
        <FormField label="Difficulty (optional)" name="difficulty" defaultValue={question?.difficulty ?? ""} />
      </div>
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">{submitLabel}</SubmitButton>
    </form>
  );
}
