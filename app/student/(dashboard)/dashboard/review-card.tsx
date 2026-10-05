"use client";

import { useState, useTransition, type FormEvent } from "react";
import { MessageSquareQuote, Star } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectNative } from "@/components/ui/select-native";
import { REVIEW_LIMITS } from "@/lib/reviews-shared";
import type { StudentReviewState } from "@/lib/student-review";
import { submitStudentReviewAction } from "./review-actions";

const STATUS_TEXT = {
  PENDING: { label: "Pending approval", variant: "warning" },
  APPROVED: { label: "Approved", variant: "success" },
  REJECTED: { label: "Not published", variant: "neutral" },
} as const;

/**
 * Student Dashboard block "share-review": a compact, collapsed-by-default
 * prompt. Shown only after the student has completed a test (or already has
 * a review) — the server action re-checks everything.
 */
export function StudentReviewCard({ state }: { state: StudentReviewState }) {
  const [review, setReview] = useState(state.review);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(state.review?.rating ?? 0);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const editable = !review || review.status === "PENDING";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMessage(null);
    if (rating < 1) {
      setMessage({ tone: "error", text: "Choose a rating from 1 to 5 stars." });
      return;
    }
    formData.set("rating", String(rating));
    startTransition(async () => {
      try {
        const result = await submitStudentReviewAction(formData);
        if (result.ok) {
          const comment = String(formData.get("comment") ?? "");
          const examName = state.exams.find((e) => e.id === formData.get("examId"))?.name ?? null;
          setReview({ status: "PENDING", isPublished: false, rating, comment, examName });
          setOpen(false);
        }
        setMessage(result.ok ? { tone: "ok", text: result.message } : { tone: "error", text: result.error });
      } catch {
        setMessage({ tone: "error", text: "Something went wrong. Please try again." });
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareQuote className="h-4 w-4 text-[var(--color-primary)]" aria-hidden />
          {review ? "Your review" : "Share your experience"}
        </CardTitle>
        <CardDescription>
          {review
            ? "Thanks for your feedback. Approved reviews may appear on our homepage."
            : `Tell other aspirants how Mock Test Series is helping you. Shown publicly as “${state.publicName}” after our team approves it.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {review && !open ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StarRow value={review.rating} />
              <Badge variant={STATUS_TEXT[review.status].variant}>{review.status === "APPROVED" && review.isPublished ? "Published" : STATUS_TEXT[review.status].label}</Badge>
            </div>
            <p className="line-clamp-3 whitespace-pre-line text-[var(--color-muted-foreground)]">{review.comment}</p>
            {editable ? (
              <div>
                <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
                  Edit review
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {!review && !open ? (
          <div>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Write a review
            </Button>
          </div>
        ) : null}

        {open && editable ? (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-medium text-[var(--color-foreground)]">Your rating</legend>
              <div className="flex gap-1" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={rating === n}
                    aria-label={`${n} star${n === 1 ? "" : "s"}`}
                    onClick={() => setRating(n)}
                    className="rounded p-0.5 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
                  >
                    <Star className={n <= rating ? "h-6 w-6 fill-[var(--color-warning)] text-[var(--color-warning)]" : "h-6 w-6 text-[var(--color-muted-foreground)]"} aria-hidden />
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="student-review-comment">Your review</Label>
              <Textarea
                id="student-review-comment"
                name="comment"
                rows={4}
                required
                minLength={REVIEW_LIMITS.commentMin}
                maxLength={REVIEW_LIMITS.commentMax}
                defaultValue={review?.comment ?? ""}
                placeholder="What helped you most — mock tests, PYQs, explanations?"
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {REVIEW_LIMITS.commentMin}–{REVIEW_LIMITS.commentMax} characters. Please don&apos;t include links or contact details.
              </p>
            </div>
            {state.exams.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="student-review-exam">Exam (optional)</Label>
                <SelectNative
                  id="student-review-exam"
                  name="examId"
                  defaultValue={state.exams.find((e) => e.name === review?.examName)?.id ?? (state.exams.length === 1 ? state.exams[0].id : "")}
                >
                  <option value="">Don&apos;t show an exam</option>
                  {state.exams.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Submitting…" : review ? "Update review" : "Submit review"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {message ? (
          <p role="status" className={`text-sm ${message.tone === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
            {message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StarRow({ value }: { value: number }) {
  return (
    <span className="flex gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={n <= value ? "h-4 w-4 fill-[var(--color-warning)] text-[var(--color-warning)]" : "h-4 w-4 text-[var(--color-border)]"} aria-hidden />
      ))}
    </span>
  );
}
