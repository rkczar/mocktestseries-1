"use client";

import { useEffect, useRef, useState } from "react";
import type { ReportType } from "@prisma/client";
import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { QuestionBottomNav } from "@/components/student/question-bottom-nav";
import { SaveQuestionButton } from "@/components/student/save-question-button";
import { ReportQuestionDialog } from "@/components/student/report-question-dialog";
import { useAskAi } from "@/components/student/explanation-panel";
import { WhatsAppShareButton } from "@/components/student/whatsapp-share-button";
import type { QuestionSnapshot } from "@/lib/test-attempt";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia, preloadImages } from "@/components/content/question-media";
import { HumanExplanation } from "@/components/content/human-explanation";
import type { ExplanationView, MatchView, RichQuestionView } from "@/lib/rich-content-types";
import { MatchLists } from "@/components/content/match-lists";
import { formatLabelSet, snapshotCorrectLabels, snapshotQuestionType } from "@/lib/question-types";

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
  /** Snapshot v2 RICH_V1 only: server-rendered text/options + images. */
  rich?: RichQuestionView;
  /** Snapshot v2 only: the human explanation (this page is the authorized review). */
  explanation?: ExplanationView;
  /** MULTIPLE_CORRECT (snapshot v3) only: the submitted label set. */
  selectedLabels?: string[];
  /** MATCH_THE_FOLLOWING (snapshot v3) only: server-rendered List I / List II. */
  match?: MatchView;
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

  // RICH_V1 media: warm the next question's images only (never the whole review).
  useEffect(() => {
    const next = questions[index + 1];
    if (next?.rich) preloadImages(next.rich.assets.map((a) => a.url));
    if (next?.explanation) preloadImages(next.explanation.assets.map((a) => a.url));
    if (next?.match) preloadImages([...next.match.listI, ...next.match.listII].flatMap((i) => i.assets.map((a) => a.url)));
  }, [index, questions]);

  if (!q) return null;

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(total - 1, i + 1));

  return (
    <div className="flex flex-col gap-4">
      <div ref={cardRef} className="scroll-mt-20">
        {/* key resets ReviewQuestionCard's Ask AI state (useAskAi) whenever Prev/Next swaps to a different question — the old per-question <div key=...> boundary, now scoped to the card itself. */}
        <ReviewQuestionCard key={q.attemptQuestionId} q={q} index={index} total={total} />
      </div>

      <QuestionBottomNav
        testId="review-nav"
        positionTestId="review-nav-position"
        index={index}
        total={total}
        onPrevious={goPrev}
        onNext={goNext}
        previousDisabled={index === 0}
        nextDisabled={index === total - 1}
        previousAriaLabel="Previous question"
        nextAriaLabel="Next question"
      />
    </div>
  );
}

function ReviewQuestionCard({ q, index, total }: { q: ReviewQuestionView; index: number; total: number }) {
  const { actions: askAiActions, usageNotice, panel: askAiPanel } = useAskAi(q.questionId, "attempt_review", q.attemptId);
  const correctOption = q.snapshot.options.find((opt) => opt.label === q.snapshot.correctLabel);
  // MULTIPLE_CORRECT (NEET Phase 4): the frozen correct SET vs the submitted set. SINGLE_CORRECT / MATCH use the lines above.
  const multi = snapshotQuestionType(q.snapshot) === "MULTIPLE_CORRECT";
  const correctSet = multi ? snapshotCorrectLabels(q.snapshot) : [];
  const selectedSet = multi ? (q.selectedLabels ?? []) : [];
  // Ask AI explains single-correct questions only (the server refuses the rest too).
  const askAiAllowed = snapshotQuestionType(q.snapshot) === "SINGLE_CORRECT";
  const panelRef = useRef<HTMLDivElement>(null);
  const panelOpen = askAiPanel !== null;

  // On a phone the AI panel opens BELOW the whole action area, so it can start
  // off-screen: bring it into view when it first opens (the loading state, then
  // the content, fill the same spot). Phone only, and only when it isn't already visible.
  useEffect(() => {
    const el = panelRef.current;
    if (!panelOpen || !el || !window.matchMedia("(max-width: 767.98px)").matches) return;
    const navTop = document.querySelector("[data-testid=review-nav]")?.getBoundingClientRect().top ?? window.innerHeight;
    if (el.getBoundingClientRect().top > navTop - 96) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: reduce ? "instant" : "smooth" });
    }
  }, [panelOpen]);

  return (
    // Everything renders ONCE. md+ (unchanged): a grid puts Save / Report / Share in the header band beside "Question N
    // of M" (both cells carry the band's background + rule, so it reads as one strip), then the body block. Below md the
    // body and its row wrappers become `display: contents`, so each piece is a flex item of this column and `order`
    // gives the phone flow: header → question → options → result → Correct Answer → AI actions (+ usage) → Save /
    // Report → Share → AI panel. Nothing moves when the panel opens; it appears under the action area.
    <div className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] max-md:pb-4 md:grid md:grid-cols-[1fr_auto]">
      <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-info)]/5 px-4 py-3 max-md:order-1 md:col-start-1 md:row-start-1 md:pl-5 md:pr-0">
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
      </div>
      <div
        data-testid="review-question-tools"
        className="grid grid-cols-2 gap-2 px-4 max-md:order-8 max-md:mt-3 [&>button]:h-10 md:col-start-2 md:row-start-1 md:flex md:flex-wrap md:items-center md:justify-end md:border-b md:border-[var(--color-border)] md:bg-[var(--color-info)]/5 md:py-3 md:pl-3 md:pr-5 md:[&>button]:h-8"
      >
        <SaveQuestionButton initialSaved={q.saved} onToggle={q.saveAction} />
        <ReportQuestionDialog onSubmit={q.reportAction} />
        {q.shareText ? (
          <div className="col-span-2 flex md:contents">
            <WhatsAppShareButton text={q.shareText} />
          </div>
        ) : null}
      </div>

      <div className="max-md:contents md:col-span-2 md:row-start-2 md:p-5">
        <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)] max-md:order-2 max-md:px-4 max-md:pt-4 max-md:text-[length:calc(1.0625rem*var(--text-scale))] max-md:leading-[1.65]">
          <RichText text={q.snapshot.text} html={q.rich?.textHtml} />
        </p>
        {q.snapshot.imageUrl && !q.rich?.assets.some((a) => a.role === "QUESTION") ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={q.snapshot.imageUrl}
            alt=""
            className="mt-3 max-h-72 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain max-md:order-2 max-md:mx-4 max-md:max-w-[calc(100%-2rem)] max-md:self-start"
          />
        ) : null}
        {q.rich ? <QuestionMedia className="mt-3 max-md:order-2 max-md:px-4" assets={q.rich.assets.filter((a) => a.role === "QUESTION")} /> : null}
        {q.match ? <MatchLists className="mt-4 max-md:order-2 max-md:mx-4" match={q.match} /> : null}

        <div className="mt-4 flex flex-col gap-2.5 max-md:order-3 max-md:px-4 md:gap-2" data-testid="review-options">
          {multi ? q.snapshot.options.map((opt) => {
            const isSelected = selectedSet.includes(opt.label);
            const isAnswer = correctSet.includes(opt.label);
            const state = isAnswer && isSelected ? "selected-correct" : isSelected ? "selected-incorrect" : isAnswer ? "missed-correct" : "none";
            return (
              <div
                key={opt.label}
                data-state={state}
                className={cn(
                  "rounded-[var(--radius-card)] border p-3 text-sm max-md:text-[length:calc(1rem*var(--text-scale))] max-md:leading-relaxed",
                  state === "selected-correct" && "border-[var(--color-success)] bg-[var(--color-success)]/10",
                  state === "missed-correct" && "border-dashed border-[var(--color-success)]",
                  state === "selected-incorrect" && "border-[var(--color-error)] bg-[var(--color-error)]/10",
                  state === "none" && "border-[var(--color-border)]"
                )}
              >
                <span className="font-semibold">{opt.label}.</span> <RichText text={opt.text} html={q.rich?.optionHtml[opt.label]} />
                {state === "selected-correct" ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Your answer · Correct</span> : null}
                {state === "missed-correct" ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Correct answer · Missed</span> : null}
                {state === "selected-incorrect" ? <span className="ml-2 text-xs font-medium text-[var(--color-error)]">Your answer · Incorrect</span> : null}
                {opt.imageUrl && !q.rich?.assets.some((a) => a.role === "OPTION" && a.optionLabel === opt.label) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={opt.imageUrl}
                    alt=""
                    className="mt-2 max-h-48 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                  />
                ) : null}
                {q.rich ? (
                  <QuestionMedia className="mt-2" size="option" assets={q.rich.assets.filter((a) => a.role === "OPTION" && a.optionLabel === opt.label)} />
                ) : null}
              </div>
            );
          }) : q.snapshot.options.map((opt) => {
            const isSelected = q.selected === opt.label;
            const isAnswer = opt.label === q.snapshot.correctLabel;
            return (
              <div
                key={opt.label}
                className={cn(
                  "rounded-[var(--radius-card)] border p-3 text-sm max-md:text-[length:calc(1rem*var(--text-scale))] max-md:leading-relaxed",
                  isAnswer
                    ? "border-[var(--color-success)] bg-[var(--color-success)]/10"
                    : isSelected
                      ? "border-[var(--color-error)] bg-[var(--color-error)]/10"
                      : "border-[var(--color-border)]"
                )}
              >
                <span className="font-semibold">{opt.label}.</span> <RichText text={opt.text} html={q.rich?.optionHtml[opt.label]} />
                {isAnswer ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Correct answer</span> : null}
                {isSelected && !isAnswer ? (
                  <span className="ml-2 text-xs font-medium text-[var(--color-error)]">Your answer</span>
                ) : null}
                {opt.imageUrl && !q.rich?.assets.some((a) => a.role === "OPTION" && a.optionLabel === opt.label) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={opt.imageUrl}
                    alt=""
                    className="mt-2 max-h-48 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                  />
                ) : null}
                {q.rich ? (
                  <QuestionMedia className="mt-2" size="option" assets={q.rich.assets.filter((a) => a.role === "OPTION" && a.optionLabel === opt.label)} />
                ) : null}
              </div>
            );
          })}
        </div>

        {/* md+: Correct / Incorrect on the left, the AI actions on the right, then usage and the correct answer. Phone: see the card comment. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 max-md:contents" data-testid="review-answer-header">
          <p
            className={cn(
              "flex items-center gap-2 text-sm font-semibold max-md:order-4 max-md:mt-4 max-md:px-4",
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
          <div className="max-md:order-6 max-md:mt-4 max-md:px-4 max-md:[&_button]:h-10 max-md:[&_button]:flex-1">{askAiAllowed ? askAiActions : null}</div>
        </div>
        <div className="mt-2 flex flex-col gap-2 max-md:contents">
          <div className="empty:hidden max-md:order-7 max-md:mt-2 max-md:px-4">{askAiAllowed ? usageNotice : null}</div>
          {multi ? (
            <div className="text-sm font-medium max-md:order-5 max-md:mt-2 max-md:px-4" data-testid="review-answer-sets">
              <p className="text-[var(--color-foreground)]">Your answer: {selectedSet.length ? formatLabelSet(selectedSet) : "Not answered"}</p>
              <p className="text-[var(--color-success)]">Correct answer: {formatLabelSet(correctSet)}</p>
              <p className="mt-0.5 text-xs font-normal text-[var(--color-muted-foreground)]">Marked correct only when every correct option, and nothing else, is selected.</p>
            </div>
          ) : correctOption ? (
            <p className="text-sm font-medium text-[var(--color-success)] max-md:order-5 max-md:mt-2 max-md:px-4">
              Correct Answer: {correctOption.label}. <RichText text={correctOption.text} html={q.rich?.optionHtml[correctOption.label]} />
            </p>
          ) : null}
          {q.explanation ? <HumanExplanation className="max-md:order-5 max-md:mx-4 max-md:mt-3" explanation={q.explanation} /> : null}
        </div>

        {/* The one highlighted AI area — explanation (with its styles) or AI Question Variant, opened by the two AI actions. Never a separate page/card. */}
        <div ref={panelRef} className="empty:hidden max-md:order-9 max-md:scroll-mt-20 max-md:px-4">
          {askAiAllowed ? askAiPanel : null}
        </div>
      </div>
    </div>
  );
}
