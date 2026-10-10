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
  TRAP_HEAD,
  textBlocksFor,
  textSlideLayout,
  trapLayout,
  type TextBlock,
} from "@/lib/instagram/layout";
import { DIAGRAM_AREA, diagramLayout, type Arrow, type Box } from "@/lib/instagram/diagram";
import { resolveTheme, type SlideTheme } from "@/lib/instagram/templates";
import { SLIDE_HEIGHT, SLIDE_WIDTH, type DiagramSpec, type PostContent, type PostDesign, type SeriesStats, type SlideModule, type SourceSnapshot, type TrapVariant } from "@/lib/instagram/types";

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

/**
 * Geist first (brand font); Kalam is the Handwritten templates' face (OFL,
 * bundled); Liberation Sans only supplies glyphs the others lack (Greek etc.).
 * Nothing is ever fetched.
 */
function loadFonts() {
  fontsPromise ??= Promise.all(
    [FONT_FILES.geistBold, FONT_FILES.geistMedium, FONT_FILES.fallbackBold, FONT_FILES.fallbackRegular, HANDWRITING_FONTS.bold, HANDWRITING_FONTS.regular].map((f) =>
      readFile(path.join(process.cwd(), f))
    )
  ).then(([bold, medium, fbBold, fbRegular, kalamBold, kalamRegular]) => [
    { name: "Geist", data: bold, weight: 700 as const, style: "normal" as const },
    { name: "Geist", data: medium, weight: 500 as const, style: "normal" as const },
    { name: "Liberation Sans", data: fbBold, weight: 700 as const, style: "normal" as const },
    { name: "Liberation Sans", data: fbRegular, weight: 500 as const, style: "normal" as const },
    { name: "Kalam", data: kalamBold, weight: 700 as const, style: "normal" as const },
    { name: "Kalam", data: kalamRegular, weight: 500 as const, style: "normal" as const },
  ]);
  return fontsPromise;
}

export const HANDWRITING_FONTS = { bold: "lib/instagram/fonts/Kalam-Bold.ttf", regular: "lib/instagram/fonts/Kalam-Regular.ttf" } as const;

const hw = (t: SlideTheme) => t.mode === "handwritten";
/** Satori rejects `undefined` style values: drop them so conditional (handwritten-only) styles stay optional. */
function sx(style: React.CSSProperties): React.CSSProperties {
  return Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined)) as React.CSSProperties;
}
/** Small deterministic tilt for handwritten cards (looks hand-placed, identical on every render). */
const tilt = (t: SlideTheme, i: number) => (hw(t) ? `rotate(${[-0.7, 0.5, -0.4, 0.8, -0.6, 0.3][i % 6]}deg)` : undefined);
/** Handwritten cards: uneven "pen" corners. */
const hwRadius = (t: SlideTheme) => (hw(t) ? `${t.radius + 8}px ${t.radius - 4}px ${t.radius + 12}px ${t.radius - 6}px` : t.radius);

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
      pearls: c.pearls.map(r),
      mistakes: c.mistakes.map(r),
      diagram: c.diagram ? sanitizeDiagram(c.diagram, r) : null,
      trap: c.trap
        ? { ...c.trap, question: r(c.trap.question), options: c.trap.options.map((o) => ({ ...o, text: r(o.text) })), trapExplanation: r(c.trap.trapExplanation), avoidTip: r(c.trap.avoidTip) }
        : null,
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

function sanitizeDiagram(d: DiagramSpec, r: (s: string) => string): DiagramSpec {
  return {
    ...d,
    title: r(d.title),
    footnote: r(d.footnote),
    nodes: d.nodes.map((n) => ({ ...n, label: r(n.label), ...(n.note ? { note: r(n.note) } : {}) })),
    edges: d.edges.map((e) => ({ ...e, ...(e.label ? { label: r(e.label) } : {}) })),
    columns: d.columns.map(r),
    rows: d.rows.map((row) => ({ label: r(row.label), cells: row.cells.map(r) })),
    sets: d.sets.map((x) => ({ label: r(x.label), items: x.items.map(r) })),
    overlap: d.overlap.map(r),
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
      {hw(t) ? (
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: t.marker, color: t.foreground, fontSize: 30, fontWeight: 700, padding: "2px 16px", transform: "rotate(-1deg)" }}>{badge}</div>
          <div style={{ display: "flex", border: `3px solid ${t.annotation}`, color: t.annotation, fontSize: 26, fontWeight: 700, padding: "2px 18px", borderRadius: "40px 32px 44px 30px", transform: "rotate(1.2deg)" }}>{tag}</div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: t.accent, color: t.accentInk, fontSize: 26, fontWeight: 700, padding: "10px 22px", borderRadius: 999 }}>{badge}</div>
          <div style={{ display: "flex", border: `2px solid ${t.border}`, color: t.foreground, fontSize: 24, fontWeight: 500, padding: "8px 20px", borderRadius: 999 }}>{tag}</div>
        </div>
      )}
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

/** Notebook / graph-paper background for Handwritten templates (absolute lines — deterministic, no gradients). */
function Paper({ t }: { t: SlideTheme }) {
  if (!t.paper) return null;
  const p = t.paper;
  const step = p.kind === "grid" ? 45 : 54;
  const rows = Math.ceil(SLIDE_HEIGHT / step);
  const cols = p.kind === "grid" ? Math.ceil(SLIDE_WIDTH / step) : 0;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT, display: "flex" }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={`r${i}`} style={{ position: "absolute", left: 0, top: (i + 1) * step, width: SLIDE_WIDTH, height: 2, background: p.line }} />
      ))}
      {Array.from({ length: cols }, (_, i) => (
        <div key={`c${i}`} style={{ position: "absolute", top: 0, left: (i + 1) * step, height: SLIDE_HEIGHT, width: 2, background: p.line }} />
      ))}
      {p.margin ? <div style={{ position: "absolute", top: 0, left: 50, height: SLIDE_HEIGHT, width: 3, background: p.margin }} /> : null}
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
        position: "relative",
        padding: `${GEOMETRY.padTop}px ${GEOMETRY.padX}px ${GEOMETRY.padBottom}px`,
        background: t.background,
        fontFamily: t.font === "Kalam" ? "Kalam, Geist, Liberation Sans" : "Geist, Liberation Sans",
        color: t.foreground,
      }}
    >
      <Paper t={t} />
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
      style={sx({
        display: "flex",
        flexShrink: 0,
        width: OPTION.bubble,
        height: OPTION.bubble,
        borderRadius: OPTION.bubble / 2,
        alignItems: "center",
        justifyContent: "center",
        fontSize: 28,
        fontWeight: 700,
        background: hw(t) ? "transparent" : filled ? t.correct : t.bubble,
        border: hw(t) ? `3px solid ${filled ? t.annotation : t.border}` : undefined,
        color: hw(t) ? (filled ? t.annotation : t.foreground) : filled ? "#ffffff" : t.foreground,
      })}
    >
      {label}
    </div>
  );
}

function Label({ text, color, t }: { text: string; color: string; t?: SlideTheme }) {
  if (t && hw(t)) {
    return (
      <div style={{ display: "flex", height: TEXT_CARD.labelH, alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color, background: t.marker, padding: "0 10px", lineHeight: 1.1 }}>{text}</div>
      </div>
    );
  }
  return <div style={{ display: "flex", fontSize: 24, fontWeight: 700, letterSpacing: "0.12em", color, height: TEXT_CARD.labelH, alignItems: "center" }}>{text}</div>;
}

/** A hand-drawn curved arrow (SVG path), used as decoration on Handwritten slides. */
function HandArrow({ color, width = 150, height = 70, flip = false }: { color: string; width?: number; height?: number; flip?: boolean }) {
  return (
    <svg width={width} height={height} viewBox="0 0 150 70" style={sx({ transform: flip ? "scaleX(-1)" : undefined })}>
      <path d="M6 58 C 40 12, 92 6, 136 26" stroke={color} strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M118 12 L 138 27 L 116 38" stroke={color} strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Slides ------------------------------------------------------------------

function HookSlide({ input, t }: { input: RenderInput; t: SlideTheme }) {
  const stats = input.series === "MOST_MISSED" ? input.seriesStats : null;
  const layout = hookLayout(input.content.hookText, stats ? 2 : 1, input.design.bodyScale);
  const s = input.snapshot;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 40 }}>
      {hw(t) ? <HandArrow color={t.annotation ?? t.accent} /> : <div style={{ display: "flex", width: 120, height: 10, borderRadius: 5, background: t.accent }} />}
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
            style={sx({
              display: "flex",
              alignItems: "center",
              gap: OPTION.gap,
              padding: `${OPTION.padY}px ${OPTION.padX}px`,
              background: t.card,
              border: hw(t) ? "none" : `2px solid ${t.border}`,
              borderBottom: hw(t) ? `2px dashed ${t.border}` : undefined,
              borderRadius: hw(t) ? 0 : t.radius,
            })}
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
        <Label text={correct.length > 1 ? "CORRECT ANSWERS" : "CORRECT ANSWER"} color={t.correct} t={t} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {correct.map((o) => (
          <div
            key={o.label}
            style={sx({ display: "flex", alignItems: "center", gap: OPTION.gap, padding: "40px 44px", background: t.correctSoft, border: `3px solid ${t.correct}`, borderRadius: hwRadius(t), transform: tilt(t, 1) })}
          >
            <Bubble label={o.label} t={t} filled />
            <div style={{ display: "flex", flex: 1, fontSize: layout.answerSize, fontWeight: 700, lineHeight: 1.28 }}>{plainText(o.text)}</div>
          </div>
        ))}
      </div>
      {layout.showNote ? (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 40 }}>
          <Label text="WHY" color={t.muted} t={t} />
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
      {visible.map((b, bi) => (
        <div
          key={b.label}
          style={sx({
            display: "flex",
            flexDirection: "column",
            padding: TEXT_CARD.pad,
            background: hw(t) ? "transparent" : toneBg(b),
            border: `${hw(t) ? 3 : 2}px solid ${b.tone === "plain" ? t.border : toneColor(b)}`,
            borderRadius: hwRadius(t),
            transform: tilt(t, bi),
          })}
        >
          <Label text={b.label} color={toneColor(b)} t={t} />
          {b.bullets?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: TEXT_CARD.labelGap }}>
              {b.bullets.map((item, i) => (
                <div key={i} style={{ display: "flex", gap: 16, fontSize: layout.size, fontWeight: 500, lineHeight: 1.28 }}>
                  <div style={{ display: "flex", width: 24, color: hw(t) ? (t.annotation ?? t.correct) : t.correct }}>{hw(t) ? "→" : "•"}</div>
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
          <Label text="QUICK REVISION" color={t.highlight} t={t} />
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

// ---- Medical concept diagram ---------------------------------------------------------

function arrowHead(a: Arrow, size = 18) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const p1 = `${a.x2 - size * Math.cos(ang - 0.45)},${a.y2 - size * Math.sin(ang - 0.45)}`;
  const p2 = `${a.x2 - size * Math.cos(ang + 0.45)},${a.y2 - size * Math.sin(ang + 0.45)}`;
  return `${p1} ${a.x2},${a.y2} ${p2}`;
}

/** Arrows as one SVG layer. Handwritten: a slightly curved, rounded "pen" stroke. */
function ArrowLayer({ arrows, t, width, height }: { arrows: Arrow[]; t: SlideTheme; width: number; height: number }) {
  const color = hw(t) ? (t.annotation ?? t.accent) : t.muted;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", left: 0, top: 0 }}>
      {arrows.map((a, i) => {
        const mx = (a.x1 + a.x2) / 2 + (hw(t) ? (i % 2 ? 14 : -14) : 0);
        const my = (a.y1 + a.y2) / 2;
        const d = hw(t) ? `M${a.x1} ${a.y1} Q ${mx} ${my} ${a.x2} ${a.y2}` : `M${a.x1} ${a.y1} L ${a.x2} ${a.y2}`;
        return (
          <g key={i}>
            <path d={d} stroke={color} strokeWidth={hw(t) ? 5 : 4} fill="none" strokeLinecap="round" />
            <polygon points={arrowHead(a)} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

function DiagramBox({ b, t }: { b: Box; t: SlideTheme }) {
  const first = b.index === 0;
  return (
    <div
      style={sx({
        position: "absolute",
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "10px 18px",
        background: hw(t) ? (first ? t.marker : t.background) : first ? t.correctSoft : t.card,
        border: `${hw(t) ? 3 : 2}px solid ${first ? t.accent : t.border}`,
        borderRadius: hwRadius(t),
        transform: tilt(t, b.index),
        textAlign: "center",
      })}
    >
      <div style={{ display: "flex", fontSize: b.size, fontWeight: 700, lineHeight: 1.25, textAlign: "center", justifyContent: "center" }}>{b.label}</div>
      {b.note ? <div style={{ display: "flex", marginTop: 6, fontSize: b.noteSize, fontWeight: 500, color: t.muted, lineHeight: 1.25, textAlign: "center", justifyContent: "center" }}>{b.note}</div> : null}
    </div>
  );
}

function DiagramSlide({ input, t }: { input: RenderInput; t: SlideTheme }) {
  const d = input.content.diagram;
  const W = DIAGRAM_AREA.width;
  const H = DIAGRAM_AREA.height;
  if (!d) {
    return <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: 32, color: t.muted }}>No diagram yet</div>;
  }
  const L = diagramLayout(d);
  let body: React.ReactNode = null;
  if (L.kind === "boxes") {
    body = (
      <div style={{ position: "relative", display: "flex", width: W, height: H }}>
        <ArrowLayer arrows={L.arrows} t={t} width={W} height={H} />
        {L.boxes.map((b) => (
          <DiagramBox key={b.id} b={b} t={t} />
        ))}
        {L.arrows.map((a, i) =>
          a.label ? (
            <div key={`l${i}`} style={{ position: "absolute", left: (a.x1 + a.x2) / 2 + 12, top: (a.y1 + a.y2) / 2 - 16, display: "flex", fontSize: 22, fontWeight: 700, color: hw(t) ? t.annotation : t.highlight }}>
              {a.label}
            </div>
          ) : null
        )}
      </div>
    );
  } else if (L.kind === "table") {
    const cell = (text: string, w: number, h: number, head: boolean, key: string, first: boolean) => (
      <div
        key={key}
        style={{
          display: "flex",
          width: w,
          height: h,
          padding: "10px 14px",
          alignItems: "center",
          fontSize: L.size,
          fontWeight: head || first ? 700 : 500,
          lineHeight: 1.25,
          color: head ? (hw(t) ? t.foreground : t.accentInk) : t.foreground,
          background: head ? (hw(t) ? t.marker : t.accent) : first ? (hw(t) ? "transparent" : t.bubble) : hw(t) ? "transparent" : t.card,
          borderRight: `2px solid ${t.border}`,
          borderBottom: `2px solid ${t.border}`,
        }}
      >
        {text}
      </div>
    );
    body = (
      <div style={sx({ display: "flex", flexDirection: "column", width: W, borderTop: `2px solid ${t.border}`, borderLeft: `2px solid ${t.border}`, transform: tilt(t, 2) })}>
        <div style={{ display: "flex" }}>{d.columns.map((c, i) => cell(c, L.colW[i], L.headerH, true, `h${i}`, i === 0))}</div>
        {d.rows.map((r, ri) => (
          <div key={ri} style={{ display: "flex" }}>
            {cell(r.label, L.colW[0], L.rowH[ri], false, `r${ri}`, true)}
            {r.cells.map((c, ci) => cell(c, L.colW[ci + 1], L.rowH[ri], false, `c${ri}-${ci}`, false))}
          </div>
        ))}
      </div>
    );
  } else {
    const fills = hw(t) ? ["rgba(66,110,190,0.14)", "rgba(214,48,49,0.12)", "rgba(255,200,0,0.18)"] : [`${t.accent}22`, `${t.highlight}22`, `${t.correct}22`];
    const strokes = hw(t) ? [t.accent, t.annotation ?? t.highlight, t.foreground] : [t.accent, t.highlight, t.correct];
    const list = (items: string[], x: number, y: number, w: number, key: string, align: "left" | "center" = "left") => (
      <div key={key} style={{ position: "absolute", left: x, top: y, width: w, display: "flex", flexDirection: "column", gap: 6, alignItems: align === "center" ? "center" : "flex-start" }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", fontSize: L.size, fontWeight: 500, lineHeight: 1.25, textAlign: align }}>
            {it}
          </div>
        ))}
      </div>
    );
    body = (
      <div style={{ position: "relative", display: "flex", width: W, height: H }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
          {L.circles.map((c, i) => (
            <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill={fills[i]} stroke={strokes[i]} strokeWidth={hw(t) ? 5 : 3} />
          ))}
        </svg>
        {L.circles.map((c, i) => (
          <div key={`t${i}`} style={{ position: "absolute", left: c.labelX, top: c.labelY, width: 400, display: "flex", justifyContent: i === 1 ? "flex-end" : i === 2 ? "center" : "flex-start", fontSize: 30, fontWeight: 700, color: strokes[i] }}>
            {c.label}
          </div>
        ))}
        {L.circles.map((c, i) => list(c.items, c.itemsX, c.itemsY, c.itemsW, `i${i}`))}
        {list(L.overlap.items, L.overlap.x, L.overlap.y, L.overlap.w, "ov", "center")}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div style={{ display: "flex", height: DIAGRAM_AREA.titleH, alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 34, fontWeight: 700, background: hw(t) ? t.marker : "transparent", color: hw(t) ? t.foreground : t.foreground, padding: hw(t) ? "0 10px" : 0 }}>{d.title}</div>
      </div>
      <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>{body}</div>
      <div style={{ display: "flex", height: DIAGRAM_AREA.footH, alignItems: "flex-end", justifyContent: "space-between", fontSize: 20, color: t.muted }}>
        <div style={{ display: "flex", flex: 1 }}>{d.footnote}</div>
        <div style={{ display: "flex" }}>Schematic · not a clinical image</div>
      </div>
    </div>
  );
}

// ---- Examiner trap -------------------------------------------------------------------------

function TrapSlide({ input, t }: { input: RenderInput; t: SlideTheme }) {
  const trap = input.content.trap as TrapVariant | null;
  if (!trap) return <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: 32, color: t.muted }}>No examiner trap yet</div>;
  const L = trapLayout(trap, input.design.bodyScale);
  const red = hw(t) ? (t.annotation ?? t.highlight) : t.highlight;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", height: TRAP_HEAD.height, justifyContent: "center", gap: 6 }}>
        <div style={{ display: "flex", fontSize: TRAP_HEAD.titleSize, fontWeight: 700, color: red, lineHeight: 1.1 }}>HOW THE EXAMINER TRAPS YOU?</div>
        <div style={{ display: "flex", fontSize: TRAP_HEAD.subtitleSize, fontWeight: 700, letterSpacing: "0.12em", color: t.muted }}>{"AI VARIANT · EXAMINER'S TRAP"}</div>
      </div>
      <div style={{ display: "flex", fontSize: L.stemSize, fontWeight: 700, lineHeight: 1.28, marginBottom: 20 }}>{trap.question}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {trap.options.map((o) => {
          const correct = o.label === trap.correct;
          const tempting = o.label === trap.tempting;
          return (
            <div
              key={o.label}
              style={sx({
                display: "flex",
                alignItems: "center",
                gap: 18,
                padding: "12px 22px",
                background: hw(t) ? "transparent" : correct ? t.correctSoft : tempting ? t.highlightSoft : t.card,
                border: `${hw(t) ? 3 : 2}px ${hw(t) && !correct && !tempting ? "dashed" : "solid"} ${correct ? t.correct : tempting ? red : t.border}`,
                borderRadius: hwRadius(t),
              })}
            >
              <div style={sx({ display: "flex", flexShrink: 0, width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, background: hw(t) ? "transparent" : t.bubble, border: hw(t) ? `3px solid ${t.border}` : undefined })}>
                {o.label}
              </div>
              <div style={{ display: "flex", flex: 1, fontSize: L.optionSize, fontWeight: 500, lineHeight: 1.28 }}>{o.text}</div>
              {correct || tempting ? (
                <div style={{ display: "flex", width: 150, justifyContent: "flex-end", fontSize: 22, fontWeight: 700, color: correct ? t.correct : red }}>{correct ? "CORRECT" : "THE TRAP"}</div>
              ) : (
                <div style={{ display: "flex", width: 150 }} />
              )}
            </div>
          );
        })}
      </div>
      {[
        { label: "WHY IT TRAPS YOU", text: trap.trapExplanation, color: red },
        { label: "HOW TO AVOID IT", text: trap.avoidTip, color: t.correct },
      ].map((b, i) => (
        <div key={b.label} style={sx({ display: "flex", flexDirection: "column", marginTop: 16, padding: "22px 30px", border: `${hw(t) ? 3 : 2}px solid ${b.color}`, borderRadius: hwRadius(t), background: hw(t) ? "transparent" : t.card, transform: tilt(t, i + 3) })}>
          <Label text={b.label} color={b.color} t={t} />
          <div style={{ display: "flex", marginTop: 10, fontSize: L.noteSize, fontWeight: 500, lineHeight: 1.28 }}>{b.text}</div>
        </div>
      ))}
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
    case "DIAGRAM":
      return <DiagramSlide input={input} t={t} />;
    case "TRAP":
      return <TrapSlide input={input} t={t} />;
    default:
      return <TextSlide blocks={textBlocksFor(module, input.content)} input={input} t={t} />;
  }
}

/** Renders slide `index` (0-based) as JPEG. */
export async function renderSlideJpeg(raw: RenderInput, index: number, quality = 92): Promise<Buffer> {
  const input = sanitizeForRender(raw);
  const modules = input.design.modules;
  if (index < 0 || index >= modules.length) throw new Error("Slide index out of range.");
  const t = resolveTheme(input.design);
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
