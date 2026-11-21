/**
 * Importer upgrade — browser suite (scratch server on mts_va, loopback mocks, synthetic data; never real AI or prod).
 * Verify Answers beside Verify 2 (price confirmation, Key check only, full run with the mock model, question-wise
 * report, history), tables in the student preview, Original vs Extracted, cost dashboard, OpenAI-direct switch;
 * desktop 1366 px and phone 390 px (no sideways page scroll). Screenshots → $SHOTS.
 *   BASE=http://127.0.0.1:3591 FIXTURE=/root/mts-scratch/va/ui-fixture.json MOCK=http://127.0.0.1:3571 SHOTS=<dir> \
 *   DATABASE_URL=<scratch mts_va> NODE_PATH=/root/.claude/skills/gstack/node_modules node scripts/verify-importer-upgrade-ui.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
if (!/\/mts_va(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing: DATABASE_URL is not the scratch mts_va database.");
  process.exit(2);
}
const { BASE, MOCK, SHOTS } = process.env;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
mkdirSync(SHOTS, { recursive: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const chats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()).chat;
const vaState = async (id) => (await db.query(`select status, config->'verifyAnswers'->>'status' as va from "AiImportJob" where id=$1`, [id])).rows[0];
async function waitDone(id, ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    const s = await vaState(id);
    if (s.status === "NEEDS_REVIEW" && (s.va === "DONE" || s.va === "STOPPED")) return s;
    if (Date.now() - t0 > ms) return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const browser = await chromium.launch();
async function session(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", F.adminUser);
  await page.fill("input[name=password]", F.password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  return page;
}

try {
  const page = await session({ width: 1366, height: 900 });
  const bar = `${BASE}/admin/ai-importer/exceptions?job=${F.jobId}`;

  console.log("\n=== Verify Answers button beside Verify 2 (desktop)");
  await page.goto(bar);
  const v2 = page.getByTestId("verify2");
  const va = page.getByTestId("verify-answers");
  await va.waitFor();
  const [b2, bva] = [await v2.boundingBox(), await va.boundingBox()];
  check("Verify Answers is on the same row, right of Verify 2", Math.abs(b2.y - bva.y) < 8 && bva.x > b2.x, { b2, bva });
  await shot(page, "01-desktop-verify-bar");

  console.log("\n=== Price confirmation (nothing sent)");
  const c0 = await chats();
  let chosen = "";
  await va.click();
  const dlg = page.getByTestId("verify-answers-preview");
  await dlg.waitFor();
  // No model chosen yet: the cheapest eligible text model is preselected (an admin can pick another).
  chosen = await page.getByTestId("verify-answers-model").inputValue();
  check("preview: 8 questions to ask, an eligible model preselected", (await page.getByTestId("va-to-ask").textContent()) === "8" && /^mock/.test(chosen), chosen);
  check("preview shows an estimate and a maximum in ₹", /₹\d/.test(await page.getByTestId("va-estimate").textContent()));
  check("opening the price sent no AI request", (await chats()) === c0);
  await shot(page, "02-desktop-price-confirmation");

  console.log("\n=== Key check only (₹0)");
  await page.getByTestId("verify-answers-key-only").click();
  await page.getByTestId("verify-answers-msg").waitFor();
  const s1 = await waitDone(F.jobId);
  check("key-only run finished", s1.va === "DONE", s1);
  check("key-only sent no AI request", (await chats()) === c0);
  await page.goto(`${BASE}/admin/ai-importer/answers?job=${F.jobId}&va=1`);
  const count = async (c) => Number(await page.locator(`[data-testid=va-counts] [data-category=${c}]`).getAttribute("data-count"));
  check("key-only report: 4 mapped, 1 missing, 1 incorrect, 1 duplicate, 1 withdrawn, 0 AI disagreements", (await count("CONFIRMED")) === 4 && (await count("MISSING")) === 1 && (await count("INCORRECT_MAPPING")) === 1 && (await count("DUPLICATE")) === 1 && (await count("WITHDRAWN")) === 1 && (await count("AI_DISAGREES")) === 0);
  check("history: 1 run (key check only)", (await page.locator("[data-testid=va-history] li").count()) === 1);

  console.log("\n=== Full verification with the mock model");
  await page.goto(bar);
  await page.getByTestId("verify-answers").click();
  await page.getByTestId("verify-answers-confirm").waitFor();
  const label = await page.getByTestId("verify-answers-confirm").textContent();
  check("confirm button states the maximum", /Confirm & Continue \(max ₹/.test(label), label);
  await page.getByTestId("verify-answers-confirm").click();
  await page.getByTestId("verify-answers-msg").waitFor();
  const s2 = await waitDone(F.jobId);
  check("AI run finished", s2.va === "DONE", s2);
  check("8 AI requests sent to the mock (one per question)", (await chats()) - c0 === 8, (await chats()) - c0);

  console.log("\n=== Question-wise results + history");
  await page.goto(`${BASE}/admin/ai-importer/answers?job=${F.jobId}&va=1`);
  check("report: 2 AI disagreements (Q2 different answer, Q7 defective), 2 confirmed", (await count("AI_DISAGREES")) === 2 && (await count("CONFIRMED")) === 2);
  const q2 = page.locator("[data-testid=va-row]").filter({ hasText: "Q2" }).first();
  const q2t = await q2.textContent();
  check("Q2 row: AI disagrees, official B kept, AI answer C shown with its model", (await q2.getAttribute("data-category")) === "AI_DISAGREES" && q2t.includes("B / B") && new RegExp(`C \\(80%, ${chosen.replace("/", "\\/")}\\)`).test(q2t), q2t);
  check("history: 2 runs", (await page.locator("[data-testid=va-history] li").count()) === 2);
  const saved = (await db.query(`select "finalAnswer" from "AiImportQuestion" where "jobId"=$1 and "sourceNumber"=2`, [F.jobId])).rows[0].finalAnswer;
  check("official / saved answer unchanged after the AI disagreement", JSON.stringify(saved) === '["B"]', saved);
  await shot(page, "03-desktop-va-report");

  console.log("\n=== Table + Original vs Extracted (question review)");
  await page.goto(`${BASE}/admin/ai-importer/questions/${F.tableQuestionId}`);
  const table = page.locator("table.rich-table").first();
  await table.waitFor();
  check("student preview renders a real table (header + 3 rows)", (await table.locator("th").allTextContents()).join("|") === "Test|Patient|Reference" && (await table.locator("tbody tr").count()) === 3);
  const src = await page.getByTestId("source-text").textContent();
  check("Original Markdown shown exactly beside the extracted question", src.includes("| Haemoglobin | 8.2 g/dL | 13-17 g/dL |") && src.includes("Original text exactly as in the file"));
  await shot(page, "04-desktop-table-original-vs-extracted");
  await page.goto(`${BASE}/admin/ai-importer/questions/${F.ocrQuestionId}`);
  const ocr = await page.getByTestId("source-text").textContent();
  check("OCR question: raw OCR reading shown (numbered statements kept)", ocr.includes("1. Statement one is about the kidney.") && ocr.includes("OCR reading as read"), ocr.slice(0, 120));

  console.log("\n=== Cost dashboard");
  await page.goto(`${BASE}/admin/ai-importer/costs`);
  const models = await page.getByTestId("cost-models").textContent();
  check("model-wise row for the model used, via OpenRouter, with tokens", models.includes(chosen) && models.includes("OpenRouter"));
  check("by-step lists verify-answers", (await page.getByTestId("cost-stages").textContent()).includes("verify-answers"));
  await shot(page, "05-desktop-costs");

  console.log("\n=== OpenAI direct switch (settings)");
  await page.goto(`${BASE}/admin/ai-importer/settings`);
  const sw = page.getByTestId("openai-direct");
  check("Import Settings has the OpenAI-direct switch, off by default", (await sw.count()) === 1 && !(await sw.isChecked()));
  const html = await page.content();
  check("no API key value rendered on the settings page", !/sk-(?:or-v1-mock|mock-openai)/.test(html));

  console.log("\n=== Phone 390 px");
  const m = await session({ width: 390, height: 844 });
  await m.goto(bar);
  await m.getByTestId("verify-answers").waitFor();
  check("phone: Verify Answers visible, no sideways page scroll (bar)", (await m.getByTestId("verify-answers").isVisible()) && (await noSideScroll(m)));
  await m.getByTestId("verify-answers").click();
  await m.getByTestId("verify-answers-preview").waitFor();
  check("phone: price dialog fits (no sideways scroll)", await noSideScroll(m));
  await shot(m, "06-phone-verify-bar-price");
  await m.goto(`${BASE}/admin/ai-importer/answers?job=${F.jobId}&va=1`);
  check("phone: report page — wide table scrolls inside its box, page does not", await noSideScroll(m));
  await shot(m, "07-phone-va-report");
  await m.goto(`${BASE}/admin/ai-importer/questions/${F.tableQuestionId}`);
  await m.locator("table.rich-table").first().waitFor();
  check("phone: question with table — no sideways page scroll", await noSideScroll(m));
  await shot(m, "08-phone-table-question");
} catch (e) {
  fail++;
  console.error(e);
} finally {
  await browser.close();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
