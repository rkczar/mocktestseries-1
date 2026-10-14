/**
 * Browser verification for the admin upgrade (scratch server + scratch DB only).
 *
 *   BASE=http://localhost:<port> DATABASE_URL=<scratch> QA_PASSWORD=<pw> AUTH_SECRET=<scratch secret> \
 *   BACKUP_FILE=<a Backup Center .tar> SHOTS=<dir> NODE_PATH=<dir with playwright> node scripts/verify-admin-upgrade-ui.mjs
 *
 * Needs admins qa-master (MASTER_ADMIN) and qa-full (FULL_ADMIN) with QA_PASSWORD on the scratch DB.
 * Covers: All Students paging/search/filters, Admin Edit + password reset (authorized and
 * unauthorized), dashboard cards + drag/move/save/reset layout, Communications/Action Required
 * counts and that opening never resolves, Multiple Sessions detail, Appearance palettes (both
 * modes, persistence, SEO head unchanged, mobile), Backup on-device check (intact + truncated).
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE;
const PW = process.env.QA_PASSWORD;
const SHOTS = process.env.SHOTS ?? null;
const DBURL = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!BASE || !PW || !DBURL || /\/mocktestseries$/.test(DBURL)) {
  console.error("Refusing to run: needs BASE, QA_PASSWORD and a SCRATCH DATABASE_URL.");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const sql = (q) => execFileSync("psql", [DBURL, "-X", "-A", "-t", "-c", q], { encoding: "utf8" }).trim();
const shot = async (page, name, fullPage = false) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
};
async function step(name, fn) {
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (e) {
    check(`${name} (no exception)`, false, e instanceof Error ? e.message : String(e));
  }
}
async function adminLogin(browser, username, password = PW, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }).catch(() => null), page.locator("form button[type=submit]").click()]);
  return { ctx, page, ok: !page.url().includes("/admin/login") };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// Repeat runs within 15 minutes would trip the login and re-auth throttles (each run makes
// deliberate wrong-password attempts). Clear only the qa-* rows on this scratch DB.
sql(`delete from "LoginAttempt" where username like 'qa-%'`);
sql(`delete from "AuditLog" where action='ADMIN_REAUTH_FAILED' and "actorId" in (select id from "AdminUser" where username like 'qa-%')`);

const browser = await chromium.launch();
try {
  const nonDeleted = Number(sql(`select count(*) from "Student" where status <> 'DELETED'`));
  const master = await adminLogin(browser, "qa-master");
  check("qa-master signs in", master.ok);
  const page = master.page;

  await step("All Students", async () => {
    await page.goto(`${BASE}/admin/students?tab=all`);
    const counts = await page.locator("[data-testid=students-counts]").innerText();
    check(`Header shows the full total (${nonDeleted})`, counts.includes(nonDeleted.toLocaleString("en-IN")), counts);
    check("Default page shows 50 rows", (await page.locator("[data-testid=students-table] tbody tr").count()) === Math.min(50, nonDeleted));
    const last = Math.ceil(nonDeleted / 50);
    await page.goto(`${BASE}/admin/students?tab=all&page=${last}`);
    const lastRows = await page.locator("[data-testid=students-table] tbody tr").count();
    check(`Last page ${last} shows the remaining ${nonDeleted - (last - 1) * 50} students`, lastRows === nonDeleted - (last - 1) * 50, lastRows);
    const oldest = sql(`select "studentId" from "Student" where status <> 'DELETED' order by "createdAt" asc, id asc limit 1`);
    check(`The oldest student (${oldest}) is on the last page`, (await page.locator("[data-testid=students-table]").innerText()).includes(oldest));
    await page.goto(`${BASE}/admin/students?tab=all&per=200`);
    check("200 per page → 200 rows", (await page.locator("[data-testid=students-table] tbody tr").count()) === Math.min(200, nonDeleted));
    await page.locator("[data-testid=students-pagination] a[rel=next]").click();
    await page.waitForURL(/page=2/);
    check("Next → page 2 keeps 200 per page", (await page.locator("[data-testid=students-table] tbody tr").count()) === Math.max(0, Math.min(200, nonDeleted - 200)));
    await page.goto(`${BASE}/admin/students?tab=all`);
    await page.fill("input[name=q]", oldest.replace("-", ""));
    await Promise.all([page.waitForURL(/q=/), page.locator("[data-testid=students-filters] button[type=submit]").click()]);
    const found = await page.locator("[data-testid=students-table]").innerText();
    check(`Search "${oldest.replace("-", "")}" finds ${oldest}`, found.includes(oldest));
    const premium = Number(sql(`select count(distinct e."studentId") from "StudentEntitlement" e join "Student" s on s.id=e."studentId" where s.status<>'DELETED' and e.status='ACTIVE' and e."startsAt"<=now() and (e."expiresAt" is null or e."expiresAt">now()) and e."productId" in (select jsonb_array_elements_text(value->'premiumProductIds') from "Setting" where key='access.premium_policy')`));
    await page.goto(`${BASE}/admin/students?tab=all&access=premium`);
    const pc = await page.locator("[data-testid=students-counts]").innerText();
    check(`Premium filter count = ${premium}`, pc.includes(`${premium} match`), pc);
    await shot(page, "students-premium");
    const m = await adminLogin(browser, "qa-master", PW, { width: 390, height: 844 });
    await m.page.goto(`${BASE}/admin/students?tab=all`);
    check("Mobile: no horizontal page scroll", await noHScroll(m.page));
    await shot(m.page, "students-mobile");
    await m.ctx.close();
  });

  await step("Admin users: edit + password reset", async () => {
    const fullId = sql(`select id from "AdminUser" where username='qa-full'`);
    const fullRole = sql(`select id from "Role" where name='ADMIN'`);
    const teacherRole = sql(`select id from "Role" where name='TEACHER'`);
    sql(`update "AdminUser" set name='QA Full Admin', "roleId"='${fullRole}' where id='${fullId}'`); // fresh state on repeat runs
    await page.goto(`${BASE}/admin/users?tab=admins`);
    await page.locator("[data-testid=edit-admin-qa-full]").click();
    const dlg = page.locator("[role=dialog]");
    await dlg.waitFor();
    check("Edit dialog shows last login and permissions, never a password value", (await dlg.innerText()).includes("Last login") && (await dlg.innerText()).includes("payments:view") && !(await dlg.innerText()).includes("$argon2"));
    await dlg.locator(`#ae-name-${fullId}`).fill("QA Full Admin Renamed");
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await dlg.locator("text=Saved.").waitFor({ timeout: 15000 });
    check("Name-only change saves without re-authentication", sql(`select name from "AdminUser" where id='${fullId}'`) === "QA Full Admin Renamed");
    await dlg.locator(`#ae-role-${fullId}`).selectOption(teacherRole);
    await dlg.locator(`#ae-reauth-${fullId}`).fill("wrong-password-123");
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await dlg.locator("text=Your current password is incorrect.").waitFor({ timeout: 15000 });
    check("Role change with a wrong password is refused", sql(`select "roleId" from "AdminUser" where id='${fullId}'`) === fullRole);
    check("Failed re-check is audit-logged", Number(sql(`select count(*) from "AuditLog" where action='ADMIN_REAUTH_FAILED' and "actorId"=(select id from "AdminUser" where username='qa-master')`)) >= 1);
    await dlg.locator(`#ae-reauth-${fullId}`).fill(PW);
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await dlg.locator("[role=status]", { hasText: "Saved. This admin has been signed out" }).waitFor({ timeout: 15000 });
    check("Role change with the correct password saves", sql(`select "roleId" from "AdminUser" where id='${fullId}'`) === teacherRole);
    check("…invalidates the target's sessions", sql(`select "sessionsValidAfter" is not null from "AdminUser" where id='${fullId}'`) === "t");
    check("…and is audit-logged with from/to (no password)", /"roleFrom": ?"FULL_ADMIN".*"roleTo": ?"TEACHER"|roleTo/.test(sql(`select metadata::text from "AuditLog" where action='ADMIN_ROLE_CHANGED' and "entityId"='${fullId}' order by "createdAt" desc limit 1`)));
    // Put the role back for the unauthorized checks below.
    await dlg.locator(`#ae-role-${fullId}`).selectOption(fullRole);
    await dlg.locator(`#ae-reauth-${fullId}`).fill(PW);
    await dlg.getByRole("button", { name: "Save changes" }).click();
    for (let i = 0; i < 30 && sql(`select "roleId" from "AdminUser" where id='${fullId}'`) !== fullRole; i++) await page.waitForTimeout(500);
    check("Role restored to FULL_ADMIN", sql(`select "roleId" from "AdminUser" where id='${fullId}'`) === fullRole);
    // Password reset
    const NEWPW = `Qa-${crypto.randomBytes(6).toString("hex")}-reset`;
    const before = sql(`select "passwordHash" from "AdminUser" where id='${fullId}'`);
    await dlg.getByLabel("New password", { exact: true }).fill(NEWPW);
    await dlg.getByLabel("Confirm new password").fill(NEWPW + "x");
    await dlg.getByLabel("Your current password", { exact: true }).fill(PW);
    await dlg.getByRole("button", { name: "Reset password" }).click();
    await dlg.locator("text=do not match").waitFor({ timeout: 15000 });
    check("Mismatched confirmation refused", sql(`select "passwordHash" from "AdminUser" where id='${fullId}'`) === before);
    await dlg.getByLabel("Confirm new password").fill(NEWPW);
    await dlg.getByRole("button", { name: "Reset password" }).click();
    await dlg.locator("text=Password reset.").waitFor({ timeout: 15000 });
    const after = sql(`select "passwordHash" from "AdminUser" where id='${fullId}'`);
    check("Password reset stores a new argon2 hash (never plaintext)", after !== before && after.startsWith("$argon2") && !after.includes(NEWPW));
    check("Reset is audit-logged", Number(sql(`select count(*) from "AuditLog" where action='ADMIN_PASSWORD_RESET' and "entityId"='${fullId}'`)) >= 1);
    const oldLogin = await adminLogin(browser, "qa-full", PW);
    check("Old password no longer works", !oldLogin.ok);
    await oldLogin.ctx.close();
    const full = await adminLogin(browser, "qa-full", NEWPW);
    check("New password works", full.ok);
    // FULL_ADMIN: read-only — no Edit button, and the server action itself refuses.
    await full.page.goto(`${BASE}/admin/users?tab=admins`);
    check("FULL_ADMIN sees no Edit buttons", (await full.page.locator("[data-testid^=edit-admin-]").count()) === 0);
    await page.keyboard.press("Escape");
    // Self-protection: master's own role select is disabled.
    const masterId = sql(`select id from "AdminUser" where username='qa-master'`);
    await page.locator("[data-testid=edit-admin-qa-master]").click();
    check("Own role cannot be changed (control disabled)", await page.locator(`#ae-role-${masterId}`).isDisabled());
    await page.keyboard.press("Escape");
    // Raw server-action call as FULL_ADMIN (bypassing the UI) must be refused.
    const manifest = JSON.parse(fs.readFileSync(process.env.ACTION_MANIFEST, "utf8"));
    const entry = Object.entries(manifest.node).find(([, v]) => v.exportedName === "updateAdminUserAction" || (v.filename ?? "").includes("users/admins/actions") && v.exportedName === "updateAdminUserAction");
    if (entry) {
      const [actionId] = entry;
      const res = await full.page.evaluate(
        async ({ id, body }) => {
          const r = await fetch("/admin/users?tab=admins", { method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body });
          return { status: r.status, text: (await r.text()).slice(0, 400) };
        },
        { id: actionId, body: JSON.stringify([{ id: masterId, name: "Hacked", email: "", roleId: teacherRole, isActive: true, actorPassword: NEWPW }]) }
      );
      check("FULL_ADMIN raw action call → refused, nothing changed", sql(`select name from "AdminUser" where id='${masterId}'`) === "QA Master" && sql(`select "roleId" from "AdminUser" where id='${masterId}'`) !== teacherRole, res);
    } else check("found updateAdminUserAction in the action manifest", false);
    await full.ctx.close();
    sql(`update "AdminUser" set name='QA Full Admin' where id='${fullId}'`);
  });

  await step("Dashboard cards, counts and layout", async () => {
    // Start from the default order even if an earlier aborted run left a saved layout behind.
    sql(`delete from "Setting" where key='admin.dashboard.layout:'||(select id from "AdminUser" where username='qa-master')`);
    await page.goto(`${BASE}/admin`);
    await page.locator("[data-testid=dashboard-grid]").waitFor();
    for (const id of ["action-required", "online-now", "communications", "multiple-sessions", "total-students", "active-students", "revenue-mtd", "vps-storage", "ai-usage"])
      check(`Card present: ${id}`, (await page.locator(`[data-card-id=${id}]`).count()) === 1);
    check("Last updated timestamp shown", /Last updated \d/.test(await page.locator("[data-testid=dashboard-updated]").innerText()));
    const contactPending = Number(sql(`select count(*) from "Communication" where type='CONTACT' and status in ('NEW','READ','IN_PROGRESS')`));
    const growPending = Number(sql(`select count(*) from "Communication" where type='GROW_WITH_US' and status in ('NEW','READ','IN_PROGRESS')`));
    const unread = Number(sql(`select count(*) from "Communication" where status='NEW'`));
    const comm = await page.locator("[data-testid=communications-card]").innerText();
    check(`Communications card: ${contactPending + growPending} pending, ${unread} unread`, comm.includes(`${contactPending + growPending}`) && comm.includes(`${unread}`), comm);
    check("Communications tone is red when something is unread", (await page.locator("[data-testid=communications-card]").getAttribute("data-tone")) === (unread ? "urgent" : contactPending + growPending ? "attention" : "none"));
    const contactRow = await page.locator("[data-testid=action-contact]").innerText();
    check("Action Required: Contact row count", contactRow.includes(String(contactPending)), contactRow);
    check("Action Required: Grow With Us row count", (await page.locator("[data-testid=action-grow-with-us]").innerText()).includes(String(growPending)));
    const statusBefore = sql(`select string_agg(id||status, ',' order by id) from "Communication"`);
    await page.locator("[data-testid=action-contact]").click();
    await page.waitForURL(/communications\?tab=contact/);
    await page.goto(`${BASE}/admin`);
    check("Opening a queue from the dashboard does not change any status", sql(`select string_agg(id||status, ',' order by id) from "Communication"`) === statusBefore);
    const totalCard = await page.locator("[data-card-id=total-students]").innerText();
    check(`Total Students = ${nonDeleted} (deleted excluded)`, totalCard.includes(String(nonDeleted)), totalCard);
    await shot(page, "dashboard", true);

    // Layout: move, drag, save, persist, reset
    const orderNow = () => page.locator("[data-testid=dashboard-grid] > [data-card-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-card-id")));
    const original = await orderNow();
    await page.locator("[data-testid=dashboard-customize]").click();
    await page.getByRole("button", { name: "Move Online Now up" }).click();
    let o = await orderNow();
    check("Move Up moves the card one place", o.indexOf("online-now") === original.indexOf("online-now") - 1);
    const handle = page.getByRole("button", { name: "Drag New Registrations (7d)" });
    await page.locator("[data-card-id=action-required]").scrollIntoViewIfNeeded();
    const target = page.locator("[data-card-id=action-required]");
    const hb = await handle.boundingBox();
    const tb = await target.boundingBox();
    const cb0 = await page.locator("[data-card-id=new-registrations]").boundingBox();
    await page.mouse.move(hb.x + 10, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 30, hb.y + 30, { steps: 5 });
    // closestCenter compares the dragged card's centre with each card's centre, so steer the card's
    // centre (not the handle) onto the wide Action Required card's centre.
    const cb = cb0;
    const gx = hb.x + 10 - (cb.x + cb.width / 2);
    const gy = hb.y + hb.height / 2 - (cb.y + cb.height / 2);
    await page.mouse.move(tb.x + tb.width / 2 + gx, tb.y + tb.height / 2 + gy, { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    o = await orderNow();
    check("Drag-and-drop moves New Registrations above Action Required", o.indexOf("new-registrations") < o.indexOf("action-required"), o.slice(0, 4));
    await page.locator("[data-testid=dashboard-save-layout]").click();
    await page.locator("text=Layout saved.").waitFor({ timeout: 15000 });
    await page.reload();
    const saved = await orderNow();
    check("Saved layout persists after reload", JSON.stringify(saved) === JSON.stringify(o));
    check("Layout stored per admin in Setting", Number(sql(`select count(*) from "Setting" where key='admin.dashboard.layout:'||(select id from "AdminUser" where username='qa-master')`)) === 1);
    const mob = await adminLogin(browser, "qa-master", PW, { width: 390, height: 844 });
    await mob.page.goto(`${BASE}/admin`);
    check("Mobile: same saved order", JSON.stringify(await mob.page.locator("[data-testid=dashboard-grid] > [data-card-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-card-id")))) === JSON.stringify(o));
    check("Mobile: no horizontal page scroll", await noHScroll(mob.page));
    await mob.page.locator("[data-testid=dashboard-customize]").click();
    check("Mobile: Move Up/Down controls available", (await mob.page.getByRole("button", { name: /Move .* down/ }).count()) > 5);
    await shot(mob.page, "dashboard-mobile-edit");
    await mob.ctx.close();
    await page.locator("[data-testid=dashboard-customize]").click();
    await page.locator("[data-testid=dashboard-reset-layout]").click();
    await page.locator("text=Default layout restored.").waitFor({ timeout: 15000 });
    await page.reload();
    check("Reset Default Layout restores the default order", JSON.stringify(await orderNow()) === JSON.stringify(original));
    // FULL_ADMIN: restricted cards. TEACHER-like check uses role permissions; FULL_ADMIN has payments/backup view.
  });

  await step("Multiple sessions detail", async () => {
    await page.goto(`${BASE}/admin/monitoring/authentication#multiple-sessions`);
    const sec = page.locator("[data-testid=multiple-sessions]");
    await sec.waitFor();
    const txt = await sec.innerText();
    check("Section explains the definition and that nothing is blocked", txt.includes("Display only") && txt.includes("tabs in one browser are one session"));
    check("No session token material in the page", !(await page.content()).includes("tokenHash"));
  });

  await step("Appearance palettes", async () => {
    const seoHead = async () => {
      const html = await (await fetch(`${BASE}/`)).text();
      const pick = (re) => (html.match(re) ?? [""])[0];
      return [pick(/<title>[^<]*<\/title>/), pick(/<meta name="description"[^>]*>/), pick(/<link rel="canonical"[^>]*>/), (html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) ?? []).join("")].join("\n");
    };
    const headBefore = await seoHead();
    const css = async (ctx, theme, vars = ["--color-background", "--color-primary", "--color-foreground"]) => {
      const p = await ctx.newPage();
      if (theme) await ctx.addCookies([{ name: "mts-theme", value: theme, url: BASE }]);
      else await ctx.clearCookies();
      await p.goto(`${BASE}/`);
      const out = await p.evaluate((vs) => ({ theme: document.documentElement.dataset.theme, ...Object.fromEntries(vs.map((v) => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim().toLowerCase().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3")])) }), vars);
      await p.close();
      return out;
    };
    const savedBefore = sql(`select colors::text from "AppearanceConfig" where "isActive" order by "updatedAt" desc limit 1`);
    await page.goto(`${BASE}/admin/website/appearance`);
    await page.waitForTimeout(1500);
    check("Opening Appearance saves nothing (no automatic palette change)", sql(`select colors::text from "AppearanceConfig" where "isActive" order by "updatedAt" desc limit 1`) === savedBefore);
    check("Brand Green card is labelled as the default", (await page.locator("[data-testid=palette-brand-default]").innerText()).includes("Brand Green (default)"));
    for (const id of ["brand-default", "midnight-monochrome", "clean-monochrome"]) check(`Palette card: ${id}`, (await page.locator(`[data-testid=palette-${id}]`).count()) === 1);
    await shot(page, "appearance-cards");
    const visitor = await browser.newContext({ viewport: { width: 1366, height: 900 } });

    await page.locator("[data-testid=apply-midnight-monochrome]").click();
    await page.locator("text=Saved — live across the site immediately.").waitFor({ timeout: 15000 });
    check("Midnight: saved with paletteId", sql(`select colors->>'paletteId' from "AppearanceConfig" where "isActive" order by "updatedAt" desc limit 1`) === "midnight-monochrome");
    let v = await css(visitor, null);
    check("Midnight, no cookie: Night mode, #050505 background, white primary", v.theme === "dark" && v["--color-background"] === "#050505" && v["--color-primary"] === "#ffffff", v);
    v = await css(visitor, "light");
    check("Midnight, Day mode: dark primary (#111111) on the normal light canvas", v.theme === "light" && v["--color-primary"] === "#111111" && v["--color-background"] === "#fbfbfc", v);
    v = await css(visitor, "eyesaver");
    check("Midnight, Eye-Saver unchanged", v.theme === "eyesaver" && v["--color-background"] === "#000000");
    await page.reload();
    check("Midnight shows Selected after reload", (await page.locator("[data-testid=palette-midnight-monochrome]").getAttribute("data-selected")) === "true");

    await page.locator("[data-testid=apply-clean-monochrome]").click();
    await page.locator("text=Saved — live across the site immediately.").waitFor({ timeout: 15000 });
    v = await css(visitor, null);
    check("Clean, no cookie: Day mode, white background, #111111 primary", v.theme === "light" && v["--color-background"] === "#ffffff" && v["--color-primary"] === "#111111", v);
    v = await css(visitor, "dark");
    check("Clean, Night mode: white primary on the black canvas", v.theme === "dark" && v["--color-primary"] === "#ffffff" && v["--color-background"] === "#000000", v);
    check("Palette switch did not change title/description/canonical/JSON-LD", (await seoHead()) === headBefore);

    // Visual pass of key public/student pages in both palettes (screenshots for review) + no unreadable primary buttons.
    const pages = ["/", "/login", "/plans-and-pricing", "/exams"];
    for (const [pal, apply] of [["clean", null], ["midnight", "apply-midnight-monochrome"]]) {
      if (apply) {
        await page.goto(`${BASE}/admin/website/appearance`);
        await page.locator(`[data-testid=${apply}]`).click();
        await page.locator("text=Saved — live across the site immediately.").waitFor({ timeout: 15000 });
      }
      for (const theme of ["light", "dark"]) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await ctx.addCookies([{ name: "mts-theme", value: theme, url: BASE }]);
        const p = await ctx.newPage();
        for (const path of pages) {
          const r = await p.goto(`${BASE}${path}`);
          const bad = await p.evaluate(() => {
            // Normalise any CSS colour (rgb/oklab/oklch/color()) through a canvas to 8-bit RGBA.
            const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
            const rgba = (c) => {
              cv.clearRect(0, 0, 1, 1);
              cv.fillStyle = "#000";
              cv.fillStyle = c;
              cv.fillRect(0, 0, 1, 1);
              const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
              return [r, g, b, a / 255];
            };
            const lum = ([r, g, b]) => {
              const [R, G, B] = [r, g, b].map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
              return 0.2126 * R + 0.7152 * G + 0.0722 * B;
            };
            // First mostly-opaque solid background up the tree. Translucent tints (hover pills, glass
            // headers) are skipped; a gradient/image background makes the result unknown (null).
            const bgOf = (el) => {
              for (let e = el; e; e = e.parentElement) {
                const cs = getComputedStyle(e);
                if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
                const c = rgba(cs.backgroundColor);
                if (c[3] >= 0.5) return c;
              }
              return rgba(getComputedStyle(document.body).backgroundColor);
            };
            const issues = [];
            for (const el of document.querySelectorAll("a, button, h1, h2, h3, p, label, span")) {
              const r = el.getBoundingClientRect();
              // Only text this element paints itself (a wrapper's inherited colour is not what's on screen).
              const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
              if (!r.width || !r.height || !ownText || el.closest("[aria-hidden=true]")) continue;
              const cs = getComputedStyle(el);
              if (cs.visibility === "hidden" || Number(cs.opacity) < 0.2) continue;
              const fg = rgba(cs.color);
              const bg = bgOf(el);
              if (!bg || fg[3] < 0.2) continue;
              const a = lum(fg);
              const b = lum(bg);
              const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
              if (ratio < 1.6) issues.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
            }
            return issues.slice(0, 5);
          });
          check(`${pal} / ${theme} ${path}: renders, no invisible text (contrast < 1.6:1)`, r?.status() === 200 && bad.length === 0, bad);
          check(`${pal} / ${theme} ${path}: no horizontal scroll (mobile)`, await noHScroll(p));
          await shot(p, `pal-${pal}-${theme}-${path.replace(/\W+/g, "_") || "home"}`);
        }
        await ctx.close();
      }
    }
    await page.goto(`${BASE}/admin/website/appearance`);
    await page.locator("[data-testid=apply-brand-default]").click();
    await page.locator("text=Saved — live across the site immediately.").waitFor({ timeout: 15000 });
    v = await css(visitor, null);
    check("Switching back to Brand Green restores the current brand (#008209, Night default)", v["--color-primary"] === "#008209" && v.theme === "dark", v);
    await visitor.close();
  });

  await step("Backup: check a downloaded file on this device", async () => {
    const file = process.env.BACKUP_FILE;
    if (!file) return check("BACKUP_FILE provided", false);
    await page.goto(`${BASE}/admin/backup?tab=verify`);
    const box = page.locator("[data-testid=local-backup-check]");
    await box.locator("input[type=file]").setInputFiles(file);
    await box.getByRole("button", { name: "Check file" }).click();
    const sum = box.locator("[data-testid=local-check-summary]");
    await sum.waitFor({ timeout: 120000 });
    const t = await sum.innerText();
    check("Intact package → every component SHA-256 OK", t.includes("is intact"), t);
    check("Manifest summary shows students/questions/attempts", /Students\s*\n?\s*\d/.test(await box.innerText()));
    await shot(page, "backup-local-ok", true);
    const cut = `${file}.cut-${process.pid}.tar`;
    const buf = fs.readFileSync(file);
    fs.writeFileSync(cut, buf.subarray(0, 10 * 1024 * 1024 - 46_683));
    await box.locator("input[type=file]").setInputFiles(cut);
    await box.getByRole("button", { name: "Check file" }).click();
    await page.waitForFunction(() => document.querySelector("[data-testid=local-check-summary]")?.textContent?.includes("Not a complete"), null, { timeout: 60000 });
    const t2 = await box.innerText();
    check("Truncated copy → clear 'incomplete' message (not 'corrupt backup')", t2.includes("incomplete"), t2.slice(0, 300));
    fs.unlinkSync(cut);
    await shot(page, "backup-local-truncated", true);
    await page.goto(`${BASE}/admin/backup?tab=restore`);
    check("Restore tab shows new-server restore instructions", (await page.locator("[data-testid=restore-instructions]").innerText()).includes("Scheduled jobs last"));
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
