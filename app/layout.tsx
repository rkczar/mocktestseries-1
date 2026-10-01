import { safeJsonLd } from "@/lib/json-ld";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { THEME_COOKIE, isTheme } from "@/lib/theme";
import { TEXT_SIZE_COOKIE, isTextSize } from "@/lib/text-size";
import { getAppearance, appearanceToCssVariables } from "@/lib/appearance";
import { getSeoSettings } from "@/lib/seo-settings";
import { PUBLIC_BRAND_NAME } from "@/lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: PUBLIC_BRAND_NAME,
  description: "Online mock tests, previous year papers and AI-powered explanations for medical officer exams.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const theme = isTheme(themeCookie) ? themeCookie : "dark";
  const textSizeCookie = cookieStore.get(TEXT_SIZE_COOKIE)?.value;
  const textSize = isTextSize(textSizeCookie) ? textSizeCookie : "md";

  const appearance = await getAppearance();
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
        <style dangerouslySetInnerHTML={{ __html: appearanceToCssVariables(appearance) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(organizationJsonLd) }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
