"use client";

import { useState } from "react";
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
        <QuestionCountInput name={inputName} count={count} onChange={onChange} max={max} className="w-20" />
      </div>
    </div>
  );
}

/**
 * Free-typed question count. Keeps the raw text as a draft so the field can
 * be cleared and retyped (e.g. 15 → "" → 7) — the previous controlled
 * `Math.max(1, Number(value))` snapped an empty field straight back to 1, so
 * typing "7" produced "17". Only whole numbers in [1, max] are emitted; the
 * draft re-syncs to `count` on blur or when `count` changes from outside
 * (a preset click).
 */
export function QuestionCountInput({
  count,
  onChange,
  max = 200,
  id,
  name,
  className,
}: {
  count: number;
  onChange: (n: number) => void;
  max?: number;
  id?: string;
  name?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(count));
  const [syncedCount, setSyncedCount] = useState(count);
  if (count !== syncedCount) {
    // Adjust state during render when the prop changes (preset click) — React's
    // recommended alternative to a syncing effect.
    setSyncedCount(count);
    if (Number(draft) !== count) setDraft(String(count));
  }

  return (
    <Input
      id={id}
      name={name}
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      step={1}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = Number(raw);
        if (raw !== "" && Number.isInteger(n) && n >= 1 && n <= max) onChange(n);
      }}
      onBlur={() => setDraft(String(count))}
      className={className}
    />
  );
}
