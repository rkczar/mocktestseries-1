"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createAnnouncementAction, updateAnnouncementAction, type AnnouncementFormState } from "./actions";

const TYPES = ["GENERAL", "IMPORTANT", "EXAM_UPDATE", "NEW_TEST", "LIVE_TEST", "RESULT", "MAINTENANCE"] as const;
const PRIORITIES = ["NORMAL", "IMPORTANT"] as const;
const AUDIENCES = ["ALL_STUDENTS", "EXAM_STUDENTS", "ACTIVE_STUDENTS", "SELECTED_STUDENTS"] as const;

const AUDIENCE_LABEL: Record<(typeof AUDIENCES)[number], string> = {
  ALL_STUDENTS: "All Students",
  EXAM_STUDENTS: "Students Enrolled in an Exam",
  ACTIVE_STUDENTS: "Active Students Only",
  SELECTED_STUDENTS: "Selected Students",
};

export interface AnnouncementExam {
  id: string;
  name: string;
}

export interface AnnouncementInitial {
  title: string;
  message: string;
  content?: string | null;
  type: (typeof TYPES)[number];
  priority: (typeof PRIORITIES)[number];
  audience: (typeof AUDIENCES)[number];
  examId?: string | null;
  ctaLabel?: string | null;
  ctaRoute?: string | null;
  showOnDashboard: boolean;
  publishAt?: string | null; // datetime-local value
  expiresAt?: string | null;
  selectedStudentIds?: string; // newline/comma-separated codes, pre-filled on edit
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function AnnouncementForm({
  exams,
  announcementId,
  initial,
}: {
  exams: AnnouncementExam[];
  announcementId?: string;
  initial?: AnnouncementInitial;
}) {
  const isEdit = Boolean(announcementId);
  const action = isEdit ? updateAnnouncementAction.bind(null, announcementId!) : createAnnouncementAction;
  const [state, formAction] = useActionState<AnnouncementFormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);

  const [audience, setAudience] = useState<(typeof AUDIENCES)[number]>(initial?.audience ?? "ALL_STUDENTS");

  useEffect(() => {
    if (state.success && !isEdit) formRef.current?.reset();
  }, [state.success, isEdit]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" required defaultValue={initial?.title} placeholder="New Grand Test Available" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="type">Type</Label>
          <SelectNative id="type" name="type" defaultValue={initial?.type ?? "GENERAL"}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </SelectNative>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="message">Message (shown in the notification list)</Label>
        <textarea
          id="message"
          name="message"
          rows={2}
          required
          defaultValue={initial?.message}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="content">Full Content (optional, shown on click-through)</Label>
        <textarea
          id="content"
          name="content"
          rows={3}
          defaultValue={initial?.content ?? undefined}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="priority">Priority</Label>
          <SelectNative id="priority" name="priority" defaultValue={initial?.priority ?? "NORMAL"}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audience">Audience</Label>
          <SelectNative
            id="audience"
            name="audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value as (typeof AUDIENCES)[number])}
          >
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABEL[a]}
              </option>
            ))}
          </SelectNative>
        </div>
        {audience === "EXAM_STUDENTS" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="examId">Exam</Label>
            <SelectNative id="examId" name="examId" defaultValue={initial?.examId ?? ""} required>
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
        ) : null}
      </div>

      {audience === "SELECTED_STUDENTS" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="selectedStudentIds">Student IDs (comma or newline separated, e.g. MTS-000123)</Label>
          <textarea
            id="selectedStudentIds"
            name="selectedStudentIds"
            rows={3}
            defaultValue={initial?.selectedStudentIds ?? ""}
            placeholder="MTS-000123, MTS-000456"
            className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ctaLabel">CTA Label (optional)</Label>
          <Input id="ctaLabel" name="ctaLabel" defaultValue={initial?.ctaLabel ?? undefined} placeholder="View Test" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ctaRoute">CTA Route (optional, internal path)</Label>
          <Input id="ctaRoute" name="ctaRoute" defaultValue={initial?.ctaRoute ?? undefined} placeholder="/student/live-tests" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="publishAt">Publish At (optional — blank = manual publish)</Label>
          <Input id="publishAt" name="publishAt" type="datetime-local" defaultValue={initial?.publishAt ?? undefined} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expiresAt">Expires At (optional)</Label>
          <Input id="expiresAt" name="expiresAt" type="datetime-local" defaultValue={initial?.expiresAt ?? undefined} />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
        <input type="checkbox" name="showOnDashboard" defaultChecked={initial?.showOnDashboard ?? false} />
        Show as a card on the student dashboard (in addition to the notification bell)
      </label>

      <div className="flex items-center gap-3">
        <SubmitButton label={isEdit ? "Save Changes" : "Create Announcement"} pendingLabel={isEdit ? "Saving…" : "Creating…"} />
        {state.error ? (
          <p className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
          </p>
        ) : null}
        {state.success && !isEdit ? <p className="text-sm text-[var(--color-success)]">Announcement created as Draft.</p> : null}
        {state.success && isEdit ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      </div>
    </form>
  );
}
