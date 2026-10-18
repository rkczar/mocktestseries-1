/**
 * AI Question Importer — Import Settings: provider status, automatic model
 * selection (routes, reasons, prices, privacy), the manual override's searchable
 * model pickers, cost estimates, server-side validation and pilot ceilings,
 * persistence, loading / error / retry / empty states, read-only view, desktop + mobile. Scratch DB +
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

await db.query(`delete from "Setting" where key in ('ai.importer', 'ai.importer.routes')`);
// What an administrator approves for the importer (Import Settings → Importer models). The global
// AI → Models approval flags are never touched here; the suite checks they stay exactly as they were.
const APPROVED = ["mockvision/reader", "mockvision/checker", "mockvision/mid", "mockvision/cheapnozdr", "mockvision/down", "mockvision/pricey", "mocktext/classifier"];
const globalFlags = async () => JSON.stringify((await db.query(`select id, approved, "medicallyApproved" from "AiModel" order by id`)).rows);
const flags0 = await globalFlags();
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
check("model metadata: synced; no importer model yet → asks to add a vision model", (await tone("catalog")) === "warning" && /0 on the importer's model list/.test(await page.locator("[data-testid=status-catalog]").textContent()) && /Add a vision model under Importer models/.test(await page.locator("[data-testid=status-catalog]").textContent()));
check("prices in rupees: FX rate shown", (await tone("fx")) === "success" && /95\.00/.test(await page.locator("[data-testid=status-fx]").textContent()));

section("A2. Automatic model selection (default)");
check("automatic selection is the default; the manual pickers are hidden", await page.locator("[data-testid=sel-auto]").isChecked() && (await page.locator("[data-testid=manual-models]").count()) === 0 && (await page.locator("[data-testid=m-extract-search]").count()) === 0);
check("more expensive fallbacks: off by default", !(await page.locator("[data-testid=b-pricier]").isChecked()));
check("routes not read yet → status says so, no model chosen", (await tone("routes")) === "error" && /None — this task does not run/.test(await page.locator("[data-testid=sel-extract-model]").textContent()));
check("Importer models card: empty, says it applies to the importer only", (await page.locator("[data-testid=importer-models-empty]").count()) === 1 && /does not approve it for student Ask AI, Instagram or any other AI feature/.test(await page.locator("[data-testid=importer-models]").textContent()));
const addImporterModel = async (p, id) => {
  await p.locator("[data-testid=importer-model-search]").fill(id);
  await p.locator(`[data-testid=importer-model-hits] li[data-model-id="${id}"] [data-testid=importer-model-add]`).click();
};
for (const id of APPROVED) await addImporterModel(page, id);
check("models added to the importer list through the card", (await page.locator("[data-testid=importer-model]").count()) === APPROVED.length);
await page.locator("[data-testid=importer-model-search]").fill("reader");
check("search does not offer a model already on the list", (await page.locator("[data-testid=importer-model-hits] li[data-model-id='mockvision/reader']").count()) === 0);
await page.locator("[data-testid=importer-model-search]").fill("");
await page.locator("[data-testid=routes-refresh]").click();
check("Refresh provider routes → routes read, ZDR list read", await until(async () => (await tone("routes")) === "success" && /Zero-Data-Retention list read/.test(await page.locator("[data-testid=status-routes]").textContent())));
const selModel = async (t) => page.locator(`[data-testid=sel-${t}]`).getAttribute("data-model");
check("page reading → mockvision/reader (cheapest eligible with a ZDR route)", (await selModel("extract")) === "mockvision/reader", await selModel("extract"));
check("verification → a different model (mockvision/mid)", (await selModel("verify")) === "mockvision/mid", await selModel("verify"));
const why = (await page.locator("[data-testid=sel-extract-reason]").textContent()) ?? "";
check("reason shown: cheapest of N eligible, maximum per request, runner-up", /Cheapest suitable of \d+ eligible models: up to ₹[\d.]+ per request \(next: /.test(why), why);
const costTxt = (await page.locator("[data-testid=sel-extract-cost]").textContent()) ?? "";
check("estimated and conservative maximum cost shown", /about ₹[\d.]+max ₹[\d.]+/.test(costTxt), costTxt);
check("current price shown (highest over routes: in $0.055 · out $0.33)", /in \$0\.055 · out \$0\.33/.test(await page.locator("[data-testid=sel-extract]").textContent()));
check("image input requirement shown as supported", /Required — supported/.test(await page.locator("[data-testid=sel-extract]").textContent()));
check("privacy route shown (ZDR routes listed)", /ZDR routes: mockprov\/zdr, mockprov\/zdr-eu/.test(await page.locator("[data-testid=sel-extract-privacy]").textContent()));
await page.locator("[data-testid=sel-candidates-extract] summary").click();
const cand = (id) => page.locator(`[data-testid=sel-candidates-extract] [data-model-id="${id}"]`);
check("ineligible models listed with the reason (no ZDR route / unhealthy / over the ₹1 limit)", /no Zero-Data-Retention route/.test(await cand("mockvision/cheapnozdr").textContent()) && /serving normally/.test(await cand("mockvision/down").textContent()) && /above the per-request limit/.test(await cand("mockvision/pricey").textContent()));
await page.locator("[data-testid=privacy-zdr]").uncheck();
await page.locator("[data-testid=models-reload]").click();
check("unsaved change (ZDR off) previewed: the cheaper non-ZDR model would be chosen", await until(async () => (await selModel("extract")) === "mockvision/cheapnozdr"));
await page.locator("[data-testid=privacy-zdr]").check();
await page.locator("[data-testid=models-reload]").click();
await until(async () => (await selModel("extract")) === "mockvision/reader");
check("pilot ceilings shown next to the budget fields", /Pilot ceiling ₹10/.test(await page.locator("body").textContent()) && /Pilot ceiling ₹1\./.test(await page.locator("body").textContent()));
await page.locator("[data-testid=settings-save]").click();
await page.locator("[data-testid=settings-msg]").waitFor();
const va = await saved();
check("saved: importer model list, automatic selection, ZDR on, pricier fallbacks off, pilot limits", JSON.stringify(va?.importerModels) === JSON.stringify(APPROVED) && va?.selection?.mode === "auto" && va?.privacy?.zdr === true && va?.budget?.allowPricierFallback === false && va?.budget?.totalInr === 10 && va?.budget?.maxRequestInr === 1, va);
check("saving the importer list changed no global AI → Models approval", (await globalFlags()) === flags0);
await page.reload();
check("after refresh: the importer list is shown again", (await page.locator("[data-testid=importer-model]").count()) === APPROVED.length);
check("after refresh: still automatic, same chosen model", (await page.locator("[data-testid=sel-auto]").isChecked()) && (await selModel("extract")) === "mockvision/reader");
await page.locator("[data-testid=sel-manual]").check();
check("manual override → the model pickers appear", (await page.locator("[data-testid=manual-models]").count()) === 1);

section("B. Searchable extraction model picker (manual override)");
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
check("option shows name, ID, input/output price per M tokens and the max per request", /mockvision\/reader/.test(optText) && /in \$0\.050 \/ out \$0\.30 per M tokens/.test(optText) && /max ₹\d/.test(optText), optText);
await search.press("Enter");
check("Enter selects the highlighted model", /mockvision\/reader/.test(await page.locator("[data-testid=m-extract-current]").textContent()));
const cost = (await page.locator("[data-testid=m-extract-cost]").textContent()) ?? "";
check("selected model: estimate per request + conservative maximum shown", /Estimate per request: about ₹[\d.]+; conservative maximum ₹[\d.]+/.test(cost), cost);
await search.fill("nothing-matches-this");
check("empty search result state", (await page.locator("[data-testid=m-extract-empty]").textContent()) === "No model matches.");
await search.fill("");
await page.keyboard.press("Escape");

section("C. Models off the importer list / unusable models are listed but cannot be chosen");
await page.goto(URL_SETTINGS);
await page.locator("[data-testid=sel-manual]").check();
await page.locator("[data-testid=importer-model][data-model-id='mockvision/checker'] [data-testid=importer-model-remove]").click();
await addImporterModel(page, "mockvision/badimg");
await page.locator("[data-testid=m-verify-search]").fill("checker");
const chk = page.locator("[data-testid=m-verify-list] [data-model-id='mockvision/checker']");
check("a model removed from the importer list is shown with the reason", (await chk.getAttribute("data-usable")) === "false" && /Not on the importer's model list — add it under Importer models/.test(await chk.textContent()));
await chk.click({ force: true });
check("…and clicking it selects nothing", /None — no second read/.test(await page.locator("[data-testid=m-verify-current]").textContent()));
await page.locator("[data-testid=m-verify-search]").fill("badimg");
const bad = page.locator("[data-testid=m-verify-list] [data-model-id='mockvision/badimg']");
check("a model whose image price cannot be read is not selectable, with the reason", (await bad.getAttribute("data-usable")) === "false" && /per-image input price/.test(await bad.textContent()));
await page.keyboard.press("Escape");

section("D. Verification model, same-model notice and cost table");
await page.goto(URL_SETTINGS);
await page.locator("[data-testid=sel-manual]").check();
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
check("persisted: manual override + models + pilot limits + ZDR; paid AI still OFF", v?.selection?.mode === "manual" && v?.models?.extract === "mockvision/reader" && v?.models?.verify === "mockvision/checker" && v?.budget?.totalInr === 10 && v?.budget?.monthlyInr === 10 && v?.budget?.maxJobInr === 8 && v?.budget?.maxRequestInr === 1 && v?.budget?.keyReserveUsd === 5 && v?.privacy?.zdr === true && v?.aiEnabled === false && v?.budget?.retryTransient === false && (v?.models?.extractFallbacks ?? []).length === 0, v);
await page.reload();
check("after refresh: selections shown again", /mockvision\/reader/.test(await page.locator("[data-testid=m-extract-current]").textContent()) && /mockvision\/checker/.test(await page.locator("[data-testid=m-verify-current]").textContent()) && (await page.locator("[data-testid=b-total]").inputValue()) === "10" && (await page.locator("[data-testid=b-maxjob]").inputValue()) === "8");
check("with the ₹1 request cap the reader's maximum fits (not flagged)", (await page.locator("[data-testid=cost-over-cap]").count()) === 0);
check("manual override evaluated with the same checks: shown in the selection table with the reason", /Manual override by an administrator/.test(await page.locator("[data-testid=sel-extract-reason]").textContent()));

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
const t2 = await call({ ...v, budget: { ...v.budget, maxRequestInr: 1, maxJobInr: 0.5 } });
check("raw save with request cap above the hard job limit: refused", /cannot be above the hard limit per job/.test(t2), t2.slice(-200));
const t3 = await call({ ...v, budget: { ...v.budget, monthlyInr: 1500, totalInr: 1000, maxJobInr: 200, defaultJobCapInr: 200, maxRequestInr: 50, keyReserveUsd: 0 } });
const v3 = await saved();
check("raw save above the pilot ceilings: stored clamped (₹10 / ₹10 / ₹8 / ₹1 / $5)", /"ok":true/.test(t3) && v3.budget.monthlyInr === 10 && v3.budget.totalInr === 10 && v3.budget.maxJobInr === 8 && v3.budget.maxRequestInr === 1 && v3.budget.keyReserveUsd === 5, v3.budget);

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
check("retry shows the loading state", await until(async () => /Loading/.test(await page.locator("[data-testid=models-reload]").textContent()), 3000));
check("retry succeeds → error cleared", await until(async () => (await page.locator("[data-testid=models-error]").count()) === 0 && !/Loading/.test(await page.locator("[data-testid=models-reload]").textContent())));
await page.unroute("**/admin/ai-importer/settings");
await db.query(`update "Setting" set value = jsonb_set(value, '{importerModels}', '[]') where key='ai.importer'`);
await page.goto(URL_SETTINGS);
check("importer list emptied → status asks to add a vision model", await until(async () => (await page.locator("[data-testid=status-catalog]").getAttribute("data-tone")) === "warning"));
check("…the saved extraction model is reported as invalid configuration", /not on the importer's model list/.test((await page.locator("[data-testid=status-invalid]").textContent().catch(() => "")) ?? ""));
await page.locator("[data-testid=m-extract-search]").click();
check("…empty list explains how to fix it", /No importer model can read page images/.test((await page.locator("[data-testid=m-extract-empty]").textContent().catch(() => "")) ?? ""));
await page.keyboard.press("Escape");
await page.locator("[data-testid=settings-save]").click();
check("…saving is blocked in the browser with the reason", /fix the invalid model selection/.test((await page.locator("[data-testid=settings-msg]").textContent()) ?? ""));
await db.query(`update "Setting" set value = jsonb_set(value, '{importerModels}', $1::jsonb) where key='ai.importer'`, [JSON.stringify(APPROVED)]);
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
check("FULL_ADMIN: importer list visible but not editable", (await full.locator("[data-testid=importer-models]").count()) === 1 && (await full.locator("[data-testid=importer-model-search]").count()) === 0 && (await full.locator("[data-testid=importer-model-remove]").count()) === 0);
check("FULL_ADMIN: status + selection visible, no model search, no Save, no route refresh", (await full.locator("[data-testid=provider-status]").count()) === 1 && (await full.locator("[data-testid=selection]").count()) === 1 && (await full.locator("[data-testid=m-extract-search]").count()) === 0 && (await full.locator("[data-testid=settings-save]").count()) === 0 && (await full.locator("[data-testid=routes-refresh]").count()) === 0);
const fullRaw = await full.evaluate(async ([id, b]) => { const r = await fetch(location.pathname, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([b]) }); return r.text(); }, [saveId, { ...v, aiEnabled: true }]);
check("FULL_ADMIN raw save refused; paid AI stays OFF", /do not have permission/.test(fullRaw) && (await saved())?.aiEnabled === false, fullRaw.slice(-160));
const m = await newPage(true);
await login(m, process.env.ADMIN_USER, process.env.ADMIN_PASS);
await m.goto(URL_SETTINGS);
check("mobile: selection table readable inside its card (no page scroll)", (await m.locator("[data-testid=sel-extract]").count()) === 1 && (await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
await m.locator("[data-testid=m-extract-search]").click();
await m.locator("[data-testid=m-extract-list]").waitFor();
const box = await m.locator("[data-testid=m-extract-list]").boundingBox();
check("mobile: model list fits the screen", !!box && box.x >= 0 && box.x + box.width <= 376, box);
check("mobile: no horizontal page scroll", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

section("I. Expired admin session vs dropped connection vs missing permission");
// An expired 12 h admin JWT and a missing cookie look the same to the admin proxy (no valid session
// → redirect to /admin/login); both are covered: the cookie removed, and its value made undecodable.
const routesRow = async () => JSON.stringify((await db.query(`select value, "updatedAt" from "Setting" where key='ai.importer.routes'`)).rows[0] ?? null);
const LOGIN_HREF = "/admin/login?callbackUrl=%2Fadmin%2Fai-importer%2Fsettings";
const sx = await newPage();
await login(sx, process.env.ADMIN_USER, process.env.ADMIN_PASS);
await sx.goto(URL_SETTINGS);
const sxText = (id) => sx.locator(`[data-testid=${id}]`).textContent().catch(() => "");
// Waits until the element's text matches (the previous message may still be shown right after the click).
const shows = (id, re) => until(async () => re.test(((await sxText(id)) ?? "").trim()));

await sx.locator("[data-testid=models-reload]").click();
await shows("models-reload", /^Reload status and selection$/);
check("signed in: reload succeeds, no error", (await sx.locator("[data-testid=models-error]").count()) === 0);
await sx.locator("[data-testid=routes-refresh]").click();
await sx.locator("[data-testid=routes-refresh-msg]").waitFor({ timeout: 30000 });
check("signed in: refresh succeeds (no error, no sign-in link)", (await sx.locator("[data-testid=routes-refresh-msg]").getAttribute("data-tone")) !== "error" && (await sx.locator("[data-testid=routes-refresh-msg] [data-testid=session-login]").count()) === 0, await sxText("routes-refresh-msg"));

// Dropped connection: only the action POST fails; the page itself still answers, so this is not a session problem.
await sx.route("**/admin/ai-importer/settings", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
await sx.locator("[data-testid=models-reload]").click();
await sx.locator("[data-testid=models-error]").waitFor({ timeout: 10000 }).catch(() => {});
check("dropped connection: reload says the server could not be reached, with Retry", /Could not load the model list: the server could not be reached/.test((await sxText("models-error")) ?? "") && (await sx.locator("[data-testid=models-retry]").count()) === 1 && (await sx.locator("[data-testid=session-login]").count()) === 0);
await sx.locator("[data-testid=routes-refresh]").click();
check("dropped connection: refresh keeps the could-not-be-reached message", (await shows("routes-refresh-msg", /^Provider routes were not refreshed: the server could not be reached/)) && (await sx.locator("[data-testid=routes-refresh-msg] [data-testid=session-login]").count()) === 0, await sxText("routes-refresh-msg"));
await sx.locator("[data-testid=settings-save]").click();
check("dropped connection: save says not saved / could not be reached (no success)", (await shows("settings-msg", /^Not saved: the server could not be reached/)) && (await sx.locator("[data-testid=session-login]").count()) === 0, await sxText("settings-msg"));
await sx.unroute("**/admin/ai-importer/settings");
await sx.locator("[data-testid=models-reload]").click();
check("connection back: reload clears the error", await until(async () => (await sx.locator("[data-testid=models-error]").count()) === 0));

// Signed in, but the account may no longer use the importer (deactivated): the existing permission message stays.
const { rows: [adminRow] } = await db.query(`select id from "AdminUser" where username = $1`, [process.env.ADMIN_USER]);
const before1 = JSON.stringify(await saved());
await db.query(`update "AdminUser" set "isActive" = false where id = $1`, [adminRow.id]);
try {
  await sx.locator("[data-testid=models-reload]").click();
  await sx.locator("[data-testid=models-error]").waitFor({ timeout: 10000 }).catch(() => {});
  check("permission denied: reload shows the permission error (not session expiry)", /Could not load the model list: You do not have permission/.test((await sxText("models-error")) ?? "") && (await sx.locator("[data-testid=session-login]").count()) === 0, await sxText("models-error"));
  await sx.locator("[data-testid=b-key]").fill("4");
  await sx.locator("[data-testid=b-key]").blur();
  await sx.locator("[data-testid=settings-save]").click();
  check("permission denied: save shows the permission error; nothing saved", (await shows("settings-msg", /do not have permission/)) && JSON.stringify(await saved()) === before1, await sxText("settings-msg"));
} finally {
  await db.query(`update "AdminUser" set "isActive" = true where id = $1`, [adminRow.id]);
}
await sx.goto(URL_SETTINGS);

// Session gone.
const before2 = JSON.stringify(await saved());
const routes2 = await routesRow();
await sx.context().clearCookies();
await sx.locator("[data-testid=models-reload]").click();
await sx.locator("[data-testid=models-error]").waitFor({ timeout: 10000 }).catch(() => {});
const expiredLink = sx.locator("[data-testid=models-error] [data-testid=session-login]");
check("expired session: reload says “Your admin session has expired. Sign in again” (no network error, no Retry)", /^Your admin session has expired\. Sign in again$/.test(((await sxText("models-error")) ?? "").trim()) && (await sx.locator("[data-testid=models-retry]").count()) === 0, await sxText("models-error"));
check("expired session: the sign-in link returns to Import Settings", (await expiredLink.getAttribute("href").catch(() => null)) === LOGIN_HREF);
await sx.locator("[data-testid=routes-refresh]").click();
check("expired session: refresh says the session expired, with the sign-in link", (await shows("routes-refresh-msg", /^Provider routes were not refreshed\. Your admin session has expired\. Sign in again$/)) && (await sx.locator("[data-testid=routes-refresh-msg]").getAttribute("data-tone")) === "error" && (await sx.locator("[data-testid=routes-refresh-msg] [data-testid=session-login]").getAttribute("href")) === LOGIN_HREF, await sxText("routes-refresh-msg"));
check("expired session: refresh saved nothing", (await routesRow()) === routes2);
await sx.locator("[data-testid=b-key]").fill("4");
await sx.locator("[data-testid=b-key]").blur();
await sx.locator("[data-testid=settings-save]").click();
check("expired session: save shows “Not saved. Your admin session has expired. Sign in again”, no success", (await shows("settings-msg", /^Not saved\. Your admin session has expired\. Sign in again$/)) && (await sx.locator("[data-testid=settings-msg] [data-testid=session-login]").getAttribute("href")) === LOGIN_HREF, await sxText("settings-msg"));
check("expired session: save persisted nothing", JSON.stringify(await saved()) === before2);
check("expired session: the form is still there (no crash)", (await sx.locator("[data-testid=settings-form]").count()) === 1);

// Undecodable session cookie (what an expired/forged token amounts to for the proxy).
await login(sx, process.env.ADMIN_USER, process.env.ADMIN_PASS);
await sx.goto(URL_SETTINGS);
const jar = await sx.context().cookies();
await sx.context().clearCookies();
await sx.context().addCookies(jar.map((c) => (/session-token/.test(c.name) ? { ...c, value: `${c.value.slice(0, -8)}AAAAAAAA` } : c)));
await sx.locator("[data-testid=models-reload]").click();
await sx.locator("[data-testid=models-error]").waitFor({ timeout: 10000 }).catch(() => {});
check("invalid session cookie: reload shows the session-expiry message", (await sx.locator("[data-testid=models-error]").getAttribute("data-kind").catch(() => null)) === "session", await sxText("models-error"));

// Sign in again → back on Import Settings, no redirect loop, everything works.
await sx.locator("[data-testid=models-error] [data-testid=session-login]").click();
await sx.waitForURL(/\/admin\/login\?callbackUrl=%2Fadmin%2Fai-importer%2Fsettings$/);
await sx.fill("input[name=username]", process.env.ADMIN_USER);
await sx.fill("input[name=password]", process.env.ADMIN_PASS);
await Promise.all([sx.waitForURL(/\/admin\/ai-importer\/settings$/, { timeout: 30000 }).catch(() => {}), sx.locator("form button[type=submit]").click()]);
check("sign in again: returns to Import Settings", new URL(sx.url()).pathname === "/admin/ai-importer/settings", sx.url());
await sx.locator("[data-testid=models-reload]").click();
await shows("models-reload", /^Reload status and selection$/);
check("after signing in again: reload works", (await sx.locator("[data-testid=models-error]").count()) === 0);
check("after the session tests: saved settings unchanged", JSON.stringify(await saved()) === before2);

check("whole suite: no global AI → Models approval changed", (await globalFlags()) === flags0);
check("no page errors", errors.length === 0, errors);
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
