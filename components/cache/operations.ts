"use client";

import { clearCacheAction, hardCacheResetAction } from "@/lib/cache/actions";
import { clearBrowserOwnedCache } from "@/lib/cache/browserCache";

/**
 * The three canonical cache operations. Both the Admin Cache Management page and the public
 * Footer widget import these exact functions — there is no second implementation anywhere else.
 */

export async function runClearCache() {
  return clearCacheAction();
}

export async function runHardCacheReset() {
  const serverResult = await hardCacheResetAction();
  if (!serverResult.ok) return serverResult;
  // The confirmation copy promises this reloads the latest version, so it also sweeps any
  // browser-owned resources (Service Worker / Cache Storage / this app's own cache-prefixed
  // storage keys) exactly like Browser Cache Reset does, before the caller reloads the page.
  await clearBrowserOwnedCache();
  return { ok: true as const };
}

export async function runBrowserCacheReset() {
  await clearBrowserOwnedCache();
  return { ok: true as const };
}
