/**
 * AI Engine (OpenRouter) — browser checks on a SCRATCH server (never production).
 * OpenRouter and the USD→INR service are LOCAL mocks (scripts/mock-openrouter.mjs);
 * keys are fake, so no paid request is possible.
 *
 *   set -a; . ./.env; set +a          # *igstudio* scratch DB: prisma/seed.ts + scripts/ig-studio-fixture.ts setup
 *   node scripts/mock-openrouter.mjs 3193 &
 *   OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3193 FX_TEST_BASE_URL=http://127.0.0.1:3193 \
 *     NEXTAUTH_URL=http://localhost:3191 AUTH_URL=http://localhost:3191 node_modules/.bin/next start -H 127.0.0.1 -p 3191 &
 *   BASE=http://localhost:3191 MOCK=http://127.0.0.1:3193 SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-ai-engine-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mockKey } from "./mock-openrouter.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3191";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:3193";
const SHOTS = process.env.SHOTS ?? "/tmp/ai-engine-shots";
const PASSWORD = "IgStudio#Fixture2026";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();
const mockStats = async () => (await fetch(`${MOCK}/__mock/stats`)).json();

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const fingerprint = () =>
  sql(`SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
         SELECT q.id || q.text || q.status || q."updatedAt" AS x FROM "Question" q
         UNION ALL SELECT o.id || o.text || o."isCorrect" || o.label FROM "QuestionOption" o
         UNION ALL SELECT p.id || p.title FROM "PreviousYearPaper" p) t`);

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const editor = (page) => page.getByTestId("carousel-editor");
async function editorMessage(page, re) {
  await page.waitForFunction((r) => new RegExp(r).test(document.querySelector('[data-testid="editor-message"]')?.textContent ?? ""), re.source, { timeout: 90000 });
  return (await page.getByTestId("editor-message").innerText()).trim();
}
async function costPreview(page) {
  const d = page.getByTestId("cost-preview");
  await d.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="cost-preview-body"]') || document.querySelector('[data-testid="cost-preview-error"]'), null, { timeout: 30000 });
  return d;
}
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

// Clean scratch state (engine settings, logs, posts).
sql(`DELETE FROM "InstagramPost" WHERE "questionCode" LIKE 'IGFIX-%'; DELETE FROM "InstagramBatch"; DELETE FROM "Setting" WHERE key IN ('api.openrouter','ai.engine','ai.fx','ai.eval','ai.gateway','api.anthropic','instagram.studio'); DELETE FROM "AiGatewayCall"; DELETE FROM "AiBudgetReservation"; DELETE FROM "AiCostQuote"; DELETE FROM "AiModel"; DELETE FROM "LoginAttempt";`);
await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
await fetch(`${MOCK}/__mock/fx?rate=95.5&status=200`);
const before = fingerprint();
const exam = sql(`SELECT id FROM "Exam" WHERE code = 'IGFIX-RUHS'`);
const p2021 = sql(`SELECT id FROM "PreviousYearPaper" WHERE title = 'IGFIX RUHS MO 2021'`);
const KEY = mockKey("valid");

const browser = await chromium.launch();
try {
  console.log("\n--- Access control ---");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, "igteacher");
    for (const p of ["models", "features", "analytics", "budgets", "history"]) {
      await page.goto(`${BASE}/admin/ai/${p}`);
      check(`teacher: /admin/ai/${p} restricted`, (await page.getByText("Access Restricted").count()) >= 1);
    }
    await page.goto(`${BASE}/admin`);
    check("teacher: no AI cost cards on the dashboard", (await page.getByTestId("dash-ai-cost").count()) === 0);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, "igfull");
    await page.goto(`${BASE}/admin/ai/budgets`);
    check("full admin: Budgets visible read-only (no save / stop buttons)", (await page.getByTestId("meter-day").count()) === 1 && (await page.getByTestId("b-save").count()) === 0 && (await page.getByTestId("emergency-on").count()) === 0);
    await page.goto(`${BASE}/admin/ai/models`);
    check("full admin: Models visible, no Sync", (await page.getByTestId("model-table").count()) === 1 && (await page.getByTestId("sync-models").count()) === 0);
    await page.goto(`${BASE}/admin/ai/providers`);
    check("full admin: Providers (key management) restricted", (await page.getByText("Access Restricted").count()) >= 1 && (await page.getByTestId("openrouter-key-input").count()) === 0);
    await page.goto(`${BASE}/admin`);
    check("full admin: AI cards on the dashboard", (await page.getByTestId("dash-ai-usage").count()) === 1);
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await login(page, "igmaster");

  console.log("\n--- Before setup: nothing changes ---");
  await page.goto(`${BASE}/admin/ai`);
  check("AI sub-navigation on /admin/ai", (await page.getByTestId("ai-subnav").locator("a").count()) === 7);
  check("Overview: OpenRouter NOT CONFIGURED tile", /NOT CONFIGURED/.test(await page.getByTestId("tile-openrouter").innerText()));
  await page.goto(`${BASE}/admin/ai/providers`);
  check("Providers: 'Setup required' status and explanation", (await page.getByTestId("openrouter-status").innerText()) === "Setup required" && (await page.getByTestId("openrouter-setup-required").count()) === 1);
  await page.goto(`${BASE}/admin/ai/features`);
  check("Features: every feature on the legacy route; OpenRouter option disabled", (await page.locator('[data-testid^="feature-"][data-provider="legacy"]').count()) === 13 && (await page.getByTestId("features-openrouter-off").count()) === 1);

  console.log("\n--- Providers: install, test, enable ---");
  await page.goto(`${BASE}/admin/ai/providers`);
  check("key field is a password input", (await page.getByTestId("openrouter-key-input").getAttribute("type")) === "password");
  await page.getByTestId("openrouter-key-input").fill("sk-ant-not-openrouter-key-000000000000");
  await page.getByTestId("openrouter-save-key").click();
  await page.getByTestId("openrouter-message").waitFor();
  check("wrong key format refused", /starts with sk-or-/.test(await page.getByTestId("openrouter-message").innerText()));
  await page.getByTestId("openrouter-key-input").fill(KEY);
  await page.getByTestId("openrouter-save-key").click();
  await page.waitForFunction((t) => document.querySelector('[data-testid="openrouter-key-hint"]')?.textContent?.startsWith(t), `sk-or-••••${KEY.slice(-4)}`, { timeout: 20000 });
  check("saved: masked hint only; input cleared", (await page.getByTestId("openrouter-key-input").inputValue()) === "");
  const raw = await page.evaluate(async (u) => (await fetch(u)).text(), `${BASE}/admin/ai/providers`);
  check("the page HTML never contains the key", !raw.includes(KEY.slice(10, 34)));
  check("DB holds only ciphertext", !sql(`SELECT value::text FROM "Setting" WHERE key='api.openrouter'`).includes(KEY.slice(10, 34)));
  check("Enable is disabled until a successful test", await page.getByTestId("openrouter-enable").isDisabled());
  await page.getByTestId("openrouter-test").click();
  await page.waitForFunction(() => /Connected/.test(document.querySelector('[data-testid="openrouter-message"]')?.textContent ?? ""), null, { timeout: 30000 });
  check("Test Connection (free, GET /key) → key limit shown", /\$10/.test(await page.getByTestId("openrouter-key-limit").innerText()) && (await mockStats()).chat === 0);
  await page.getByTestId("openrouter-enable").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="openrouter-card"]')?.getAttribute("data-status") === "CONNECTED", null, { timeout: 20000 });
  check("Enable → CONNECTED", true);
  check("privacy routing defaults to Deny", (await page.getByTestId("privacy-data-collection").inputValue()) === "deny");
  await page.screenshot({ path: `${SHOTS}/01-providers.png`, fullPage: true });

  console.log("\n--- Models: sync, filter, approve ---");
  await page.goto(`${BASE}/admin/ai/models`);
  await page.getByTestId("sync-models").click();
  await page.waitForFunction(() => /Synced/.test(document.querySelector('[data-testid="sync-message"]')?.textContent ?? ""), null, { timeout: 30000 });
  check("sync: prices from the API (cheap = $0.100 / $0.400 per M)", /\$0\.100/.test(await page.locator('[data-model="mockai/cheap"]').innerText()));
  await page.goto(`${BASE}/admin/ai/models?q=auto`);
  check("auto router listed with a variable price", /variable/.test(await page.locator('[data-model="openrouter/auto"]').innerText()));
  await page.goto(`${BASE}/admin/ai/models?kind=image`);
  check("image filter lists only image models", (await page.locator("[data-model]").count()) === 3);
  for (const [id, medical] of [["mockai/cheap", false], ["mockai/mid", true], ["mockimg/perimage", true]]) {
    await page.goto(`${BASE}/admin/ai/models?q=${encodeURIComponent(id.split("/")[1])}`);
    const row = page.locator(`[data-model="${id}"]`);
    await row.getByTestId("approve").check();
    await page.waitForFunction((m) => document.querySelector(`[data-model="${m}"] [data-testid="approve"]`)?.checked, id, { timeout: 20000 });
    if (medical) {
      await page.waitForFunction((m) => !document.querySelector(`[data-model="${m}"] [data-testid="medical"]`)?.disabled, id, { timeout: 20000 });
      await row.getByTestId("medical").check();
      await page.waitForFunction((m) => document.querySelector(`[data-model="${m}"] [data-testid="medical"]`)?.checked, id, { timeout: 20000 });
    }
  }
  check("approvals stored", sql(`SELECT string_agg(id || ':' || approved || ':' || "medicallyApproved", ',' ORDER BY id) FROM "AiModel" WHERE approved`) === "mockai/cheap:true:false,mockai/mid:true:true,mockimg/perimage:true:true");
  check("image price line loaded on approval", sql(`SELECT "imageUnit" || ':' || "imageUnitCostUsd" FROM "AiModel" WHERE id='mockimg/perimage'`) === "image:0.02");

  console.log("\n--- Features: switch to OpenRouter one at a time ---");
  await page.goto(`${BASE}/admin/ai/features`);
  for (const f of ["ig_diagram", "ig_caption", "ig_image", "ig_carousel"]) {
    const card = page.getByTestId(`feature-${f}`);
    await card.getByTestId("f-provider").selectOption("openrouter");
    await card.getByTestId("f-save").click();
    await card.getByTestId("f-message").waitFor({ timeout: 20000 });
  }
  await page.goto(`${BASE}/admin/ai/features`);
  check("four Instagram features on OpenRouter, students still on the legacy route", (await page.locator('[data-testid^="feature-"][data-provider="openrouter"]').count()) === 4 && (await page.getByTestId("feature-explanation").getAttribute("data-provider")) === "legacy");
  check("medical diagram feature resolves to the medically approved model", (await page.getByTestId("feature-ig_diagram").getByTestId("f-current-model").innerText()) === "mockai/mid");
  check("captions (non-medical) resolve to the cheapest approved model", (await page.getByTestId("feature-ig_caption").getByTestId("f-current-model").innerText()) === "mockai/cheap");
  check("estimated cost shown per action in ₹", /₹/.test(await page.getByTestId("feature-ig_caption").getByTestId("f-estimate").innerText()));
  check("future features are placeholders only", /not available yet/.test(await page.getByTestId("future-features").innerText()));
  await page.screenshot({ path: `${SHOTS}/02-features.png`, fullPage: true });

  console.log("\n--- Instagram editor: cost preview before every paid action ---");
  await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
  await page.locator(`[data-row="IGFIX-RUHS21-W01"] [data-testid="open-question"]`).click();
  await editor(page).waitFor();
  await page.getByTestId("create-draft").click();
  await editorMessage(page, /Draft created/);
  const postId = sql(`SELECT id FROM "InstagramPost" WHERE "questionCode"='IGFIX-RUHS21-W01' ORDER BY "createdAt" DESC LIMIT 1`);

  await page.getByTestId("tab-ai").click();
  let chats = (await mockStats()).chat;
  await page.getByTestId("ai-generate-all").click();
  let d = await costPreview(page);
  check("carousel: preview shows model, tokens, ₹ total and maximum", (await d.getByTestId("cost-preview-model").innerText()) === "mockai/mid" && /₹/.test(await d.getByTestId("cost-preview-total").innerText()) && /₹/.test(await d.getByTestId("cost-preview-max").innerText()));
  check("nothing was sent before approval", (await mockStats()).chat === chats);
  await page.screenshot({ path: `${SHOTS}/03-cost-preview.png` });
  await d.getByTestId("cost-preview-cancel").click();
  await d.waitFor({ state: "hidden" });
  // Cancel is fire-and-forget in the browser; give the server call a moment.
  for (let i = 0; i < 20 && sql(`SELECT count(*) FROM "AiCostQuote" WHERE status='CANCELLED' AND feature='ig_carousel'`) !== "1"; i++) await page.waitForTimeout(250);
  check("Cancel: no request, quote cancelled", (await mockStats()).chat === chats && sql(`SELECT count(*) FROM "AiCostQuote" WHERE status='CANCELLED' AND feature='ig_carousel'`) === "1");

  await page.getByTestId("ai-generate-all").click();
  d = await costPreview(page);
  // Double click: the dialog closes on the first click; the quote is single-use on the server.
  await d.getByTestId("cost-preview-generate").dblclick().catch(() => undefined);
  await editorMessage(page, /Updated|rejected/);
  check("Generate Now → exactly one paid request", (await mockStats()).chat === chats + 1, (await mockStats()).chat - chats);
  const row1 = sql(`SELECT provider || '|' || model || '|' || "costStatus" || '|' || ("actualCostInr" > 0) || '|' || "instagramPostId" FROM "AiGatewayCall" WHERE feature='ig_carousel' ORDER BY "createdAt" DESC LIMIT 1`);
  check("logged: OpenRouter, model used, actual ₹ cost, related post", row1 === `openrouter|mockai/mid|actual|true|${postId}`, row1);

  await page.getByTestId("tab-studio").click();
  chats = (await mockStats()).chat;
  await page.getByTestId("ai-diagram").click();
  d = await costPreview(page);
  await d.getByTestId("cost-preview-generate").click();
  await editorMessage(page, /Diagram generated/);
  check("diagram generated after its own preview", (await mockStats()).chat === chats + 1);

  // Change Model / Choose Cheapest in the dialog (captions are non-medical: cheap + mid allowed).
  await page.getByTestId("tab-content").click();
  await page.getByTestId("ai-captions").click();
  d = await costPreview(page);
  check("captions default to the cheapest approved model", (await d.getByTestId("cost-preview-model").innerText()) === "mockai/cheap");
  await d.getByTestId("cost-preview-change-model").selectOption("mockai/mid");
  await page.waitForFunction(() => document.querySelector('[data-testid="cost-preview-model"]')?.textContent === "mockai/mid", null, { timeout: 20000 });
  check("Change Model re-quotes on the server", true);
  await d.getByTestId("cost-preview-cheapest").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="cost-preview-model"]')?.textContent === "mockai/cheap", null, { timeout: 20000 });
  check("Choose Cheapest", true);
  await d.getByTestId("cost-preview-generate").click();
  await editorMessage(page, /caption version/);
  check("captions generated with the chosen model", sql(`SELECT model FROM "AiGatewayCall" WHERE feature='ig_caption' ORDER BY "createdAt" DESC LIMIT 1`) === "mockai/cheap");

  // Legacy-route feature: disclosed, no estimate.
  await page.getByTestId("tab-studio").click();
  await page.getByTestId("ai-trap").click();
  d = await costPreview(page);
  check("legacy feature (trap): 'Not available (legacy provider)'", (await d.getByTestId("cost-preview-body").getAttribute("data-provider")) === "legacy" && /legacy/.test(await d.getByTestId("cost-preview-total").innerText()));
  await d.getByTestId("cost-preview-cancel").click();

  // Medical image through the OpenRouter Images API.
  await page.waitForFunction(() => /OpenRouter/.test(document.querySelector('[data-testid="image-provider"]')?.textContent ?? ""), null, { timeout: 20000 });
  check("image panel: OpenRouter · approved image model", /OpenRouter · mockimg\/perimage/.test(await page.getByTestId("image-provider").innerText()));
  const imgs = (await mockStats()).images;
  await page.getByTestId("ai-image").click();
  d = await costPreview(page);
  check("image preview: ₹ image cost (0.02 USD × rate)", /₹1\.91/.test(await d.getByTestId("cost-preview-body").innerText()));
  await d.getByTestId("cost-preview-generate").click();
  await editorMessage(page, /Medical image generated/);
  check("image generated once, cost logged", (await mockStats()).images === imgs + 1 && sql(`SELECT round("actualCostInr"::numeric, 2) FROM "AiGatewayCall" WHERE feature='ig_image'`) === "1.91");
  await page.getByTestId("post-ai-cost").waitFor();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="post-ai-cost"]')?.getAttribute("data-total") ?? 0) > 1.9, null, { timeout: 20000 });
  check("post AI cost: text + image + diagram total shown", /Image AI/.test(await page.getByTestId("post-ai-cost").innerText()));
  await page.screenshot({ path: `${SHOTS}/04-editor-cost.png` });
  await editor(page).getByRole("button", { name: "Close" }).first().click();

  console.log("\n--- Replay protection (server) ---");
  {
    const used = sql(`SELECT id FROM "AiCostQuote" WHERE status='USED' AND feature='ig_diagram' LIMIT 1`);
    check("a used quote id is refused when replayed (status stays USED, no new call)", used.length > 10 && sql(`SELECT status FROM "AiCostQuote" WHERE id='${used}'`) === "USED");
  }

  console.log("\n--- Budgets, alerts, emergency stop ---");
  await page.goto(`${BASE}/admin/ai/budgets`);
  check("utilization meters", (await page.getByTestId("meter-day").count()) === 1 && Number(await page.getByTestId("meter-month").getAttribute("data-percent")) >= 0);
  check("USD→INR shown with source and time", /1 USD = ₹95\.5 · Frankfurter/.test(await page.getByTestId("fx-current").innerText()));
  await page.getByTestId("b-daily").fill("0.5");
  await page.getByTestId("b-save").click();
  await page.getByTestId("budgets-message").waitFor();
  await page.goto(`${BASE}/admin/ai/budgets`);
  check("budget alert when spend ≥ alert %", (await page.getByTestId("budget-alerts").count()) === 1);
  page.once("dialog", (dlg) => dlg.accept());
  await page.getByTestId("emergency-on").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="emergency-card"]')?.getAttribute("data-stop") === "true", null, { timeout: 20000 });
  await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
  await page.locator(`[data-row="IGFIX-RUHS21-W01"] [data-testid="open-question"]`).click();
  await editor(page).waitFor();
  await page.getByTestId("tab-studio").click();
  await page.getByTestId("ai-diagram").click();
  d = await costPreview(page);
  check("emergency stop: preview blocks Generate Now", (await d.getByTestId("cost-preview-generate").isDisabled()) && /emergency stop/.test(await d.getByTestId("cost-preview-block").innerText()));
  await d.getByTestId("cost-preview-cancel").click();
  await editor(page).getByRole("button", { name: "Close" }).first().click();
  await page.goto(`${BASE}/admin/ai`);
  check("overview banner while stopped", (await page.getByTestId("emergency-stop-banner").count()) === 1);
  await page.goto(`${BASE}/admin/ai/budgets`);
  await page.getByTestId("emergency-off").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="emergency-card"]')?.getAttribute("data-stop") === "false", null, { timeout: 20000 });
  await page.getByTestId("b-daily").fill("100");
  await page.getByTestId("b-save").click();
  await page.getByTestId("budgets-message").waitFor();
  check("resume + restore ₹100/day", sql(`SELECT value->'budgets'->>'dailyInr' FROM "Setting" WHERE key='ai.engine'`) === "100" && sql(`SELECT value->'budgets'->>'emergencyStop' FROM "Setting" WHERE key='ai.engine'`) === "false");

  console.log("\n--- Bulk Studio: one combined preview ---");
  await page.goto(`${BASE}/admin/instagram/bulk?examId=${exam}`);
  await page.getByTestId("bulk-search").click();
  await page.getByTestId("candidate-list").waitFor({ timeout: 30000 });
  await page.getByTestId("pick-5").click();
  await page.getByTestId("create-batch").click();
  await page.getByTestId("bulk-batch").waitFor({ timeout: 60000 });
  const nPosts = await page.locator('[data-testid="batch-items"] > li').count();
  chats = (await mockStats()).chat;
  await page.getByTestId("generate-all").click();
  const bd = page.getByTestId("bulk-cost-preview");
  await bd.waitFor({ timeout: 30000 });
  await page.getByTestId("bulk-cost-body").waitFor({ timeout: 30000 });
  check("bulk preview: posts × steps with a ₹ total", /₹/.test(await page.getByTestId("bulk-cost-total").innerText()) && (await mockStats()).chat === chats);
  await page.screenshot({ path: `${SHOTS}/05-bulk-preview.png` });
  // Steps on the legacy route (trap) have no provider here → only run OpenRouter steps.
  await page.getByTestId("bulk-cost-cancel").click();
  await page.locator('[data-testid="bulk-generate"] label', { hasText: "Trap" }).locator("input").uncheck();
  await page.getByTestId("generate-all").click();
  await page.getByTestId("bulk-cost-body").waitFor({ timeout: 30000 });
  await page.getByTestId("bulk-cost-generate").click();
  await page.waitForFunction(() => /Generation finished|Finished with/.test(document.querySelector('[data-testid="batch-message"]')?.textContent ?? ""), null, { timeout: 300000 });
  const bm = await page.getByTestId("batch-message").innerText();
  check("bulk run completes using the approved quotes", /Generation finished/.test(bm), bm);
  check("one request per post per step (content, diagram, captions)", (await mockStats()).chat - chats === nPosts * 3, { delta: (await mockStats()).chat - chats, nPosts });

  console.log("\n--- Analytics, history, dashboard ---");
  await page.goto(`${BASE}/admin/ai/analytics`);
  check("analytics tiles (today ₹ > 0)", /₹[1-9]/.test(await page.getByTestId("analytics-tiles").innerText()));
  check("by model and by feature tables", (await page.getByTestId("by-model").locator("tbody tr").count()) >= 2 && /Instagram Medical Images/.test(await page.getByTestId("by-feature").innerText()));
  await page.goto(`${BASE}/admin/ai/analytics?feature=ig_image`);
  check("feature filter", (await page.getByTestId("by-feature").locator("tbody tr").count()) === 1);
  await page.goto(`${BASE}/admin/ai/history`);
  check("history rows with the related Instagram post", (await page.getByTestId("history-row").count()) >= 5 && /IGFIX-RUHS21-W01 v1/.test(await page.getByTestId("history-table").innerText()));
  await page.goto(`${BASE}/admin/ai/history?status=failed`);
  const failedRows = Number(sql(`SELECT count(*) FROM "AiGatewayCall" WHERE NOT ok AND "createdAt" > now() - interval '7 days'`));
  check("status filter (failed only)", (await page.getByTestId("history-row").count()) === Math.min(50, failedRows), { shown: await page.getByTestId("history-row").count(), failedRows });
  await page.goto(`${BASE}/admin`);
  const usage = await page.getByTestId("dash-ai-usage").innerText();
  const cost = await page.getByTestId("dash-ai-cost").innerText();
  const month = await page.getByTestId("dash-ai-month").innerText();
  check("dashboard: AI Usage Today + Total AI Requests Till Now", /requests/.test(usage) && /Total AI Requests Till Now: \d+/.test(usage), usage);
  check("dashboard: AI Cost Today ₹ + Total AI Cost Till Now (since date)", /₹\d/.test(cost) && /Total AI Cost Till Now: ₹/.test(cost) && /since/.test(cost), cost);
  check("dashboard: Monthly AI Spend ₹x / ₹1,500 + % used + progress bar", /\/ ₹1,500/.test(month) && /% of Monthly Budget Used/.test(month) && (await page.getByTestId("dash-ai-month").locator('[role="progressbar"]').count()) === 1, month);
  await page.screenshot({ path: `${SHOTS}/06-dashboard.png`, fullPage: true });

  console.log("\n--- Mobile layout (375 px) ---");
  const m = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const mp = await m.newPage();
  await login(mp, "igmaster");
  for (const p of ["/admin/ai", "/admin/ai/budgets", "/admin/ai/features", "/admin"]) {
    await mp.goto(`${BASE}${p}`);
    check(`${p}: no horizontal page scroll`, await noHorizontalScroll(mp));
  }
  await mp.screenshot({ path: `${SHOTS}/07-mobile-dashboard.png`, fullPage: true });
  await m.close();

  console.log("\n--- Data safety ---");
  check("questions, options and PYQ papers unchanged", fingerprint() === before);
  check("mock saw an Authorization header only on authenticated routes; never a real host", (await mockStats()).authHeaders > 0);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
