"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the server-rendered page every few seconds while an import is running. */
export function JobsAutoRefresh({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [everyMs, router]);
  return null;
}
