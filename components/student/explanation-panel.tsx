"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getExplanationAction } from "@/app/student/ai-actions";

const AUTO_RETRY_DELAYS_MS = [2500, 4000]; // a couple of gentle retries while someone else's generation finishes

type ExplanationResult = Awaited<ReturnType<typeof getExplanationAction>>;
type SuccessResult = Extract<ExplanationResult, { ok: true }>;

export function ExplanationPanel({ questionId }: { questionId: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<SuccessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waitingOnOther, setWaitingOnOther] = useState(false);
  const attemptRef = useRef(0);

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

  if (result) {
    const { content, remainingToday, relatedQuestions, isStale } = result;
    const optionEntries = Object.entries(content.optionAnalysis ?? {});
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

          {relatedQuestions && relatedQuestions.length > 0 ? (
            <div>
              <p className="font-medium">Related practice questions</p>
              <ul className="mt-1 list-decimal pl-5">
                {relatedQuestions.map((q) => (
                  <li key={q.id}>{q.text}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
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
