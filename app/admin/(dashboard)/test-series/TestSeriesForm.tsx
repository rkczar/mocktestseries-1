"use client";

import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { FormTextarea } from "@/components/admin/FormTextarea";
import { SubmitButton } from "@/components/auth/SubmitButton";

import type { FormState } from "./actions";

type TestSeries = {
  id: string;
  examId: string;
  slug: string;
  kind: "FULL_MOCK" | "PREVIOUS_YEAR" | "SUBJECT_WISE";
  title: string;
  description: string;
  metaLabel: string | null;
  isPopular: boolean;
  isFree: boolean;
  order: number;
};

const KIND_OPTIONS = [
  { value: "FULL_MOCK", label: "Full mock test" },
  { value: "PREVIOUS_YEAR", label: "Previous year papers" },
  { value: "SUBJECT_WISE", label: "Subject-wise practice" },
];

export function TestSeriesForm({
  series,
  exams,
  defaultExamId,
  action,
  submitLabel,
}: {
  series?: TestSeries;
  exams: { id: string; title: string }[];
  defaultExamId?: string;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4">
      {series ? <input type="hidden" name="id" value={series.id} /> : null}
      <FormSelect
        label="Exam"
        name="examId"
        defaultValue={series?.examId ?? defaultExamId ?? exams[0]?.id}
        options={exams.map((e) => ({ value: e.id, label: e.title }))}
      />
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Title" name="title" defaultValue={series?.title ?? ""} required />
        <FormField label="Slug" name="slug" defaultValue={series?.slug ?? ""} required />
      </div>
      <FormSelect label="Kind" name="kind" defaultValue={series?.kind ?? "FULL_MOCK"} options={KIND_OPTIONS} />
      <FormTextarea label="Description" name="description" defaultValue={series?.description ?? ""} required />
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Meta label (optional)" name="metaLabel" defaultValue={series?.metaLabel ?? ""} />
        <FormField label="Order" name="order" type="number" defaultValue={series?.order ?? 0} />
      </div>
      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
          <input type="checkbox" name="isPopular" defaultChecked={series?.isPopular ?? false} className="size-4 accent-primary" />
          Popular
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
          <input type="checkbox" name="isFree" defaultChecked={series?.isFree ?? false} className="size-4 accent-primary" />
          Free
        </label>
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
