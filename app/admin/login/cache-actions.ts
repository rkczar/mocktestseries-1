"use server";

import { revalidatePath } from "next/cache";

// Callable pre-login, so repeated calls must not be able to keep the whole
// site re-rendering: at most one real bust per worker every 30 seconds.
const MIN_INTERVAL_MS = 30_000;
let lastClearedAt = 0;

/** Busts Next.js's server-side route/data cache. Safe to call pre-login — no data is read or written. */
export async function clearServerCacheAction() {
  const now = Date.now();
  if (now - lastClearedAt >= MIN_INTERVAL_MS) {
    lastClearedAt = now;
    revalidatePath("/", "layout");
  }
  return { clearedAt: new Date(lastClearedAt).toISOString() };
}
