"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type GaWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void } & Record<string, unknown>;

const isAdminPath = (pathname: string) => pathname === "/admin" || pathname.startsWith("/admin/");

/**
 * Loads gtag.js on the first non-admin route and sends one page_view per
 * route. The `config` call records the first page_view; later client-side
 * navigations are sent here because the App Router keeps its own reference
 * to history.pushState, so GA4's Enhanced Measurement history listener
 * never sees them (verified on production).
 *
 * /admin and /admin/* are never tracked: gtag.js is not loaded when the
 * session starts there, and once loaded GA's documented `ga-disable-<ID>`
 * flag blocks every hit (page_view and Enhanced Measurement) while on admin.
 */
export function GaRouteTracker({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const url = search ? `${pathname}?${search}` : pathname;
  const isAdmin = isAdminPath(pathname);
  const [load, setLoad] = useState(false);
  const configured = useRef(false);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    const w = window as unknown as GaWindow;
    w[`ga-disable-${measurementId}`] = isAdmin;
    if (lastUrl.current === url) return;
    lastUrl.current = url;
    if (isAdmin) return;

    if (!configured.current) {
      configured.current = true;
      w.dataLayer = w.dataLayer || [];
      // gtag.js expects the arguments object itself, not an array.
      w.gtag = function gtag() {
        // eslint-disable-next-line prefer-rest-params
        w.dataLayer!.push(arguments);
      };
      w.gtag("js", new Date());
      w.gtag("config", measurementId);
      setLoad(true);
      return;
    }
    w.gtag?.("event", "page_view", { page_location: window.location.href, page_title: document.title });
  }, [url, isAdmin, measurementId]);

  return load ? <Script src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} strategy="afterInteractive" /> : null;
}
