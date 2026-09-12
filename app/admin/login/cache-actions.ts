"use server";

import { revalidatePath } from "next/cache";

/** Busts Next.js's server-side route/data cache. Safe to call pre-login — no data is read or written. */
export async function clearServerCacheAction() {
  revalidatePath("/", "layout");
  return { clearedAt: new Date().toISOString() };
}
