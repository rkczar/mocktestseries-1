/**
 * AI Question Importer — Import Settings: provider status, searchable model
 * pickers, cost estimates, server-side validation, persistence, loading /
 * error / retry / empty states, read-only view, desktop + mobile. Scratch DB +
 * mock OpenRouter; run scripts/ai-import-ui-fixture.ts setup first (key, synced
 * mock catalog, FULL_ADMIN). Never real AI.
 *
 *   BASE=http://localhost:3432 FIXTURE=/tmp/aiui.json APP_DIR=. ADMIN_USER=… ADMIN_PASS=… \
 *   DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-ai-import-settings-ui.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const BASE = process.env.BASE;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const APP = process.env.APP_DIR ?? ".";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = any($1)`, [[process.env.ADMIN_USER, F.fullAdmin]]);
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
const browser = await chromium.launch();
const errors = [];
async function newPage(mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  return page;
}
async function login(page, user, pw) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pw);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const saved = async () => (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value ?? null;
const URL_SETTINGS = `${BASE}/admin/ai-importer/settings`;

await db.query(`delete from "Setting" where key='ai.importer'`);
const page = await newPage();
await login(page, process.env.ADMIN_USER, process.env.ADMIN_PASS);

section("A. Provider and configuration status (no secrets)");
await page.goto(URL_SETTINGS);
const html = await page.evaluate(() => fetch(location.href).then((r) => r.text()));
const keyRow = (await db.query(`select value from "Setting" where key='api.openrouter'`)).rows[0].value;
check("no key, key fragment, hint or cipher anywhere in the page HTML", !/sk-or-/.test(html) && !html.includes(keyRow.apiKeyCipher) && !html.includes("••••") && !html.includes(keyRow.keyHint.slice(-4)));
const tone = async (id) => page.locator(`[data-testid=status-${id}]`).getAttribute("data-tone");
check("OpenRouter: connected (OK)", (await tone("provider")) === "success" && /Connected/.test(await page.locator("[data-testid=status-provider]").textContent()));
check("paid AI: OFF by default, shown as info", (await tone("paid")) === "neutral" && /OFF/.test(await page.locator("[data-testid=status-paid]").textContent()));
check("model metadata: synced, approved vision models counted", (await tone("catalog")) === "success" && /approved/.test(await page.locator("[data-testid=status-catalog]").textContent()));
check("prices in rupees: FX rate shown", (await tone("fx")) === "success" && /95\.00/.test(await page.locator("[data-testid=status-fx]").textContent()));

section("B. Searchable extraction model picker");
const search = page.locator("[data-testid=m-extract-search]");
await search.click();
const list = page.locator("[data-testid=m-extract-list]");
await list.waitFor();
const initialIds = await list.locator("[data-testid=model-option]").evaluateAll((els) => els.map((e) => e.getAttribute("data-model-id")));
check("opens with the approved vision models (no text-only model)", initialIds.includes("mockvision/reader") && !initialIds.includes("mocktext/classifier"), initialIds);
await search.fill("read");
const ids = await list.locator("[data-testid=model-option]").evaluateAll((els) => els.map((e) => e.getAttribute("data-model-id")));
check("typing filters the list", ids.length === 1 && ids[0] === "mockvision/reader", ids);
const opt = list.locator("[data-model-id='mockvision/reader']");
const optText = (await opt.textContent()) ?? "";
check("option shows name, ID, input/output price per M tokens and the max per request", /mockvision\/reader/.test(optText) && /in \$0\.50 \/ out \$3\.00 per M tokens/.test(optText) && /max ₹\d/.test(optText), optText);
await search.press("Enter");
check("Enter selects the highlighted model", /mockvision\/reader/.test(await page.locator("[data-testid=m-extract-current]").textContent()));
const cost = (await page.locator("[data-testid=m-extract-cost]").textContent()) ?? "";
check("selected model: estimate per request + conservative maximum shown", /Estimate per request: about ₹[\d.]+; conservative maximum ₹[\d.]+/.test(cost), cost);
await search.fill("nothing-matches-this");
check("empty search result state", (await page.locator("[data-testid=m-extract-empty]").textContent()) === "No model matches.");
await search.fill("");
await page.keyboard.press("Escape");

section("C. Unapproved / unusable models are listed but cannot be chosen");
await db.query(`update "AiModel" set approved=false where id='mockvision/checker'`);
await page.goto(URL_SETTINGS);
await page.locator("[data-testid=m-verify-search]").fill("checker");
const chk = page.locator("[data-testid=m-verify-list] [data-model-id='mockvision/checker']");
check("an unapproved model is shown with the reason", (await chk.getAttribute("data-usable")) === "false" && /Not approved — approve it in AI → Models/.test(await chk.textContent()));
await chk.click({ force: true });
check("…and clicking it selects nothing", /None — no second read/.test(await page.locator("[data-testid=m-verify-current]").textContent()));
await page.locator("[data-testid=m-verify-search]").fill("badimg");
const bad = page.locator("[data-testid=m-verify-list] [data-model-id='mockvision/badimg']");
check("a model whose image price cannot be read is not selectable, with the reason", (await bad.getAttribute("data-usable")) === "false" && /per-image input price/.test(await bad.textContent()));
await page.keyboard.press("Escape");
await db.query(`update "AiModel" set approved=true where id='mockvision/checker'`);

section("D. Verification model, same-model notice and cost table");
await page.goto(URL_SETTINGS);
const pick = async (slot, id) => {
  await page.locator(`[data-testid=m-${slot}-search]`).fill(id);
  await page.locator(`[data-testid=m-${slot}-list] [data-model-id="${id}"]`).click();
};
await pick("extract", "mockvision/reader");
await pick("verify", "mockvision/reader");
check("same model for extraction and verification → explained (second read skipped)", /second read is skipped/.test((await page.locator("[data-testid=verify-same]").textContent()) ?? ""));
check("cost table: verification row says not run", /Not run: same model as extraction/.test(await page.locator("[data-testid=cost-verify]").textContent()));
await pick("verify", "mockvision/checker");
check("different model → no same-model notice", (await page.locator("[data-testid=verify-same]").count()) === 0);
const ex = (await page.locator("[data-testid=cost-extract]").textContent()) ?? "";
const ve = (await page.locator("[data-testid=cost-verify]").textContent()) ?? "";
check("cost table: extraction and verification estimated separately (typical + maximum)", /mockvision\/reader.*₹[\d.]+.*₹[\d.]+/.test(ex) && /mockvision\/checker.*₹[\d.]+.*₹[\d.]+/.test(ve), { ex, ve });
check("cost table labelled as estimates, image tokens explained", /estimates/.test(await page.locator("[data-testid=cost-table]").textContent()) && /tokens per page image/.test(await page.locator("[data-testid=cost-table]").textContent()));
await page.locator("[data-testid=v-independent]").check();
check("answer opinion switched on → its own verification cost row", (await page.locator("[data-testid=cost-solve]").count()) === 1);
await page.locator("[data-testid=v-independent]").uncheck();
await pick("extract", "mockvision/pricey");
check("a model above the per-request limit is flagged as refused", (await page.locator("[data-testid=cost-over-cap]").count()) >= 1 && /would be refused/.test(await page.locator("[data-testid=m-extract-cost]").textContent()));
await pick("extract", "mockvision/reader");

section("E. Save, persistence after refresh, pilot limits");
await page.locator("[data-testid=b-total]").fill("10");
await page.locator("[data-testid=b-month]").fill("10");
await page.locator("[data-testid=b-maxjob]").fill("8");
await page.locator("[data-testid=b-job]").fill("8");
await page.locator("[data-testid=b-req]").fill("1");
await page.locator("[data-testid=b-key]").fill("5");
await page.locator("[data-testid=privacy-zdr]").check();
await page.locator("[data-testid=settings-save]").click();
await page.locator("[data-testid=settings-msg]").waitFor();
const msg = (await page.locator("[data-testid=settings-msg]").textContent()) ?? "";
check("save confirmation shown", /Settings saved at/.test(msg), msg);
const v = await saved();
check("persisted: models + pilot limits + ZDR; paid AI still OFF", v?.models?.extract === "mockvision/reader" && v?.models?.verify === "mockvision/checker" && v?.budget?.totalInr === 10 && v?.budget?.monthlyInr === 10 && v?.budget?.maxJobInr === 8 && v?.budget?.maxRequestInr === 1 && v?.budget?.keyReserveUsd === 5 && v?.privacy?.zdr === true && v?.aiEnabled === false && v?.budget?.retryTransient === false && (v?.models?.extractFallbacks ?? []).length === 0, v);
await page.reload();
check("after refresh: selections shown again", /mockvision\/reader/.test(await page.locator("[data-testid=m-extract-current]").textContent()) && /mockvision\/checker/.test(await page.locator("[data-testid=m-verify-current]").textContent()) && (await page.locator("[data-testid=b-total]").inputValue()) === "10" && (await page.locator("[data-testid=b-maxjob]").inputValue()) === "8");
check("with the ₹1 request cap the reader's maximum is flagged", (await page.locator("[data-testid=cost-over-cap]").count()) >= 1);

section("F. Invalid model IDs are refused by the server");
const manifest = JSON.parse(readFileSync(path.join(APP, ".next/server/server-reference-manifest.json"), "utf8"));
const saveId = Object.entries(manifest.node).find(([, x]) => JSON.stringify(x).includes("saveSettingsAction"))?.[0];
const call = (body) => page.evaluate(async ([id, b]) => { const r = await fetch(location.pathname, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([b]) }); return r.text(); }, [saveId, body]);
const before = JSON.stringify(await saved());
for (const [label, patch, re] of [
  ["unknown model", { extract: "acme/not-a-model" }, /not in the model catalog/],
  ["text-only model as extraction model", { extract: "mocktext/classifier" }, /cannot read images/],
  ["malformed model ID", { extract: "not a model id" }, /not a valid OpenRouter model ID/],
  ["fallback pricier than the extraction model", { extractFallbacks: ["mockvision/pricey"] }, /costs more than the extraction model/],
]) {
  const t = await call({ ...v, models: { ...v.models, ...patch } });
  check(`raw save with ${label}: refused`, /"ok":false/.test(t) && re.test(t), t.slice(-200));
}
check("…the saved settings did not change", JSON.stringify(await saved()) === before);
const t2 = await call({ ...v, budget: { ...v.budget, maxRequestInr: 9, maxJobInr: 8 } });
check("raw save with request cap above the hard job limit: refused", /cannot be above the hard limit per job/.test(t2), t2.slice(-200));

section("G. Loading, error, retry");
await page.goto(URL_SETTINGS);
await page.route("**/admin/ai-importer/settings", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
await page.locator("[data-testid=models-reload]").click();
await page.locator("[data-testid=models-error]").waitFor({ timeout: 10000 }).catch(() => {});
check("reload fails → error with a Retry", /Could not load the model list/.test((await page.locator("[data-testid=models-error]").textContent().catch(() => "")) ?? "") && (await page.locator("[data-testid=models-retry]").count()) === 1);
await page.unroute("**/admin/ai-importer/settings");
await page.route("**/admin/ai-importer/settings", async (route) => {
  if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1200));
  await route.continue();
});
await page.locator("[data-testid=models-retry]").click();
check("retry shows the loading state", await until(async () => /Loading models/.test(await page.locator("[data-testid=models-reload]").textContent()), 3000));
check("retry succeeds → error cleared", await until(async () => (await page.locator("[data-testid=models-error]").count()) === 0 && !/Loading/.test(await page.locator("[data-testid=models-reload]").textContent())));
await page.unroute("**/admin/ai-importer/settings");
await db.query(`update "AiModel" set approved=false where id like 'mock%'`);
await page.locator("[data-testid=models-reload]").click();
check("no approved vision model → status asks to approve one", await until(async () => (await page.locator("[data-testid=status-catalog]").getAttribute("data-tone")) === "warning"));
check("…the saved extraction model is reported as invalid configuration", /not approved/.test((await page.locator("[data-testid=status-invalid]").textContent().catch(() => "")) ?? ""));
await page.locator("[data-testid=m-extract-search]").click();
check("…empty list explains how to fix it", /No approved model can read page images/.test((await page.locator("[data-testid=m-extract-empty]").textContent().catch(() => "")) ?? ""));
await page.keyboard.press("Escape");
await page.locator("[data-testid=settings-save]").click();
check("…saving is blocked in the browser with the reason", /fix the invalid model selection/.test((await page.locator("[data-testid=settings-msg]").textContent()) ?? ""));
await db.query(`update "AiModel" set approved=true where id like 'mock%'`);
const cipher = keyRow.apiKeyCipher;
await db.query(`update "Setting" set value = value - 'apiKeyCipher' where key='api.openrouter'`);
await page.locator("[data-testid=models-reload]").click();
check("missing key → “Not configured” (distinct from disabled AI)", await until(async () => /Not configured — no OpenRouter API key/.test(await page.locator("[data-testid=status-provider]").textContent())));
await db.query(`update "Setting" set value = jsonb_set(value, '{apiKeyCipher}', to_jsonb($1::text)) where key='api.openrouter'`, [cipher]);
await db.query(`update "Setting" set value = jsonb_set(value, '{enabled}', 'false') where key='api.openrouter'`);
await page.locator("[data-testid=models-reload]").click();
check("provider switched off → “switched off”", await until(async () => /switched off/.test(await page.locator("[data-testid=status-provider]").textContent())));
await db.query(`update "Setting" set value = jsonb_set(value, '{enabled}', 'true') where key='api.openrouter'`);

section("H. Read-only admin and mobile");
const full = await newPage();
await login(full, F.fullAdmin, F.password);
await full.goto(URL_SETTINGS);
check("FULL_ADMIN: status visible, no model search, no Save", (await full.locator("[data-testid=provider-status]").count()) === 1 && (await full.locator("[data-testid=m-extract-search]").count()) === 0 && (await full.locator("[data-testid=settings-save]").count()) === 0);
const fullRaw = await full.evaluate(async ([id, b]) => { const r = await fetch(location.pathname, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([b]) }); return r.text(); }, [saveId, { ...v, aiEnabled: true }]);
check("FULL_ADMIN raw save refused; paid AI stays OFF", /do not have permission/.test(fullRaw) && (await saved())?.aiEnabled === false, fullRaw.slice(-160));
const m = await newPage(true);
await login(m, process.env.ADMIN_USER, process.env.ADMIN_PASS);
await m.goto(URL_SETTINGS);
await m.locator("[data-testid=m-extract-search]").click();
await m.locator("[data-testid=m-extract-list]").waitFor();
const box = await m.locator("[data-testid=m-extract-list]").boundingBox();
check("mobile: model list fits the screen", !!box && box.x >= 0 && box.x + box.width <= 376, box);
check("mobile: no horizontal page scroll", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

check("no page errors", errors.length === 0, errors);
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
