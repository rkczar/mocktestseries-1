import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { THEME_COOKIE, isTheme } from "@/lib/theme";
import { TEXT_SIZE_COOKIE, isTextSize } from "@/lib/text-size";
import { getAppearance, appearanceToCssVariables } from "@/lib/appearance";
import { getSeoSettings } from "@/lib/seo-settings";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mock Test Series.in",
  description: "Mock tests, previous year papers, and AI-powered explanations for RUHS Medical Officer, NEET UG, and more.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const theme = isTheme(themeCookie) ? themeCookie : "dark";
  const textSizeCookie = cookieStore.get(TEXT_SIZE_COOKIE)?.value;
  const textSize = isTextSize(textSizeCookie) ? textSizeCookie : "md";

  const appearance = await getAppearance();
  const seo = await getSeoSettings();

  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: seo.siteName,
    url: seo.canonicalBase,
    ...(seo.defaultOgImage ? { logo: seo.defaultOgImage } : {}),
  };
  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: seo.siteName,
    url: seo.canonicalBase,
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
        <meta name="theme-color" content={theme === "light" ? "#fbfbfc" : theme === "eyesaver" ? "#000000" : "#0a0a0a"} />
        <style dangerouslySetInnerHTML={{ __html: appearanceToCssVariables(appearance) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
