"use client";

import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RichText } from "@/components/student/explanation-content";
import type { VariantView } from "@/lib/ai-variant";

/**
 * Inline "AI Question Variants" list rendered inside the Ask AI panel,
 * directly under the source question. Each variant is a light "try it"
 * block: tap an option (or "Show answer") to reveal the correct answer and
 * explanation — no separate test engine, no navigation away.
 */

/** "RUHS MO 2024 W01 AI03" → "AI03"; falls back to the full code. */
function shortCode(code: string): string {
  return code.match(/AI\d{2}$/)?.[0] ?? code;
}

function VariantItem({ variant }: { variant: VariantView }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const correct = variant.options.find((o) => o.isCorrect);
  const show = revealed || picked !== null;

  return (
    <li className="border-t border-[var(--color-border)] pt-4 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="rounded bg-[var(--color-info)]/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--color-info)]" title={variant.code}>
          {shortCode(variant.code)}
        </span>
      </div>
      <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--color-foreground)]">{variant.text}</p>

      <div className="mt-2 flex flex-col gap-1.5">
        {variant.options.map((o) => {
          const isPicked = picked === o.label;
          return (
            <button
              key={o.label}
              type="button"
              disabled={show}
              onClick={() => setPicked(o.label)}
              className={cn(
                "flex w-full items-start gap-2 rounded-[var(--radius-button)] border px-3 py-2 text-left text-sm transition-colors",
                !show && "border-[var(--color-border)] hover:border-[var(--color-info)]/60",
                show && o.isCorrect && "border-[var(--color-success)] bg-[var(--color-success)]/10",
                show && isPicked && !o.isCorrect && "border-[var(--color-error)] bg-[var(--color-error)]/10",
                show && !o.isCorrect && !isPicked && "border-[var(--color-border)] opacity-80"
              )}
            >
              <span className="font-semibold">{o.label}.</span>
              <span className="min-w-0 flex-1 break-words">{o.text}</span>
            </button>
          );
        })}
      </div>

      {show ? (
        <div className="mt-2.5 space-y-1.5 text-sm">
          <p className="font-medium text-[var(--color-success)]">
            Correct Answer: {correct ? `${correct.label}. ${correct.text}` : "—"}
            {picked ? <span className="ml-2 font-normal text-[var(--color-muted-foreground)]">{picked === correct?.label ? "(you got it)" : `(you chose ${picked})`}</span> : null}
          </p>
          {variant.explanation ? (
            <p className="leading-relaxed text-[var(--color-foreground)]">
              <span className="font-semibold">Explanation: </span>
              <RichText text={variant.explanation} />
            </p>
          ) : null}
          {Object.keys(variant.optionAnalysis).length > 0 ? (
            <ul className="space-y-0.5 text-xs text-[var(--color-muted-foreground)]">
              {Object.entries(variant.optionAnalysis)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([label, reason]) => (
                  <li key={label}>
                    <span className="font-semibold">{label}:</span> {reason}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <button type="button" onClick={() => setRevealed(true)} className="mt-2 text-xs font-medium text-[var(--color-info)] hover:underline">
          Show answer &amp; explanation
        </button>
      )}
    </li>
  );
}

export function QuestionVariantsView({
  state,
  onRetry,
}: {
  state:
    | { kind: "loading" }
    | { kind: "error"; message: string; canRetry: boolean }
    | { kind: "ready"; variants: VariantView[]; requested: number };
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-[var(--color-muted-foreground)]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Generating unique practice questions…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3 py-1">
        <p className="text-sm text-[var(--color-error)]">{state.message}</p>
        {state.canRetry ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
          </Button>
        ) : null}
      </div>
    );
  }

  const { variants, requested } = state;
  if (variants.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-1">
        <p className="text-sm text-[var(--color-muted-foreground)]">No sufficiently different practice questions could be generated this time.</p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
        {variants.length} unique practice question{variants.length === 1 ? "" : "s"}
        {variants.length < requested ? ` (${requested} requested — only genuinely different questions are kept)` : ""} · same concept, new
        scenario. Tap an option to try it.
      </p>
      <ol className="flex flex-col gap-4">
        {variants.map((v) => (
          <VariantItem key={v.id} variant={v} />
        ))}
      </ol>
    </div>
  );
}
