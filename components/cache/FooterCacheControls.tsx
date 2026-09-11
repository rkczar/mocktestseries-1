"use client";

import { Database, Eraser, RefreshCcw, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { checkAdminCacheAccessAction } from "@/lib/cache/actions";

import { CacheOperationButton } from "./CacheOperationButton";
import { runBrowserCacheReset, runClearCache, runHardCacheReset } from "./operations";

/**
 * Compact Cache Management widget for the public Footer — primarily a development-phase
 * control. It calls the exact same three operations (components/cache/operations.ts) as the
 * Admin Cache Management page; there is no separate Footer cache logic.
 *
 * `Clear Cache` and `Hard Cache Reset` invalidate server-side application cache, so they only
 * render for a viewer who holds a valid Admin session. That check runs client-side, after
 * mount, via `checkAdminCacheAccessAction` — not a security boundary itself (the two actions'
 * own `requireAdminRole()` checks are), just what decides whether to show the buttons at all.
 * `Browser Cache Reset` only touches this browser's own storage, so it's shown to any visitor
 * immediately, with no check needed.
 */
export function FooterCacheControls() {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    checkAdminCacheAccessAction().then((result) => {
      if (!cancelled) setIsAdmin(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-wrap items-start gap-x-5 gap-y-3 rounded-[10px] border border-border-subtle bg-background px-3.5 py-3">
      <span className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-[.06em] text-text-placeholder uppercase">
        <Wrench className="size-3.5" strokeWidth={2} />
        Cache
      </span>

      {isAdmin ? (
        <CacheOperationButton
          compact
          icon={Eraser}
          label="Clear Cache"
          run={runClearCache}
          successMessage="Cache cleared successfully."
          errorMessage="Cache clear failed. Please try again."
        />
      ) : null}

      {isAdmin ? (
        <CacheOperationButton
          compact
          icon={RefreshCcw}
          label="Hard Cache Reset"
          run={runHardCacheReset}
          successMessage="Hard cache reset completed successfully."
          errorMessage="Hard cache reset failed. Please try again."
          confirmText="Hard Cache Reset can invalidate cached application resources and reload the latest version. Continue?"
          reloadOnSuccess
        />
      ) : null}

      <CacheOperationButton
        compact
        icon={Database}
        label="Browser Cache Reset"
        run={runBrowserCacheReset}
        successMessage="Browser cache reset completed."
        errorMessage="Browser cache reset failed. Please try again."
        reloadOnSuccess
      />
    </div>
  );
}
