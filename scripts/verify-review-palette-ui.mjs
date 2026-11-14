/**
 * Question Review: direct question palette (read-only). Real browser against a LOCAL build on a DISPOSABLE database.
 *
 *   BASE=http://127.0.0.1:3681 ATTEMPT=<submitted attempt id> DATABASE_URL=<scratch> AUTH_SECRET=<scratch> SHOTS=<dir> \
 *     NODE_PATH=<playwright dir> node scripts/verify-review-palette-ui.mjs
 *
 * Proves: Q12 / Q45 / Q87 open with ONE click (desktop); the card shown is that question and its verdict matches the
 * palette colour; the current cell is marked; Previous / Next still work; on a phone the palette is collapsed, opens,
 * jumps and closes, with no sideways scroll; clicking around never POSTs (no save / timer / answer action).
 */
import { createRequire } from "node:module";
import pg from "pg";
import { encode } from "@auth/core/jwt";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:3681";
const ATTEMPT = process.env.ATTEMPT;
const SHOTS = process.env.SHOTS || "";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) || !/\/mts_[a-z0-9_]+/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Local server + scratch database only.");
  process.exit(2);
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=[^&]*/, "") });
await db.connect();
const { rows: [st] } = await db.query(
  `select s.id, s."studentId", s.name, s.email from "TestAttempt" a join "Student" s on s.id = a."studentId" where a.id = $1 and a.status = 'SUBMITTED'`,
  [ATTEMPT]
);
if (!st) throw new Error("ATTEMPT must be a SUBMITTED attempt");
// Per question, in attempt order: the stored verdict (no Answer row = not answered).
const { rows: aq } = await db.query(
  `select a."isCorrect" from "TestAttemptQuestion" q left join "Answer" a on a."attemptQuestionId" = q.id where q."attemptId" = $1 order by q."order" asc`,
  [ATTEMPT]
);
const token = await encode({
  token: { studentDbId: st.id, studentId: st.studentId, authProvider: "CREDENTIALS", sub: st.id, name: st.name, email: st.email },
  secret: process.env.AUTH_SECRET,
  salt: "student-session-token",
});

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const EXPECT = { correct: "Correct", incorrect: "Incorrect", "not answered": "Not Answered", withdrawn: "Withdrawn" };

async function open(browser, device) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: "student-session-token", value: token, url: BASE }]);
  // Scratch DBs can carry an analytics id: never let a test reach a third party.
  await ctx.route((url) => !url.href.startsWith(BASE), (route) => route.abort());
  const page = await ctx.newPage();
  page.errors = [];
  page.posts = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("request", (r) => r.method() === "POST" && page.posts.push(r.url()));
  await page.goto(`${BASE}/student/attempt/${ATTEMPT}/review`);
  await page.waitForSelector("[data-testid=review-palette]", { state: "attached", timeout: 30000 });
  await page.waitForLoadState("networkidle");
  page.posts.length = 0; // page-load requests (AI usage label) are not navigation
  return { ctx, page };
}
const shownNumber = async (page) => Number(/Question (\d+) of/.exec(await page.locator("text=/Question \\d+ of \\d+/").first().innerText())?.[1]);
const cell = (page, n) => page.locator(`[data-testid=review-palette] button`).nth(n - 1);

const browser = await chromium.launch();
try {
  console.log("Desktop");
  const { ctx, page } = await open(browser);
  const total = await page.locator("[data-testid=review-palette] button").count();
  check(`palette lists every question (${total})`, total >= 87, total);
  check("palette visible without opening anything (desktop)", await page.locator("[data-testid=review-palette]").isVisible());
  for (const n of [12, 45, 87]) {
    await cell(page, n).click(); // ONE interaction
    const label = await cell(page, n).getAttribute("aria-label");
    const status = /\(([^)]+)\)$/.exec(label ?? "")?.[1];
    const verdictOk = await page.getByTestId("review-answer-header").innerText().then((t) => t.includes(EXPECT[status] ?? "??"));
    check(`Q${n}: one click opens Question ${n} (${status}); card verdict matches the palette`, (await shownNumber(page)) === n && verdictOk, { shown: await shownNumber(page), status });
    check(`Q${n}: cell marked current`, (await cell(page, n).getAttribute("aria-current")) === "true");
  }
  const labels = await page.locator("[data-testid=review-palette] button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const mismatch = aq
    .map((r, i) => [i + 1, r.isCorrect === true ? "correct" : r.isCorrect === false ? "incorrect" : "not answered", labels[i]])
    .filter(([, want, got]) => !got?.endsWith(`(${want})`) && !got?.endsWith("(withdrawn)"));
  check(`every cell's status = the database verdict (${aq.filter((r) => r.isCorrect === true).length} correct, ${aq.filter((r) => r.isCorrect === false).length} incorrect)`, aq.length === total && mismatch.length === 0, mismatch.slice(0, 5));
  const firstWrong = aq.findIndex((r) => r.isCorrect === false) + 1;
  if (firstWrong > 0) {
    await cell(page, firstWrong).click();
    check(`incorrect question Q${firstWrong}: card says Incorrect`, (await shownNumber(page)) === firstWrong && (await page.getByTestId("review-answer-header").innerText()).includes("Incorrect"));
    await cell(page, 87).click();
  }
  await page.getByRole("button", { name: "Previous question" }).click();
  check("Previous still works (87 → 86)", (await shownNumber(page)) === 86);
  await page.getByRole("button", { name: "Next question" }).click();
  check("Next still works (86 → 87)", (await shownNumber(page)) === 87);
  check("legend shows correct / incorrect / not answered counts", /Correct \(\d+\)[\s\S]*Incorrect \(\d+\)[\s\S]*Not answered \(\d+\)/.test(await page.getByTestId("review-palette-card").innerText()));
  check("Ask AI tools still on the card", (await page.getByTestId("review-question-tools").count()) === 1);
  check("no POST while navigating (read-only)", page.posts.length === 0, page.posts);
  check("no page errors (desktop)", page.errors.length === 0, page.errors);
  await shot(page, "review-palette-desktop");
  await ctx.close();

  console.log("Phone (Pixel 7)");
  const m = await open(browser, "Pixel 7");
  check("phone: palette collapsed by default", !(await m.page.locator("[data-testid=review-palette]").isVisible()));
  await m.page.getByTestId("review-palette-toggle").click();
  check("phone: toggle opens the palette", await m.page.locator("[data-testid=review-palette]").isVisible());
  await shot(m.page, "review-palette-phone-open");
  await cell(m.page, 45).click();
  check("phone: tap Q45 → Question 45, palette closes", (await shownNumber(m.page)) === 45 && !(await m.page.locator("[data-testid=review-palette]").isVisible()));
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("phone: no sideways scroll", overflow <= 1, overflow);
  check("phone: no POST, no page errors", m.page.posts.length === 0 && m.page.errors.length === 0, { posts: m.page.posts, errors: m.page.errors });
  await shot(m.page, "review-palette-phone-q45");
  await m.ctx.close();
} finally {
  await browser.close();
  await db.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL REVIEW PALETTE CHECKS PASSED");
process.exit(failures ? 1 : 0);
