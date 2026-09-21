"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DEFAULT_PRESETS = [10, 20, 30, 50];

/**
 * Quick question-count picker shared by Test on the Go and the Custom
 * Module builder (Sections 4 and 10) — preset buttons plus a custom number
 * input, all driving the same controlled `count`.
 */
export function QuestionCountPresets({
  count,
  onChange,
  presets = DEFAULT_PRESETS,
  max = 200,
  inputName,
}: {
  count: number;
  onChange: (n: number) => void;
  presets?: number[];
  max?: number;
  inputName?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
            count === p
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
              : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface)]"
          )}
        >
          {p}
        </button>
      ))}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-[var(--color-muted-foreground)]">Custom</span>
        <Input
          type="number"
          name={inputName}
          min={1}
          max={max}
          value={count}
          onChange={(e) => onChange(Math.max(1, Math.min(max, Number(e.target.value))))}
          className="w-20"
        />
      </div>
    </div>
  );
}
