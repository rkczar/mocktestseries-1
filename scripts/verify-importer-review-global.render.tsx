/**
 * Student preview render check (with scripts/verify-importer-review-global.ts, which writes the previews):
 * renders the importer's preview data through the shared QuestionPreviewBody — the same RichText / QuestionMedia /
 * MatchLists the test player uses. No DB.
 *   PREVIEW_OUT=<json> … verify-importer-review-global.ts; npx tsx scripts/verify-importer-review-global.render.tsx <json>
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// QuestionPreviewBody is a Server Component ("server-only" via lib/rich-content), and react-dom/server refuses the
// react-server condition: neutralise the "server-only" marker for this test process only, then load both.
const req = createRequire(import.meta.url);
const marker = req.resolve("server-only");
req.cache[marker] = { id: marker, filename: marker, loaded: true, exports: {} } as never;

async function main() {
const { renderToStaticMarkup } = await import("react-dom/server");
const { QuestionPreviewBody } = await import("@/components/content/question-preview-body");
const [p1, p3] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const html1 = renderToStaticMarkup(<QuestionPreviewBody q={p1.q} assets={p1.assets} />);
assert.ok(html1.includes("Read carefully") && html1.includes("Costs"), "stem shown");
assert.ok(html1.includes("/api/admin/ai-importer/figures/f1/image"), "importer figure URL used");
assert.ok(["Opt A", "Opt B", "Opt C", "Opt D"].every((t) => html1.includes(t)), "all four options");
assert.equal((html1.match(/Correct answer/g) ?? []).length, 1, "exactly one correct answer marked");
assert.ok(/B\.<\/span>[\s\S]*?Correct answer/.test(html1), "B marked correct");
assert.ok(html1.includes("text-question"), "same stem class as the test player");
const html3 = renderToStaticMarkup(<QuestionPreviewBody q={p3.q} assets={p3.assets} />);
assert.ok(html3.includes("Heart") && html3.includes("Pump"), "match lists rendered");
console.log("PASS preview render: stem, importer figure, 4 options, one correct answer, test-player stem class, match lists");
}

main();
