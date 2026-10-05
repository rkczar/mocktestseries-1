import type { RenderedHtml, RenderedText } from "@/lib/rich-content-types";

/**
 * Displays text produced by the one server renderer (lib/rich-content.ts).
 * Safe in server and client components: it holds no KaTeX code, only the
 * finished HTML.
 *
 *  - PLAIN (`text`, or `content.format === "PLAIN"`): rendered as a React text
 *    node, exactly like the `{question.text}` it replaces. `$`, `\ce{}`, LaTeX
 *    and HTML are shown literally.
 *  - RICH_V1 (`html`): inserted as HTML. The value is a RenderedHtml, which
 *    only renderRichHtml produces (escaped text + KaTeX with trust:false) —
 *    never a stored field.
 *
 * The KaTeX stylesheet (self-hosted, fonts load only for glyphs in use) and
 * the layout rules are attached only when RICH_V1 content is on the page, so
 * PLAIN-only pages are unchanged.
 */
export function RichText(props: { text: string; html?: RenderedHtml | null } | { content: RenderedText }) {
  const html = "content" in props ? (props.content.format === "RICH_V1" ? props.content.html : null) : props.html;
  const text = "content" in props ? (props.content.format === "PLAIN" ? props.content.text : "") : props.text;
  if (!html) return <>{text}</>;
  return (
    <>
      <RichContentStyles />
      <span className="rich-text" data-rich="v1" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

export const KATEX_STYLESHEET = "/vendor/katex-0.16.47/katex.min.css";

/**
 * React 19 hoists these into <head> and de-duplicates them by href, however
 * many RichText blocks a page renders.
 */
export function RichContentStyles() {
  return (
    <>
      <link rel="stylesheet" href={KATEX_STYLESHEET} precedence="default" />
      <style href="mts-rich-text" precedence="default">{RICH_TEXT_CSS}</style>
    </>
  );
}

// Long formulas scroll sideways inside their own box instead of widening the
// page on a phone; display math keeps its own line. KaTeX inherits the text
// color, so it follows light/dark themes.
const RICH_TEXT_CSS = `
.rich-text .rich-math{display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden;vertical-align:middle;padding:0.1em 0}
.rich-text .rich-math-display{display:block;max-width:100%;overflow-x:auto;overflow-y:hidden;padding:0.25em 0}
.rich-text .rich-math-display .katex-display{margin:0.4em 0}
.rich-text .katex{font-size:1.08em}
.rich-text .katex-error,.rich-text .rich-math-error{color:var(--color-error);white-space:pre-wrap;font-family:var(--font-mono,monospace);font-size:0.9em}
`;
