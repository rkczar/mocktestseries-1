import Script from "next/script";
import { Suspense } from "react";
import { GaRouteTracker } from "./ga-route-tracker";

export const GA_MEASUREMENT_ID = "G-BSBYPQ9QK2";

/**
 * GA4 (gtag.js), mounted once in the root layout so every route gets it.
 * The `config` call records the first page_view. Client-side navigations
 * are sent by GaRouteTracker: the App Router keeps its own reference to
 * history.pushState, so GA4's Enhanced Measurement history listener never
 * sees them (verified on production).
 * Production builds only, so local dev traffic stays out of reports.
 */
export function GoogleAnalytics() {
  if (process.env.NODE_ENV !== "production") return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} strategy="afterInteractive" />
      <Script id="ga4-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`}
      </Script>
      <Suspense fallback={null}>
        <GaRouteTracker />
      </Suspense>
    </>
  );
}
