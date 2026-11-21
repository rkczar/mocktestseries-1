/**
 * Tables (synthetic, pure, no DB / AI): detection from positioned lines, rebuild as a pipe table, original crop kept,
 * `$` escaping, rich rendering as an HTML table, false positives (options in a row, two-column prose).
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-tables.ts
 */
import assert from "node:assert/strict";
import { detectTables, tableMarkdown } from "@/lib/ai-import/table-detect";
import { applyTables, parsePdfPageLocal } from "@/lib/ai-import/pdf-local";
import { renderRichHtml } from "@/lib/rich-content";
import { orderSegments, type Line } from "@/lib/ai-import/local-parse";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  console.log(`ok ${++n} ${name}`);
};
const H = 0.014;
/** One line of cells starting at the given x positions (y in page fractions). */
/** Table cells are short; a prose line (one piece) is as wide as its text. */
const row = (y: number, cells: [number, string][]): { text: string; box: { x: number; y: number; w: number; h: number } }[] => cells.map(([x, text]) => ({ text, box: { x, y, w: cells.length > 1 ? Math.min(0.12, text.length * 0.008) : Math.min(0.84, text.length * 0.008), h: H } }));
const asLine = (y: number, cells: [number, string][]): Line => {
  const segs = row(y, cells);
  return { text: segs.map((s) => s.text).join("  "), y, h: H, x: segs[0].box.x, column: 0, segs };
};

const LAB: [number, string][][] = [
  [[0.1, "Test"], [0.35, "Patient"], [0.6, "Reference"]],
  [[0.1, "Haemoglobin"], [0.35, "8.2 g/dL"], [0.6, "13-17 g/dL"]],
  [[0.1, "MCV"], [0.35, "68 fL"], [0.6, "80-100 fL"]],
  [[0.1, "Ferritin"], [0.35, "6 ng/mL"], [0.6, "30-400 ng/mL"]],
];

t("lab table: 4 rows × 3 columns, cells exact, box covers the rows", () => {
  const lines = LAB.map((r, i) => asLine(0.3 + i * 0.022, r));
  const [tb] = detectTables(lines);
  assert.deepEqual(tb.rows, [["Test", "Patient", "Reference"], ["Haemoglobin", "8.2 g/dL", "13-17 g/dL"], ["MCV", "68 fL", "80-100 fL"], ["Ferritin", "6 ng/mL", "30-400 ng/mL"]]);
  assert.ok(tb.box.y < 0.3 && tb.box.y + tb.box.h > 0.3 + 3 * 0.022);
});
t("options laid out in a row are NOT a table", () => {
  const lines = [0, 1, 2].map((i) => asLine(0.3 + i * 0.022, [[0.1, `(a) choice ${i}`], [0.5, `(b) other ${i}`]]));
  assert.equal(detectTables(lines).length, 0);
});
t("two lines are not enough for a table", () => assert.equal(detectTables(LAB.slice(0, 2).map((r, i) => asLine(0.3 + i * 0.022, r))).length, 0));
t("prose with one piece per line is not a table", () => assert.equal(detectTables([0, 1, 2, 3].map((i) => asLine(0.3 + i * 0.022, [[0.1, `A long sentence of a clinical case ${i}`]]))).length, 0));
t("rows far apart vertically are separate (no table)", () => assert.equal(detectTables(LAB.slice(0, 3).map((r, i) => asLine(0.1 + i * 0.2, r))).length, 0));
t("a missing cell keeps its column (empty cell, nothing shifted)", () => {
  const rows = [...LAB.slice(0, 3), [[0.1, "Iron"], [0.6, "60-170"]] as [number, string][]];
  const [tb] = detectTables(rows.map((r, i) => asLine(0.3 + i * 0.022, r)));
  assert.deepEqual(tb.rows[3], ["Iron", "", "60-170"]);
});
t("tableMarkdown escapes | inside a cell", () => assert.equal(tableMarkdown([["a|b", "c"], ["1", "2"]]), "| a\\|b | c |\n|---|---|\n| 1 | 2 |"));

t("full page: question with a lab table → rich table in the stem, crop kept, options intact, flagged", () => {
  const lines = [
    ...row(0.2, [[0.08, "12. A 30-year-old woman has fatigue. Her results:"]]),
    ...LAB.flatMap((r, i) => row(0.23 + i * 0.022, r)),
    ...row(0.33, [[0.08, "What is the most likely diagnosis? Cost $5"]]),
    ...row(0.36, [[0.08, "(a) Iron deficiency"]]),
    ...row(0.38, [[0.08, "(b) Thalassaemia trait"]]),
    ...row(0.4, [[0.08, "(c) Anaemia of chronic disease"]]),
    ...row(0.42, [[0.08, "(d) Sideroblastic anaemia"]]),
  ];
  const page = parsePdfPageLocal({ lines, images: [] }, 3, { last: 11, sectionIdx: 1 });
  const q = page.questions.find((x) => x.number === 12)!;
  assert.ok(q, JSON.stringify(page.questions.map((x) => x.number)));
  assert.equal(q.contentFormat, "RICH_V1");
  assert.ok(q.stem.includes("| Test | Patient | Reference |\n|---|---|---|\n| Haemoglobin | 8.2 g/dL | 13-17 g/dL |"), q.stem);
  assert.ok(q.stem.includes("Cost \\$5"), "a literal $ stays text");
  assert.equal(q.options.length, 4);
  assert.ok(q.figures.some((f) => f.description?.startsWith("Original table crop") && f.box));
  assert.ok(q.notes!.some((x) => /kept row by row as a table/.test(x)));
  const html = renderRichHtml(q.stem);
  assert.ok(html.includes('<table class="rich-table"><thead><tr><th>Test</th><th>Patient</th><th>Reference</th></tr></thead>'), html);
  assert.ok(html.includes("<td>8.2 g/dL</td>") && html.includes("Cost $5") && !html.includes("katex"));
});

t("table token not in the stem (landed in an option): cells put back as text, crop shown, low confidence", () => {
  const q = { stem: "Stem", options: [{ label: "A", text: "x ⟦TABLE:0⟧" }], contentFormat: "PLAIN", figures: [], notes: [], confidence: 0.95 } as unknown as ExtractedQuestion;
  applyTables(q, detectTables(LAB.map((r, i) => asLine(0.3 + i * 0.022, r))), 2);
  assert.equal(q.stem, "Stem");
  assert.ok(q.options[0].text.includes("Haemoglobin  8.2 g/dL") && !q.options[0].text.includes("⟦"));
  assert.equal(q.contentFormat, "PLAIN");
  assert.equal(q.figures.length, 1);
  assert.ok(q.confidence <= 0.6);
});

t("renderer: math inside a table cell, escaping of HTML, non-table | lines stay text", () => {
  const html = renderRichHtml("| Ion | Value |\n|---|---|\n| $Na^+$ | <b>130</b> |\nratio a | b");
  assert.ok(html.includes("katex") && html.includes("&lt;b&gt;130&lt;/b&gt;") && html.endsWith("ratio a | b"));
  assert.equal(renderRichHtml("a | b |\n| c |"), "a | b |\n| c |");
});
t("renderer: text without tables is byte-identical to before (no regression)", () => {
  const src = "Line 1\nLine 2 with $x^2$ and \\$5";
  assert.ok(renderRichHtml(src).startsWith("Line 1\nLine 2 with "));
});
t("two-column page (running text both sides) is still read column by column", () => {
  const segs = [0, 1, 2, 3, 4, 5].flatMap((i) => [
    { text: `Left column line ${i} of a clinical vignette text`, box: { x: 0.06, y: 0.1 + i * 0.03, w: 0.4, h: H } },
    { text: `Right column line ${i} of another question text`, box: { x: 0.53, y: 0.1 + i * 0.03, w: 0.4, h: H } },
  ]);
  const lines = orderSegments(segs);
  assert.equal(lines.filter((l) => l.column === 1).length, 6);
  assert.ok(lines[5].text.startsWith("Left column line 5") && lines[6].text.startsWith("Right column line 0"));
});
t("one-column page with a 3-column table is NOT split into two columns", () => {
  const segs = [...row(0.1, [[0.08, "1. A long question stem that runs across the whole page width here"]]), ...LAB.flatMap((r, i) => row(0.14 + i * 0.022, r)), ...row(0.26, [[0.08, "Which statement about these results is correct overall?"]])];
  assert.ok(orderSegments(segs).every((l) => l.column === 0));
});
console.log(`\n${n}/${n} passed`);
