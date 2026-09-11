"use client";

import { Database, Eraser, RefreshCcw } from "lucide-react";

import { CacheOperationButton } from "./CacheOperationButton";
import { runBrowserCacheReset, runClearCache, runHardCacheReset } from "./operations";

export function AdminCacheManagementPanel() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <CacheOperationButton
        icon={Eraser}
        label="Clear Cache"
        description="Invalidates the application's server-side cache (appearance settings and homepage content) so the next visit reflects the latest saved data."
        run={runClearCache}
        successMessage="Cache cleared successfully."
        errorMessage="Cache clear failed. Please try again."
      />
      <CacheOperationButton
        icon={RefreshCcw}
        label="Hard Cache Reset"
        description="A stronger reset for development/deployment: invalidates the same server-side cache plus the cached HTML for every public page, then reloads this browser."
        run={runHardCacheReset}
        successMessage="Hard cache reset completed successfully."
        errorMessage="Hard cache reset failed. Please try again."
        confirmText="Hard Cache Reset can invalidate cached application resources and reload the latest version. Continue?"
        reloadOnSuccess
      />
      <CacheOperationButton
        icon={Database}
        label="Browser Cache Reset"
        description="Browser Cache Reset clears this website's cached browser resources."
        run={runBrowserCacheReset}
        successMessage="Browser cache reset completed."
        errorMessage="Browser cache reset failed. Please try again."
        reloadOnSuccess
      />
    </div>
  );
}
