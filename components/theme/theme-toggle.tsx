"use client";

import { useSyncExternalStore } from "react";
import { Sun, Moon, Eye } from "lucide-react";
import { THEME_COOKIE, isTheme, nextTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const ICONS: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  eyesaver: Eye,
};

const LABELS: Record<Theme, string> = {
  light: "Day Mode",
  dark: "Night Mode",
  eyesaver: "Eye Saver Mode",
};

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notify() {
  for (const listener of listeners) listener();
}

function readThemeFromDom(): Theme {
  const attr = document.documentElement.dataset.theme;
  return isTheme(attr) ? attr : "dark";
}

function getServerSnapshot(): Theme {
  return "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; SameSite=Lax`;
  try {
    window.localStorage.setItem(THEME_COOKIE, theme);
  } catch {
    // localStorage unavailable (private mode, etc.) — cookie still works
  }
  notify();
}

/** One compact button: each click cycles Day → Night → Eye Saver → Day. No menu. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, readThemeFromDom, getServerSnapshot);
  const Icon = ICONS[theme];
  const next = nextTheme(theme);

  return (
    <button
      type="button"
      onClick={() => applyTheme(nextTheme(readThemeFromDom()))}
      aria-label={`${LABELS[theme]}. Switch to ${LABELS[next]}.`}
      title={`${LABELS[theme]} — click for ${LABELS[next]}`}
      data-theme-current={theme}
      suppressHydrationWarning
      className={cn(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-card)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]",
        className
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}
