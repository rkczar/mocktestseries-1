"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ADMIN_NAV_STACK_KEY as STORAGE_KEY, ADMIN_ROOT, backTarget, recordVisit } from "@/lib/admin-back";

function readStack(): string[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeStack(stack: string[]) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stack));
  } catch {
    // Private mode / storage blocked: Back falls back to the logical parent.
  }
}

/**
 * The Admin Panel's own Back button, rendered once in the shared Admin
 * header (never per page). Goes to the previous Admin location from this
 * tab's in-Admin history — which keeps list filters/pagination that live in
 * the URL — else to the page's logical parent. Never navigates outside
 * /admin (no raw history.back()), and is hidden on the Admin root.
 */
export function AdminBackButton() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const current = query ? `${pathname}?${query}` : pathname;

  useEffect(() => {
    writeStack(recordVisit(readStack(), current));
  }, [current]);

  if (pathname === ADMIN_ROOT) return null;

  const handleBack = () => {
    const stack = readStack();
    const { href, fromHistory } = backTarget(stack, current);
    if (fromHistory) {
      // Drop everything above the destination so repeated Back keeps walking back.
      const idx = stack.lastIndexOf(href);
      writeStack(stack.slice(0, idx + 1));
    }
    router.push(href);
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      aria-label="Back to previous Admin page"
      title="Back"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--color-border)] px-2 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-surface)] sm:px-3"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">Back</span>
    </button>
  );
}
