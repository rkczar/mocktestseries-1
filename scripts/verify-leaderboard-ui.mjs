/**
 * Ranking Phase 1 browser checks against a local production build on a
 * DISPOSABLE database (fixture: scripts/leaderboard-ui-fixture.ts).
 *
 *   BASE=http://localhost:3111 FIXTURE=/tmp/lb.json DATABASE_URL=<scratch> SHOTS=<dir> \
 *     NODE_PATH=<dir containing playwright> node scripts/verify-leaderboard-ui.mjs
 *
 * Result-page summary (#rank / N, percentile, Top %), not-ranked states (retake,
 * OMR, practice first, disabled), the leaderboard page (podium, table, YOU row,
 * Your Position window, paging), PYQ board, the server payload carrying no
 * other student's id / email / phone / MTS id / surname, IDOR, mobile 360 px
 * (no sideways scroll) and dark mode, and the admin Ranking settings forms.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// NODE_PATH lookup (ESM imports ignore it), like the other browser suites.
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE ?? "http://localhost:3111";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? "/tmp/lb-shots";
mkdirSync(SHOTS, { recursive: true });
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const sql = (q) => execFileSync("psql", [process.env.DATABASE_URL.replace(/\?schema=public$/, ""), "-Atc", q], { encoding: "utf8" }).trim();

const deviceCookies = new Map();
async function studentLogin(page, email) {
  const known = deviceCookies.get(email);
  if (known) await page.context().addCookies([known]);
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  const device = (await page.context().cookies()).find((c) => c.name === "mts-device");
  if (device) deviceCookies.set(email, device);
}
/** The server-rendered RSC payload + HTML, fetched from inside the page (see ops/TEST-ENGINE.md). */
async function serverPayload(page) {
  return page.evaluate(async () => {
    const html = await (await fetch(location.href)).text();
    const rsc = await (await fetch(location.href, { headers: { RSC: "1" } })).text();
    return html + "\n" + rsc;
  });
}
const resultUrl = (id) => `${BASE}/student/attempt/${id}/result`;
const boardUrl = (id, page) => `${BASE}/student/attempt/${id}/leaderboard${page ? `?page=${page}` : ""}`;
const E = F.expected;
const fmt = (v) => v.toFixed(1);

const browser = await chromium.launch();
try {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 900, isMobile: false, colorScheme: "light" },
    { name: "mobile", width: 360, height: 780, isMobile: true, colorScheme: "dark" },
  ]) {
    console.log(`\n=== ${viewport.name} (${viewport.width}px, ${viewport.colorScheme}) ===`);
    const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.isMobile, colorScheme: viewport.colorScheme });
    const page = await ctx.newPage();
    await studentLogin(page, F.viewer.email);

    console.log("Result page — ranked attempt");
    await page.goto(resultUrl(F.attempts.official));
    const summary = page.getByTestId("rank-summary");
    await summary.waitFor();
    check("Your Rank #128 / 133", (await page.getByTestId("rank-value").innerText()).replace(/\s+/g, " ") === `#${E.rank} / ${E.total}`, await page.getByTestId("rank-value").innerText());
    check(`Percentile ${fmt(E.percentile)}`, (await page.getByTestId("percentile-value").innerText()) === fmt(E.percentile));
    check(`Top ${fmt(E.topPercent)}%`, (await page.getByTestId("top-value").innerText()) === `${fmt(E.topPercent)}%`);
    check("ranked attempt shows no not-ranked badge", (await summary.getAttribute("data-rank-status")) === "OFFICIAL");
    check("score card and Review link still render", (await page.getByText("Test submitted successfully").count()) === 1 && (await page.getByRole("link", { name: "Review Answers" }).count()) === 1);
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-result.png`, fullPage: true });

    console.log("Leaderboard page");
    await page.getByRole("link", { name: /View Leaderboard/ }).click();
    await page.waitForURL(/\/leaderboard/);
    check("podium shows ranks 1–3", (await page.getByTestId("podium").locator("> *").count()) === 3);
    const tableRanks = await page.getByTestId("leaderboard-table").locator("tbody tr td:first-child").allInnerTexts();
    check("page-1 table continues from #4 to #50", tableRanks[0] === "#4" && tableRanks.at(-1) === "#50", [tableRanks[0], tableRanks.at(-1)]);
    const pos = page.getByTestId("your-position");
    check("Your Position card is shown (viewer not on page 1)", (await pos.count()) === 1);
    const posRanks = await page.getByTestId("your-position-table").locator("tbody tr td:first-child").allInnerTexts();
    check("Your Position = #126 … #130", JSON.stringify(posRanks) === JSON.stringify(["#126", "#127", "#128", "#129", "#130"]), posRanks);
    const selfRow = page.getByTestId("your-position-table").locator("tr[data-self=true]");
    check("exactly one highlighted row, at #128, with YOU badge", (await selfRow.count()) === 1 && (await selfRow.locator("td").first().innerText()) === "#128" && (await selfRow.getByText("YOU", { exact: true }).count()) === 1);
    check("YOU row shows privacy-safe name 'Rahul K.'", (await selfRow.innerText()).includes("Rahul K.") && !(await selfRow.innerText()).includes("Kumar"));
    const bg = await selfRow.evaluate((el) => getComputedStyle(el).backgroundColor);
    const otherBg = await page.getByTestId("your-position-table").locator("tbody tr").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    check("YOU row is visually highlighted (background differs)", bg !== otherBg, { bg, otherBg });
    check("Your Position appears before the full table (no scrolling to find yourself)", (await pos.boundingBox()).y < (await page.getByTestId("podium").boundingBox()).y);
    check("other rows show First Name + Last Initial only", (await page.getByTestId("leaderboard-table").innerText()).includes("Aspirant") && !(await page.getByTestId("leaderboard-table").innerText()).includes("Surnamezq"));
    const payload = await serverPayload(page);
    const leaked = F.privateValues.filter((v) => payload.includes(v));
    check("server payload (HTML + RSC) has no other student's id / MTS id / email / phone / surname", leaked.length === 0, leaked.slice(0, 5));
    check("server payload does not contain the viewer's internal student id", !payload.includes(F.viewer.id));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`no horizontal page scroll at ${viewport.width}px`, overflow <= 0, overflow);
    if (viewport.isMobile) {
      check("mobile: Accuracy/Time columns collapse under the name", !(await page.getByTestId("leaderboard-table").locator("th", { hasText: "Accuracy" }).isVisible()));
    } else {
      check("desktop: Rank · Student · Score · Accuracy · Time · Percentile columns", JSON.stringify(await page.getByTestId("leaderboard-table").locator("th").allInnerTexts()).toUpperCase() === JSON.stringify(["RANK", "STUDENT", "SCORE", "ACCURACY", "TIME", "PERCENTILE"]));
    }
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-leaderboard.png`, fullPage: true });

    await page.getByRole("link", { name: "Show my page" }).click();
    await page.waitForURL(/page=3/);
    check("'Show my page' jumps to page 3 with the YOU row in the table", (await page.getByTestId("leaderboard-table").locator("tr[data-self=true]").count()) === 1 && (await page.getByTestId("your-position").count()) === 0);
    check("deleted student listed as Former Student on the last page", (await page.getByTestId("leaderboard-table").innerText()).includes("Former Student") && !(await page.getByTestId("leaderboard-table").innerText()).includes("Deleted Student"));

    console.log("Not-ranked states");
    await page.goto(resultUrl(F.attempts.retake));
    check("retake: 'Retake — not ranked' + official rank #128", (await page.getByTestId("rank-summary").innerText()).includes("Retake — not ranked") && (await page.getByTestId("rank-value").innerText()).startsWith("#128"));
    await page.goto(resultUrl(F.attempts.omr));
    check("OMR entry: neutral 'OMR entry — not ranked', no rank", (await page.getByTestId("rank-summary").innerText()).includes("OMR entry — not ranked") && (await page.getByTestId("rank-value").count()) === 0);
    await page.goto(resultUrl(F.attempts.afterPractice));
    check("practice first: 'Practice used before competitive attempt', no rank", (await page.getByTestId("rank-summary").innerText()).includes("Practice used before competitive attempt") && (await page.getByTestId("rank-value").count()) === 0);
    await page.goto(boardUrl(F.attempts.afterPractice));
    check("…its leaderboard lists the other student only, no YOU row", (await page.locator("[data-self=true]").count()) === 0 && (await page.getByText("1 ranked participant").count()) === 1);
    await page.goto(resultUrl(F.attempts.disabled));
    check("leaderboard disabled: neutral note, no rank", (await page.getByTestId("rank-summary-disabled").count()) === 1 && (await page.getByTestId("rank-summary").count()) === 0);
    await page.goto(boardUrl(F.attempts.disabled));
    check("disabled leaderboard URL redirects to the result", page.url().endsWith(`/student/attempt/${F.attempts.disabled}/result`), page.url());

    console.log("PYQ leaderboard");
    await page.goto(resultUrl(F.attempts.pyq));
    check(`PYQ: #1 / 3, percentile ${fmt(E.pyq.percentile)}, Top ${fmt(E.pyq.topPercent)}%`,
      (await page.getByTestId("rank-value").innerText()).replace(/\s+/g, " ") === "#1 / 3" && (await page.getByTestId("percentile-value").innerText()) === fmt(E.pyq.percentile) && (await page.getByTestId("top-value").innerText()) === `${fmt(E.pyq.topPercent)}%`);
    await page.goto(boardUrl(F.attempts.pyq));
    const podiumSelf = page.getByTestId("podium").locator("[data-self=true]");
    check("PYQ podium highlights YOU at rank #1", (await podiumSelf.count()) === 1 && /rank #1/i.test(await podiumSelf.innerText()) && (await podiumSelf.getByText("YOU", { exact: true }).count()) === 1);
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-pyq-leaderboard.png`, fullPage: true });
    await ctx.close();
  }

  console.log("\n=== IDOR ===");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await studentLogin(page, F.other.email);
    const res = await page.goto(boardUrl(F.attempts.official));
    check("another student cannot open the viewer's leaderboard URL (404)", res.status() === 404, res.status());
    await page.goto(resultUrl(F.attempts.otherM1));
    check("their own board works and shows their rank (#132)", (await page.getByTestId("rank-value").innerText()).startsWith("#132"));
    await ctx.close();
  }

  console.log("\n=== Admin Ranking settings ===");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`);
    await page.fill("input[name=username]", F.adminUsername);
    await page.fill("input[name=password]", F.password);
    await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);

    await page.goto(`${BASE}/admin/tests/mock/${F.mocks.m1}#ranking`);
    const card = page.locator("#ranking");
    check("Mock editor has a Ranking & Leaderboard card", (await card.count()) === 1);
    check("Counts Toward Overall Ranking defaults OFF", !(await card.locator("input[name=countsTowardOverall]").isChecked()));
    check("Access & Result no longer carries a leaderboard checkbox", (await page.locator("#access input[name=leaderboardEnabled]").count()) === 0);
    await card.locator("input[name=leaderboardEnabled]").uncheck();
    await card.locator("input[name=countsTowardOverall]").check();
    await card.getByRole("button", { name: "Save Ranking Settings" }).click();
    await card.getByText("Saved.").waitFor();
    check("save → TestRankingConfig off + counts, legacy column mirrored",
      sql(`select "leaderboardEnabled"||','||"countsTowardOverall" from "TestRankingConfig" where "mockTestId"='${F.mocks.m1}'`) === "false,true" &&
      sql(`select "leaderboardEnabled" from "MockTest" where id='${F.mocks.m1}'`) === "f");
    check("audit log written", Number(sql(`select count(*) from "AuditLog" where action='TEST_RANKING_UPDATED' and "entityId"='${F.mocks.m1}'`)) >= 1);
    await page.screenshot({ path: `${SHOTS}/admin-mock-ranking.png`, fullPage: false });

    // Saving Access & Result must not touch the leaderboard state any more.
    await page.locator("#access").getByRole("button", { name: "Save Access & Result" }).click();
    await page.locator("#access").getByText("Saved.").waitFor();
    check("saving Access & Result leaves the leaderboard setting alone", sql(`select "leaderboardEnabled" from "TestRankingConfig" where "mockTestId"='${F.mocks.m1}'`) === "f");

    const sctx = await browser.newContext();
    const sp = await sctx.newPage();
    await studentLogin(sp, F.viewer.email);
    await sp.goto(resultUrl(F.attempts.official));
    check("student: disabled board now shows the neutral note", (await sp.getByTestId("rank-summary-disabled").count()) === 1);

    await page.reload();
    await card.locator("input[name=leaderboardEnabled]").check();
    await card.locator("input[name=countsTowardOverall]").uncheck();
    await card.getByRole("button", { name: "Save Ranking Settings" }).click();
    await card.getByText("Saved.").waitFor();
    await sp.goto(resultUrl(F.attempts.official));
    check("re-enabled → student sees rank again", (await sp.getByTestId("rank-value").count()) === 1);
    await sctx.close();

    await page.goto(`${BASE}/admin/exams/previous-year-papers/${F.paperId}`);
    const pcard = page.locator("form:has(input[name=leaderboardEnabled])");
    check("PYQ page: Leaderboard Enabled control, no Counts Toward Overall control", (await pcard.count()) === 1 && (await page.locator("input[name=countsTowardOverall]").count()) === 0);
    check("PYQ page explains Overall Rank is not applicable", (await page.getByText("not applicable").count()) === 1);
    await pcard.locator("input[name=leaderboardEnabled]").uncheck();
    await pcard.getByRole("button", { name: "Save Ranking Settings" }).click();
    await pcard.getByText("Saved.").waitFor();
    check("PYQ save → config off, countsTowardOverall false", sql(`select "leaderboardEnabled"||','||"countsTowardOverall" from "TestRankingConfig" where "previousYearPaperId"='${F.paperId}'`) === "false,false");
    await page.screenshot({ path: `${SHOTS}/admin-pyq-ranking.png`, fullPage: false });
    await page.reload();
    await pcard.locator("input[name=leaderboardEnabled]").check();
    await pcard.getByRole("button", { name: "Save Ranking Settings" }).click();
    await pcard.getByText("Saved.").waitFor();
    check("PYQ re-enabled", sql(`select "leaderboardEnabled" from "TestRankingConfig" where "previousYearPaperId"='${F.paperId}'`) === "t");
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
