"use client";

import Image from "next/image";
import { useActionState } from "react";

import { FormField } from "@/components/admin/FormField";
import { FormSelect } from "@/components/admin/FormSelect";
import { FormTextarea } from "@/components/admin/FormTextarea";
import { SubmitButton } from "@/components/auth/SubmitButton";

import type { FormState } from "./actions";

type Exam = {
  id: string;
  slug: string;
  title: string;
  shortTitle: string | null;
  description: string;
  status: "ACTIVE" | "COMING_SOON" | "ARCHIVED";
  isFeatured: boolean;
  order: number;
  region: string | null;
  metaChips: string[];
  seoTitle: string | null;
  seoDesc: string | null;
  iconUrl: string | null;
  imageUrl: string | null;
};

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "COMING_SOON", label: "Coming soon" },
  { value: "ARCHIVED", label: "Archived" },
];

export function ExamForm({
  exam,
  action,
  submitLabel,
}: {
  exam?: Exam;
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);

  return (
    <form action={formAction} encType="multipart/form-data" className="flex max-w-2xl flex-col gap-4">
      {exam ? <input type="hidden" name="id" value={exam.id} /> : null}
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Title" name="title" defaultValue={exam?.title ?? ""} required />
        <FormField
          label="Slug (used in /exams/[slug])"
          name="slug"
          defaultValue={exam?.slug ?? ""}
          required
        />
      </div>
      <FormField label="Short title (optional)" name="shortTitle" defaultValue={exam?.shortTitle ?? ""} />
      <FormTextarea
        label="Description"
        name="description"
        defaultValue={exam?.description ?? ""}
        required
      />
      <div className="grid grid-cols-3 gap-4">
        <FormSelect label="Status" name="status" defaultValue={exam?.status ?? "COMING_SOON"} options={STATUS_OPTIONS} />
        <FormField label="Order" name="order" type="number" defaultValue={exam?.order ?? 0} />
        <FormField label="Region (optional)" name="region" defaultValue={exam?.region ?? ""} />
      </div>
      <FormField
        label="Meta chips (comma-separated, e.g. 100 Q · 90 min, 12 mock tests)"
        name="metaChips"
        defaultValue={exam?.metaChips.join(", ") ?? ""}
      />
      <label className="flex items-center gap-2 text-sm font-semibold text-text-muted">
        <input
          type="checkbox"
          name="isFeatured"
          defaultChecked={exam?.isFeatured ?? false}
          className="size-4 accent-primary"
        />
        Featured on homepage
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="mb-1.5 block text-[13px] font-bold text-text-muted">Icon (PNG/JPG/WebP, ≤5MB)</span>
          {exam?.iconUrl ? (
            <Image src={exam.iconUrl} alt="" width={40} height={40} className="mb-2 rounded-lg border border-border" />
          ) : null}
          <input type="file" name="icon" accept="image/png,image/jpeg,image/webp" className="text-sm" />
        </div>
        <div>
          <span className="mb-1.5 block text-[13px] font-bold text-text-muted">Image (PNG/JPG/WebP, ≤5MB)</span>
          {exam?.imageUrl ? (
            <Image src={exam.imageUrl} alt="" width={80} height={40} className="mb-2 rounded-lg border border-border object-cover" />
          ) : null}
          <input type="file" name="image" accept="image/png,image/jpeg,image/webp" className="text-sm" />
        </div>
      </div>

      <FormField label="SEO title (optional)" name="seoTitle" defaultValue={exam?.seoTitle ?? ""} />
      <FormField label="SEO description (optional)" name="seoDesc" defaultValue={exam?.seoDesc ?? ""} />

      {state?.error ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">{submitLabel}</SubmitButton>
    </form>
  );
}
