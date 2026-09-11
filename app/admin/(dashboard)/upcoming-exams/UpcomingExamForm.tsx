"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { SubmitButton } from "@/components/auth/SubmitButton";

import type { FormState } from "./actions";

type UpcomingExam = {
  id: string;
  title: string;
  subtitle: string | null;
  examDate: Date | null;
  dateLabel: string | null;
  region: string | null;
  status: string;
  statusTone: string;
  actionLabel: string | null;
  actionHref: string | null;
  examId: string | null;
  order: number;
  isVisible: boolean;
};

const TONE_OPTIONS = [
  { value: "neutral", label: "Neutral" },
  { value: "success", label: "Success (green)" },
  { value: "accent", label: "Accent (orange)" },
];

export function UpcomingExamForm({
  exam,
  linkedExams,
  action,
  submitLabel,
}: {
  exam?: UpcomingExam;
  linkedExams: { id: string; title: string }[];
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4">
      {exam ? <input type="hidden" name="id" value={exam.id} /> : null}
      <FormField label="Title" name="title" defaultValue={exam?.title ?? ""} required />
      <FormField label="Subtitle (optional)" name="subtitle" defaultValue={exam?.subtitle ?? ""} />
      <div className="grid grid-cols-2 gap-4">
        <FormField
          label="Exam date (optional)"
          name="examDate"
          type="date"
          defaultValue={exam?.examDate ? exam.examDate.toISOString().slice(0, 10) : ""}
        />
        <FormField label="Date label (used if no exact date)" name="dateLabel" defaultValue={exam?.dateLabel ?? ""} />
      </div>
      <FormField label="Region (optional)" name="region" defaultValue={exam?.region ?? ""} />
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Status text" name="status" defaultValue={exam?.status ?? "Expected"} required />
        <FormSelect label="Status tone" name="statusTone" defaultValue={exam?.statusTone ?? "neutral"} options={TONE_OPTIONS} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Action label (optional)" name="actionLabel" defaultValue={exam?.actionLabel ?? "Get notified"} />
        <FormField label="Action href (optional)" name="actionHref" defaultValue={exam?.actionHref ?? "/upcoming-exams"} />
      </div>
      <FormSelect
        label="Linked exam (optional)"
        name="examId"
        defaultValue={exam?.examId ?? ""}
        options={[{ value: "", label: "None" }, ...linkedExams.map((e) => ({ value: e.id, label: e.title }))]}
      />
      <FormField label="Order" name="order" type="number" defaultValue={exam?.order ?? 0} />
      <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
        <input type="checkbox" name="isVisible" defaultChecked={exam?.isVisible ?? true} className="size-4 accent-primary" />
        Visible
      </label>
      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">{submitLabel}</SubmitButton>
    </form>
  );
}
