"use client";

import { useEffect, useState } from "react";
import { Sun, Moon, EyeOff } from "lucide-react";
import { THEME_COOKIE, isTheme, nextTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const ICONS: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  eyesaver: EyeOff,
};

const LABELS: Record<Theme, string> = {
  light: "Day mode",
  dark: "Night mode",
  eyesaver: "Eye saver mode",
};

function readThemeFromDom(): Theme {
  const attr = document.documentElement.dataset.theme;
  return isTheme(attr) ? attr : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; SameSite=Lax`;
  try {
    window.localStorage.setItem(THEME_COOKIE, theme);
  } catch {
    // localStorage unavailable (private mode, etc.) — cookie still works
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readThemeFromDom());
    setMounted(true);
  }, []);

  const handleClick = () => {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next);
  };

  const Icon = ICONS[theme];

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Appearance: ${LABELS[theme]}. Click to switch.`}
      title={LABELS[theme]}
      suppressHydrationWarning
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-card)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]",
        className
      )}
    >
      {mounted ? <Icon className="h-4 w-4" aria-hidden /> : <span className="h-4 w-4" />}
    </button>
  );
}
