"use client";

import { useCallback, useRef, useState } from "react";

export type CacheActionStatus = "idle" | "loading" | "success" | "error";

/**
 * Shared loading/success/error state machine for a single cache operation. Both the Admin
 * Cache Management page and the public Footer widget use this same hook (via the op wrappers in
 * components/cache/operations.ts) instead of each rolling their own — there is exactly one
 * implementation of "run this, show Loading…, then show the result" in the whole app.
 */
export function useCacheAction(
  run: () => Promise<{ ok: boolean; error?: string }>,
  successMessage: string,
  genericErrorMessage: string,
) {
  const [status, setStatus] = useState<CacheActionStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const execute = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus("loading");
    setMessage(null);
    try {
      const result = await run();
      if (result.ok) {
        setStatus("success");
        setMessage(successMessage);
      } else {
        setStatus("error");
        setMessage(result.error ?? genericErrorMessage);
      }
    } catch {
      setStatus("error");
      setMessage(genericErrorMessage);
    } finally {
      inFlight.current = false;
    }
  }, [run, successMessage, genericErrorMessage]);

  return { status, message, execute, isLoading: status === "loading" };
}
