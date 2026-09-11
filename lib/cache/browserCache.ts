/**
 * Browser Cache Reset — clears only browser-side resources this website itself owns and is
 * technically permitted to control. There is no web API that lets a page purge the browser's
 * general HTTP disk cache for arbitrary origins (or even fully for its own origin) — that is
 * deliberately not exposed to page script for any website. What a page *can* do, and what this
 * does:
 *
 *  - Unregister its own Service Worker registrations, if any exist.
 *  - Delete its own Cache Storage (`caches`) entries, if any exist — Cache Storage is already
 *    same-origin isolated by the browser, so this can never reach another site's data.
 *  - Remove localStorage/sessionStorage keys that belong to this app's *cache* system,
 *    identified by the `LOCAL_STORAGE_CACHE_PREFIX` below — never arbitrary keys. Notably this
 *    does NOT touch the `mts-mode` key next-themes uses for the Day/Night/Eye Saver preference
 *    (see components/layout/ModeProvider.tsx): that is a user preference, not cache data, and
 *    the prefix does not match it.
 *
 * This app currently has no Service Worker, no Cache Storage entries, and no localStorage/
 * sessionStorage cache keys — so today this mostly runs as a safe, real no-op that still reloads
 * the page. It is written to genuinely act on any of those mechanisms the moment the app starts
 * using them, rather than faking activity now.
 */

export const LOCAL_STORAGE_CACHE_PREFIX = "mts:cache:";

export type BrowserCacheClearResult = {
  unregisteredServiceWorkers: number;
  clearedCacheStorageEntries: number;
  clearedStorageKeys: number;
};

export async function clearBrowserOwnedCache(): Promise<BrowserCacheClearResult> {
  let unregisteredServiceWorkers = 0;
  let clearedCacheStorageEntries = 0;
  let clearedStorageKeys = 0;

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      if (await registration.unregister()) unregisteredServiceWorkers += 1;
    }
  }

  if (typeof window !== "undefined" && "caches" in window) {
    const keys = await caches.keys();
    for (const key of keys) {
      if (await caches.delete(key)) clearedCacheStorageEntries += 1;
    }
  }

  if (typeof window !== "undefined") {
    for (const store of [window.localStorage, window.sessionStorage]) {
      const staleKeys = Object.keys(store).filter((key) => key.startsWith(LOCAL_STORAGE_CACHE_PREFIX));
      for (const key of staleKeys) {
        store.removeItem(key);
        clearedStorageKeys += 1;
      }
    }
  }

  return { unregisteredServiceWorkers, clearedCacheStorageEntries, clearedStorageKeys };
}
