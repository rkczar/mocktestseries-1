"use client";

import { useCallback, useRef, useState } from "react";

export type DiagramActionState = "idle" | "loading" | "success" | "error";

/** Same idle/loading/success/error state machine as components/cache/useCacheAction.ts, reused
 * here for every diagram mutation (refresh, node metadata edits, planned pages). */
export function useDiagramAction<T>(run: () => Promise<{ ok: boolean; data?: T; error?: string }>) {
  const [state, setState] = useState<DiagramActionState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const execute = useCallback(async (): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setState("loading");
    setMessage(null);
    try {
      const result = await run();
      if (result.ok) {
        setState("success");
        return result.data;
      }
      setState("error");
      setMessage(result.error ?? "That didn't work. Please try again.");
      return undefined;
    } catch {
      setState("error");
      setMessage("That didn't work. Please try again.");
      return undefined;
    } finally {
      inFlight.current = false;
    }
  }, [run]);

  return { state, message, execute, isLoading: state === "loading" };
}
