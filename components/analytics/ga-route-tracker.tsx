"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

type Gtag = (command: "event", name: string, params: Record<string, string>) => void;

/** Sends a GA4 page_view for each client-side route change (not the first load). */
export function GaRouteTracker() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const url = search ? `${pathname}?${search}` : pathname;
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    // The first render is the initial page_view, already sent by gtag('config').
    if (lastUrl.current === null || lastUrl.current === url) {
      lastUrl.current = url;
      return;
    }
    lastUrl.current = url;
    const gtag = (window as unknown as { gtag?: Gtag }).gtag;
    gtag?.("event", "page_view", { page_location: window.location.href, page_title: document.title });
  }, [url]);

  return null;
}
