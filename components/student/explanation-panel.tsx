"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getExplanationAction, getExplanationVariantAction } from "@/app/student/ai-actions";
import { EXPLANATION_VARIANTS } from "@/lib/ai-explanation-variants-catalog";
import type { ExplanationContent } from "@/lib/ai-explanation";

const AUTO_RETRY_DELAYS_MS = [2500, 4000]; // a couple of gentle retries while someone else's generation finishes

type ExplanationResult = Awaited<ReturnType<typeof getExplanationAction>>;
type SuccessResult = Extract<ExplanationResult, { ok: true }>;
type VariantResult = Awaited<ReturnType<typeof getExplanationVariantAction>>;

/** Shared by the default explanation and every AI Variant — same content shape, same rendering. */
function ExplanationContentView({ content, extra }: { content: ExplanationContent; extra?: React.ReactNode }) {
  const optionEntries = Object.entries(content.optionAnalysis ?? {});
  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--color-foreground)]">
      {content.concept ? (
        <p>
          <span className="font-medium">Concept: </span>
          {content.concept}
        </p>
      ) : null}

      {optionEntries.length > 0 ? (
        <div>
          <p className="font-medium">Why the other options are wrong</p>
          <div className="mt-1 flex flex-col gap-1">
            {optionEntries.map(([label, text]) => (
              <p key={label}>
                <span className="font-medium">{label} — </span>
                {text}
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {content.pointsToRemember?.length ? (
        <div>
          <p className="font-medium">Points to remember</p>
          <ul className="mt-1 list-disc pl-5">
            {content.pointsToRemember.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {content.memoryTrick ? (
        <p>
          <span className="font-medium">Memory trick: </span>
          {content.memoryTrick}
        </p>
      ) : null}

      {content.examinerTraps?.length ? (
        <div>
          <p className="font-medium">Examiner traps</p>
          <ul className="mt-1 list-disc pl-5">
            {content.examinerTraps.map((trap, i) => (
              <li key={i}>{trap}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {content.trapWords?.length ? (
        <p>
          <span className="font-medium">Watch for these words: </span>
          {content.trapWords.join(", ")}
        </p>
      ) : null}

      {content.examinerVariation ? (
        <p>
          <span className="font-medium">How the examiner can change this question: </span>
          {content.examinerVariation}
        </p>
      ) : null}

      {extra}
    </div>
  );
}

export function ExplanationPanel({ questionId }: { questionId: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<SuccessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingOnOther, setWaitingOnOther] = useState(false);
  const attemptRef = useRef(0);

  // AI Variants: null = showing the default explanation above. Each fetched
  // variant is cached client-side by id so re-clicking a tab already viewed
  // this session doesn't re-hit the server (the server itself is also a
  // permanent DB cache — this is just avoiding a redundant round trip).
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [variantContents, setVariantContents] = useState<Record<string, ExplanationContent>>({});
  const [variantPendingId, setVariantPendingId] = useState<string | null>(null);
  const [variantError, setVariantError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    startTransition(async () => {
      const outcome = await getExplanationAction(questionId);
      if (outcome.ok) {
        setResult(outcome);
        setWaitingOnOther(false);
        return;
      }
      if (outcome.retry && attemptRef.current < AUTO_RETRY_DELAYS_MS.length) {
        setWaitingOnOther(true);
        const delay = AUTO_RETRY_DELAYS_MS[attemptRef.current];
        attemptRef.current += 1;
        setTimeout(run, delay);
        return;
      }
      setWaitingOnOther(false);
      setError(outcome.error);
    });
  };

  const handleClick = () => {
    attemptRef.current = 0;
    run();
  };

  const selectVariant = (variantId: string | null) => {
    setVariantError(null);
    setActiveVariantId(variantId);
    if (variantId === null || variantContents[variantId]) return;

    setVariantPendingId(variantId);
    startTransition(async () => {
      const outcome: VariantResult = await getExplanationVariantAction(questionId, variantId);
      setVariantPendingId(null);
      if (outcome.ok) {
        setVariantContents((prev) => ({ ...prev, [variantId]: outcome.content }));
        return;
      }
      setVariantError(outcome.error);
      setActiveVariantId(null);
    });
  };

  if (result) {
    const { content, remainingToday, relatedQuestions, isStale } = result;
    const shownContent = activeVariantId ? variantContents[activeVariantId] : content;

    return (
      <div className="mt-4 rounded-[var(--radius-card)] border border-[var(--color-info)]/30 bg-[var(--color-info)]/5 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-info)]">
            <Sparkles className="h-4 w-4" aria-hidden /> AI Explanation
          </p>
          {Number.isFinite(remainingToday) ? (
            <span className="text-xs text-[var(--color-muted-foreground)]">{remainingToday} Ask AI explanations remaining today</span>
          ) : null}
        </div>

        {isStale ? (
          <p className="mb-2 text-xs text-[var(--color-warning)]">
            This question was updated after this explanation was generated — it may be outdated.
          </p>
        ) : null}

        {EXPLANATION_VARIANTS.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--color-muted-foreground)]">AI Variants:</span>
            <button
              type="button"
              onClick={() => selectVariant(null)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                activeVariantId === null
                  ? "border-[var(--color-info)] bg-[var(--color-info)]/15 text-[var(--color-info)]"
                  : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
              )}
            >
              Default
            </button>
            {EXPLANATION_VARIANTS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => selectVariant(v.id)}
                disabled={variantPendingId === v.id}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60",
                  activeVariantId === v.id
                    ? "border-[var(--color-info)] bg-[var(--color-info)]/15 text-[var(--color-info)]"
                    : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                )}
              >
                {variantPendingId === v.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                {v.label}
              </button>
            ))}
          </div>
        ) : null}

        {variantError ? <p className="mb-2 text-xs text-[var(--color-error)]">{variantError}</p> : null}

        {shownContent ? (
          <ExplanationContentView
            content={shownContent}
            extra={
              !activeVariantId && relatedQuestions && relatedQuestions.length > 0 ? (
                <div>
                  <p className="font-medium">Related practice questions</p>
                  <ul className="mt-1 list-decimal pl-5">
                    {relatedQuestions.map((q) => (
                      <li key={q.id}>{q.text}</li>
                    ))}
                  </ul>
                </div>
              ) : null
            }
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
        {isPending ? (waitingOnOther ? "Generating (someone else started this one)…" : "Generating…") : "Ask AI"}
      </Button>
      {error ? <p className="mt-2 text-sm text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
