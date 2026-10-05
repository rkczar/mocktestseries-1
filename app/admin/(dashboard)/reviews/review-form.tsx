"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectNative } from "@/components/ui/select-native";
import { Switch } from "@/components/ui/switch";
import { REVIEW_LIMITS } from "@/lib/reviews-shared";
import { createReviewAction, updateReviewAction, type ReviewActionResult } from "./actions";

export interface ReviewFormValues {
  id: string;
  displayName: string;
  rating: number;
  comment: string;
  examName: string | null;
  isFeatured: boolean;
  isPublished: boolean;
  displayOrder: number;
  approved: boolean;
}

/** Add Testimonial (create) and the Edit dialog (edit). The server action re-validates and re-sanitizes everything. */
export function ReviewForm({ mode, initial, onDone }: { mode: "create" | "edit"; initial?: ReviewFormValues; onDone?: () => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const prefix = mode === "create" ? "new-review" : `edit-review-${initial?.id}`;
  const canPublish = mode === "create" || Boolean(initial?.approved);

  // onSubmit (not <form action>): the message clears immediately and the
  // form only resets after a successful create, never while a save is pending.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMessage(null);
    startTransition(async () => {
      let result: ReviewActionResult;
      try {
        result = mode === "create" ? await createReviewAction(formData) : await updateReviewAction(initial!.id, formData);
      } catch {
        result = { ok: false, error: "Something went wrong. Please try again." };
      }
      if (result.ok) {
        setMessage({ tone: "ok", text: result.message ?? "Saved." });
        if (mode === "create") formRef.current?.reset();
        onDone?.();
      } else {
        setMessage({ tone: "error", text: result.error });
      }
    });
  };

  return (
    <form ref={formRef} onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${prefix}-name`}>Display Name</Label>
          <Input id={`${prefix}-name`} name="displayName" required minLength={2} maxLength={REVIEW_LIMITS.nameMax} defaultValue={initial?.displayName ?? ""} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${prefix}-exam`}>Exam (optional)</Label>
          <Input id={`${prefix}-exam`} name="examName" maxLength={REVIEW_LIMITS.examMax} defaultValue={initial?.examName ?? ""} placeholder="e.g. RUHS Medical Officer" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${prefix}-rating`}>Rating</Label>
          <SelectNative id={`${prefix}-rating`} name="rating" defaultValue={String(initial?.rating ?? 5)}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {"★".repeat(n)} ({n})
              </option>
            ))}
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${prefix}-order`}>Display Order</Label>
          <Input id={`${prefix}-order`} name="displayOrder" type="number" min={-9999} max={9999} step={1} defaultValue={initial?.displayOrder ?? 0} />
          <p className="text-xs text-[var(--color-muted-foreground)]">Lower numbers show first.</p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${prefix}-comment`}>Comment</Label>
        <Textarea
          id={`${prefix}-comment`}
          name="comment"
          rows={4}
          required
          minLength={10}
          maxLength={REVIEW_LIMITS.commentMax}
          defaultValue={initial?.comment ?? ""}
        />
        <p className="text-xs text-[var(--color-muted-foreground)]">Plain text only, up to {REVIEW_LIMITS.commentMax} characters.</p>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
          <Switch name="isFeatured" defaultChecked={initial?.isFeatured ?? false} aria-label="Featured" />
          Featured
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
          <Switch name="isPublished" defaultChecked={initial?.isPublished ?? true} disabled={!canPublish} aria-label="Published" />
          Published{canPublish ? "" : " (approve first)"}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Add Testimonial" : "Save Changes"}
        </Button>
        {message ? (
          <p role="status" className={`text-sm ${message.tone === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
