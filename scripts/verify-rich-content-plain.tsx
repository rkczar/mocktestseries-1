/**
 * NEET Phase 1 — PLAIN backward compatibility at the markup level.
 *
 * Every render site now writes `<RichText text={…} html={rich?.…} />` where it
 * used to write `{text}`. For a PLAIN question `html` is undefined, and this
 * proves the server-rendered HTML is byte-for-byte what the old JSX produced,
 * for legacy text full of `$`, `\ce{}`, LaTeX, HTML and unusual characters,
 * and that no KaTeX stylesheet is attached to a PLAIN-only page.
 *
 *   npx tsx scripts/verify-rich-content-plain.tsx      (no DB, no react-server condition)
 */
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { RichText } from "@/components/content/rich-text";
import { HumanExplanation } from "@/components/content/human-explanation";
import type { RenderedHtml } from "@/lib/rich-content-types";
import { PLAIN_TRICKY } from "./rich-content-fixtures";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!passed) failures++;
}

const samples = [
  PLAIN_TRICKY,
  "",
  " ",
  "Simple RUHS MO question about the brachial plexus?",
  "$",
  "$$",
  "$x$",
  "\\ce{H2O}",
  "<script>alert(1)</script>",
  "&amp; &lt; &#39;",
  "Line 1\n\nLine 3",
  "Emoji 🧪 and Devanagari परीक्षा",
  "{{ template }} ${notTemplate}",
];

const sites: { name: string; old: (t: string) => React.ReactElement; now: (t: string) => React.ReactElement }[] = [
  {
    name: "player question text",
    old: (t) => <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">{t}</p>,
    now: (t) => (
      <p className="whitespace-pre-wrap text-question text-[var(--color-foreground)]">
        <RichText text={t} html={undefined} />
      </p>
    ),
  },
  {
    name: "option label + text",
    old: (t) => (
      <span className="min-w-0 text-sm">
        <span className="font-semibold">A.</span> {t}
        {null}
      </span>
    ),
    now: (t) => (
      <span className="min-w-0 text-sm">
        <span className="font-semibold">A.</span> <RichText text={t} html={undefined} />
        {null}
        {null}
      </span>
    ),
  },
  {
    name: "Correct Answer line",
    old: (t) => (
      <p>
        Correct Answer: {"A"}. {t}
      </p>
    ),
    now: (t) => (
      <p>
        Correct Answer: {"A"}. <RichText text={t} html={null} />
      </p>
    ),
  },
  {
    name: "admin mock preview option",
    old: (t) => (
      <li>
        {"A"}. {t} {"✓"}
      </li>
    ),
    now: (t) => (
      <li>
        {"A"}. <RichText text={t} html={undefined} /> {"✓"}
      </li>
    ),
  },
];

console.log("\n--- PLAIN markup is byte-identical at every render site ---");
for (const site of sites) {
  let allSame = true;
  let firstDiff: unknown;
  for (const t of samples) {
    for (const render of [renderToString, renderToStaticMarkup]) {
      const a = render(site.old(t));
      const b = render(site.now(t));
      if (a !== b) {
        allSame = false;
        firstDiff ??= { sample: t, old: a, now: b };
      }
    }
  }
  check(`${site.name}: ${samples.length} samples identical (renderToString + static)`, allSame, firstDiff);
}

console.log("\n--- PLAIN never becomes HTML ---");
const html = renderToString(<RichText text={"<b>x</b> $y$"} />);
check("tags in PLAIN text are escaped", html === "&lt;b&gt;x&lt;/b&gt; $y$", html);
check("no KaTeX stylesheet / rich-text style for PLAIN", !html.includes("katex") && !html.includes("<link") && !html.includes("<style"));
const plainContent = renderToString(<RichText content={{ format: "PLAIN", text: "$\\frac{1}{2}$" }} />);
check("content={{format:PLAIN}} is literal", plainContent === "$\\frac{1}{2}$", plainContent);

console.log("\n--- RICH_V1 attaches the self-hosted stylesheet ---");
const rich = renderToStaticMarkup(<RichText text="ignored" html={'<span class="rich-math">x</span>' as RenderedHtml} />);
check("RICH output is the rendered HTML inside span.rich-text", rich.includes('<span class="rich-text" data-rich="v1"><span class="rich-math">x</span></span>'), rich);
check("KaTeX CSS is the self-hosted versioned file", rich.includes('href="/vendor/katex-0.16.47/katex.min.css"'), rich);
const expl = renderToStaticMarkup(<HumanExplanation explanation={{ body: { format: "PLAIN", text: "<i>plain</i> $x$" }, assets: [] }} />);
check("HumanExplanation renders a PLAIN body literally", expl.includes("&lt;i&gt;plain&lt;/i&gt; $x$") && !expl.includes("katex"), expl);

console.log(failures === 0 ? "\nALL PLAIN-COMPATIBILITY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
