"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Sparkles, Zap, Check, Infinity as InfinityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getExplanationAction, getExplanationVariantAction, getQuestionVariantsAction } from "@/app/student/ai-actions";
import { EXPLANATION_VARIANTS } from "@/lib/ai-explanation-variants-catalog";
import type { ExplanationContent } from "@/lib/ai-explanation";
import { ExplanationContentView } from "@/components/student/explanation-content";
import { QuestionVariantsView } from "@/components/student/question-variants";
import { applyAiRemaining, getAiUsageSnapshot, markAiLimitReached, useAiUsage, type AiUsage } from "@/components/student/ai-usage-store";
import { trackEvent } from "@/lib/analytics-events";

const AUTO_RETRY_DELAYS_MS = [2500, 4000]; // a couple of gentle retries while someone else's generation finishes

type ExplanationResult = Awaited<ReturnType<typeof getExplanationAction>>;
type SuccessResult = Extract<ExplanationResult, { ok: true }>;
type VariantResult = Awaited<ReturnType<typeof getExplanationVariantAction>>;
type QuestionVariantsState = React.ComponentProps<typeof QuestionVariantsView>["state"];

/** Where an Ask AI surface lives — sent with analytics events only. */
export type AskAiSource = "practice_player" | "attempt_review" | "saved_questions";

/** At or below this many credits left, the free-plan notice nudges toward upgrading. */
const LOW_LIMIT_THRESHOLD = 5;
/** Never leave an indefinite spinner: two bounded provider calls fit well inside this. */
const QUESTION_VARIANTS_TIMEOUT_MS = 120_000;

type View = "explanation" | "variants";

function usageParams(source: AskAiSource) {
  const usage = getAiUsageSnapshot();
  return {
    source_page: source,
    subscription_status: usage?.subscription ?? "unknown",
    remaining_ai_uses: usage ? (usage.remainingToday ?? "unlimited") : "unknown",
  };
}

/** "Shown" impressions are sent once per page load, not once per question. */
const shownOnce = new Set<string>();
function trackOnce(name: string, source: AskAiSource) {
  if (shownOnce.has(name)) return;
  shownOnce.add(name);
  trackEvent(name, usageParams(source));
}

/**
 * All Ask AI state/logic for one question, split into `actions` (the two AI
 * buttons — Ask AI and AI Question Variant — meant to sit in the answer's
 * Correct/Incorrect header row), `usageNotice` (server-backed remaining
 * credits / upgrade prompt, rendered under that row) and `panel` (the one
 * highlighted AI area under the correct answer — never a separate page).
 * The two buttons open the same area in different views; both go through
 * the existing server actions, which enforce the answer-reveal rule and the
 * daily quota (one credit per distinct question, shared by both views).
 * `reviewAttemptId` is passed only by a submitted attempt's Review page, so
 * the server judges the question in that attempt's context.
 */
export function useAskAi(questionId: string, source: AskAiSource, reviewAttemptId?: string) {
  const usage = useAiUsage();
  const [isPending, startTransition] = useTransition();
  const [, startStyleTransition] = useTransition();
  const [result, setResult] = useState<SuccessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  /** This question's own request hit the daily limit (the usage notice then shows the upgrade card). */
  const [limitHit, setLimitHit] = useState(false);
  const attemptRef = useRef(0);

  // Explanation styles (ELI5 etc.): null = the default explanation. Each
  // fetched style is cached client-side by id so re-clicking a chip doesn't
  // re-hit the server (the server itself is also a permanent DB cache).
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [variantContents, setVariantContents] = useState<Record<string, { content: ExplanationContent; isStale: boolean }>>({});
  const [variantPendingId, setVariantPendingId] = useState<string | null>(null);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [questionVariants, setQuestionVariants] = useState<QuestionVariantsState | null>(null);
  const questionVariantsRetryRef = useRef(0);
  /** A double click must not start a second identical request before React re-renders the disabled button. */
  const variantsInflightRef = useRef(false);

  const onLimitReached = () => {
    markAiLimitReached();
    setLimitHit(true);
    trackOnce("ai_limit_reached", source);
  };

  const loadQuestionVariants = () => {
    if (variantsInflightRef.current) return;
    variantsInflightRef.current = true;
    setQuestionVariants({ kind: "loading" });
    let settled = false;
    const finish = () => {
      settled = true;
      variantsInflightRef.current = false;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      finish();
      trackEvent("ai_generation_failed", { ...usageParams(source), ai_kind: "question_variant", reason: "timeout" });
      setQuestionVariants({ kind: "error", message: "This is taking longer than expected.", canRetry: true });
    }, QUESTION_VARIANTS_TIMEOUT_MS);
    getQuestionVariantsAction(questionId, reviewAttemptId)
      .then((outcome) => {
        if (settled) return;
        finish();
        if (!outcome.ok && "retry" in outcome && outcome.retry && questionVariantsRetryRef.current < AUTO_RETRY_DELAYS_MS.length) {
          // Someone else is generating this question's variants right now — wait and read theirs.
          const delay = AUTO_RETRY_DELAYS_MS[questionVariantsRetryRef.current];
          questionVariantsRetryRef.current += 1;
          setTimeout(loadQuestionVariants, delay);
          return;
        }
        if (outcome.ok) {
          applyAiRemaining(outcome.remainingToday);
          trackEvent("ai_generation_success", { ...usageParams(source), ai_kind: "question_variant" });
          setQuestionVariants({ kind: "ready", variants: outcome.variants, requested: outcome.requested });
          return;
        }
        if ("limitReached" in outcome && outcome.limitReached) {
          // The usage notice turns into the upgrade card — no second error box here.
          onLimitReached();
          setQuestionVariants(null);
          setView(null);
          return;
        }
        trackEvent("ai_generation_failed", { ...usageParams(source), ai_kind: "question_variant" });
        setQuestionVariants({
          kind: "error",
          message: outcome.error,
          canRetry: ("canRetry" in outcome && Boolean(outcome.canRetry)) || ("retry" in outcome && Boolean(outcome.retry)),
        });
      })
      .catch(() => {
        if (settled) return;
        finish();
        trackEvent("ai_generation_failed", { ...usageParams(source), ai_kind: "question_variant", reason: "network" });
        setQuestionVariants({ kind: "error", message: "Couldn't reach the server.", canRetry: true });
      });
  };

  const run = () => {
    setError(null);
    startTransition(async () => {
      let outcome: ExplanationResult;
      try {
        outcome = await getExplanationAction(questionId, reviewAttemptId);
      } catch {
        outcome = { ok: false, error: "Couldn't reach the server." };
      }
      if (outcome.ok) {
        applyAiRemaining(outcome.remainingToday);
        trackEvent("ai_generation_success", { ...usageParams(source), ai_kind: "explanation" });
        setResult(outcome);
        return;
      }
      if ("retry" in outcome && outcome.retry && attemptRef.current < AUTO_RETRY_DELAYS_MS.length) {
        const delay = AUTO_RETRY_DELAYS_MS[attemptRef.current];
        attemptRef.current += 1;
        setTimeout(run, delay);
        return;
      }
      if ("limitReached" in outcome && outcome.limitReached) {
        onLimitReached();
        setView(null);
        return;
      }
      trackEvent("ai_generation_failed", { ...usageParams(source), ai_kind: "explanation" });
      setError(outcome.error);
    });
  };

  const openExplanation = () => {
    if (view === "explanation") {
      setView(null);
      return;
    }
    trackEvent("ai_ask_clicked", usageParams(source));
    setView("explanation");
    if (!result && !isPending) {
      attemptRef.current = 0;
      run();
    }
  };

  const openQuestionVariants = () => {
    if (view === "variants") {
      setView(null);
      return;
    }
    trackEvent("ai_variant_clicked", usageParams(source));
    setView("variants");
    if (!questionVariants || questionVariants.kind === "error") {
      questionVariantsRetryRef.current = 0;
      loadQuestionVariants();
    }
  };

  const selectExplanationStyle = (variantId: string | null) => {
    if (variantPendingId) return;
    setVariantError(null);
    setActiveVariantId(variantId);
    if (variantId === null || variantContents[variantId]) return;

    setVariantPendingId(variantId);
    startStyleTransition(async () => {
      let outcome: VariantResult;
      try {
        outcome = await getExplanationVariantAction(questionId, variantId, reviewAttemptId);
      } catch {
        outcome = { ok: false, error: "Couldn't reach the server." };
      }
      setVariantPendingId(null);
      if (outcome.ok) {
        applyAiRemaining(outcome.remainingToday);
        setVariantContents((prev) => ({ ...prev, [variantId]: { content: outcome.content, isStale: outcome.isStale ?? false } }));
        return;
      }
      if ("limitReached" in outcome && outcome.limitReached) onLimitReached();
      setVariantError(outcome.error);
      setActiveVariantId(null);
    });
  };

  const variantsLoading = questionVariants?.kind === "loading";
  const actions = (
    <div className="flex flex-wrap items-center gap-2" data-testid="ai-actions">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ai-action premium-glow"
        data-glow-target="ASK_AI"
        onClick={openExplanation}
        disabled={isPending}
        aria-expanded={view === "explanation"}
        data-testid="ask-ai-button"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="ai-action-icon h-4 w-4" aria-hidden />}
        {isPending ? "Generating…" : "Ask AI"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ai-action premium-glow"
        data-glow-target="AI_QUESTION_VARIANT"
        onClick={openQuestionVariants}
        disabled={variantsLoading}
        aria-expanded={view === "variants"}
        data-testid="ai-variant-button"
      >
        {variantsLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="ai-action-icon h-4 w-4" aria-hidden />}
        {variantsLoading ? "Generating…" : "AI Question Variant"}
      </Button>
    </div>
  );

  const usageNotice = <AiUsageNotice usage={usage} source={source} />;

  let panel: React.ReactNode = null;
  if (view === "variants") {
    panel = (
      <section className="ai-panel mt-4 rounded-[var(--radius-card)] p-4" aria-label="AI Question Variant" data-testid="ai-panel">
        <p className="ai-heading mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4" aria-hidden /> AI Question Variant
        </p>
        <QuestionVariantsView
          state={questionVariants ?? { kind: "loading" }}
          onRetry={() => {
            questionVariantsRetryRef.current = 0;
            loadQuestionVariants();
          }}
        />
      </section>
    );
  } else if (view === "explanation" && result) {
    const { content, isStale } = result;
    const activeVariant = activeVariantId ? variantContents[activeVariantId] : null;
    const shownContent = activeVariant ? activeVariant.content : content;
    const shownIsStale = activeVariant ? activeVariant.isStale : isStale;

    panel = (
      <div className="ai-panel mt-4 rounded-[var(--radius-card)] p-4" data-testid="ai-panel">
        <p className="ai-heading mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4" aria-hidden /> AI Explanation
        </p>

        {shownIsStale ? (
          <p className="mb-2 text-xs text-[var(--color-warning)]">This question was updated after this explanation was generated — it may be outdated.</p>
        ) : null}

        {EXPLANATION_VARIANTS.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Explain it:</span>
            <button
              type="button"
              onClick={() => selectExplanationStyle(null)}
              aria-pressed={activeVariantId === null}
              className="ai-chip rounded-full px-2.5 py-1 text-xs font-medium text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)]"
            >
              Default
            </button>
            {EXPLANATION_VARIANTS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => selectExplanationStyle(v.id)}
                disabled={variantPendingId !== null}
                aria-pressed={activeVariantId === v.id}
                className="ai-chip flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)] disabled:opacity-60"
              >
                {variantPendingId === v.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                {v.label}
              </button>
            ))}
          </div>
        ) : null}

        {variantError ? <p className="mb-2 text-xs text-[var(--color-error)]">{variantError}</p> : null}

        {shownContent ? <ExplanationContentView content={shownContent} /> : null}
      </div>
    );
  } else if (view === "explanation" && isPending) {
    panel = (
      <div className="ai-panel mt-4 rounded-[var(--radius-card)] p-4" data-testid="ai-panel">
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Generating AI explanation…
        </p>
      </div>
    );
  } else if (view === "explanation" && error) {
    panel = (
      <div className="mt-4 rounded-[var(--radius-card)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4">
        <p className="text-sm text-[var(--color-error)]">{error}</p>
      </div>
    );
  }

  return { actions, usageNotice, panel, isOpen: view !== null, limitHit };
}

/**
 * Remaining daily AI credits under the AI buttons, straight from the server
 * ledger (ai-usage-store). Free plan: plain count → a gentle upgrade nudge at
 * ≤5 left → the upgrade card at 0. Unlimited plan: a quiet "Unlimited AI".
 * A finite paid plan only ever sees the count — never an upgrade prompt.
 */
export function AiUsageNotice({ usage, source }: { usage: AiUsage | null; source: AskAiSource }) {
  const remaining = usage?.remainingToday;
  const isFree = usage?.subscription === "free";
  const low = isFree && typeof remaining === "number" && remaining > 0 && remaining <= LOW_LIMIT_THRESHOLD;
  const exhausted = isFree && remaining === 0;

  useEffect(() => {
    if (low) trackOnce("ai_low_limit_shown", source);
    if (exhausted) trackOnce("ai_limit_reached", source);
  }, [low, exhausted, source]);

  if (!usage || remaining === undefined) return null;

  if (remaining === null) {
    return (
      <p className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]" data-testid="ai-usage" data-state="unlimited">
        <InfinityIcon className="h-3.5 w-3.5" aria-hidden /> Unlimited AI
      </p>
    );
  }

  const unlimitedCopy = usage.paidPlanUnlimited;
  const onUpgradeClick = () => trackEvent("ai_upgrade_clicked", usageParams(source));

  if (exhausted && usage.upgrade) {
    return (
      <div className="ai-panel rounded-[var(--radius-card)] p-4" data-testid="ai-usage" data-state="exhausted">
        <p className="ai-heading flex flex-wrap items-center gap-x-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4" aria-hidden />
          {unlimitedCopy ? "Unlock Unlimited AI" : "Get more AI with a paid plan"}
          {usage.upgrade.priceLabel ? <span className="text-[var(--color-foreground)]">— {usage.upgrade.priceLabel}</span> : null}
        </p>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">You&apos;ve used your daily AI allowance. Free uses reset at midnight (IST).</p>
        <p className="mt-2 text-xs font-medium text-[var(--color-foreground)]">{unlimitedCopy ? "Get unlimited access to:" : "A paid plan includes more daily:"}</p>
        <ul className="mt-1 flex flex-col gap-0.5 text-sm text-[var(--color-foreground)]">
          <li className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden /> Ask AI explanations
          </li>
          <li className="flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden /> AI Question Variants
          </li>
        </ul>
        <Button asChild size="sm" variant="primary" className="mt-3">
          <Link href={usage.upgrade.href} onClick={onUpgradeClick} data-testid="ai-upgrade-cta">
            <Sparkles className="h-4 w-4" aria-hidden /> {unlimitedCopy ? "Upgrade for Unlimited AI" : "View Plans"}
          </Link>
        </Button>
      </div>
    );
  }

  if (low && usage.upgrade) {
    return (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2"
        data-testid="ai-usage"
        data-state="low"
      >
        <p className="min-w-0 flex-1 text-xs text-[var(--color-foreground)]">
          <span className="inline-flex items-center gap-1 font-semibold text-[var(--color-warning)]">
            <Zap className="h-3.5 w-3.5" aria-hidden /> Only {remaining} AI {remaining === 1 ? "use" : "uses"} remaining today.
          </span>{" "}
          {unlimitedCopy ? "Upgrade for unlimited AI explanations and AI Question Variants." : "Upgrade for more daily AI explanations and AI Question Variants."}
        </p>
        <Link href={usage.upgrade.href} onClick={onUpgradeClick} className="text-xs font-semibold text-[var(--color-primary)] hover:underline" data-testid="ai-upgrade-cta">
          {unlimitedCopy ? "Get Unlimited Access" : "View Plans"}
        </Link>
      </div>
    );
  }

  return (
    <p
      className={cn("flex items-center gap-1 text-xs", remaining <= LOW_LIMIT_THRESHOLD ? "font-medium text-[var(--color-warning)]" : "text-[var(--color-muted-foreground)]")}
      data-testid="ai-usage"
      data-state={remaining === 0 ? "exhausted" : remaining <= LOW_LIMIT_THRESHOLD ? "low" : "ok"}
    >
      {remaining <= LOW_LIMIT_THRESHOLD ? <Zap className="h-3.5 w-3.5" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
      {remaining === 0
        ? "You've used today's AI allowance — it resets at midnight (IST)."
        : remaining <= LOW_LIMIT_THRESHOLD
          ? `Only ${remaining} AI ${remaining === 1 ? "use" : "uses"} remaining today`
          : `${remaining} AI uses remaining today`}
    </p>
  );
}

/**
 * Self-contained Ask AI (actions + usage + panel stacked) — used where there
 * is no answer header row (e.g. Saved Questions). That page lists many
 * questions at once, so the usage notice shows only on the question being
 * used instead of repeating under every card.
 */
export function ExplanationPanel({ questionId }: { questionId: string }) {
  const { actions, usageNotice, panel, isOpen, limitHit } = useAskAi(questionId, "saved_questions");
  return (
    <div className="mt-4 flex flex-col gap-2">
      {actions}
      {isOpen || limitHit ? usageNotice : null}
      {panel}
    </div>
  );
}
