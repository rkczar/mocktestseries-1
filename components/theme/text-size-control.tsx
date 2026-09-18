"use client";

import { useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import {
  TEXT_SIZE_COOKIE,
  TEXT_SIZES,
  TEXT_SIZE_LABELS,
  TEXT_SIZE_SHORT,
  isTextSize,
  type TextSize,
} from "@/lib/text-size";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notify() {
  for (const listener of listeners) listener();
}

function readTextSizeFromDom(): TextSize {
  const attr = document.documentElement.dataset.textSize;
  return isTextSize(attr) ? attr : "md";
}

function getServerSnapshot(): TextSize {
  return "md";
}

/**
 * Purely a visual/typography preference — never touches TestAttempt state,
 * the timer, or autosave. It only flips a `data-text-size` attribute (which
 * CSS reads via --text-scale) plus persists the choice, independent of the
 * [data-theme] attribute set by ThemeToggle.
 */
function applyTextSize(size: TextSize) {
  document.documentElement.dataset.textSize = size;
  document.cookie = `${TEXT_SIZE_COOKIE}=${size}; path=/; max-age=31536000; SameSite=Lax`;
  try {
    window.localStorage.setItem(TEXT_SIZE_COOKIE, size);
  } catch {
    // localStorage unavailable (private mode, etc.) — cookie still works
  }
  notify();
}

export function TextSizeControl({ className }: { className?: string }) {
  const size = useSyncExternalStore(subscribe, readTextSizeFromDom, getServerSnapshot);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Text size: ${TEXT_SIZE_LABELS[size]}. Click to change.`}
          title={`Text size: ${TEXT_SIZE_LABELS[size]}`}
          suppressHydrationWarning
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-card)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]",
            className
          )}
        >
          <span aria-hidden suppressHydrationWarning>
            {TEXT_SIZE_SHORT[size]}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Text Size</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TEXT_SIZES.map((s) => (
          <DropdownMenuItem key={s} onSelect={() => applyTextSize(s)}>
            <span className="w-8 shrink-0 font-mono text-xs text-[var(--color-muted-foreground)]">{TEXT_SIZE_SHORT[s]}</span>
            <span className="flex-1">{TEXT_SIZE_LABELS[s]}</span>
            {size === s ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
