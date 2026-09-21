"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { editExamAction, type EditExamFormState } from "./actions";
import { pairListToText } from "@/lib/homepage-field-codec";

export interface EditableExam {
  id: string;
  name: string;
  code: string;
  year: number | null;
  examDate: Date | string | null;
  isUpcoming: boolean;
  upcomingDate: Date | string | null;
  isActive: boolean;
  order: number;
  negativeMarking: number | null;
  durationMinutes: number | null;
  instructions: string | null;
  description: string | null;
  publicPageEnabled: boolean;
  publicSlug: string | null;
  shortDescription: string | null;
  overview: string | null;
  conductingAuthority: string | null;
  eligibility: string | null;
  examPatternInfo: string | null;
  totalQuestions: number | null;
  totalMarks: number | null;
  examMode: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  importantDates: unknown;
  faqItems: unknown;
}

function toDateInputValue(value: Date | string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save Changes"}
    </Button>
  );
}

export function EditExamDialog({ exam }: { exam: EditableExam }) {
  const [state, formAction] = useActionState<EditExamFormState, FormData>(editExamAction, {});
  const [open, setOpen] = useState(false);
  const [isUpcoming, setIsUpcoming] = useState(exam.isUpcoming);
  const [isActive, setIsActive] = useState(exam.isActive);
  const [publicPageEnabled, setPublicPageEnabled] = useState(exam.publicPageEnabled);

  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state.success]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="compact" variant="outline" aria-label={`Edit ${exam.name}`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Exam</DialogTitle>
          <DialogDescription>
            Renaming preserves the Exam&apos;s id and every Subject/Topic/Question/Previous Year Paper/Test/Enrollment relationship.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <input type="hidden" name="id" value={exam.id} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`name-${exam.id}`}>Exam Name</Label>
            <Input id={`name-${exam.id}`} name="name" defaultValue={exam.name} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`code-${exam.id}`}>Exam Code</Label>
            <Input id={`code-${exam.id}`} name="code" defaultValue={exam.code} required className="uppercase" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`year-${exam.id}`}>Exam Year</Label>
            <Input id={`year-${exam.id}`} name="year" type="number" defaultValue={exam.year ?? ""} placeholder="2026" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`examDate-${exam.id}`}>Exam Date</Label>
            <Input id={`examDate-${exam.id}`} name="examDate" type="date" defaultValue={toDateInputValue(exam.examDate)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`order-${exam.id}`}>Display Order</Label>
            <Input id={`order-${exam.id}`} name="order" type="number" min={0} defaultValue={exam.order} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`durationMinutes-${exam.id}`}>Duration (minutes)</Label>
            <Input id={`durationMinutes-${exam.id}`} name="durationMinutes" type="number" min={1} defaultValue={exam.durationMinutes ?? ""} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`negativeMarking-${exam.id}`}>Negative Marking</Label>
            <Input
              id={`negativeMarking-${exam.id}`}
              name="negativeMarking"
              type="number"
              step="0.01"
              min={0}
              max={1}
              defaultValue={exam.negativeMarking ?? ""}
              placeholder="0.25"
            />
          </div>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
              <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} />
              Active
            </label>
            <input type="hidden" name="isActive" value={isActive ? "true" : "false"} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
              <Checkbox checked={isUpcoming} onCheckedChange={(v) => setIsUpcoming(v === true)} />
              Upcoming Exam
            </label>
            <input type="hidden" name="isUpcoming" value={isUpcoming ? "true" : "false"} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`upcomingDate-${exam.id}`}>Upcoming Date (countdown)</Label>
            <Input
              id={`upcomingDate-${exam.id}`}
              name="upcomingDate"
              type="date"
              defaultValue={toDateInputValue(exam.upcomingDate)}
              disabled={!isUpcoming}
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`description-${exam.id}`}>Description</Label>
            <Input id={`description-${exam.id}`} name="description" defaultValue={exam.description ?? ""} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`instructions-${exam.id}`}>Instructions</Label>
            <Textarea id={`instructions-${exam.id}`} name="instructions" defaultValue={exam.instructions ?? ""} rows={3} />
          </div>

          <div className="mt-2 flex flex-col gap-1 sm:col-span-2">
            <p className="text-sm font-semibold text-[var(--color-foreground)]">Public Page &amp; SEO</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Controls the public marketing page at /exams/&lt;slug&gt;. Leave the public page off until real, verified content is
              entered — never publish invented facts.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
              <Checkbox checked={publicPageEnabled} onCheckedChange={(v) => setPublicPageEnabled(v === true)} />
              Public page enabled
            </label>
            <input type="hidden" name="publicPageEnabled" value={publicPageEnabled ? "true" : "false"} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`publicSlug-${exam.id}`}>Public URL slug</Label>
            <Input
              id={`publicSlug-${exam.id}`}
              name="publicSlug"
              defaultValue={exam.publicSlug ?? ""}
              placeholder="rajasthan-medical-officer"
              disabled={!publicPageEnabled}
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`shortDescription-${exam.id}`}>Short description (hero subheading)</Label>
            <Input id={`shortDescription-${exam.id}`} name="shortDescription" defaultValue={exam.shortDescription ?? ""} maxLength={300} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`overview-${exam.id}`}>Overview (About This Exam section)</Label>
            <Textarea id={`overview-${exam.id}`} name="overview" defaultValue={exam.overview ?? ""} rows={4} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`conductingAuthority-${exam.id}`}>Conducting authority</Label>
            <Input id={`conductingAuthority-${exam.id}`} name="conductingAuthority" defaultValue={exam.conductingAuthority ?? ""} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`examMode-${exam.id}`}>Exam mode (only if officially confirmed)</Label>
            <Input id={`examMode-${exam.id}`} name="examMode" defaultValue={exam.examMode ?? ""} placeholder="e.g. Offline (OMR)" />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`eligibility-${exam.id}`}>Eligibility (only verified facts)</Label>
            <Textarea id={`eligibility-${exam.id}`} name="eligibility" defaultValue={exam.eligibility ?? ""} rows={3} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`totalQuestions-${exam.id}`}>Total questions (only if officially confirmed)</Label>
            <Input id={`totalQuestions-${exam.id}`} name="totalQuestions" type="number" min={0} defaultValue={exam.totalQuestions ?? ""} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`totalMarks-${exam.id}`}>Total marks (only if officially confirmed)</Label>
            <Input id={`totalMarks-${exam.id}`} name="totalMarks" type="number" min={0} defaultValue={exam.totalMarks ?? ""} />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`examPatternInfo-${exam.id}`}>
              Exam pattern notes — for historical/unconfirmed pattern details, label them as such in the text itself
            </Label>
            <Textarea id={`examPatternInfo-${exam.id}`} name="examPatternInfo" defaultValue={exam.examPatternInfo ?? ""} rows={4} />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`importantDatesText-${exam.id}`}>Important dates — only verified/official dates (one per line: Label | Date)</Label>
            <Textarea
              id={`importantDatesText-${exam.id}`}
              name="importantDatesText"
              defaultValue={pairListToText(exam.importantDates)}
              rows={3}
              placeholder="Notification Released | 13 August 2026"
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`faqItemsText-${exam.id}`}>FAQ (one per line: Question | Answer)</Label>
            <Textarea
              id={`faqItemsText-${exam.id}`}
              name="faqItemsText"
              defaultValue={pairListToText(exam.faqItems)}
              rows={5}
              placeholder="Who conducts this exam? | ..."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`seoTitle-${exam.id}`}>SEO title (blank = default template)</Label>
            <Input id={`seoTitle-${exam.id}`} name="seoTitle" defaultValue={exam.seoTitle ?? ""} maxLength={200} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`seoDescription-${exam.id}`}>SEO meta description (blank = site default)</Label>
            <Input id={`seoDescription-${exam.id}`} name="seoDescription" defaultValue={exam.seoDescription ?? ""} maxLength={300} />
          </div>

          {state.error ? <p className="text-sm text-[var(--color-error)] sm:col-span-2">{state.error}</p> : null}

          <DialogFooter className="sm:col-span-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
