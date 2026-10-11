/**
 * Direct Instagram publishing — browser checks on a SCRATCH server against a
 * MOCK Meta API (never production, never real Instagram).
 *
 * The suite starts the mock (scripts/mock-meta-graph.mjs) on MOCK_PORT; the
 * scratch `next start` must already run with:
 *   INSTAGRAM_ACCESS_TOKEN=<mockToken("valid")> INSTAGRAM_USER_ID=17841400000000001
 *   INSTAGRAM_GRAPH_API_BASE=http://127.0.0.1:<MOCK_PORT> INSTAGRAM_MEDIA_BASE_URL=http://127.0.0.1:<app port>
 *   INSTAGRAM_PUBLISH_POLL_MS=200 INSTAGRAM_QUEUE_SPACING_MS=1000 NEXTAUTH_URL=AUTH_URL=<BASE> STORAGE_DIR=<scratch>
 *
 *   set -a; . ./.env; set +a     # DATABASE_URL must be an *igstudio* scratch DB (fixture set up)
 *   BASE=http://localhost:3141 MOCK_PORT=3195 TOKEN=<same token> SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-ig-publish-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startMockGraph } from "./mock-meta-graph.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3141";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 3195);
const TOKEN = process.env.TOKEN ?? "";
const SHOTS = process.env.SHOTS ?? "/tmp/ig-publish-shots";
const PASSWORD = "IgStudio#Fixture2026";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
if (!TOKEN.startsWith("IGAAMOCK")) throw new Error("TOKEN must be the fake mock token the scratch server was started with.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();
const fixture = (...args) => execFileSync("npx", ["tsx", "scripts/ig-publish-fixture.ts", ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }).trim().split("\n").pop();

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}

const actionIds = (() => {
  const m = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8"));
  const out = {};
  for (const [id, v] of Object.entries(m.node)) if (v.filename === "app/admin/(dashboard)/instagram/actions.ts") out[v.exportedName] = id;
  return out;
})();

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}

/** Raw Server Action call from inside the signed-in page (bypasses the UI entirely). */
async function rawAction(page, name, args) {
  return page.evaluate(
    async ({ id, args }) => {
      const r = await fetch("/admin/instagram/drafts", { method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body: JSON.stringify(args) });
      return { status: r.status, text: await r.text() };
    },
    { id: actionIds[name], args }
  );
}

async function openPost(page, code) {
  await page.goto(`${BASE}/admin/instagram/drafts`);
  await page.locator(`tr[data-row="${code}"] [data-testid=open-question]`).first().click();
  await page.getByTestId("carousel-editor").waitFor();
  await page.getByTestId("publish-open").waitFor({ timeout: 30000 });
}

async function main() {
  const { server: mock, stats, base } = await startMockGraph(MOCK_PORT);
  const mockState = () => fetch(`${base}/__mock/state`).then((r) => r.json());
  const browser = await chromium.launch();
  const responses = [];
  try {
    fixture("switch-off");
    const OURS = `('IGFIX-RUHS21-W01','IGFIX-RUHS19-W02','IGFIX-RUHS19-W01','IGFIX-RPSC24I-W01')`;
    const otherPostsBefore = sql(`SELECT count(*) FROM "InstagramPost" WHERE "questionCode" NOT IN ${OURS}`);
    const idA = fixture("draft", "IGFIX-RUHS21-W01");
    const idB = fixture("legacy-ready", "IGFIX-RUHS19-W02");
    const batchId = fixture("batch", "IGFIX-RUHS19-W01", "IGFIX-RPSC24I-W01");
    check("fixture: a DRAFT, a legacy READY row and a 2-post batch of completed drafts", sql(`SELECT status FROM "InstagramPost" WHERE id='${idA}'`) === "DRAFT" && sql(`SELECT status FROM "InstagramPost" WHERE id='${idB}'`) === "READY" && /^[a-z0-9]{10,40}$/.test(batchId));

    // ---------------------------------------------------------------- Unauthorized roles
    for (const user of ["igfull", "igteacher"]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await login(page, user);
      await page.goto(`${BASE}/admin/instagram/drafts`);
      const body = await page.locator("body").innerText();
      check(`${user}: Instagram studio restricted, no Publish button`, !/Publish to Instagram/.test(body) && (await page.getByTestId("publish-open").count()) === 0);
      const r = await rawAction(page, "publishPostAction", [{ postId: idA, expectedRevision: 3, requestKey: "aaaaaaaaaaaaaaaaaaaa", format: "CAROUSEL", confirmed: true, acknowledged: [] }]);
      check(`${user}: raw publishPostAction → refused (Master Admin only)`, /Only a Master Admin/.test(r.text), r.text.slice(0, 200));
      const s = await rawAction(page, "setPublishingSwitchAction", [true]);
      check(`${user}: raw setPublishingSwitchAction → refused`, /Only a Master Admin/.test(s.text), s.text.slice(0, 200));
      await ctx.close();
    }
    check("unauthorized calls changed nothing (still DRAFT, switch OFF, no Meta writes)", sql(`SELECT status FROM "InstagramPost" WHERE id='${idA}'`) === "DRAFT" && !/"enabled":true/.test(sql(`SELECT coalesce(value::text,'') FROM "Setting" WHERE key='instagram.publishing'`)) && stats.publishCalls === 0 && stats.nonGet === 0);

    // ---------------------------------------------------------------- Master Admin
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    page.on("response", async (res) => {
      try {
        if (res.url().startsWith(BASE)) responses.push(await res.text());
      } catch {}
    });
    await login(page, "igmaster");

    await page.goto(`${BASE}/admin/instagram/drafts`);
    check("banner: publishing OFF", (await page.getByTestId("publishing-disabled").count()) === 1);
    await openPost(page, "IGFIX-RUHS21-W01");
    check("switch OFF: Publish button disabled with the reason", (await page.getByTestId("publish-open").isDisabled()) && /turned off/.test(await page.getByTestId("publish-blocked-reason").innerText()));
    const forced = await rawAction(page, "publishPostAction", [{ postId: idA, expectedRevision: Number(sql(`SELECT revision FROM "InstagramPost" WHERE id='${idA}'`)), requestKey: "bbbbbbbbbbbbbbbbbbbbbbbb", format: "CAROUSEL", confirmed: true, acknowledged: [] }]);
    check("switch OFF: raw publish call refused server-side", /turned off/.test(forced.text) && stats.publishCalls === 0, forced.text.slice(0, 200));

    await page.goto(`${BASE}/admin/instagram/settings`);
    check("Settings: Direct publishing card shows OFF", (await page.getByTestId("publishing-switch-state").innerText()).trim() === "OFF");
    await page.getByTestId("publishing-switch-toggle").click();
    await page.getByTestId("publishing-switch-state").filter({ hasText: "ON" }).waitFor();
    check("Settings: switch turned ON (audited)", sql(`SELECT count(*) FROM "AuditLog" WHERE action='INSTAGRAM_PUBLISHING_ENABLED'`) !== "0");
    await page.goto(`${BASE}/admin/instagram/drafts`);
    check("banner: publishing ON, manual confirmation only", /Confirm & Publish/.test(await page.getByTestId("publishing-enabled").innerText()));

    const rev = Number(sql(`SELECT revision FROM "InstagramPost" WHERE id='${idA}'`));
    const unconfirmed = await rawAction(page, "publishPostAction", [{ postId: idA, expectedRevision: rev, requestKey: "cccccccccccccccccccccccc", format: "CAROUSEL", confirmed: false, acknowledged: [] }]);
    check("raw call without explicit confirmation → refused", /explicit confirmation/.test(unconfirmed.text) && stats.publishCalls === 0, unconfirmed.text.slice(0, 200));
    const unacked = await rawAction(page, "publishPostAction", [{ postId: idA, expectedRevision: rev, requestKey: "eeeeeeeeeeeeeeeeeeeeeeee", format: "CAROUSEL", confirmed: true, acknowledged: [] }]);
    check("raw call that skips the dialog's warnings → refused, nothing claimed", /New review warnings/.test(unacked.text) && sql(`SELECT status FROM "InstagramPost" WHERE id='${idA}'`) === "DRAFT" && stats.publishCalls === 0, unacked.text.slice(0, 200));
    await page.goto(`${BASE}/admin/instagram/drafts`);
    const draftsText = await page.getByTestId("drafts-table").innerText();
    check("Drafts: no 'Ready' status anywhere; legacy READY row listed as Draft", !/\bReady\b/.test(draftsText) && /Draft/.test(await page.locator(`tr[data-row="IGFIX-RUHS19-W02"]`).innerText()), draftsText.slice(0, 300));
    check("Drafts: every row has a Publish to Instagram button", (await page.getByTestId("row-publish").count()) >= 2);

    // Open → Publish → Cancel
    await openPost(page, "IGFIX-RUHS21-W01");
    await page.screenshot({ path: `${SHOTS}/01-editor-ready.png` });
    check("no Mark Ready / approval controls in the editor", (await page.getByTestId("mark-ready").count()) === 0 && (await page.getByTestId("back-to-draft").count()) === 0 && (await page.getByTestId("trap-approve").count()) === 0);
    check("green Publish to Instagram button enabled straight on the Draft", await page.getByTestId("publish-open").isEnabled());
    await page.getByTestId("publish-open").click();
    const dlg = page.getByTestId("publish-confirm");
    await dlg.waitFor();
    await page.getByTestId("publish-confirm-button").and(page.locator(":enabled")).waitFor({ timeout: 20000 });
    const dlgText = await dlg.innerText();
    check("one dialog titled 'Publish to Instagram?' with account + destination", /Publish to Instagram\?/.test(dlgText) && /Instagram feed/.test(await page.getByTestId("confirm-destination").innerText()) && (await page.getByTestId("publish-confirm").count()) === 1);
    check("dialog lists warnings to check + what the confirmation covers; only Cancel / Confirm & Publish", (await page.getByTestId("confirm-warnings").count()) === 1 && /medically accurate/.test(await page.getByTestId("confirm-covers").innerText()) && (await dlg.locator('input[type="checkbox"]').count()) === 0 && (await dlg.locator('input[type="text"]').count()) === 0);
    check("dialog shows username, 5 slides, caption, hashtags", (await page.getByTestId("confirm-username").innerText()) === "@mocktestseries.in" && (await page.getByTestId("confirm-slide-count").innerText()) === "5" && /Can you solve this IGFIX-RUHS21-W01 PYQ/.test(await page.getByTestId("confirm-caption").innerText()) && /#RUHSMO2026 #MedicalOfficer/.test(await page.getByTestId("confirm-hashtags").innerText()));
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="confirm-preview"] img')].length === 5 && [...document.querySelectorAll('[data-testid="confirm-preview"] img')].every((i) => i.complete && i.naturalWidth === 1080), null, { timeout: 60000 });
    check("dialog preview: 5 rendered 1080-px slides", true);
    await page.screenshot({ path: `${SHOTS}/02-confirm-dialog.png` });
    await page.getByTestId("publish-cancel").click();
    await dlg.waitFor({ state: "detached" });
    check("Cancel → nothing published, still DRAFT", sql(`SELECT status FROM "InstagramPost" WHERE id='${idA}'`) === "DRAFT" && stats.publishCalls === 0 && stats.nonGet === 0);

    // Confirm (double click) → Publishing… → Success
    await page.getByTestId("publish-open").click();
    await page.getByTestId("publish-confirm-button").and(page.locator(":enabled")).waitFor({ timeout: 20000 });
    await page.getByTestId("publish-confirm-button").dblclick();
    await page.getByTestId("publishing-message").waitFor({ timeout: 15000 }).catch(() => {});
    const sawPublishing = (await page.getByTestId("publishing-message").count()) > 0 || (await page.getByTestId("published-state").count()) > 0;
    check("“Publishing to Instagram…” shown while the job runs", sawPublishing);
    await page.getByTestId("published-state").waitFor({ timeout: 90000 });
    await page.screenshot({ path: `${SHOTS}/03-published.png` });
    const st = await mockState();
    const row = sql(`SELECT status || '|' || coalesce("igMediaId",'') || '|' || coalesce("igPermalink",'') || '|' || ("publishedAt" IS NOT NULL) FROM "InstagramPost" WHERE id='${idA}'`).split("|");
    check("double click → exactly one Instagram post (one media_publish)", st.media.length === 1 && stats.publishCalls === 1, { media: st.media.length, calls: stats.publishCalls });
    check("DB: PUBLISHED with media ID, permalink, publishedAt", row[0] === "PUBLISHED" && row[1] === st.media[0].id && row[2] === st.media[0].permalink && row[3] === "true", row);
    const conf = JSON.parse(sql(`SELECT review::text FROM "InstagramPost" WHERE id='${idA}'`) || "{}");
    check("the single confirmation is stored (via single, exact revision, acknowledged warnings) + audited", conf.via === "single" && conf.revision === rev && Array.isArray(conf.acknowledged) && conf.acknowledged.length > 0 && sql(`SELECT count(*) FROM "AuditLog" WHERE "entityId"='${idA}' AND action='INSTAGRAM_PUBLISH_STARTED' AND metadata->>'confirmedVia'='single'`) === "1", conf);
    check("success panel: message, media ID, URL, date", /Successfully published to Instagram/.test(await page.getByTestId("published-state").innerText()) && (await page.getByTestId("published-media-id").innerText()) === st.media[0].id && (await page.getByTestId("published-permalink").innerText()) === st.media[0].permalink && /IST/.test(await page.getByTestId("published-at").innerText()));
    check("“View on Instagram” links to the permalink in a new tab", (await page.getByTestId("view-on-instagram").getAttribute("href")) === st.media[0].permalink && (await page.getByTestId("view-on-instagram").getAttribute("target")) === "_blank");
    check("Meta downloaded all 5 slides anonymously from the public media route (JPEG)", stats.imageFetches.length === 5 && stats.imageFetches.every((f) => f.ok && f.contentType.startsWith("image/jpeg") && f.url.startsWith("http://127.0.0.1:")), stats.imageFetches);
    check("published post is locked in the editor (fields disabled, no Publish button)", (await page.getByTestId("field-hook").isDisabled()) && (await page.getByTestId("publish-open").count()) === 0);
    const mediaUrl = stats.imageFetches[0].url.replace(/^http:\/\/127\.0\.0\.1:\d+/, BASE);
    const afterRes = await fetch(mediaUrl);
    check("public media URL is gone after publishing (404)", afterRes.status === 404, afterRes.status);
    const again = await rawAction(page, "publishPostAction", [{ postId: idA, expectedRevision: Number(sql(`SELECT revision FROM "InstagramPost" WHERE id='${idA}'`)), requestKey: "dddddddddddddddddddddddd", format: "CAROUSEL", confirmed: true }]);
    check("re-publishing a published post is refused server-side", /already published/.test(again.text) && stats.publishCalls === 1, again.text.slice(0, 200));

    // Reload mid-flight is covered by the library suite; here: failure → Retry.
    await fetch(`${base}/__mock/control`, { method: "POST", body: JSON.stringify({ failNextPublish: true }) });
    await page.keyboard.press("Escape");
    // Drafts → "Publish to Instagram" on the row opens the final confirmation directly (legacy READY row).
    await page.goto(`${BASE}/admin/instagram/drafts`);
    await page.locator(`tr[data-row="IGFIX-RUHS19-W02"] [data-testid=row-publish]`).click();
    await page.getByTestId("publish-confirm").waitFor({ timeout: 30000 });
    check("Drafts row Publish → straight to the 'Publish to Instagram?' confirmation", /Publish to Instagram\?/.test(await page.getByTestId("publish-confirm").innerText()));
    await page.getByTestId("publish-confirm-button").and(page.locator(":enabled")).waitFor({ timeout: 20000 });
    await page.getByTestId("publish-confirm-button").click();
    await page.getByTestId("failed-state").waitFor({ timeout: 90000 });
    await page.screenshot({ path: `${SHOTS}/04-failed.png` });
    const failText = await page.getByTestId("failed-state").innerText();
    check("failure shown: useful message, nothing was posted, retry offered", /Publishing failed — nothing was posted/.test(failText) && /temporarily unavailable/.test(failText) && /Nothing was published/.test(failText) && /Retry/.test(await page.getByTestId("publish-open").innerText()), failText);
    check("failed post: content kept, status FAILED, no Instagram post", sql(`SELECT status FROM "InstagramPost" WHERE id='${idB}'`) === "FAILED" && (await mockState()).media.length === 1);
    await page.getByTestId("publish-open").click();
    await page.getByTestId("publish-confirm-button").and(page.locator(":enabled")).waitFor({ timeout: 20000 });
    await page.getByTestId("publish-confirm-button").click();
    await page.getByTestId("published-state").waitFor({ timeout: 90000 });
    const st2 = await mockState();
    check("Retry → published once, reusing the prepared container", st2.media.length === 2 && st2.containers.filter((c) => c.kind === "CAROUSEL").length === 2 && stats.imageFetches.length === 10, { media: st2.media.length, fetches: stats.imageFetches.length });

    // ---------------------------------------------------------------- Bulk Studio: one confirmation for the selected drafts
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/admin/instagram/bulk/${batchId}`);
    await page.getByTestId("bulk-batch").waitFor();
    check("Bulk: no approval / 'Mark Ready' wording; completed drafts are selectable", !/Mark Ready|approved/i.test(await page.getByTestId("bulk-batch").innerText()) && (await page.getByTestId("select-item").count()) === 2);
    await page.getByTestId("select-all-completed").click();
    await page.getByTestId("queue-open-confirm").click();
    const qd = page.getByTestId("queue-confirm");
    await qd.waitFor();
    await page.getByTestId("queue-confirm-button").and(page.locator(":enabled")).waitFor({ timeout: 30000 });
    const qText = await qd.innerText();
    check("Bulk review: one screen with every selected post (slides, caption), account, destination", /Publish to Instagram\?/.test(qText) && (await qd.locator("[data-review-item]").count()) === 2 && (await page.getByTestId("queue-caption").count()) === 2 && /@mocktestseries\.in/.test(qText) && /Instagram feed/.test(qText), qText.slice(0, 300));
    check("Bulk review: no 'type PUBLISH' box, no per-post approval; one 'Confirm & Publish Selected' button", (await qd.locator("input").count()) === 0 && (await page.getByTestId("queue-confirm-button").innerText()).includes("Confirm & Publish Selected"));
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="queue-review-list"] img')].every((i) => i.complete && i.naturalWidth === 1080), null, { timeout: 90000 });
    check("Bulk review: every slide of every selected post rendered (1080 px)", (await qd.locator("img").count()) === 10);
    await page.screenshot({ path: `${SHOTS}/04b-bulk-review.png` });
    const mediaBefore = (await mockState()).media.length;
    await page.getByTestId("queue-confirm-button").dblclick();
    await page.waitForFunction(() => document.querySelector('[data-testid="bulk-batch"]')?.getAttribute("data-status") === "COMPLETE", null, { timeout: 120000 });
    const stB = await mockState();
    check("Bulk: both selected posts published exactly once (double click safe), queue COMPLETE", stB.media.length === mediaBefore + 2 && ["IGFIX-RUHS19-W01", "IGFIX-RPSC24I-W01"].every((c) => stB.media.filter((m) => m.caption.includes(c)).length === 1), { before: mediaBefore, after: stB.media.length });
    check("Bulk: one INSTAGRAM_QUEUE_CONFIRMED audit; each publish recorded as confirmedVia=bulk", sql(`SELECT count(*) FROM "AuditLog" WHERE "entityId"='${batchId}' AND action='INSTAGRAM_QUEUE_CONFIRMED'`) === "1" && sql(`SELECT count(*) FROM "AuditLog" WHERE action='INSTAGRAM_PUBLISH_STARTED' AND metadata->>'batchId'='${batchId}'`) === "2");
    await page.screenshot({ path: `${SHOTS}/04c-bulk-done.png` });

    // Published History
    await page.goto(`${BASE}/admin/instagram/history`);
    const table = page.getByTestId("published-table");
    await table.waitFor();
    const text = await table.innerText();
    check("History: the posts with question code, exam / PYQ year, media ID, View link", /IGFIX-RUHS21-W01/.test(text) && /IGFIX-RUHS19-W02/.test(text) && /PYQ 2021/.test(text) && /PYQ 2019/.test(text) && text.includes(st2.media[0].id) && text.includes(st2.media[1].id) && (await table.getByTestId("row-permalink").count()) === 4, text);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="published-table"] img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60000 });
    check("History: post previews render", true);
    await page.screenshot({ path: `${SHOTS}/05-history.png`, fullPage: true });

    // Secrets
    const all = responses.join("\n");
    check(`no token in any page / action / image response (${responses.length} responses)`, !all.includes(TOKEN) && !/IGAAMOCK/.test(all));
    check("no token in Meta URLs or bodies", stats.tokenInUrl === 0 && stats.tokenInBody === 0 && stats.missingAuth === 0);
    check("other Instagram drafts untouched", sql(`SELECT count(*) FROM "InstagramPost" WHERE "questionCode" NOT IN ${OURS}`) === otherPostsBefore);
    const bad = await fetch(`${BASE}/api/instagram-media/${"0".repeat(48)}/slide-1.jpg`);
    const bad2 = await fetch(`${BASE}/api/instagram-media/..%2F..%2F.env/slide-1.jpg`);
    check("public media route: unknown token / traversal → 404", bad.status === 404 && bad2.status === 404);
    const adminImg = await fetch(`${BASE}/api/admin/instagram/slide?postId=${idA}&i=0`);
    check("admin slide route still needs login (403 signed-out)", adminImg.status === 403);
    await ctx.close();
  } finally {
    fixture("switch-off");
    await browser.close();
    mock.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
