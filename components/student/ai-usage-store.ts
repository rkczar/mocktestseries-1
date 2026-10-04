"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getAiUsageStatusAction } from "@/app/student/ai-actions";

/**
 * Client mirror of the server's daily AI usage (display only — the server
 * re-checks every Ask AI request; nothing here can grant access). One
 * status read per page load, shared by every Ask AI surface on the page,
 * then kept current from the `remainingToday` each Ask AI response already
 * carries, so opening/closing panels or paging questions never re-polls.
 */
export type AiUsage = Extract<Awaited<ReturnType<typeof getAiUsageStatusAction>>, { ok: true }>;

const STALE_MS = 5 * 60_000;

let usage: AiUsage | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ensureLoaded() {
  if (inflight || (usage && Date.now() - loadedAt < STALE_MS)) return;
  inflight = getAiUsageStatusAction()
    .then((next) => {
      usage = next;
      loadedAt = Date.now();
      emit();
    })
    .catch(() => {
      // Label just stays hidden; Ask AI itself is unaffected.
    })
    .finally(() => {
      inflight = null;
    });
}

/** Server-reported remaining credits after an Ask AI response (Infinity = unlimited). */
export function applyAiRemaining(remainingToday: number) {
  if (!usage) return;
  const next = Number.isFinite(remainingToday) ? Math.max(0, remainingToday) : null;
  if (next === usage.remainingToday) return;
  usage = { ...usage, remainingToday: next };
  emit();
}

/** The server refused an Ask AI request for the daily limit. */
export function markAiLimitReached() {
  if (!usage || usage.remainingToday === 0) return;
  usage = { ...usage, remainingToday: 0 };
  emit();
}

export function getAiUsageSnapshot() {
  return usage;
}

export function useAiUsage(): AiUsage | null {
  const value = useSyncExternalStore(subscribe, getAiUsageSnapshot, () => null);
  useEffect(ensureLoaded, []);
  return value;
}
