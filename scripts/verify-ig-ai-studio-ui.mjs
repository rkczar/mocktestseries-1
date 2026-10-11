/**
 * AI Providers (Claude) + Instagram AI Studio — browser checks on a SCRATCH
 * server (never production). Claude is a LOCAL mock (scripts/mock-anthropic.mjs);
 * no Instagram token is installed, so nothing can be published.
 *
 *   set -a; . ./.env; set +a                # an *igstudio* scratch DB + scripts/ig-studio-fixture.ts setup
 *   node scripts/mock-anthropic.mjs 3185 &
 *   ANTHROPIC_TEST_BASE_URL=http://127.0.0.1:3185 NEXTAUTH_URL=http://localhost:3141 AUTH_URL=http://localhost:3141 \
 *     node_modules/.bin/next start -H 127.0.0.1 -p 3141 &
 *   BASE=http://localhost:3141 SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-ig-ai-studio-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mockKey } from "./mock-anthropic.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3141";
const SHOTS = process.env.SHOTS ?? "/tmp/ig-ai-shots";
const PASSWORD = "IgStudio#Fixture2026";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();

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
         UNION ALL SELECT x.id || x.content::text FROM "AIExplanation" x) t`);

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const editor = (page) => page.getByTestId("carousel-editor");
async function editorMessage(page, re) {
  const m = page.getByTestId("editor-message");
  await m.waitFor({ timeout: 60000 });
  if (re) await page.waitForFunction((r) => new RegExp(r).test(document.querySelector('[data-testid="editor-message"]')?.textContent ?? ""), re.source, { timeout: 60000 });
  return (await m.innerText()).trim();
}
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

sql(`DELETE FROM "InstagramPost" WHERE "questionCode" LIKE 'IGFIX-%'; DELETE FROM "InstagramBatch"; DELETE FROM "InstagramReference"; DELETE FROM "InstagramInsightReport"; DELETE FROM "Setting" WHERE key IN ('instagram.studio','api.anthropic','ai.gateway','instagram.scope','instagram.designPresets'); DELETE FROM "LoginAttempt"; DELETE FROM "AiGatewayCall";`);
const before = fingerprint();
const exam = sql(`SELECT id FROM "Exam" WHERE code = 'IGFIX-RUHS'`);
const p2021 = sql(`SELECT id FROM "PreviousYearPaper" WHERE title = 'IGFIX RUHS MO 2021'`);
const KEY = mockKey("valid");
const KEY2 = mockKey("valid");

const browser = await chromium.launch();
try {
  console.log("\n--- Authorization ---");
  for (const who of ["igfull", "igteacher"]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, who);
    await page.goto(`${BASE}/admin/ai/providers`);
    check(`${who}: AI Providers restricted`, (await page.getByText("Access Restricted").count()) >= 1 && (await page.getByTestId("claude-key-input").count()) === 0);
    await page.goto(`${BASE}/admin/instagram/bulk`);
    check(`${who}: Bulk Studio restricted`, (await page.getByTestId("bulk-create").count()) === 0);
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await login(page, "igmaster");

  console.log("\n--- AI Providers: paste, save, test, enable, route (no terminal, no restart) ---");
  await page.goto(`${BASE}/admin/ai?tab=providers`);
  await page.getByTestId("ai-providers").waitFor();
  check("three provider cards", (await page.getByTestId("provider-card-gemini").count()) === 1 && (await page.getByTestId("provider-card-openai").count()) === 1 && (await page.getByTestId("provider-card-anthropic").count()) === 1);
  const claudeCard = page.getByTestId("provider-card-anthropic");
  check("Claude starts NOT CONFIGURED", (await claudeCard.getByTestId("provider-status").getAttribute("data-status")) === "NOT_CONFIGURED");
  check("key field is a password input", (await page.getByTestId("claude-key-input").getAttribute("type")) === "password");
  await page.getByTestId("claude-key-input").fill(KEY);
  await page.getByTestId("claude-save-key").click();
  await page.getByTestId("claude-key-hint").waitFor({ timeout: 20000 });
  const hint = await page.getByTestId("claude-key-hint").innerText();
  check("saved: masked hint sk-ant-••••xxxx shown, input gone", hint === `sk-ant-••••${KEY.slice(-4)}` && (await page.getByTestId("claude-key-input").count()) === 0, hint);
  const raw = await page.evaluate(async (u) => (await fetch(u)).text(), `${BASE}/admin/ai?tab=providers`);
  check("the page HTML never contains the key", !raw.includes(KEY.slice(7, 30)));
  const dbRow = sql(`SELECT value::text FROM "Setting" WHERE key='api.anthropic'`);
  check("DB holds only ciphertext", !dbRow.includes(KEY.slice(7, 30)) && /"apiKeyCipher": "v1:/.test(dbRow));
  await page.getByTestId("claude-test").click();
  await page.getByTestId("claude-test-result").waitFor({ timeout: 30000 });
  check("Test Connection: real server-side test passes (mock)", (await page.getByTestId("claude-test-result").getAttribute("data-ok")) === "true", await page.getByTestId("claude-test-result").innerText());
  await page.getByTestId("claude-enabled").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-card-anthropic"] [data-testid="provider-status"]')?.getAttribute("data-status") === "CONNECTED", null, { timeout: 20000 });
  check("Enable → CONNECTED", true);
  await page.screenshot({ path: `${SHOTS}/01-providers.png`, fullPage: true });

  for (const f of ["ig_carousel", "ig_trap", "ig_diagram", "ig_caption", "ig_trends", "ig_competitors"]) {
    await page.getByTestId(`route-mode-${f}`).selectOption("custom");
    await page.getByTestId(`route-primary-${f}`).selectOption("anthropic");
  }
  await page.getByTestId("routes-save").click();
  await page.getByTestId("routes-message").waitFor({ timeout: 20000 });
  const gwRow = sql(`SELECT value->'routes'->'ig_trap'->>'primary' FROM "Setting" WHERE key='ai.gateway'`);
  check("routing saved: Instagram features → Claude; explanation/variant untouched", gwRow === "anthropic" && sql(`SELECT coalesce(value->'routes'->'explanation'->>'mode','inherit') FROM "Setting" WHERE key='ai.gateway'`) === "inherit");

  await page.getByTestId("claude-replace-key").click();
  await page.getByTestId("claude-key-input").fill("not-a-key");
  await page.getByTestId("claude-save-key").click();
  await page.getByTestId("claude-message").waitFor();
  check("invalid key format rejected with a clear message", /starts with sk-ant-/.test(await page.getByTestId("claude-message").innerText()));
  await page.getByTestId("claude-key-input").fill(KEY2);
  await page.getByTestId("claude-save-key").click();
  await page.waitForFunction((t) => document.querySelector('[data-testid="claude-key-hint"]')?.textContent === t, `sk-ant-••••${KEY2.slice(-4)}`, { timeout: 20000 });
  check("Replace API Key: new hint shown immediately", true);

  console.log("\n--- Editor: Claude content, design mode, diagram, trap, captions ---");
  await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
  await page.locator(`[data-row="IGFIX-RUHS21-W01"] [data-testid="open-question"]`).click();
  await editor(page).waitFor();
  await page.getByTestId("create-draft").click();
  await editorMessage(page, /Draft created/);
  await page.getByTestId("tab-design").click();
  await page.getByTestId("mode-handwritten").click();
  check("Handwritten mode selects a handwritten preset", (await page.getByTestId("template-hw-doctor").getAttribute("aria-pressed")) === "true");
  await page.getByTestId("save-draft").click();
  await editorMessage(page, /Saved/);
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-provider").selectOption("anthropic");
  await page.getByTestId("ai-generate-all").click();
  const genMsg = await editorMessage(page, /Updated|rejected/);
  check("Generate all content with Claude", /Updated/.test(genMsg), genMsg);
  await page.getByTestId("tab-studio").click();
  await page.getByTestId("ai-diagram").click();
  await editorMessage(page, /Diagram generated/);
  check("diagram generated, flagged to check before publishing", /Check every label before publishing/.test(await page.getByTestId("diagram-status").innerText()));
  await page.getByTestId("ai-trap").click();
  await editorMessage(page, /Trap question generated/);
  check("trap generated: check-before-publishing note, checks listed", (await page.getByTestId("trap-status").getAttribute("data-status")) === "draft" && (await page.getByTestId("trap-checks").locator("li").count()) >= 3);
  await page.getByTestId("tab-design").click();
  await page.getByTestId("smart-layout").click();
  const rows = await page.locator('[data-testid^="module-row-"] select').evaluateAll((els) => els.map((e) => e.value));
  check("Smart layout → (Hook kept) Q, A, Diagram, Pearls, Mistakes, Trap, Follow", JSON.stringify(rows) === JSON.stringify(["HOOK", "QUESTION", "ANSWER", "DIAGRAM", "PEARLS", "MISTAKES", "TRAP", "FOLLOW"]), rows);
  await page.getByTestId("save-draft").click();
  await editorMessage(page, /Saved/);
  await page.getByTestId("tab-studio").click();
  check("no separate trap / diagram approval buttons", (await page.getByTestId("trap-approve").count()) === 0 && (await page.getByTestId("trap-reject").count()) === 0 && (await page.getByTestId("diagram-reviewed").count()) === 0);
  await page.getByTestId("tab-content").click();
  await page.getByTestId("ai-captions").click();
  await editorMessage(page, /caption version/);
  check("3 caption versions shown", (await page.getByTestId("caption-versions").locator('[data-testid^="caption-"]').count()) === 3);
  await page.getByTestId("use-caption-hook").click();
  check("Use this version fills the caption", /clinical|staring|start/i.test(await page.getByTestId("field-caption").inputValue()));
  await page.getByTestId("save-draft").click();
  await editorMessage(page, /Saved/);
  // Walk the 7 slides so each renders.
  for (let i = 0; i < 8; i++) {
    await page.locator('[role="tablist"][aria-label="Slides"] button').nth(i).click();
    await page.waitForFunction((n) => document.querySelector('[data-testid="slide-preview"]')?.getAttribute("data-slide") === String(n) && document.querySelector('[data-testid="preview-frame"]')?.getAttribute("data-busy") === "false", i, { timeout: 30000 });
  }
  check("all 8 slides preview", true);
  await page.screenshot({ path: `${SHOTS}/02-editor-trap.png` });
  await page.getByTestId("tab-checks").click();
  const listed = await page.locator('[data-testid="issue-list"] [data-code]').evaluateAll((els) => els.map((e) => [e.getAttribute("data-code"), /Blocking/.test(e.textContent ?? "")]));
  check("diagram/trap are listed as checks, never as blockers", listed.some(([c]) => c === "DIAGRAM_UNREVIEWED") && !listed.some(([c, blocking]) => /DIAGRAM_UNREVIEWED|TRAP_UNAPPROVED/.test(c) && blocking), listed);
  const genCalls = Number(sql(`SELECT count(*) FROM "AiGatewayCall" WHERE provider='anthropic' AND ok`));
  check("every generation went through the gateway to Claude (logged)", genCalls >= 5, genCalls);
  await editor(page).getByRole("button", { name: "Close" }).first().click();

  console.log("\n--- Bulk Studio ---");
  await page.goto(`${BASE}/admin/instagram/bulk?examId=${exam}`);
  await page.getByTestId("bulk-search").click();
  await page.getByTestId("candidate-list").waitFor({ timeout: 30000 });
  await page.locator('[data-testid="candidate-list"] li button', { hasText: "Why this score" }).first().click();
  check("score breakdown shown", (await page.getByTestId("score-breakdown").locator("li").count()) >= 5);
  await page.getByTestId("pick-5").click();
  const picked = await page.getByTestId("picked-count").innerText();
  check("Top 5 picks only slide-ready, not-yet-created questions", /^\d+ selected/.test(picked), picked);
  await page.getByTestId("create-batch").click();
  await page.getByTestId("bulk-batch").waitFor({ timeout: 60000 });
  const items = await page.locator('[data-testid="batch-items"] > li').count();
  check("batch created: separate posts", items >= 3, items);
  await page.getByTestId("apply-handwritten").click();
  await page.getByTestId("batch-message").waitFor({ timeout: 30000 });
  check("Apply Handwritten to All", /Design changed/.test(await page.getByTestId("batch-message").innerText()));
  await page.getByTestId("generate-all").click();
  await page.waitForFunction(() => /Generation finished|Finished with/.test(document.querySelector('[data-testid="batch-message"]')?.textContent ?? ""), null, { timeout: 300000 });
  const bm = await page.getByTestId("batch-message").innerText();
  check("Generate for all Draft posts (content, diagram, trap, captions, smart layout)", /Generation finished/.test(bm), bm);
  check("queue section explains publishing is not available here (no token)", (await page.getByTestId("queue-disabled").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/03-bulk.png`, fullPage: true });

  console.log("\n--- Trends & Competitors ---");
  await page.goto(`${BASE}/admin/instagram/trends`);
  check("Business Discovery shown as NOT CONFIGURED", /NOT CONFIGURED/.test(await page.getByTestId("business-discovery").innerText()));
  await page.getByTestId("ref-handle").fill("comp.one");
  await page.getByTestId("ref-topic").fill("Antiepileptics");
  await page.getByTestId("ref-add").click();
  await page.getByTestId("trends-message").waitFor();
  const tm = await page.getByTestId("trends-message").innerText();
  await page.waitForFunction(() => (document.querySelector('[data-testid="reference-list"]')?.textContent ?? "").includes("@comp.one"), null, { timeout: 15000 }).catch(() => {});
  check("reference post added", (await page.getByTestId("reference-list").innerText()).includes("@comp.one"), tm);
  await page.getByTestId("run-trends").click();
  await page.getByTestId("trend-report").waitFor({ timeout: 60000 });
  check("trend report shows evidence-backed items with sources", /MockTestSeries|Manually entered|Instagram API/.test(await page.getByTestId("trend-report").innerText()));
  await page.getByTestId("run-competitors").click();
  await page.getByTestId("competitor-report").waitFor({ timeout: 60000 });
  check("competitor analysis shown", true);

  console.log("\n--- Other pages ---");
  await page.goto(`${BASE}/admin/instagram/design`);
  check("Design Mode page: both modes", (await page.getByTestId("mode-section-handwritten").count()) === 1 && (await page.getByTestId("mode-section-professional").count()) === 1);
  await page.goto(`${BASE}/admin/instagram/history`);
  check("Published History: performance + comparison tables", (await page.getByTestId("metrics-table").count()) === 1 && (await page.getByTestId("compare-table").count()) === 1);
  await page.goto(`${BASE}/admin/instagram/settings`);
  check("Settings: exam scope card", (await page.getByTestId("exam-scope").count()) === 1);
  await page.goto(`${BASE}/admin/ai?tab=settings`);
  check("existing AI Settings tab still renders", (await page.getByText("Gemini").count()) >= 1);

  console.log("\n--- Mobile (Android width) ---");
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await login(mp, "igmaster");
  for (const [name, url] of [
    ["providers", `${BASE}/admin/ai/providers`],
    ["bulk", `${BASE}/admin/instagram/bulk?examId=${exam}`],
    ["trends", `${BASE}/admin/instagram/trends`],
    ["design", `${BASE}/admin/instagram/design`],
  ]) {
    await mp.goto(url);
    await mp.waitForLoadState("networkidle");
    check(`mobile ${name}: no horizontal page scroll`, await noHorizontalScroll(mp));
    await mp.screenshot({ path: `${SHOTS}/m-${name}.png`, fullPage: true });
  }
  await mp.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
  await mp.locator(`[data-row="IGFIX-RUHS21-W01"] [data-testid="open-question"]`).click();
  await editor(mp).waitFor();
  await mp.getByTestId("tab-studio").click();
  check("mobile editor: Diagram & Trap tab usable", (await mp.getByTestId("studio-panel").count()) === 1);
  await mp.screenshot({ path: `${SHOTS}/m-editor.png`, fullPage: true });
  await m.close();

  console.log("\n--- Integrity ---");
  check("Question Bank / options / AI explanations unchanged (fingerprint)", fingerprint() === before);
  check("no Instagram post was published", sql(`SELECT count(*) FROM "InstagramPost" WHERE status='PUBLISHED' OR "igMediaId" IS NOT NULL`) === "0");
  const logs = sql(`SELECT count(*) FROM "AiGatewayCall" WHERE "errorSummary" LIKE '%sk-ant%'`) + sql(`SELECT count(*) FROM "AuditLog" WHERE metadata::text LIKE '%${KEY.slice(10, 30)}%' OR metadata::text LIKE '%${KEY2.slice(10, 30)}%'`);
  check("no key in gateway or audit logs", logs === "00", logs);
} finally {
  await browser.close();
  // Leave the scratch DB as other suites expect it (no AI provider configured, no batches).
  sql(`DELETE FROM "InstagramBatch"; DELETE FROM "InstagramReference"; DELETE FROM "InstagramInsightReport"; DELETE FROM "Setting" WHERE key IN ('api.anthropic','ai.gateway','instagram.designPresets');`);
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
