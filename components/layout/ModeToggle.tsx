"use client";

import { Contrast, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import { PUBLIC_MODES, type PublicMode } from "./ModeProvider";

const MODE_META: Record<PublicMode, { label: string; icon: typeof Sun }> = {
  day: { label: "Day mode", icon: Sun },
  night: { label: "Night mode", icon: Moon },
  eyesaver: { label: "Eye Saver mode", icon: Contrast },
};

const noopSubscribe = () => () => {};

// next-themes can't know the persisted mode until it reads localStorage on the client, so
// `theme` is undefined during the server render — useSyncExternalStore reports "not yet mounted"
// for that first render (both server and the client's hydration pass) and flips to true right
// after, so the Day icon shown initially never mismatches between server and client markup.
function useHasMounted() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function ModeToggle({ className }: { className?: string }) {
  const mounted = useHasMounted();
  const { theme, setTheme } = useTheme();

  const current: PublicMode = mounted && PUBLIC_MODES.includes(theme as PublicMode) ? (theme as PublicMode) : "day";
  const currentIndex = PUBLIC_MODES.indexOf(current);
  const next = PUBLIC_MODES[(currentIndex + 1) % PUBLIC_MODES.length];
  const Icon = MODE_META[current].icon;

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Appearance: ${MODE_META[current].label}. Activate to switch to ${MODE_META[next].label}.`}
      title={MODE_META[current].label}
      className={cn(
        "flex size-10 flex-none items-center justify-center rounded-[9px] border border-border-strong text-text-muted transition-colors duration-150 hover:bg-accent hover:text-primary",
        className,
      )}
    >
      <Icon className="size-[18px]" strokeWidth={2} />
    </button>
  );
}
