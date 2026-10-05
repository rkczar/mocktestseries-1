import "server-only";
import katex from "katex";
import "katex/contrib/mhchem";
import type {
  AssetRole,
  AssetView,
  ContentFormat,
  ExplanationView,
  RenderedHtml,
  RenderedText,
  RichQuestionView,
} from "@/lib/rich-content-types";

/**
 * The ONE rich scientific-content renderer (NEET Phase 1). Server-only: KaTeX
 * runs here and students receive finished HTML + the self-hosted KaTeX CSS,
 * never a math runtime.
 *
 * RICH_V1 syntax, inside question text, option text and the explanation:
 *   $…$      inline math          $$…$$   display math
 *   \ce{…}   chemistry (mhchem), also inside math: $\ce{2H2 + O2 -> 2H2O}$
 *   \pu{…}   physical units (mhchem)
 *   \$       a literal dollar sign
 * An unclosed `$` / `$$` / `\ce{` is shown as literal text.
 *
 * PLAIN content never reaches this module's parser (renderText returns it
 * untouched), so a legacy question shows exactly what it shows today.
 *
 * SECURITY BOUNDARY: renderRichHtml is the only producer of RenderedHtml, the
 * only HTML a student page inserts with dangerouslySetInnerHTML. Text between
 * formulas is HTML-escaped here; formulas go through KaTeX with trust:false
 * (no \href, \url, \includegraphics, \html* commands), throwOnError:false
 * (a bad formula becomes an escaped error span, never a crash) and bounded
 * expansion/size. Stored HTML is never inserted as HTML.
 */

export const KATEX_OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: "warn",
  output: "htmlAndMathml",
  maxExpand: 500,
  maxSize: 20,
} as const;

type Segment = { kind: "text"; value: string } | { kind: "math"; value: string; display: boolean };

/** `\ce{` / `\pu{` at `i`: index of the matching `}`, or -1. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the closing `$` / `$$` for a formula whose body starts at `from`, or -1. */
function findClose(src: string, from: number, display: boolean): number {
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c !== "$") continue;
    if (!display) return j;
    if (src[j + 1] === "$") return j;
  }
  return -1;
}

export function parseRich(src: string): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", value: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && src[i + 1] === "$") {
      buf += "$";
      i += 2;
      continue;
    }
    if (c === "$") {
      const display = src[i + 1] === "$";
      const open = display ? 2 : 1;
      const close = findClose(src, i + open, display);
      const body = close < 0 ? "" : src.slice(i + open, close);
      if (close < 0 || body.trim() === "") {
        buf += src.slice(i, close < 0 ? i + open : close + open);
        i = close < 0 ? i + open : close + open;
        continue;
      }
      flush();
      out.push({ kind: "math", value: body, display });
      i = close + open;
      continue;
    }
    if (c === "\\" && (src.startsWith("\\ce{", i) || src.startsWith("\\pu{", i))) {
      const end = matchBrace(src, i + 3);
      if (end > 0) {
        flush();
        out.push({ kind: "math", value: src.slice(i, end + 1), display: false });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// KaTeX is fast, but a 180-question paper repeats the same formulas across
// resumes; a small bounded memo keeps re-renders cheap.
const MEMO_LIMIT = 5000;
const memo = new Map<string, string>();

function renderMath(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
  } catch {
    // throwOnError:false already turns parse errors into an error span; this
    // is the belt-and-braces path for anything else KaTeX might throw.
    html = `<span class="rich-math-error">${escapeHtml(tex)}</span>`;
  }
  const wrapped = display ? `<span class="rich-math-display">${html}</span>` : `<span class="rich-math">${html}</span>`;
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, wrapped);
  return wrapped;
}

export function renderRichHtml(src: string): RenderedHtml {
  return parseRich(src)
    .map((seg) => (seg.kind === "text" ? escapeHtml(seg.value) : renderMath(seg.value, seg.display)))
    .join("") as RenderedHtml;
}

export function isRichFormat(format: unknown): format is "RICH_V1" {
  return format === "RICH_V1";
}

/** PLAIN → the text itself (no parsing at all); RICH_V1 → rendered HTML. */
export function renderText(format: unknown, text: string): RenderedText {
  return isRichFormat(format) ? { format: "RICH_V1", html: renderRichHtml(text) } : { format: "PLAIN", text };
}

// ---------------------------------------------------------------------------
// Assets (QuestionAsset → snapshot → student view)
// ---------------------------------------------------------------------------

/** Public URL root for immutable media, served by nginx (ops/nginx/README.md). */
export const MEDIA_URL_PREFIX = "/media/";
const STORAGE_KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_.-]*)*\.(webp|png|jpe?g|avif)$/i;

/** storageKey → public URL; null for anything that isn't a safe relative raster path. */
export function assetUrl(storageKey: unknown): string | null {
  if (typeof storageKey !== "string" || !STORAGE_KEY.test(storageKey) || storageKey.includes("..")) return null;
  return MEDIA_URL_PREFIX + storageKey;
}

/** What snapshot v2 freezes for one asset. */
export interface SnapshotAsset {
  role: AssetRole;
  optionLabel: string | null;
  order: number;
  storageKey: string;
  url: string;
  alt: string;
  caption: string | null;
  width: number;
  height: number;
  darkBacking: boolean;
}

export interface AssetRowLike {
  role: string;
  optionLabel: string | null;
  order: number;
  storageKey: string;
  alt: string;
  caption: string | null;
  width: number;
  height: number;
  darkBacking: boolean;
}

const ROLE_RANK: Record<AssetRole, number> = { QUESTION: 0, OPTION: 1, EXPLANATION: 2 };

function isRole(v: unknown): v is AssetRole {
  return v === "QUESTION" || v === "OPTION" || v === "EXPLANATION";
}

export function toSnapshotAssets(rows: AssetRowLike[]): SnapshotAsset[] {
  return rows
    .filter((r) => isRole(r.role))
    .map((r) => ({ r, url: assetUrl(r.storageKey) }))
    .filter((x): x is { r: AssetRowLike; url: string } => x.url !== null)
    .map(({ r, url }) => ({
      role: r.role as AssetRole,
      optionLabel: r.role === "OPTION" ? r.optionLabel : null,
      order: r.order,
      storageKey: r.storageKey,
      url,
      alt: r.alt,
      caption: r.caption,
      width: r.width,
      height: r.height,
      darkBacking: r.darkBacking,
    }))
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || (a.optionLabel ?? "").localeCompare(b.optionLabel ?? "") || a.order - b.order);
}

/** Defensive read of snapshot assets: unknown/garbled entries are dropped, never thrown. */
export function readAssets(raw: unknown): AssetView[] {
  if (!Array.isArray(raw)) return [];
  const out: AssetView[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    if (!a || typeof a !== "object" || !isRole(a.role)) continue;
    const url = assetUrl(a.storageKey) ?? (typeof a.url === "string" && a.url.startsWith(MEDIA_URL_PREFIX) ? assetUrl(a.url.slice(MEDIA_URL_PREFIX.length)) : null);
    if (!url) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    out.push({
      role: a.role,
      optionLabel: a.role === "OPTION" && typeof a.optionLabel === "string" ? a.optionLabel : null,
      order: typeof a.order === "number" ? a.order : 0,
      url,
      alt: typeof a.alt === "string" ? a.alt : "",
      caption: typeof a.caption === "string" && a.caption ? a.caption : null,
      width: num(a.width),
      height: num(a.height),
      darkBacking: a.darkBacking !== false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot v2 views
// ---------------------------------------------------------------------------

/** The v2 keys of a frozen question snapshot; a snapshot without `v` is v1. */
export interface SnapshotV2Like {
  v?: unknown;
  contentFormat?: unknown;
  explanation?: unknown;
  assets?: unknown;
  text?: unknown;
  options?: unknown;
}

export function snapshotVersion(s: SnapshotV2Like | null | undefined): 1 | 2 {
  return s?.v === 2 ? 2 : 1;
}

/**
 * The RICH_V1 question body (text, option text, question/option images) for
 * a v2 snapshot, or null for v1 / PLAIN — whose rendering stays exactly as
 * before. Never includes the answer key or the explanation.
 */
export function richQuestionView(s: SnapshotV2Like | null | undefined): RichQuestionView | null {
  if (!s || snapshotVersion(s) !== 2 || !isRichFormat(s.contentFormat)) return null;
  const options = Array.isArray(s.options) ? (s.options as { label?: unknown; text?: unknown }[]) : [];
  const optionHtml: Record<string, RenderedHtml> = {};
  for (const o of options) {
    if (typeof o?.label === "string") optionHtml[o.label] = renderRichHtml(typeof o.text === "string" ? o.text : "");
  }
  return {
    textHtml: renderRichHtml(typeof s.text === "string" ? s.text : ""),
    optionHtml,
    assets: readAssets(s.assets).filter((a) => a.role !== "EXPLANATION"),
  };
}

/**
 * The human explanation of a v2 snapshot. Callers MUST have authorized the
 * answer reveal first (submitted review, or a server-revealed Practice Mode
 * question) — this is answer-key data, like correctLabel.
 */
export function explanationView(s: SnapshotV2Like | null | undefined): ExplanationView | null {
  if (!s || snapshotVersion(s) !== 2) return null;
  const text = typeof s.explanation === "string" && s.explanation.trim() ? s.explanation : null;
  const assets = readAssets(s.assets).filter((a) => a.role === "EXPLANATION");
  if (!text && assets.length === 0) return null;
  return { body: text ? renderText(s.contentFormat, text) : null, assets };
}

/** The same two views for a LIVE question row (Saved Questions, admin preview). */
export function liveRichViews(q: {
  contentFormat?: unknown;
  text: string;
  explanation?: string | null;
  options: { label: string; text: string }[];
  assets?: AssetRowLike[];
}): { rich: RichQuestionView | null; explanation: ExplanationView | null } {
  const rich = isRichFormat(q.contentFormat);
  const snapshotLike: SnapshotV2Like = {
    v: 2,
    contentFormat: q.contentFormat,
    text: q.text,
    options: q.options,
    explanation: q.explanation ?? null,
    assets: rich ? toSnapshotAssets(q.assets ?? []) : [],
  };
  return { rich: richQuestionView(snapshotLike), explanation: explanationView(snapshotLike) };
}

export type { ContentFormat };
