"use client";

import { useState } from "react";
import type { ReportType } from "@prisma/client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SaveQuestionButton } from "@/components/student/save-question-button";
import { ReportQuestionDialog } from "@/components/student/report-question-dialog";
import { useAskAi } from "@/components/student/explanation-panel";
import { WhatsAppShareButton } from "@/components/student/whatsapp-share-button";
import type { QuestionSnapshot } from "@/lib/test-attempt";

export interface ReviewQuestionView {
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
  const total = questions.length;
  const q = questions[index];

  if (!q) return null;

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(total - 1, i + 1));

  return (
    <div className="flex flex-col gap-4">
      {/* key resets ReviewQuestionCard's Ask AI state (useAskAi) whenever Prev/Next swaps to a different question — the old per-question <div key=...> boundary, now scoped to the card itself. */}
      <ReviewQuestionCard key={q.attemptQuestionId} q={q} index={index} total={total} />

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={goPrev} disabled={index === 0}>
          <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
        </Button>
        <Button type="button" variant="outline" onClick={goNext} disabled={index === total - 1}>
          Next <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function ReviewQuestionCard({ q, index, total }: { q: ReviewQuestionView; index: number; total: number }) {
  const { trigger: askAiTrigger, panel: askAiPanel } = useAskAi(q.questionId);
  const correctOption = q.snapshot.options.find((opt) => opt.label === q.snapshot.correctLabel);

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]">
      {/* Highlighted question header — Question N on the left, the four review actions grouped together on the right, wrapping cleanly on mobile. */}
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
          {askAiTrigger}
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

        {correctOption ? (
          <p className="mt-3 text-sm font-medium text-[var(--color-success)]">
            Correct Answer: {correctOption.label}. {correctOption.text}
          </p>
        ) : null}

        {/* The one highlighted AI area — default explanation + up to 5 variant tabs, rendered by the same hook whose trigger sits in the header above. Never a separate page/card. */}
        {askAiPanel}
      </div>
    </div>
  );
}
