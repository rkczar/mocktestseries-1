import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { BRAND_NAME } from "@/lib/brand";
import type { StudioSettings } from "@/lib/instagram/config";
import { FONT_FILES, renderable } from "@/lib/instagram/glyphs";
import {
  GEOMETRY,
  OPTION,
  TEXT_CARD,
  answerCarriesExplanation,
  answerLayout,
  hookLayout,
  plainText,
  questionHeadline,
  questionLayout,
  textBlocksFor,
  textSlideLayout,
  type TextBlock,
} from "@/lib/instagram/layout";
import { themeFor, type SlideTheme } from "@/lib/instagram/templates";
import { SLIDE_HEIGHT, SLIDE_WIDTH, type PostContent, type PostDesign, type SeriesStats, type SlideModule, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Carousel slide renderer: the same `next/og` (Satori) + Geist setup as the
 * site's social cards (lib/og/render.tsx), 1080 × 1350, converted to JPEG by
 * sharp because Instagram's content publishing API accepts JPEG only.
 * Sizes come from lib/instagram/layout.ts, which the quality gate also uses.
 * Question text and options are drawn from the frozen snapshot only.
 */

export interface RenderInput {
  snapshot: SourceSnapshot;
  content: PostContent;
  design: PostDesign;
  series: "PYQ" | "MOST_MISSED";
  seriesStats: SeriesStats | null;
  /** Shown only when verified. */
  questionNumber: number | null;
  questionNumberVerified: boolean;
  settings: StudioSettings;
}

type FontDef = { name: string; data: Buffer; weight: 500 | 700; style: "normal" };
let fontsPromise: Promise<FontDef[]> | null = null;

/** Geist first (brand font); Liberation Sans only supplies glyphs Geist lacks (Greek etc.). Nothing is ever fetched. */
function loadFonts() {
  fontsPromise ??= Promise.all(
    [FONT_FILES.geistBold, FONT_FILES.geistMedium, FONT_FILES.fallbackBold, FONT_FILES.fallbackRegular].map((f) => readFile(path.join(process.cwd(), f)))
  ).then(([bold, medium, fbBold, fbRegular]) => [
    { name: "Geist", data: bold, weight: 700 as const, style: "normal" as const },
    { name: "Geist", data: medium, weight: 500 as const, style: "normal" as const },
    { name: "Liberation Sans", data: fbBold, weight: 700 as const, style: "normal" as const },
    { name: "Liberation Sans", data: fbRegular, weight: 500 as const, style: "normal" as const },
  ]);
  return fontsPromise;
}

/** Every string the slides draw, with undrawable characters replaced (see lib/instagram/glyphs.ts). */
export function sanitizeForRender(input: RenderInput): RenderInput {
  const r = renderable;
  const c = input.content;
  const st = input.settings;
  return {
    ...input,
    snapshot: {
      ...input.snapshot,
      text: r(input.snapshot.text),
      options: input.snapshot.options.map((o) => ({ ...o, text: r(o.text) })),
      examName: r(input.snapshot.examName),
      paperTitle: input.snapshot.paperTitle === null ? null : r(input.snapshot.paperTitle),
      subjectName: r(input.snapshot.subjectName),
      topicName: input.snapshot.topicName === null ? null : r(input.snapshot.topicName),
    },
    content: {
      ...c,
      hookText: r(c.hookText),
      explanation: r(c.explanation),
      memoryTrick: r(c.memoryTrick),
      clinicalPearl: r(c.clinicalPearl),
      quickRevision: c.quickRevision.map(r),
      finalTrick: r(c.finalTrick),
    },
    seriesStats: input.seriesStats ? { ...input.seriesStats, rangeLabel: r(input.seriesStats.rangeLabel), headlineSuffix: r(input.seriesStats.headlineSuffix) } : null,
    settings: {
      ...st,
      ctaHeadline: r(st.ctaHeadline),
      ctaDescription: r(st.ctaDescription),
      footerText: r(st.footerText),
      telegramName: r(st.telegramName),
      examBadges: Object.fromEntries(Object.entries(st.examBadges).map(([k, v]) => [k, r(v)])),
    },
  };
}

// ---- Shared pieces -----------------------------------------------------------

/** Exam badge: per-exam override from Settings, else the exam name. */
export function examBadge(input: Pick<RenderInput, "snapshot" | "settings">): string {
  return input.settings.examBadges[input.snapshot.examId]?.trim() || input.snapshot.examName;
}

/** "PYQ 2021", "PYQ 2021 · Paper II", or "MOST MISSED · TODAY". */
export function seriesTag(input: Pick<RenderInput, "snapshot" | "series" | "seriesStats">): string {
  const s = input.snapshot;
  if (input.series === "MOST_MISSED") return `MOST MISSED · ${input.seriesStats?.headlineSuffix.replace(/[()]/g, "") ?? ""}`.replace(/ · $/, "");
  if (!s.paperYear) return "PRACTICE MCQ";
  return `PYQ ${s.paperYear}${s.paperSharesYear && s.paperTitle ? ` · ${s.paperTitle}` : ""}`;
}

function Wordmark({ size, t }: { size: number; t: SlideTheme }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", color: t.foreground, fontWeight: 700, fontSize: size, letterSpacing: "-0.03em", lineHeight: 1 }}>
      {BRAND_NAME}
      <span style={{ fontSize: size * 0.42, marginLeft: size * 0.04, marginTop: size * 0.02 }}>™</span>
    </div>
  );
}

function Header({ input, t, index, total }: { input: RenderInput; t: SlideTheme; index: number; total: number }) {
  const badge = examBadge(input);
  const tag = seriesTag(input);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: GEOMETRY.headerHeight, justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Wordmark size={34} t={t} />
        <div style={{ display: "flex", fontSize: 26, fontWeight: 500, color: t.muted }}>{`${index + 1} / ${total}`}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", background: t.accent, color: t.accentInk, fontSize: 26, fontWeight: 700, padding: "10px 22px", borderRadius: 999 }}>{badge}</div>
        <div style={{ display: "flex", border: `2px solid ${t.border}`, color: t.foreground, fontSize: 24, fontWeight: 500, padding: "8px 20px", borderRadius: 999 }}>{tag}</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {Array.from({ length: total }, (_, i) => (
          <div key={i} style={{ display: "flex", flex: 1, height: 6, borderRadius: 3, background: i <= index ? t.accent : t.border }} />
        ))}
      </div>
    </div>
  );
}

function Footer({ input, t, last }: { input: RenderInput; t: SlideTheme; last: boolean }) {
  const handle = input.settings.instagramHandle;
  return (
    <div style={{ display: "flex", height: GEOMETRY.footerHeight, alignItems: "center", justifyContent: "space-between", fontSize: 26, fontWeight: 500, color: t.muted }}>
      <div style={{ display: "flex" }}>{input.settings.websiteLabel}</div>
      <div style={{ display: "flex", color: last ? t.muted : t.foreground }}>{last ? (handle ? `@${handle}` : "") : "Swipe →"}</div>
    </div>
  );
}

function Frame({ input, t, index, total, children }: { input: RenderInput; t: SlideTheme; index: number; total: number; children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: `${GEOMETRY.padTop}px ${GEOMETRY.padX}px ${GEOMETRY.padBottom}px`,
        background: t.background,
        fontFamily: "Geist, Liberation Sans",
        color: t.foreground,
      }}
    >
      <Header input={input} t={t} index={index} total={total} />
      <div style={{ display: "flex", flexDirection: "column", height: GEOMETRY.bodyHeight, marginTop: GEOMETRY.headerGap, marginBottom: GEOMETRY.footerGap, overflow: "hidden" }}>
        {children}
      </div>
      <Footer input={input} t={t} last={index === total - 1} />
    </div>
  );
}

function Bubble({ label, t, filled }: { label: string; t: SlideTheme; filled?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flexShrink: 0,
        width: OPTION.bubble,
        height: OPTION.bubble,
        borderRadius: OPTION.bubble / 2,
        alignItems: "center",
        justifyContent: "center",
        fontSize: 28,
        fontWeight: 700,
        background: filled ? t.correct : t.bubble,
        color: filled ? "#ffffff" : t.foreground,
      }}
    >
      {label}
    </div>
  );
}

function Label({ text, color }: { text: string; color: string }) {
  return <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: "0.12em", color, height: TEXT_CARD.labelH, alignItems: "center" }}>{text}</div>;
}

// ---- Slides ------------------------------------------------------------------

function HookSlide({ input, t }: { input: RenderInput; t: SlideTheme }) {
  const stats = input.series === "MOST_MISSED" ? input.seriesStats : null;
  const layout = hookLayout(input.content.hookText, stats ? 2 : 1, input.design.bodyScale);
  const s = input.snapshot;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 40 }}>
      <div style={{ display: "flex", width: 120, height: 10, borderRadius: 5, background: t.accent }} />
      <div style={{ display: "flex", fontSize: layout.size, fontWeight: 700, lineHeight: 1.12, letterSpacing: "-0.02em" }}>{input.content.hookText}</div>
      {stats ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "28px 36px", borderRadius: t.radius, background: t.highlightSoft, border: `2px solid ${t.highlight}` }}>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 700, color: t.highlight }}>{`${Math.round(stats.wrongPct)}% answered wrong`}</div>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 500, color: t.muted }}>{`${stats.wrong} of ${stats.attempts} answers on MockTestSeries · ${stats.rangeLabel}`}</div>
        </div>
      ) : null}
      <div style={{ display: "flex", fontSize: 32, fontWeight: 500, color: t.muted }}>{`${s.subjectName}${s.topicName ? ` · ${s.topicName}` : ""}`}</div>
    </div>
  );
}

function QuestionSlide({ input, t }: { input: RenderInput; t: SlideTheme }) {
  const s = input.snapshot;
  const headline = questionHeadline(input.design, input.content);
  const layout = questionLayout(s, headline, input.design.questionScale);
  const number = input.questionNumber && input.questionNumberVerified ? `Q.${input.questionNumber} ` : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
      {headline ? (
        <div style={{ display: "flex", fontSize: layout.headlineSize, fontWeight: 700, color: t.accent === "#008209" ? t.correct : t.accent, marginBottom: 28 }}>{headline}</div>
      ) : null}
      <div style={{ display: "flex", fontSize: layout.stemSize, fontWeight: 700, lineHeight: 1.28, marginBottom: 36 }}>{`${number}${plainText(s.text)}`}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: OPTION.between }}>
        {s.options.map((o) => (
          <div
            key={o.label}
            style={{ display: "flex", alignItems: "center", gap: OPTION.gap, padding: `${OPTION.padY}px ${OPTION.padX}px`, background: t.card, border: `2px solid ${t.border}`, borderRadius: t.radius }}
          >
            <Bubble label={o.label} t={t} />
            <div style={{ display: "flex", flex: 1, fontSize: layout.optionSize, fontWeight: 500, lineHeight: 1.28 }}>{plainText(o.text)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnswerSlide({ input, t }: { input: RenderInput; t: SlideTheme }) {
  const s = input.snapshot;
  const carries = answerCarriesExplanation(input.design);
  const layout = answerLayout(s, input.content.explanation, carries, input.design.bodyScale);
  const correct = s.options.filter((o) => o.isCorrect);
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", marginBottom: 24 }}>
        <Label text={correct.length > 1 ? "CORRECT ANSWERS" : "CORRECT ANSWER"} color={t.correct} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {correct.map((o) => (
          <div key={o.label} style={{ display: "flex", alignItems: "center", gap: OPTION.gap, padding: "40px 44px", background: t.correctSoft, border: `3px solid ${t.correct}`, borderRadius: t.radius }}>
            <Bubble label={o.label} t={t} filled />
            <div style={{ display: "flex", flex: 1, fontSize: layout.answerSize, fontWeight: 700, lineHeight: 1.28 }}>{plainText(o.text)}</div>
          </div>
        ))}
      </div>
      {layout.showNote ? (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 40 }}>
          <Label text="WHY" color={t.muted} />
          <div style={{ display: "flex", marginTop: 18, fontSize: layout.noteSize, fontWeight: 500, lineHeight: 1.28 }}>{input.content.explanation}</div>
        </div>
      ) : null}
    </div>
  );
}

function TextSlide({ blocks, input, t }: { blocks: TextBlock[]; input: RenderInput; t: SlideTheme }) {
  const visible = blocks.filter((b) => b.text || b.bullets?.length);
  const layout = textSlideLayout(blocks, input.design.bodyScale);
  const toneColor = (b: TextBlock) => (b.tone === "highlight" ? t.highlight : b.tone === "accent" ? t.correct : t.muted);
  const toneBg = (b: TextBlock) => (b.tone === "highlight" ? t.highlightSoft : b.tone === "accent" ? t.correctSoft : t.card);
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: TEXT_CARD.between }}>
      {visible.map((b) => (
        <div key={b.label} style={{ display: "flex", flexDirection: "column", padding: TEXT_CARD.pad, background: toneBg(b), border: `2px solid ${b.tone === "plain" ? t.border : toneColor(b)}`, borderRadius: t.radius }}>
          <Label text={b.label} color={toneColor(b)} />
          {b.bullets?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: TEXT_CARD.labelGap }}>
              {b.bullets.map((item, i) => (
                <div key={i} style={{ display: "flex", gap: 16, fontSize: layout.size, fontWeight: 500, lineHeight: 1.28 }}>
                  <div style={{ display: "flex", width: 24, color: t.correct }}>•</div>
                  <div style={{ display: "flex", flex: 1 }}>{item}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", marginTop: TEXT_CARD.labelGap, fontSize: layout.size, fontWeight: 500, lineHeight: 1.28 }}>{b.text}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function FollowRow({ t, label, value, action }: { t: SlideTheme; label: string; value: string; action: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, padding: "26px 34px", background: t.card, border: `2px solid ${t.border}`, borderRadius: t.radius }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: "0.1em", color: t.muted }}>{label}</div>
        <div style={{ display: "flex", fontSize: 34, fontWeight: 700 }}>{value}</div>
      </div>
      <div style={{ display: "flex", background: t.accent, color: t.accentInk, fontSize: 28, fontWeight: 700, padding: "14px 28px", borderRadius: 999 }}>{action}</div>
    </div>
  );
}

/** "t.me/mocktestseries" from the configured Telegram URL. */
export function telegramLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function FollowSlide({ input, t }: { input: RenderInput; t: SlideTheme }) {
  const st = input.settings;
  const c = input.content;
  const trick = c.showFinalTrick && c.finalTrick.trim() ? c.finalTrick.trim() : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 26 }}>
      <Wordmark size={64} t={t} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", fontSize: 50, fontWeight: 700, lineHeight: 1.15 }}>{st.ctaHeadline}</div>
        <div style={{ display: "flex", fontSize: 30, fontWeight: 500, color: t.muted, lineHeight: 1.3 }}>{st.ctaDescription}</div>
      </div>
      {trick ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "22px 30px", background: t.highlightSoft, border: `2px solid ${t.highlight}`, borderRadius: t.radius }}>
          <Label text="QUICK REVISION" color={t.highlight} />
          <div style={{ display: "flex", fontSize: 30, fontWeight: 500, lineHeight: 1.28 }}>{trick}</div>
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {st.showInstagram && st.instagramHandle ? <FollowRow t={t} label="INSTAGRAM" value={`@${st.instagramHandle}`} action="Follow" /> : null}
        {st.showTelegram && st.telegramUrl ? <FollowRow t={t} label={st.telegramName.toUpperCase()} value={telegramLabel(st.telegramUrl)} action="Join" /> : null}
        {st.showWebsite ? <FollowRow t={t} label={st.footerText.toUpperCase()} value={st.websiteLabel} action="Visit" /> : null}
      </div>
      {st.showSaveShare ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
          {["Save", "Share", "Follow"].map((w) => (
            <div key={w} style={{ display: "flex", flex: 1, justifyContent: "center", padding: "16px 0", border: `2px solid ${t.accent}`, borderRadius: 999, fontSize: 28, fontWeight: 700, color: t.foreground }}>
              {w}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function slideBody(module: SlideModule, input: RenderInput, t: SlideTheme) {
  switch (module) {
    case "HOOK":
      return <HookSlide input={input} t={t} />;
    case "QUESTION":
      return <QuestionSlide input={input} t={t} />;
    case "ANSWER":
      return <AnswerSlide input={input} t={t} />;
    case "FOLLOW":
      return <FollowSlide input={input} t={t} />;
    default:
      return <TextSlide blocks={textBlocksFor(module, input.content)} input={input} t={t} />;
  }
}

/** Renders slide `index` (0-based) as JPEG. */
export async function renderSlideJpeg(raw: RenderInput, index: number, quality = 92): Promise<Buffer> {
  const input = sanitizeForRender(raw);
  const modules = input.design.modules;
  if (index < 0 || index >= modules.length) throw new Error("Slide index out of range.");
  const t = themeFor(input.design.template);
  const image = new ImageResponse(
    (
      <Frame input={input} t={t} index={index} total={modules.length}>
        {slideBody(modules[index], input, t)}
      </Frame>
    ),
    { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, fonts: await loadFonts() }
  );
  const png = Buffer.from(await image.arrayBuffer());
  return sharp(png).flatten({ background: t.background }).jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
}
