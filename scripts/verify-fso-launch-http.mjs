/**
 * HTTP + browser checks for the multi-exam / Rajasthan FSO launch against a SCRATCH server
 * (next start -H 127.0.0.1) on an mts_fsol* database seeded with synthetic data.
 *
 *   BASE=http://localhost:3611 FLOWS=<flows.json> STATE="<cmd to run scripts/fso-launch-http-state.ts>" \
 *   NODE_PATH=<dir with playwright> node scripts/verify-fso-launch-http.mjs
 *
 * STATE is a shell prefix that runs the state helper with the scratch env, e.g.
 *   "bash -c 'export SCRATCH_DB=mts_fsol_flows; . /root/mts-scratch/fsol/env.sh; npx tsx scripts/fso-launch-http-state.ts \"$@\"' --"
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://localhost:3611";
const F = JSON.parse(readFileSync(process.env.FLOWS, "utf8"));
const STATE = process.env.STATE;
const SLUG = "rajasthan-food-safety-officer";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
};
const state = (...args) => {
  const out = execFileSync("bash", ["-c", `${STATE} ${args.map((a) => `'${a}'`).join(" ")}`], { encoding: "utf8" }).trim().split("\n").pop();
  return JSON.parse(out || "{}");
};
const get = async (path, init) => {
  const r = await fetch(`${BASE}${path}`, { redirect: "manual", ...init });
  return { status: r.status, headers: r.headers, text: await r.text().catch(() => "") };
};

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
}
// In-page fetch keeps the Secure device cookie (Playwright's request API drops it over http).
const inPage = (page, url) =>
  page.evaluate(async (u) => {
    const r = await fetch(u, { redirect: "manual" });
    const buf = new Uint8Array(await r.arrayBuffer());
    let head = "";
    for (let i = 0; i < Math.min(buf.length, 8); i++) head += String.fromCharCode(buf[i]);
    let b64 = "";
    for (let i = 0; i < buf.length; i += 0x8000) b64 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { status: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), cache: r.headers.get("cache-control"), head, b64: btoa(b64), len: buf.length };
  }, url);

async function main() {
  state("reset");
  state("taxonomy");

  // ------------------------------------------------ draft: nothing public
  for (const p of ["", "/eligibility", "/recruitment", "/important-topics", "/syllabus", "/previous-year-papers/2022"]) {
    check(`D1 draft FSO /exams/${SLUG}${p} → 404`, (await get(`/exams/${SLUG}${p}`)).status === 404);
  }
  const sm0 = await get("/sitemap.xml");
  check("D2 sitemap has no FSO URL while draft", sm0.status === 200 && !sm0.text.includes(SLUG));
  for (const p of ["/eligibility", "/recruitment", "/important-topics"]) check(`D3 RUHS-like exam has no ${p} page`, (await get(`/exams/${F.examSlug}${p}`)).status === 404);
  check("D4 RUHS-like hub still 200", (await get(`/exams/${F.examSlug}`)).status === 200);

  // ------------------------------------------------ OMR isolation (draft)
  const omr = state("omr-on");
  check("M1 FSO OMR (FSO draft, switch OFF) → 404 even without login", (await get(`/api/student/test-resources/${omr.fsoOmrId}`)).status === 404);
  const ruhsOmr = await get(`/api/student/test-resources/${omr.ruhsOmrId}`);
  check("M2 RUHS OMR still public (no login) → 200 PDF", ruhsOmr.status === 200 && (ruhsOmr.headers.get("content-type") ?? "").includes("pdf"));

  // ------------------------------------------------ published on scratch: pages render
  state("publish");
  const hub = await get(`/exams/${SLUG}`);
  check("W1 FSO hub 200 once published (scratch)", hub.status === 200);
  check("W2 hub: RPSC sources heading, no 'RUHS' wording in the sources block", hub.text.includes("Official RPSC notices and sources") && !hub.text.includes("Official RUHS notices"));
  const elig = await get(`/exams/${SLUG}/eligibility`);
  check("W3 eligibility page with the RPSC qualification text", elig.status === 200 && elig.text.includes("Food Technology") && elig.text.includes("11/2022-23"));
  const rec = await get(`/exams/${SLUG}/recruitment`);
  check("W4 recruitment page: 200 posts (2022), 98 posts (2019), no invented dates", rec.status === 200 && rec.text.includes("200 posts") && rec.text.includes("98 posts") && !/2026 exam date|vacancies 2026/i.test(rec.text));
  check("W5 important topics page renders", (await get(`/exams/${SLUG}/important-topics`)).status === 200);
  const year = await get(`/exams/${SLUG}/previous-year-papers/2022`);
  check("W6 2022 page: official key + deleted questions, no download button while switch OFF", year.status === 200 && year.text.includes("Q16, Q43, Q50, Q72, Q106, Q130") && !year.text.includes("/student/papers/download"));
  check("W7 2022 page shows no question text (no public preview)", !year.text.includes("Synthetic 2022 question"));
  const mts = await get(`/exams/${SLUG}/mock-test-series`);
  check("W8 FSO mock landing is noindex (no live mock)", mts.status === 200 && /<meta name="robots" content="noindex/.test(mts.text));
  const ruhsMts = await get(`/exams/${F.examSlug}/mock-test-series`);
  check("W9 RUHS-like mock landing stays indexable", ruhsMts.status === 200 && /<meta name="robots" content="index/.test(ruhsMts.text));
  // sitemap.xml is ISR-cached (revalidate 3600): checked separately on a fresh cache (see report), not here.
  check("W11 pattern page shows 1/3 marking", (await get(`/exams/${SLUG}/exam-pattern`)).text.includes("1/3 per wrong answer"));

  // ------------------------------------------------ paper PDF downloads
  const pdf = state("pdf-on");
  const d = pdf.downloads.find((x) => x.year === 2019 && x.lang === "ENGLISH") ?? pdf.downloads[0];
  const api = `/api/student/paper-download?paperId=${d.paperId}&lang=${d.lang}`;
  const anon = await get(api);
  check("P1 logged out → 401, no-store", anon.status === 401 && (anon.headers.get("cache-control") ?? "").includes("no-store"));
  check("P2 exam-level paper PDF via the generic resource route → 404 (no bypass)", (await get(`/api/student/test-resources/${d.resourceId}`)).status === 404);
  const storage = await get(`/storage/test-resources/${"x".repeat(8)}.pdf`);
  check("P3 raw storage path not served publicly", storage.status === 404 || storage.status === 307 || storage.status === 401);
  const year19 = await get(`/exams/${SLUG}/previous-year-papers/2019`);
  check("P4 year page offers download links once switch ON", year19.text.includes("/student/papers/download?paperId="));

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, F.students.free.email);
    const locked = await inPage(page, api);
    check("P5 logged in, not bought → 402", locked.status === 402, JSON.stringify(locked));
    await page.goto(`${BASE}/student/papers/download?paperId=${d.paperId}&lang=${d.lang}`);
    // The scratch FSO product is hidden (as in production until launch): no Download, and either Buy or "not open".
    check(
      "P6 landing page: no Download before purchase (Buy, or 'not open' while the product is hidden)",
      (await page.getByText("Download PDF").count()) === 0 && ((await page.getByText("Buy access").count()) > 0 || (await page.getByText("Purchases are not open right now.").count()) > 0)
    );
    state("grant", F.students.free.id);
    const ok = await inPage(page, api);
    check("P7 bought → 200 PDF attachment, no-store", ok.status === 200 && ok.type === "application/pdf" && (ok.disp ?? "").startsWith("attachment") && (ok.cache ?? "").includes("no-store") && ok.head.startsWith("%PDF"), JSON.stringify({ ...ok, b64: undefined }));
    writeFileSync("/root/mts-scratch/fsol/out/download.pdf", Buffer.from(ok.b64 ?? "", "base64"));
    const text = execFileSync("pdftotext", ["/root/mts-scratch/fsol/out/download.pdf", "-"], { encoding: "utf8" });
    check("P8 PDF carries the per-student licence stamp on its pages", /Licensed to \S+ - .* personal use only/.test(text));
    const bogus = await inPage(page, `/api/student/paper-download?paperId=${d.paperId}&lang=TAMIL`);
    check("P9 unknown language → 404", bogus.status === 404);

    // switch OFF again: even a buyer gets 404
    state("reset");
    state("publish");
    check("P10 switch OFF → 404 even for a buyer", (await inPage(page, api)).status === 404);

    // ------------------------------------------------ OMR switch ON (exam active)
    state("omr-on");
    state("omr-switch-on");
    const fsoOmr = await get(`/api/student/test-resources/${omr.fsoOmrId}`);
    check("M3 FSO OMR public once FSO active + switch ON → 200", fsoOmr.status === 200);
    await page.goto(`${BASE}/student/dashboard`);
    const dash = await page.content();
    check("M4 RUHS student's dashboard still links the RUHS OMR (not FSO)", dash.includes(omr.ruhsOmrId) && !dash.includes(omr.fsoOmrId));

    // ------------------------------------------------ hybrid enrollment
    const nu = state("new-student", "qa-fsol-new@example.test");
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await login(p2, "qa-fsol-new@example.test");
    await p2.goto(`${BASE}/student/dashboard`);
    await p2.waitForLoadState("load");
    check("H1 2 active exams + no enrollment → /student/welcome (no auto RUHS)", new URL(p2.url()).pathname === "/student/welcome", p2.url());
    await p2.goto(`${BASE}/student/welcome?exam=${SLUG}`);
    check("H2 exam-page hint preselects FSO", (await p2.getByRole("heading", { name: /Rajasthan FSO/ }).count()) > 0);
    await p2.getByRole("button", { name: "Start" }).click();
    await p2.waitForURL(/\/student\/dashboard/, { timeout: 30000 });
    const dash2 = await p2.content();
    check("H3 after choosing: dashboard on FSO, no RUHS enrollment created", dash2.includes("RAJASTHAN FOOD SAFETY OFFICER") && !dash2.includes("Switch exam"));
    check("H4 no RUHS trial popup on the FSO dashboard", (await p2.getByText(/free trial/i).count()) === 0);
    await ctx2.close();
    void nu;
  } finally {
    await browser.close();
    state("reset");
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try {
    state("reset");
  } catch {}
  process.exit(1);
});
