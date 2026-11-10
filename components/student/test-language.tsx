"use client";

import { useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/**
 * Question language of a BILINGUAL exam (Exam.languageMode). Presentation only: switching never touches the selected
 * answer, timer, navigation, marked-for-review state or the attempt — those are keyed by question id and option label,
 * which both languages share. The choice is a per-device convenience (localStorage); when storage is blocked it lives in
 * memory for the page. Exams that are not bilingual never render any of this.
 */
export type TestLanguage = "en" | "hi";

const KEY = "mts-test-language";
const EVENT = "mts-test-language";

function readStored(): TestLanguage | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "en" || v === "hi" ? v : null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

export function useTestLanguage(enabled: boolean): { lang: TestLanguage; chosen: boolean; choose: (l: TestLanguage) => void } {
  const stored = useSyncExternalStore(subscribe, readStored, () => null);
  const [memory, setMemory] = useState<TestLanguage | null>(null);
  const current = memory ?? stored;
  const choose = (l: TestLanguage) => {
    setMemory(l);
    try {
      window.localStorage.setItem(KEY, l);
      window.dispatchEvent(new Event(EVENT));
    } catch {
      // Storage blocked: the in-memory choice still applies to this page.
    }
  };
  return { lang: enabled ? (current ?? "en") : "en", chosen: !enabled || current !== null, choose };
}

/** Instant English / हिंदी switch (header of the player, review and result). */
export function LanguageSwitch({ lang, onChange, className }: { lang: TestLanguage; onChange: (l: TestLanguage) => void; className?: string }) {
  const btn = (l: TestLanguage, label: string) => (
    <button
      type="button"
      lang={l}
      aria-pressed={lang === l}
      data-testid={`lang-${l}`}
      onClick={() => onChange(l)}
      className={cn(
        "rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors",
        lang === l ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-foreground)] hover:bg-[var(--color-border)]"
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Question language" className={cn("flex items-center gap-0.5 rounded-full border border-[var(--color-border)] p-0.5", className)} data-testid="language-switch">
      {btn("en", "English")}
      {btn("hi", "हिंदी")}
    </div>
  );
}

/** "Select Your Preferred Language" — two large choices (pre-test setup, or the player's first screen). */
export function LanguageChoice({ lang, chosen, onChoose }: { lang: TestLanguage; chosen: boolean; onChoose: (l: TestLanguage) => void }) {
  const option = (l: TestLanguage, label: string) => (
    <button
      type="button"
      lang={l}
      aria-pressed={chosen && lang === l}
      data-testid={`choose-lang-${l}`}
      onClick={() => onChoose(l)}
      className={cn(
        "flex-1 rounded-[var(--radius-card)] border px-4 py-3 text-base font-semibold",
        chosen && lang === l ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-foreground)] hover:border-[var(--color-primary)]"
      )}
    >
      {label}
    </button>
  );
  return (
    <fieldset className="flex flex-col gap-2" data-testid="language-choice">
      <legend className="mb-2 text-sm font-semibold text-[var(--color-foreground)]">Select Your Preferred Language</legend>
      <div className="flex gap-3">
        {option("en", "English")}
        {option("hi", "हिंदी")}
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">You can switch between English and हिंदी at any time during the test. Your answers stay the same.</p>
    </fieldset>
  );
}
