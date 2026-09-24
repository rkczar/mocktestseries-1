"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getExplanationAction, getExplanationVariantAction } from "@/app/student/ai-actions";
import { EXPLANATION_VARIANTS } from "@/lib/ai-explanation-variants-catalog";
import type { ExplanationContent } from "@/lib/ai-explanation";
import { ExplanationContentView, ExplanationSection } from "@/components/student/explanation-content";

const AUTO_RETRY_DELAYS_MS = [2500, 4000]; // a couple of gentle retries while someone else's generation finishes

type ExplanationResult = Awaited<ReturnType<typeof getExplanationAction>>;
type SuccessResult = Extract<ExplanationResult, { ok: true }>;
type VariantResult = Awaited<ReturnType<typeof getExplanationVariantAction>>;

/**
 * All Ask AI + AI Variants state/logic in one hook, split into a `trigger`
 * (a single button meant to sit inline with Save/Report/WhatsApp in the
 * question header row) and a `panel` (the one highlighted AI area rendered
 * directly under the question + correct answer — never a separate page or
 * card). Both pieces share state so clicking the header trigger opens
 * exactly the area described in the Review UI spec: default explanation on
 * top, up to 5 variant tabs, whichever is selected rendered in that same
 * area.
 */
export function useAskAi(questionId: string) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<SuccessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingOnOther, setWaitingOnOther] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const attemptRef = useRef(0);

  // AI Variants: null = showing the default explanation above. Each fetched
  // variant is cached client-side by id so re-clicking a tab already viewed
  // this session doesn't re-hit the server (the server itself is also a
  // permanent DB cache — this is just avoiding a redundant round trip).
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [variantContents, setVariantContents] = useState<Record<string, { content: ExplanationContent; isStale: boolean }>>({});
  const [variantPendingId, setVariantPendingId] = useState<string | null>(null);
  const [variantError, setVariantError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    startTransition(async () => {
      const outcome = await getExplanationAction(questionId);
      if (outcome.ok) {
        setResult(outcome);
        setWaitingOnOther(false);
        setPanelOpen(true);
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
      setPanelOpen(true);
    });
  };

  const handleTriggerClick = () => {
    if (result) {
      setPanelOpen((open) => !open);
      return;
    }
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
        setVariantContents((prev) => ({ ...prev, [variantId]: { content: outcome.content, isStale: outcome.isStale ?? false } }));
        return;
      }
      setVariantError(outcome.error);
      setActiveVariantId(null);
    });
  };

  const trigger = (
    <Button type="button" variant="outline" size="sm" onClick={handleTriggerClick} disabled={isPending}>
      {isPending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : result ? (
        panelOpen ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />
      ) : (
        <Sparkles className="h-4 w-4" aria-hidden />
      )}
      {isPending ? (waitingOnOther ? "Generating…" : "Generating…") : result ? "Ask AI" : "Ask AI"}
    </Button>
  );

  let panel: React.ReactNode = null;
  if (result && panelOpen) {
    const { content, remainingToday, relatedQuestions, isStale } = result;
    const activeVariant = activeVariantId ? variantContents[activeVariantId] : null;
    const shownContent = activeVariant ? activeVariant.content : content;
    const shownIsStale = activeVariant ? activeVariant.isStale : isStale;

    panel = (
      <div className="mt-4 rounded-[var(--radius-card)] border border-[var(--color-info)]/30 bg-[var(--color-info)]/5 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-info)]">
            <Sparkles className="h-4 w-4" aria-hidden /> AI Explanation
          </p>
          {Number.isFinite(remainingToday) ? (
            <span className="text-xs text-[var(--color-muted-foreground)]">{remainingToday} Ask AI explanations remaining today</span>
          ) : null}
        </div>

        {shownIsStale ? (
          <p className="mb-2 text-xs text-[var(--color-warning)]">
            This question was updated after this explanation was generated — it may be outdated.
          </p>
        ) : null}

        {EXPLANATION_VARIANTS.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Variants:</span>
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
                <ExplanationSection heading="Related practice questions" items={relatedQuestions.map((q) => q.text)} ordered />
              ) : null
            }
          />
        ) : null}
      </div>
    );
  } else if (error && panelOpen) {
    panel = (
      <div className="mt-4 rounded-[var(--radius-card)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
        <p className="text-sm text-[var(--color-error)]">{error}</p>
      </div>
    );
  }

  return { trigger, panel, isOpen: panelOpen };
}

/** Self-contained Ask AI (trigger + panel stacked) — used where the four-action header row isn't part of the layout (e.g. Saved Questions). Attempt Review composes the hook directly so Ask AI can sit inline with Save/Report/WhatsApp instead. */
export function ExplanationPanel({ questionId }: { questionId: string }) {
  const { trigger, panel } = useAskAi(questionId);
  return (
    <div className="mt-4">
      {trigger}
      {panel}
    </div>
  );
}
