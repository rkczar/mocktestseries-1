"use server";

import { revalidatePath, updateTag } from "next/cache";

import { adminAuth } from "@/lib/auth/admin";
import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";

/**
 * Read-only check for whether the CURRENT browser session (i.e. the caller's own cookies) is
 * admin-authenticated — used only to decide whether the Footer's privileged cache buttons
 * render. It is intentionally called from a Client Component (FooterCacheControls) rather than
 * from PublicShell during the server render: PublicShell wraps every public page, most of which
 * are statically prerendered, and reading cookies() there would force them all dynamic. This is
 * not itself a security boundary — clearCacheAction/hardCacheResetAction independently re-check
 * requireAdminRole() no matter what this returned.
 */
export async function checkAdminCacheAccessAction(): Promise<boolean> {
  try {
    const session = await adminAuth();
    return Boolean(session?.user);
  } catch {
    return false;
  }
}

/**
 * The only two Next.js Data Cache tags this application actually uses — see
 * lib/appearance.ts (`getAppearance`, tag "appearance") and
 * lib/content/getHomepageContent.ts (`getHomepageContent`, tag "homepage"). Every admin CRUD
 * action (exams, test-series, questions, pricing, announcements, upcoming-exams, homepage,
 * appearance) already calls `updateTag("homepage")`/`updateTag("appearance")` itself after a
 * save — this list exists so the manual "Clear Cache" control below invalidates exactly the
 * same tags rather than inventing a parallel/divergent cache layer.
 */
const APPLICATION_CACHE_TAGS = ["appearance", "homepage"] as const;

export type CacheActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "Cache clear failed. Please try again.";
const GENERIC_HARD_RESET_ERROR = "Hard cache reset failed. Please try again.";

function invalidateApplicationCacheTags() {
  for (const tag of APPLICATION_CACHE_TAGS) updateTag(tag);
}

/**
 * Clear Cache — normal, targeted invalidation of the application's Next.js Data Cache. Admin
 * only; every other caller (anonymous, student, or a direct request replaying this action
 * without a valid admin session) is rejected by `requireAdminRole()` before anything runs.
 */
export async function clearCacheAction(): Promise<CacheActionResult> {
  try {
    const session = await requireAdminRole();
    invalidateApplicationCacheTags();
    await writeAuditLog({ adminId: session.user.id, action: "clear_cache", entity: "Cache" });
    return { ok: true };
  } catch {
    // Never surface the underlying error (auth failure, DB error, etc.) to the client.
    return { ok: false, error: GENERIC_ERROR };
  }
}

/**
 * Hard Cache Reset — a strictly broader invalidation than Clear Cache. In addition to the two
 * known Data Cache tags, it purges the Full Route Cache + Client Router Cache for the entire
 * route tree via `revalidatePath("/", "layout")`, which is what actually covers the
 * statically-generated public pages (home, exams, test-series, pricing, about, contact,
 * privacy, terms, upcoming-exams, and their dynamic [slug] pages) — none of which are wrapped
 * in `unstable_cache`/a cache tag today, so tag invalidation alone would not touch them.
 * Admin only, same authorization gate as Clear Cache.
 */
export async function hardCacheResetAction(): Promise<CacheActionResult> {
  try {
    const session = await requireAdminRole();
    invalidateApplicationCacheTags();
    revalidatePath("/", "layout");
    await writeAuditLog({ adminId: session.user.id, action: "hard_reset", entity: "Cache" });
    return { ok: true };
  } catch {
    return { ok: false, error: GENERIC_HARD_RESET_ERROR };
  }
}
