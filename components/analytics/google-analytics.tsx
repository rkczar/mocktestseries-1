import { Suspense } from "react";
import { GaRouteTracker } from "./ga-route-tracker";

export const GA_MEASUREMENT_ID = "G-BSBYPQ9QK2";

/**
 * GA4 (gtag.js), mounted once in the root layout so every route gets it.
 * GaRouteTracker owns loading, page_views and the /admin exclusion.
 * Production builds only, so local dev traffic stays out of reports.
 */
export function GoogleAnalytics() {
  if (process.env.NODE_ENV !== "production") return null;
  return (
    <Suspense fallback={null}>
      <GaRouteTracker measurementId={GA_MEASUREMENT_ID} />
    </Suspense>
  );
}
