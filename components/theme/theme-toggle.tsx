"use client";

import { useSyncExternalStore } from "react";
import { Sun, Moon, Eye, Check } from "lucide-react";
import { THEME_COOKIE, THEMES, isTheme, type Theme } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

const DESCRIPTIONS: Record<Theme, string> = {
  light: "Standard light theme",
  dark: "Neutral black, for low light",
  eyesaver: "Black & white reading mode",
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

/** Explicit Day / Night / Eye Saver picker (same menu pattern as TextSizeControl). */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, readThemeFromDom, getServerSnapshot);
  const Icon = ICONS[theme];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Appearance: ${LABELS[theme]}. Click to change.`}
          title={LABELS[theme]}
          suppressHydrationWarning
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-card)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]",
            className
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEMES.map((t) => {
          const ItemIcon = ICONS[t];
          return (
            <DropdownMenuItem key={t} onSelect={() => applyTheme(t)}>
              <ItemIcon className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
              <span className="flex flex-1 flex-col">
                <span className={cn(theme === t && "font-semibold")}>{LABELS[t]}</span>
                <span className="text-xs text-[var(--color-muted-foreground)]">{DESCRIPTIONS[t]}</span>
              </span>
              {theme === t ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
