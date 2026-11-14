"use client";

import { cn } from "@/lib/utils";

/**
 * The numbered question grid shared by the Test Player and the post-submission Review page. Presentation only:
 * each caller decides the colour of every cell and what a click does (the player navigates its own state; the
 * Review page only changes which question is shown — it never saves, times or edits anything).
 */
export interface PaletteCell {
  key: string;
  className: string;
  ariaLabel: string;
}

export function QuestionPalette({
  cells,
  onSelect,
  current,
  className,
  testId = "palette",
}: {
  cells: PaletteCell[];
  onSelect: (index: number) => void;
  /** Highlighted cell (aria-current). The player already styles its current cell through `className`. */
  current?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("grid grid-cols-6 gap-2 sm:grid-cols-5 lg:grid-cols-6", className)} data-testid={testId}>
      {cells.map((c, i) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onSelect(i)}
          aria-label={c.ariaLabel}
          aria-current={current === i ? "true" : undefined}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] text-xs font-semibold transition-colors",
            c.className
          )}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}
