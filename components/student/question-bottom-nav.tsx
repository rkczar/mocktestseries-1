"use client";

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one Previous / Next bar of the question screens: the running Test
 * Player and the post-submission Review. Presentation only — each caller
 * passes its own handlers, so answer saving, reveal and submission stay
 * exactly where they are.
 *
 * Sticky (not fixed): it keeps its place in the flow after the content it
 * pages through, so it pins to the viewport bottom while that content scrolls
 * under it, yet the last line can always scroll clear above it (nothing is
 * covered), and it stops before a page footer. Safe-area padding keeps it
 * above the phone's home indicator / PWA chrome; buttons are 44px tall.
 */
export function QuestionBottomNav({
  testId,
  positionTestId,
  index,
  total,
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
  previousAriaLabel,
  nextAriaLabel,
  next,
  className,
}: {
  testId: string;
  positionTestId: string;
  /** 0-based position of the question on screen. */
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  previousDisabled: boolean;
  nextDisabled: boolean;
  previousAriaLabel?: string;
  nextAriaLabel?: string;
  /** The right button's content (e.g. "Save & Next →", or "Submit Test" on the last question). */
  next?: ReactNode;
  className?: string;
}) {
  return (
    <nav
      aria-label="Question navigation"
      data-testid={testId}
      className={cn("sticky bottom-0 z-30 -mx-1 px-1 pt-1 print:static", className)}
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex w-full items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)]/85 p-2 shadow-[var(--shadow-card)] backdrop-blur supports-[backdrop-filter]:bg-[var(--color-card)]/75 sm:max-w-md">
        <Button type="button" variant="outline" onClick={onPrevious} disabled={previousDisabled} aria-label={previousAriaLabel} className="h-11 flex-1 sm:flex-none">
          <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
        </Button>
        <span className="shrink-0 text-sm font-medium tabular-nums text-[var(--color-muted-foreground)]" aria-live="polite" data-testid={positionTestId}>
          <span className="sr-only">Question </span>
          {index + 1} / {total}
        </span>
        <Button type="button" variant="primary" onClick={onNext} disabled={nextDisabled} aria-label={nextAriaLabel} className="h-11 flex-1 sm:flex-none">
          {next ?? (
            <>
              Next <ChevronRight className="h-4 w-4" aria-hidden />
            </>
          )}
        </Button>
      </div>
    </nav>
  );
}
