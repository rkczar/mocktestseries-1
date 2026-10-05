import type { ExplanationView } from "@/lib/rich-content-types";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia } from "@/components/content/question-media";
import { cn } from "@/lib/utils";

/**
 * The human-authored explanation (Question.explanation + EXPLANATION images).
 * Separate from Ask AI. Callers render it only after an authorized reveal or
 * review — the data is never sent to the browser before that.
 */
export function HumanExplanation({ explanation, className }: { explanation: ExplanationView; className?: string }) {
  return (
    <section
      data-testid="human-explanation"
      className={cn("flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4", className)}
    >
      <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Explanation</h3>
      {explanation.body ? (
        <div className="min-w-0 whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-foreground)]">
          <RichText content={explanation.body} />
        </div>
      ) : null}
      <QuestionMedia assets={explanation.assets} />
    </section>
  );
}
