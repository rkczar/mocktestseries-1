import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { BRAND_NAME } from "@/lib/brand";
import { OG_SIZE } from "@/lib/og/constants";

/**
 * Social (Open Graph / Twitter) card images, 1200 × 630 PNG. One layout for
 * the site default and every exam: the canonical text wordmark
 * (components/brand/BrandLogo.tsx — BRAND_NAME + ™, Geist Bold) on the dark
 * theme background, with a single row of OMR answer bubbles as a quiet
 * exam motif. No third-party or government marks, no ratings or numbers.
 */
const COLORS = {
  background: "#09090b",
  panel: "#111114",
  border: "#26262b",
  foreground: "#f5f5f5",
  muted: "#a1a1aa",
  accent: "#3b82f6",
};

let fontsPromise: Promise<{ name: string; data: Buffer; weight: 500 | 700; style: "normal" }[]> | null = null;

function loadFonts() {
  fontsPromise ??= Promise.all([
    readFile(path.join(process.cwd(), "lib/og/fonts/Geist-Bold.ttf")),
    readFile(path.join(process.cwd(), "lib/og/fonts/Geist-Medium.ttf")),
  ]).then(([bold, medium]) => [
    { name: "Geist", data: bold, weight: 700 as const, style: "normal" as const },
    { name: "Geist", data: medium, weight: 500 as const, style: "normal" as const },
  ]);
  return fontsPromise;
}

function Wordmark({ size }: { size: number }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", color: COLORS.foreground, fontWeight: 700, fontSize: size, letterSpacing: "-0.03em", lineHeight: 1 }}>
      {BRAND_NAME}
      <span style={{ fontSize: size * 0.42, marginLeft: -size * 0.12, marginTop: size * 0.02 }}>™</span>
    </div>
  );
}

/** A row of OMR bubbles, one marked — reads as "exam" without any logo. */
function OmrRow() {
  const letters = ["A", "B", "C", "D"];
  return (
    <div style={{ display: "flex", gap: 14 }}>
      {letters.map((l) => {
        const marked = l === "B";
        return (
          <div
            key={l}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 500,
              border: `2px solid ${marked ? COLORS.accent : COLORS.border}`,
              background: marked ? COLORS.accent : "transparent",
              color: marked ? "#ffffff" : COLORS.muted,
            }}
          >
            {l}
          </div>
        );
      })}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: COLORS.background,
        fontFamily: "Geist",
        borderTop: `6px solid ${COLORS.accent}`,
      }}
    >
      {children}
    </div>
  );
}

function Footer() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", fontSize: 26, fontWeight: 500, color: COLORS.muted }}>mocktestseries.in</div>
      <OmrRow />
    </div>
  );
}

/** Site default card: the wordmark and one supporting line. */
export async function renderDefaultOgImage(): Promise<ImageResponse> {
  return new ImageResponse(
    (
      <Frame>
        <div style={{ display: "flex", fontSize: 24, fontWeight: 500, color: COLORS.accent, letterSpacing: "0.12em" }}>MEDICAL OFFICER EXAM PREPARATION</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <Wordmark size={96} />
          <div style={{ display: "flex", fontSize: 36, fontWeight: 500, color: COLORS.muted }}>Online Mock Tests • PYQs • AI-Powered Practice</div>
        </div>
        <Footer />
      </Frame>
    ),
    { ...OG_SIZE, fonts: await loadFonts() }
  );
}

/** Exam card: exam name as the headline, the wordmark as the signature. */
export async function renderExamOgImage(examName: string): Promise<ImageResponse> {
  const titleSize = examName.length > 34 ? 64 : 80;
  return new ImageResponse(
    (
      <Frame>
        <Wordmark size={40} />
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", fontSize: titleSize, fontWeight: 700, color: COLORS.foreground, letterSpacing: "-0.03em", lineHeight: 1.05 }}>
            {examName}
          </div>
          <div style={{ display: "flex", fontSize: 34, fontWeight: 500, color: COLORS.muted }}>Mock Tests • Previous Year Papers • Exam Preparation</div>
        </div>
        <Footer />
      </Frame>
    ),
    { ...OG_SIZE, fonts: await loadFonts() }
  );
}
