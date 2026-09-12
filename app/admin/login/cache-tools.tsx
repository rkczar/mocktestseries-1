"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { clearServerCacheAction } from "./cache-actions";

async function clearBrowserCaches() {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // best-effort — some browsers/contexts don't expose the Cache Storage API
  }
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch {
    // best-effort
  }
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // best-effort — storage can be blocked (private browsing, disabled cookies)
  }
}

type ActiveAction = "refresh" | "clear" | null;

export function CacheTools() {
  const [isPending, startTransition] = useTransition();
  const [active, setActive] = useState<ActiveAction>(null);
  const [cleared, setCleared] = useState(false);

  function hardRefresh() {
    setActive("refresh");
    setCleared(false);
    startTransition(async () => {
      await clearBrowserCaches();
      window.location.reload();
    });
  }

  function clearCache() {
    setActive("clear");
    setCleared(false);
    startTransition(async () => {
      await Promise.all([clearBrowserCaches(), clearServerCacheAction()]);
      setCleared(true);
      window.location.reload();
    });
  }

  return (
    <div className="flex items-center justify-center gap-4 text-xs text-[var(--color-muted-foreground)]">
      <button
        type="button"
        onClick={hardRefresh}
        disabled={isPending}
        className="inline-flex items-center gap-1 transition-colors hover:text-[var(--color-foreground)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending && active === "refresh" ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : (
          <RefreshCw className="h-3 w-3" aria-hidden />
        )}
        Hard refresh
      </button>
      <span aria-hidden className="text-[var(--color-border)]">
        ·
      </span>
      <button
        type="button"
        onClick={clearCache}
        disabled={isPending}
        className="inline-flex items-center gap-1 transition-colors hover:text-[var(--color-foreground)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending && active === "clear" ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : cleared ? (
          <Check className="h-3 w-3" aria-hidden />
        ) : (
          <Trash2 className="h-3 w-3" aria-hidden />
        )}
        {cleared ? "Cleared" : "Clear cache (browser + server)"}
      </button>
    </div>
  );
}
