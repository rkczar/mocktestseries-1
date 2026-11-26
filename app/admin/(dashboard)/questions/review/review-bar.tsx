"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { REVIEW_CATEGORIES, reviewCategoryOf, type ReviewCategory } from "@/lib/question-source/review";
import { flagQuestionReviewAction, markQuestionReviewedAction } from "./actions";

/** Review status of a Question Bank question + "Mark reviewed" / "Flag for review" (one place, used by preview + edit). */
export function ReviewBar({ questionId, reviewRequired, reviewReason }: { questionId: string; reviewRequired: boolean; reviewReason: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [cat, setCat] = useState<ReviewCategory>("REVIEW_REQUIRED");
  const run = (p: Promise<{ ok: boolean; error?: string }>, done: string) => start(async () => { const r = await p; setMsg(r.ok ? done : (r as { error: string }).error); router.refresh(); });
  const category = reviewCategoryOf(reviewReason);
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-xs" data-testid="review-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Review</span>
        {reviewRequired ? <Badge variant="warning" data-testid="review-status">{category ?? "REVIEW_REQUIRED"}</Badge> : <Badge variant="success" data-testid="review-status">{reviewReason?.startsWith("REVIEWED") ? "Reviewed" : "No review flag"}</Badge>}
      </div>
      {reviewReason ? <p className="break-words text-[var(--color-muted-foreground)]">{reviewReason.slice(0, 600)}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {reviewRequired ? (
          <Button size="sm" disabled={pending} data-testid="mark-reviewed" onClick={() => { const note = prompt("Optional note (what you checked / corrected):") ?? ""; run(markQuestionReviewedAction(questionId, note), "Marked reviewed."); }}>
            Mark reviewed
          </Button>
        ) : null}
        <select className="rounded border border-[var(--color-border)] bg-transparent px-2 py-1" value={cat} onChange={(e) => setCat(e.target.value as ReviewCategory)} aria-label="Review category" data-testid="review-category">
          {REVIEW_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={pending} data-testid="flag-review" onClick={() => { const note = prompt("What needs review?") ?? ""; run(flagQuestionReviewAction(questionId, cat, note), "Flagged for review."); }}>
          Flag for review
        </Button>
        {msg ? <span data-testid="review-msg">{msg}</span> : null}
      </div>
    </div>
  );
}
