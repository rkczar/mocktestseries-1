"use client";

import { useEffect, useRef, useState } from "react";
import type { ReportType } from "@prisma/client";
import { CheckCircle2, ChevronLeft, ChevronRight, MinusCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SaveQuestionButton } from "@/components/student/save-question-button";
import { ReportQuestionDialog } from "@/components/student/report-question-dialog";
import { useAskAi } from "@/components/student/explanation-panel";
import { WhatsAppShareButton } from "@/components/student/whatsapp-share-button";
import type { QuestionSnapshot } from "@/lib/test-attempt";

export interface ReviewQuestionView {
  attemptId: string;
  attemptQuestionId: string;
  questionId: string;
  snapshot: QuestionSnapshot;
  selected: string | null;
  isCorrect: boolean | null;
  saved: boolean;
  /** Pre-rendered from the Admin WhatsApp Share template; null when the feature is disabled. */
  shareText: string | null;
  saveAction: () => Promise<void>;
  reportAction: (reportType: ReportType, message: string) => Promise<void>;
}

/**
 * One question per screen (Section 12/13) — never all N questions rendered
 * vertically at once. Prev/Next only swap local state; the full attempt was
 * already fetched once server-side, so paging never refetches or reloads
 * the page, and the submitted snapshot/answers are read-only here regardless
 * of which question is showing (Section 13: review navigation never alters
 * submitted answers).
 */
export function AttemptReview({ questions }: { questions: ReviewQuestionView[] }) {
  const [index, setIndex] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  const total = questions.length;
  const q = questions[index];

  // After Prev/Next, bring the new question's heading back into view — but only
  // when the student had scrolled past it (deep in a long explanation), so a
  // press from the top of the page doesn't jump. The window is the scroll
  // container; scroll-mt clears the sticky StudentHeader.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const card = cardRef.current;
    if (card && card.getBoundingClientRect().top < 80) card.scrollIntoView({ block: "start", behavior: "instant" });
  }, [index]);

  if (!q) return null;

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(total - 1, i + 1));

  return (
    <div className="flex flex-col gap-4">
      <div ref={cardRef} className="scroll-mt-20">
        {/* key resets ReviewQuestionCard's Ask AI state (useAskAi) whenever Prev/Next swaps to a different question — the old per-question <div key=...> boundary, now scoped to the card itself. */}
        <ReviewQuestionCard key={q.attemptQuestionId} q={q} index={index} total={total} />
      </div>

      {/* Sticky (not fixed): it keeps its own place in the flow right after the card, so it pins to the viewport bottom while the card scrolls under it, yet the last line of any explanation can always scroll clear above it, and it stops before the footer. */}
      <nav
        aria-label="Question navigation"
        data-testid="review-nav"
        className="sticky bottom-0 z-30 -mx-1 px-1 pt-1 print:static"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex w-full items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]/85 p-2 shadow-[var(--shadow-card)] backdrop-blur supports-[backdrop-filter]:bg-[var(--color-card)]/75 sm:max-w-md">
          <Button
            type="button"
            variant="outline"
            onClick={goPrev}
            disabled={index === 0}
            aria-label="Previous question"
            className="h-11 flex-1 sm:flex-none"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
          </Button>
          <span className="shrink-0 text-sm font-medium tabular-nums text-[var(--color-muted-foreground)]" aria-live="polite" data-testid="review-nav-position">
            <span className="sr-only">Question </span>
            {index + 1} / {total}
          </span>
          <Button
            type="button"
            variant="primary"
            onClick={goNext}
            disabled={index === total - 1}
            aria-label="Next question"
            className="h-11 flex-1 sm:flex-none"
          >
            Next <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </nav>
    </div>
  );
}

function ReviewQuestionCard({ q, index, total }: { q: ReviewQuestionView; index: number; total: number }) {
  const { actions: askAiActions, usageNotice, panel: askAiPanel } = useAskAi(q.questionId, "attempt_review", q.attemptId);
  const correctOption = q.snapshot.options.find((opt) => opt.label === q.snapshot.correctLabel);

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]">
      {/* Highlighted question header — Question N on the left, the review actions grouped together on the right, wrapping cleanly on mobile. Ask AI lives with the answer below. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-info)]/5 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-foreground)]">
            Question {index + 1} of {total}
          </span>
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs font-medium",
              q.isCorrect === true && "bg-[var(--color-success)]/15 text-[var(--color-success)]",
              q.isCorrect === false && "bg-[var(--color-error)]/15 text-[var(--color-error)]",
              q.isCorrect === null && "bg-[var(--color-border)] text-[var(--color-muted-foreground)]"
            )}
          >
            {q.isCorrect === true ? "Correct" : q.isCorrect === false ? "Incorrect" : "Not Answered"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SaveQuestionButton initialSaved={q.saved} onToggle={q.saveAction} />
          <ReportQuestionDialog onSubmit={q.reportAction} />
          {q.shareText ? <WhatsAppShareButton text={q.shareText} /> : null}
        </div>
      </div>

      <div className="p-5">
        <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">{q.snapshot.text}</p>
        {q.snapshot.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={q.snapshot.imageUrl}
            alt=""
            className="mt-3 max-h-72 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
          />
        ) : null}

        <div className="mt-4 flex flex-col gap-2">
          {q.snapshot.options.map((opt) => {
            const isSelected = q.selected === opt.label;
            const isAnswer = opt.label === q.snapshot.correctLabel;
            return (
              <div
                key={opt.label}
                className={cn(
                  "rounded-[var(--radius-card)] border p-3 text-sm",
                  isAnswer
                    ? "border-[var(--color-success)] bg-[var(--color-success)]/10"
                    : isSelected
                      ? "border-[var(--color-error)] bg-[var(--color-error)]/10"
                      : "border-[var(--color-border)]"
                )}
              >
                <span className="font-semibold">{opt.label}.</span> {opt.text}
                {isAnswer ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Correct answer</span> : null}
                {isSelected && !isAnswer ? (
                  <span className="ml-2 text-xs font-medium text-[var(--color-error)]">Your answer</span>
                ) : null}
                {opt.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={opt.imageUrl}
                    alt=""
                    className="mt-2 max-h-48 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Answer header: Correct / Incorrect on the left, the AI actions on the right (wrapping under it on narrow screens), then usage and the correct answer. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-testid="review-answer-header">
          <p
            className={cn(
              "flex items-center gap-2 text-sm font-semibold",
              q.isCorrect === true && "text-[var(--color-success)]",
              q.isCorrect === false && "text-[var(--color-error)]",
              q.isCorrect === null && "text-[var(--color-muted-foreground)]"
            )}
          >
            {q.isCorrect === true ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden />
            ) : q.isCorrect === false ? (
              <XCircle className="h-4 w-4" aria-hidden />
            ) : (
              <MinusCircle className="h-4 w-4" aria-hidden />
            )}
            {q.isCorrect === true ? "Correct" : q.isCorrect === false ? "Incorrect" : "Not Answered"}
          </p>
          {askAiActions}
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {usageNotice}
          {correctOption ? (
            <p className="text-sm font-medium text-[var(--color-success)]">
              Correct Answer: {correctOption.label}. {correctOption.text}
            </p>
          ) : null}
        </div>

        {/* The one highlighted AI area — explanation (with its styles) or AI Question Variant, opened by the two AI actions above. Never a separate page/card. */}
        {askAiPanel}
      </div>
    </div>
  );
}
