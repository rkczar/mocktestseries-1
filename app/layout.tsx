import type { Metadata } from "next";
import { Source_Serif_4, Manrope, IBM_Plex_Mono, Playfair_Display, Lora, Inter, Work_Sans } from "next/font/google";

import { appearanceCssVars, getAppearance } from "@/lib/appearance";

import "./globals.css";

const sourceSerif4 = Source_Serif_4({
  variable: "--font-source-serif-4",
  subsets: ["latin"],
  weight: ["700"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["500", "600"],
});

// Alternate fonts selectable from /admin/appearance (Appearance module). Loading every option
// up front means switching is an instant CSS-variable swap, not a rebuild.
const playfairDisplay = Playfair_Display({ variable: "--font-playfair-display", subsets: ["latin"], weight: ["700"] });
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], weight: ["700"] });
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const workSans = Work_Sans({ variable: "--font-work-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "MockTestSeries.in — AI-Powered Exam Preparation",
    template: "%s · MockTestSeries.in",
  },
  description:
    "Practice smart and understand every answer with AI-explained mock tests for Indian competitive and recruitment exams.",
};

const FONT_VARIABLES = [
  sourceSerif4.variable,
  manrope.variable,
  ibmPlexMono.variable,
  playfairDisplay.variable,
  lora.variable,
  inter.variable,
  workSans.variable,
].join(" ");

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const appearance = await getAppearance();

  return (
    <html lang="en" className={`${FONT_VARIABLES} h-full antialiased`}>
      <head>
        {/* Admin-configured brand colors/fonts/button radius — see /admin/appearance and
            lib/appearance.ts. Overrides the :root defaults in globals.css. */}
        <style dangerouslySetInnerHTML={{ __html: appearanceCssVars(appearance) }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
