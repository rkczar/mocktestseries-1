import { safeJsonLd } from "@/lib/json-ld";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { THEME_COOKIE, isTheme } from "@/lib/theme";
import { TEXT_SIZE_COOKIE, isTextSize } from "@/lib/text-size";
import { getAppearance, appearanceToCssVariables } from "@/lib/appearance";
import { premiumGlowToCss } from "@/lib/premium-glow";
import { getPremiumGlowConfig } from "@/lib/premium-glow-settings";
import { getSeoSettings } from "@/lib/seo-settings";
import { PUBLIC_BRAND_NAME } from "@/lib/brand";
import { getSiteUrl } from "@/lib/site-url";
import { defaultSocialImage, socialMetadata } from "@/lib/social-metadata";
import { PwaProvider, PWA_INSTALL_CAPTURE_SCRIPT } from "@/components/pwa/pwa-provider";
import { GoogleAnalytics } from "@/components/analytics/google-analytics";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DEFAULT_DESCRIPTION = "Online mock tests, previous year papers and AI-powered explanations for medical officer exams.";

// Defaults for every route; pages that set their own `openGraph`/`twitter`
// build them with lib/social-metadata.ts so the image is never dropped.
export async function generateMetadata(): Promise<Metadata> {
  const [seo, siteUrl] = await Promise.all([getSeoSettings(), getSiteUrl()]);
  return {
    title: PUBLIC_BRAND_NAME,
    description: DEFAULT_DESCRIPTION,
    ...socialMetadata({ title: PUBLIC_BRAND_NAME, description: DEFAULT_DESCRIPTION, image: defaultSocialImage(seo, siteUrl), seo }),
    // Installed-app (PWA) identity; the manifest itself is app/manifest.ts.
    applicationName: "MockTestSeries",
    appleWebApp: { capable: true, title: "MockTestSeries", statusBarStyle: "default" },
    icons: { apple: "/icons/apple-touch-icon.png" },
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const theme = isTheme(themeCookie) ? themeCookie : "dark";
  const textSizeCookie = cookieStore.get(TEXT_SIZE_COOKIE)?.value;
  const textSize = isTextSize(textSizeCookie) ? textSizeCookie : "md";

  // Premium Glow rides in the same <style> as Appearance: one cached read
  // per render, so glowing buttons never fetch their own settings.
  const [appearance, premiumGlow] = await Promise.all([getAppearance(), getPremiumGlowConfig()]);
  const seo = await getSeoSettings();

  const siteUrl = seo.canonicalBase.replace(/\/+$/, "");
  // Organization on every page; WebSite is emitted by the homepage only
  // (app/page.tsx), where Google reads it for the site name.
  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${siteUrl}/#organization`,
    name: seo.siteName,
    alternateName: PUBLIC_BRAND_NAME,
    url: `${siteUrl}/`,
    ...(seo.defaultOgImage ? { logo: seo.defaultOgImage } : {}),
  };

  return (
    <html
      lang="en"
      data-theme={theme}
      data-text-size={textSize}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <meta name="theme-color" content={theme === "light" ? "#fbfbfc" : "#000000"} />
        <style dangerouslySetInnerHTML={{ __html: appearanceToCssVariables(appearance) + premiumGlowToCss(premiumGlow) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(organizationJsonLd) }} />
        <script dangerouslySetInnerHTML={{ __html: PWA_INSTALL_CAPTURE_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <PwaProvider>{children}</PwaProvider>
        <GoogleAnalytics />
      </body>
    </html>
  );
}
