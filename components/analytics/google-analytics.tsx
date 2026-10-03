import Script from "next/script";

export const GA_MEASUREMENT_ID = "G-BSBYPQ9QK2";

/**
 * GA4 (gtag.js), mounted once in the root layout so every route gets it.
 * Client-side navigations are counted by GA4 Enhanced Measurement
 * ("page changes based on browser history events"), so no manual
 * page_view calls are made here — that would double count.
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
    </>
  );
}
