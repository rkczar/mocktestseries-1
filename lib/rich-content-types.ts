/**
 * Serializable shapes for rich scientific content (NEET Phase 1), shared by
 * the server renderer (lib/rich-content.ts) and the client components that
 * display its output (components/content/*). No KaTeX here: importing this
 * file never ships a math runtime to the browser.
 */

export type ContentFormat = "PLAIN" | "RICH_V1";
export type AssetRole = "QUESTION" | "OPTION" | "EXPLANATION";

/**
 * HTML produced ONLY by lib/rich-content.ts#renderRichHtml (escaped text +
 * KaTeX output with trust:false). The brand stops a plain string — e.g. a
 * stored field — from being passed to <RichText html> by accident.
 */
export type RenderedHtml = string & { readonly __renderedByRichContent: true };

/** One image as a student sees it (resolved from a QuestionAsset / snapshot v2 asset). */
export interface AssetView {
  role: AssetRole;
  optionLabel: string | null;
  order: number;
  url: string;
  alt: string;
  caption: string | null;
  width: number;
  height: number;
  darkBacking: boolean;
}

/**
 * A rendered text field: PLAIN text is shown verbatim as a React text node
 * (today's behavior), RICH_V1 as pre-rendered HTML.
 */
export type RenderedText = { format: "PLAIN"; text: string } | { format: "RICH_V1"; html: RenderedHtml };

/** The human-authored explanation, released only with the answer key. */
export interface ExplanationView {
  body: RenderedText | null;
  assets: AssetView[];
}

/** RICH_V1 question body for the player/review: no answer key, no explanation. */
export interface RichQuestionView {
  textHtml: RenderedHtml;
  optionHtml: Record<string, RenderedHtml>;
  /** QUESTION and OPTION assets only — EXPLANATION assets travel with the explanation. */
  assets: AssetView[];
}
