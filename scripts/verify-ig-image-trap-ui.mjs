/**
 * Instagram Studio — browser checks for the Medical Image slide and the Examiner Trap
 * continuation, on a SCRATCH server (never production). Needs a server started with
 * GEMINI_TEST_BASE_URL / WIKIMEDIA_TEST_BASE_URL pointing at a loopback mock, an
 * `api.gemini` setting listing an image model, and /media served from STORAGE_DIR.
 *
 *   BASE=http://localhost:<proxy> MOCK=http://127.0.0.1:<mock> SHOTS=<dir> NODE_PATH=<playwright dir> node scripts/verify-ig-image-trap-ui.mjs
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3162";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:3193";
const SHOTS = process.env.SHOTS ?? "/tmp/ig-image-shots";
const PASSWORD = "IgStudio#Fixture2026";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();
const CODE = "IGFIX-RUHS21-W01";

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const fingerprint = () =>
  sql(`SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (SELECT q.id || q.text || q."updatedAt" AS x FROM "Question" q WHERE q.code = '${CODE}'
       UNION ALL SELECT o.id || o.text || o."isCorrect" || o.label FROM "QuestionOption" o JOIN "Question" q ON q.id = o."questionId" WHERE q.code = '${CODE}') t`);
const mockCount = async () => Number(await (await fetch(`${MOCK}/__count`)).text());
const postSql = (expr) => sql(`SELECT ${expr} FROM "InstagramPost" WHERE "questionCode" = '${CODE}' AND "supersededAt" IS NULL`);

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const editor = (page) => page.getByTestId("carousel-editor");
async function waitPreview(page, expectCounter) {
  if (expectCounter) await page.getByTestId("slide-counter").filter({ hasText: expectCounter }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await page.waitForFunction(() => {
    const frame = document.querySelector('[data-testid="preview-frame"]');
    const img = document.querySelector('[data-testid="slide-preview"]');
    return frame && frame.getAttribute("data-busy") === "false" && img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 30000 });
}
async function message(page, re) {
  const m = page.getByTestId("editor-message").filter({ hasText: re });
  await m.waitFor({ timeout: 60000 });
  return (await m.innerText()).trim();
}
async function openEditor(page, exam, paper) {
  await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${paper}`);
  await page.locator(`[data-row="${CODE}"] [data-testid="open-question"]`).click();
  await editor(page).waitFor();
}

const browser = await chromium.launch();
try {
  const fpBefore = fingerprint();
  const [exam, paper] = sql(`SELECT q."examId" || ',' || q."previousYearPaperId" FROM "Question" q WHERE q.code = '${CODE}'`).split(",");
  sql(`DELETE FROM "InstagramPost" WHERE "questionCode" = '${CODE}'`);
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await login(page, "igmaster");

  console.log("\n--- Medical Image ---");
  await openEditor(page, exam, paper);
  await page.getByTestId("create-draft").click();
  await waitPreview(page, "1 / 5");
  await page.getByTestId("field-trick").fill("Absence = Ethosuximide: empty stare, empty thoughts.");
  await page.getByTestId("save-draft").click();
  await message(page, /Saved/);
  await page.getByTestId("tab-studio").click();
  await page.getByTestId("image-provider").filter({ hasText: "gemini-3.1-flash-image" }).waitFor({ timeout: 15000 });
  check("provider status shown before clicking (no AI call on load)", (await mockCount()) === 0, await mockCount());
  check("Generate Medical Image button offered", (await page.getByTestId("ai-image").innerText()).includes("Generate Medical Image"));

  await page.getByTestId("ai-image").click();
  await message(page, /Medical image generated/);
  await page.getByTestId("image-candidate").waitFor();
  const candOk = await page.getByTestId("image-candidate-img").evaluate((img) => img.complete && img.naturalWidth > 0);
  check("Generate → preview image shown (served from media storage)", candOk);
  check("exactly one image request", (await mockCount()) === 1, await mockCount());
  check("carousel unchanged until Add (still 5 slides)", (await page.getByTestId("slide-counter").innerText()).endsWith("/ 5"));
  check("candidate cached on the saved post", postSql(`content->'imageCandidate'->>'key'`).startsWith("q/") && !postSql(`design::text`).includes("MEDICAL_IMAGE"));
  await page.screenshot({ path: `${SHOTS}/01-image-candidate.png` });

  await page.getByTestId("image-skip").click();
  check("Skip Image hides the preview", (await page.getByTestId("image-candidate").count()) === 0);
  await page.getByTestId("save-draft").click();
  await message(page, /Saved/);
  check("Skip saved: no candidate, no image slide", postSql(`content->'imageCandidate'`) === "null" && !postSql(`design::text`).includes("MEDICAL_IMAGE"));

  await page.getByTestId("ai-image").click();
  await message(page, /Medical image generated/);
  await page.getByTestId("image-add").click();
  await waitPreview(page, "/ 6");
  check("Add to Carousel → 6 slides, Medical Image before Follow", (await page.getByRole("tab", { name: /5\. Medical Image/ }).count()) === 1 && (await page.getByRole("tab", { name: /6\. Follow/ }).count()) === 1);
  await page.getByTestId("image-title").fill("Absence seizure drug of choice");
  await page.getByTestId("save-draft").click();
  await message(page, /Saved/);
  check("saved: image + MEDICAL_IMAGE slide", postSql(`content->'medicalImage'->>'title'`) === "Absence seizure drug of choice" && postSql(`design::text`).includes("MEDICAL_IMAGE"));
  await page.getByRole("tab", { name: /5\. Medical Image/ }).click();
  await waitPreview(page, "5 / 6");
  const dims = await page.getByTestId("slide-preview").evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  check("image slide preview 1080 × 1350", dims[0] === 1080 && dims[1] === 1350, dims);
  await page.screenshot({ path: `${SHOTS}/02-image-slide.png` });
  const postId = postSql("id");
  const jpeg = await page.evaluate(async ([base, id]) => {
    const r = await fetch(`${base}/api/admin/instagram/slide?postId=${id}&i=4&download=1`);
    return [r.status, r.headers.get("content-type"), (await r.arrayBuffer()).byteLength];
  }, [BASE, postId]);
  check("JPEG export of the image slide", jpeg[0] === 200 && jpeg[1] === "image/jpeg" && jpeg[2] > 20000, jpeg);

  const before = await mockCount();
  await page.reload();
  await openEditor(page, exam, paper);
  await waitPreview(page, "/ 6");
  await page.getByTestId("tab-studio").click();
  await page.getByTestId("image-current").waitFor();
  check("reload: image kept, NOT regenerated", (await mockCount()) === before, [before, await mockCount()]);

  await page.getByTestId("reference-search").locator("summary").click();
  await page.getByTestId("reference-query").fill("shoulder joint");
  await page.getByTestId("reference-go").click();
  await page.getByTestId("reference-results").waitFor({ timeout: 30000 });
  check("Find Reference Image → licensed result with licence + author", /CC BY 4\.0 · OpenStax/.test(await page.getByTestId("reference-results").innerText()));
  await page.getByTestId("reference-use").first().click();
  await message(page, /Reference image ready/);
  check("reference candidate shows credit", /OpenStax · CC BY 4\.0 · Wikimedia Commons/.test(await page.getByTestId("image-candidate").innerText()));
  await page.getByTestId("image-skip").click();

  await page.getByTestId("image-remove").click();
  await waitPreview(page, "/ 5");
  await page.getByTestId("save-draft").click();
  await message(page, /Saved/);
  check("Remove Image → back to the original 5 slides, image cleared", postSql(`content->'medicalImage'`) === "null" && !postSql(`design::text`).includes("MEDICAL_IMAGE"));

  console.log("\n--- Examiner Trap continuation ---");
  const words = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
  const trap = {
    question: `${words(100, "stem")} which drug?`,
    options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: `Option ${l} ${words(20, "opt")}` })),
    correct: "B",
    tempting: "A",
    trapExplanation: words(90, "why"),
    avoidTip: words(60, "avoid"),
    status: "draft",
    checks: [],
  };
  const lit = JSON.stringify(trap).replace(/'/g, "''");
  sql(`UPDATE "InstagramPost" SET content = jsonb_set(content, '{trap}', '${lit}'::jsonb) WHERE id = '${postId}'`);
  await page.reload();
  await openEditor(page, exam, paper);
  await waitPreview(page);
  await page.getByTestId("tab-design").click();
  await page.getByTestId("slides-7").click();
  await page.waitForTimeout(300);
  const tabs = await page.getByRole("tablist", { name: "Slides" }).innerText();
  check("long trap shows as continued slides (1/N, 2/N) in the slide list", /How the Examiner Traps You \(1\/\d\)/.test(tabs) && /How the Examiner Traps You \(2\/\d\)/.test(tabs), tabs);
  await page.getByTestId("save-draft").click();
  await message(page, /Saved/);
  await page.getByRole("tab", { name: /How the Examiner Traps You \(2\// }).click();
  await waitPreview(page);
  await page.screenshot({ path: `${SHOTS}/03-trap-continued.png` });
  await page.getByTestId("tab-checks").click();
  const review = await page.getByTestId("review-panel").innerText();
  check("Review: no 'too much text' blocker for the trap", !/too much text/i.test(review), review.slice(0, 400));
  check("Review: continuation explained as a warning", /continues automatically/.test(review));

  check("source question unchanged", fingerprint() === fpBefore);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
