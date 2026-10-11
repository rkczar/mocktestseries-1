/**
 * Instagram Studio — Examiner Trap continuation + optional Medical Image slide.
 *
 *  - A long Examiner Trap never blocks: it continues on extra slides, nothing is cut.
 *  - Medical Image: Gemini image generation (LOCAL mock), Wikimedia Commons reference
 *    images (LOCAL mock, free licences only), preview candidate → Add / Skip / Remove,
 *    rendering, export, publish preflight, and no change to the source question.
 * Never talks to Google, Wikimedia or Meta.
 *
 *   set -a; . <secret-free scratch env>; set +a   # *igstudio* scratch DB + scripts/ig-studio-fixture.ts setup
 *   export STORAGE_DIR=<scratch dir>
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ig-image-trap.ts [render-out-dir]
 */
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
if (!process.env.STORAGE_DIR || process.env.STORAGE_DIR.startsWith("/var/www")) {
  console.error("Refusing to run: export STORAGE_DIR=<scratch dir> (never production storage).");
  process.exit(2);
}
const G_PORT = 3191;
const W_PORT = 3192;
process.env.GEMINI_TEST_BASE_URL = `http://127.0.0.1:${G_PORT}`;
process.env.WIKIMEDIA_TEST_BASE_URL = `http://127.0.0.1:${W_PORT}`;
delete process.env.GEMINI_API_KEY;
const OUT = process.argv[2] ?? "";

let passes = 0;
let fails = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passes++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fails++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message.split("\n").slice(0, 4).join("\n        ") : e}`);
  }
}
async function thrown(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected an error");
}

// ---- Local mocks --------------------------------------------------------------------------
const geminiRequests: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let geminiMode: "image" | "noimage" | "error" = "image";
let pngBytes: Buffer;

function startGemini() {
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      geminiRequests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") });
      res.setHeader("content-type", "application/json");
      if (geminiMode === "error") {
        res.statusCode = 429;
        return res.end(JSON.stringify({ error: { message: "Resource exhausted (quota) for key AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE" } }));
      }
      if (geminiMode === "noimage") return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "sorry" }] }, finishReason: "IMAGE_SAFETY" }] }));
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: pngBytes.toString("base64") } }] }, finishReason: "STOP" }] }));
    });
  });
  return new Promise<http.Server>((r) => srv.listen(G_PORT, "127.0.0.1", () => r(srv)));
}

const commonsRequests: string[] = [];
function commonsPage(title: string, license: string, mime = "image/png") {
  const name = title.replace(/^File:/, "").replace(/ /g, "_");
  return {
    title,
    imageinfo: [
      {
        thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}/1200px-${name}`,
        url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}`,
        descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
        mime,
        width: 1600,
        height: 1200,
        extmetadata: { LicenseShortName: { value: license }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" }, Artist: { value: '<a href="//x">Dr <b>Grey</b></a>' } },
      },
    ],
  };
}
const PAGES = [
  commonsPage("File:Brachial plexus.png", "CC BY-SA 4.0"),
  commonsPage("File:Plexus nc.png", "CC BY-NC-SA 3.0"),
  commonsPage("File:Plexus fair.png", "Fair use"),
  commonsPage("File:Plexus pd.jpg", "Public domain", "image/jpeg"),
  commonsPage("File:Plexus vector.svg", "CC0", "image/svg+xml"),
];
function startCommons() {
  const srv = http.createServer((req, res) => {
    commonsRequests.push(req.url ?? "");
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/w/api.php") {
      res.setHeader("content-type", "application/json");
      const titles = u.searchParams.get("titles");
      const pages = titles ? PAGES.filter((p) => p.title === titles) : PAGES;
      return res.end(JSON.stringify({ query: { pages } }));
    }
    if (u.pathname.startsWith("/wikipedia/commons/")) {
      res.setHeader("content-type", "image/png");
      return res.end(pngBytes);
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise<http.Server>((r) => srv.listen(W_PORT, "127.0.0.1", () => r(srv)));
}

async function main() {
  const T = await import("@/lib/instagram/types");
  const L = await import("@/lib/instagram/layout");
  const Q = await import("@/lib/instagram/quality");
  const V = await import("@/lib/instagram/validate");
  const posts = await import("@/lib/instagram/posts");
  const R = await import("@/lib/instagram/render");
  const MI = await import("@/lib/instagram/medical-image");
  const MC = await import("@/lib/instagram/medical-image-core");
  const { checkPublishable } = await import("@/lib/instagram/publish");
  const { saveStudioSettings, getStudioSettings } = await import("@/lib/instagram/config");
  const { encryptSecret } = await import("@/lib/secret-cipher");
  const { bumpGeminiConfigEpoch } = await import("@/lib/gemini-config");
  const { smartModules } = await import("@/lib/instagram/smart-layout");

  pngBytes = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#e8f0ff" } })
    .composite([{ input: Buffer.from('<svg width="1200" height="900"><circle cx="600" cy="450" r="300" fill="#c0392b"/></svg>'), top: 0, left: 0 }])
    .png()
    .toBuffer();
  const gem = await startGemini();
  const com = await startCommons();

  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: "igmaster" } });
  const actorId = admin.id;
  await saveStudioSettings({ instagramHandle: "mocktestseries.in", telegramUrl: "https://t.me/mocktestseries_fixture" });
  const settings = await getStudioSettings();
  const code = "IGFIX-RUHS21-W01";
  const question = await prisma.question.findUniqueOrThrow({ where: { code }, include: { options: true } });
  const fingerprint = async () => {
    const q = await prisma.question.findUniqueOrThrow({ where: { id: question.id }, include: { options: { orderBy: { label: "asc" } } } });
    return JSON.stringify([q.text, q.updatedAt, q.options.map((o) => [o.label, o.text, o.isCorrect])]);
  };
  const fpBefore = await fingerprint();
  await prisma.instagramPost.deleteMany({ where: { questionId: question.id } });

  const shortTrap: import("@/lib/instagram/types").TrapVariant = {
    question: "A patient cannot abduct the arm beyond 15 degrees. Which nerve is most likely injured?",
    options: [
      { label: "A", text: "Axillary nerve" },
      { label: "B", text: "Suprascapular nerve" },
      { label: "C", text: "Long thoracic nerve" },
      { label: "D", text: "Musculocutaneous nerve" },
    ],
    correct: "B",
    tempting: "A",
    trapExplanation: "Students jump to the deltoid, but the first 15 degrees belong to supraspinatus.",
    avoidTip: "Split abduction into 0-15, 15-90 and above 90 degrees.",
    status: "draft",
    checks: [],
  };
  const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
  const longTrap = {
    ...shortTrap,
    question: `${words(110, "stem")} Which nerve is injured?`.slice(0, 900),
    options: shortTrap.options.map((o) => ({ ...o, text: `${o.text} ${words(22, "opt")}`.slice(0, 200) })),
    trapExplanation: words(110, "why").slice(0, 800),
    avoidTip: words(70, "avoid").slice(0, 500),
  };

  const { post: created } = await posts.createDraft({ questionId: question.id, series: "PYQ", stats: null, actorId, design: T.defaultDesign("midnight", 7) });
  const baseContent = {
    ...created.content,
    hookText: "Can You Solve This PYQ?",
    explanation: "The stored answer is correct; this fixture explanation is short and plain.",
    memoryTrick: "Supraspinatus starts it, deltoid continues it.",
    clinicalPearl: "Fixture pearl.",
    quickRevision: ["Point one", "Point two"],
    pearls: ["Pearl one", "Pearl two"],
    mistakes: ["Mistake one"],
    diagram: { kind: "mechanism" as const, title: "Shoulder abduction", nodes: [{ id: "a", label: "Supraspinatus 0-15" }, { id: "b", label: "Deltoid 15-90" }], edges: [], columns: [], rows: [], sets: [], overlap: [], footnote: "", reviewed: false },
    trap: shortTrap,
    caption: `Fixture caption ${Date.now()}\nComment your answer below.`,
    hashtags: ["#RUHSMO", "#MedicalMCQs"],
    origin: { kind: "manual" as const },
  };
  let post = await posts.applyChange({ postId: created.id, expectedRevision: created.revision, content: baseContent, note: "fixture", actorId });

  console.log("\nExaminer Trap — long text never blocks");
  await check("short trap: one slide; the seven-slide carousel is unchanged", () => {
    assert.deepEqual(post.design.modules, T.DEFAULT_LAYOUTS[7]);
    assert.equal(L.slideSequence(post.content, post.design).length, 7);
    assert.equal(L.trapParts(shortTrap, 1).length, 1);
  });
  await check("long trap (900/200/800/500 chars) continues on extra slides — no overflow", () => {
    const parts = L.trapParts(longTrap, 1);
    assert.ok(parts.length >= 2, `parts=${parts.length}`);
    assert.ok(parts.every((p) => !p.overflow));
    const seq = L.slideSequence({ trap: longTrap }, post.design);
    assert.equal(seq.length, 7 + parts.length - 1);
    const ti = seq.findIndex((r) => r.module === "TRAP");
    assert.deepEqual(seq.slice(ti, ti + parts.length).map((r) => r.part), parts.map((_, i) => i));
    assert.equal(seq[seq.length - 1].module, "FOLLOW");
  });
  await check("every piece of the trap is shown exactly once across its slides (nothing hidden)", () => {
    for (const t of [shortTrap, longTrap]) {
      for (const scale of [0.85, 1, 1.25]) {
        const parts = L.trapParts(t, scale);
        for (const k of ["stem", "options", "why", "avoid"] as const) assert.equal(parts.filter((p) => p.show[k]).length, 1, `${k} @${scale}`);
      }
    }
  });
  await check("worst case at the save ceiling (TRAP_MAX) still fits without overflow at every scale", () => {
    const max = {
      ...shortTrap,
      question: "W".repeat(5).concat(" ").repeat(1) + words(200, "q").slice(0, T.TRAP_MAX.question - 6),
      options: shortTrap.options.map((o) => ({ ...o, text: words(60, "o").slice(0, T.TRAP_MAX.option) })),
      trapExplanation: words(200, "w").slice(0, T.TRAP_MAX.trapExplanation),
      avoidTip: words(150, "a").slice(0, T.TRAP_MAX.avoidTip),
    };
    for (const scale of [0.85, 1, 1.25]) assert.ok(L.trapParts(max, scale).every((p) => !p.overflow), `scale ${scale}`);
  });

  const longContent = { ...post.content, trap: longTrap };
  await check("save accepts a long trap (≤ TRAP_MAX) and keeps every character", () => {
    const r = V.checkContentInput(longContent, post.content);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.ok && r.value.trap?.question, longTrap.question.trim());
    assert.equal(r.ok && r.value.trap?.avoidTip, longTrap.avoidTip.trim());
  });
  await check("save still rejects absurd input above the ceiling (sanity cap, not a layout rule)", () => {
    const r = V.checkContentInput({ ...longContent, trap: { ...longTrap, question: "x ".repeat(T.TRAP_MAX.question) } }, post.content);
    assert.ok(!r.ok && /too long/.test(r.error));
  });
  post = await posts.applyChange({ postId: post.id, expectedRevision: post.revision, content: (V.checkContentInput(longContent, post.content) as { ok: true; value: typeof longContent }).value, note: "long trap", actorId });
  await check("quality gate: no blocking issue for the long trap — only a 'continues' warning", () => {
    const errs = post.issues.filter((i) => i.severity === "error");
    assert.deepEqual(errs.map((e) => e.code), []);
    assert.ok(!post.issues.some((i) => /too much text/.test(i.message)), "old blocker text still present");
    const cont = post.issues.find((i) => i.code === "TRAP_CONTINUED");
    assert.ok(cont && cont.severity === "warning", "TRAP_CONTINUED warning");
    assert.ok(post.issues.some((i) => i.code.startsWith("TRAP_LONG") && i.severity === "warning"));
  });
  await check("other quality checks still block (missing explanation, unsafe text, invalid trap structure)", () => {
    const base = { snapshot: post.snapshot, design: post.design, series: "PYQ" as const, seriesStats: null, questionNumber: null, questionNumberVerified: false, currentHash: "h", snapshotHash: "h", follow: { instagramHandle: "x", showInstagram: true, telegramUrl: "", showTelegram: false }, allowedDomains: ["mocktestseries.in"] };
    const g1 = Q.runQualityGate({ ...base, content: { ...post.content, trap: { ...longTrap, correct: "Z" } } });
    assert.ok(g1.some((i) => i.code.startsWith("TRAP_INVALID") && i.severity === "error"));
    const g2 = Q.runQualityGate({ ...base, content: { ...post.content, trap: { ...longTrap, status: "rejected" } } });
    assert.ok(g2.some((i) => i.code === "TRAP_REJECTED"));
    const g3 = Q.runQualityGate({ ...base, design: { ...post.design, modules: ["QUESTION", "ANSWER", "FOLLOW"], slideCount: 3 }, content: { ...post.content, explanation: "" } });
    assert.ok(g3.some((i) => i.code.startsWith("SLIDE_MISSING") && i.severity === "error"));
    const g4 = Q.runQualityGate({ ...base, content: { ...post.content, explanation: words(200, "longword") }, design: { ...post.design, modules: ["QUESTION", "ANSWER", "EXPLANATION", "FOLLOW"], slideCount: 4, bodyScale: 1.25 } });
    assert.ok(g4.some((i) => i.code.startsWith("SLIDE_OVERFLOW") && i.severity === "error"), "non-trap overflow still blocks");
  });
  await check("carousel limit: a continuation that would exceed 10 slides is a clear blocking issue", () => {
    const ten = ["HOOK", "QUESTION", "ANSWER", "EXPLANATION", "MEMORY_TRICK", "PEARLS", "MISTAKES", "DIAGRAM", "TRAP", "FOLLOW"] as const;
    const g = Q.runQualityGate({ snapshot: post.snapshot, design: { ...post.design, modules: [...ten], slideCount: 10 }, content: post.content, series: "PYQ", seriesStats: null, questionNumber: null, questionNumberVerified: false, currentHash: "h", snapshotHash: "h", follow: { instagramHandle: "x", showInstagram: true, telegramUrl: "", showTelegram: false }, allowedDomains: [] });
    assert.ok(g.some((i) => i.code === "CAROUSEL_TOO_LONG"));
  });
  const renderInput = (p: typeof post) => ({ snapshot: p.snapshot, content: p.content, design: p.design, series: p.series, seriesStats: p.seriesStats, questionNumber: p.questionNumber, questionNumberVerified: p.questionNumberVerified, settings });
  await check("JPEG export: every slide incl. trap continuations renders 1080×1350; beyond the end throws", async () => {
    const seq = L.slideSequence(post.content, post.design);
    if (OUT) mkdirSync(OUT, { recursive: true });
    for (let i = 0; i < seq.length; i++) {
      const jpg = await R.renderSlideJpeg(renderInput(post), i);
      const m = await sharp(jpg).metadata();
      assert.equal(m.format, "jpeg");
      assert.equal(`${m.width}x${m.height}`, "1080x1350");
      if (OUT) writeFileSync(path.join(OUT, `trap-${i + 1}-${seq[i].module}-${seq[i].part}.jpg`), jpg);
    }
    await thrown(() => R.renderSlideJpeg(renderInput(post), seq.length));
  });
  await check("publish preflight counts the continuation slides (carousel, no real publication)", async () => {
    const row = await prisma.instagramPost.findUniqueOrThrow({ where: { id: post.id } });
    const pre = await checkPublishable(row, post.revision, "CAROUSEL");
    assert.equal(pre.slideCount, L.slideSequence(post.content, post.design).length);
    assert.ok(pre.warnings.some((w) => w.code === "TRAP_CONTINUED"));
  });

  // Image section uses the short trap (a 4-slide trap + image would exceed Instagram's 10).
  post = await posts.applyChange({ postId: post.id, expectedRevision: post.revision, content: { ...post.content, trap: shortTrap }, note: "short trap", actorId });
  console.log("\nMedical Image — provider status");
  await prisma.setting.deleteMany({ where: { key: "api.gemini" } });
  bumpGeminiConfigEpoch();
  await check("no image provider configured → clear message, nothing generated or stored", async () => {
    const st = await MI.imageGenerationStatus();
    assert.equal(st.available, false);
    assert.match(st.message, /No image generation provider/);
    const before = geminiRequests.length;
    const e = await thrown(() => MI.generateMedicalImage({ snapshot: post.snapshot, content: post.content }));
    assert.match(e.message, /No image generation provider.*No image was generated/);
    assert.equal(geminiRequests.length, before);
  });
  await prisma.setting.create({
    data: { key: "api.gemini", value: { enabled: true, apiKeyCipher: encryptSecret("AIzaFAKE-scratch-key-000000000000000"), model: "gemini-3.1-flash-lite", primaryModel: "gemini-3.1-flash-lite", availableModels: [{ id: "gemini-3.1-flash-lite", displayName: "x" }] } },
  });
  bumpGeminiConfigEpoch();
  await check("a text-only Gemini key is not treated as an image generator", async () => {
    const st = await MI.imageGenerationStatus();
    assert.equal(st.available, false);
    assert.match(st.message, /no image model/);
  });
  await prisma.setting.update({ where: { key: "api.gemini" }, data: { value: { enabled: true, apiKeyCipher: encryptSecret("AIzaFAKE-scratch-key-000000000000000"), model: "gemini-3.1-flash-lite", primaryModel: "gemini-3.1-flash-lite", availableModels: [{ id: "gemini-3.1-flash-lite", displayName: "x" }, { id: "gemini-2.5-flash-image", displayName: "y" }, { id: "gemini-3.1-flash-image", displayName: "z" }] } } });
  bumpGeminiConfigEpoch();
  await check("image model picked from the key's model list (best first)", async () => {
    const st = await MI.imageGenerationStatus();
    assert.equal(st.available, true);
    assert.equal(st.model, "gemini-3.1-flash-image");
  });

  console.log("\nMedical Image — generate, preview, add, remove, skip");
  let generated: import("@/lib/instagram/types").MedicalImage;
  await check("Generate: one small request (IMAGE modality, header key, no history), stored content-addressed", async () => {
    const before = geminiRequests.length;
    const r = await MI.generateMedicalImage({ snapshot: post.snapshot, content: post.content, instruction: "show the rotator cuff" });
    generated = r.image;
    assert.equal(geminiRequests.length, before + 1);
    const req = geminiRequests[geminiRequests.length - 1];
    assert.match(req.url, /\/v1beta\/models\/gemini-3\.1-flash-image:generateContent$/);
    assert.ok(!req.url.includes("key="), "API key must not be in the URL");
    assert.equal(req.headers["x-goog-api-key"], "AIzaFAKE-scratch-key-000000000000000");
    const body = req.body as { contents: { parts: { text: string }[] }[]; generationConfig: { responseModalities: string[] } };
    assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]);
    assert.equal(body.contents.length, 1, "single turn — no conversation history");
    const prompt = body.contents[0].parts[0].text;
    assert.ok(prompt.length < 1500, `prompt ${prompt.length} chars`);
    assert.match(prompt, /no text of any kind/i);
    assert.match(prompt, /rotator cuff/);
    assert.match(generated.key, /^q\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
    assert.ok(existsSync(path.join(process.env.STORAGE_DIR!, "media", generated.key)));
    assert.equal(generated.source.kind, "ai");
    assert.equal(generated.source.model, "gemini-3.1-flash-image");
    assert.equal(generated.title, "Shoulder abduction", "title from existing diagram metadata");
    assert.equal(generated.memoryTip, post.content.memoryTrick, "tip from the existing memory trick");
  });
  await check("provider failure / no image → clear error, key redacted, nothing changed", async () => {
    geminiMode = "error";
    const e1 = await thrown(() => MI.generateMedicalImage({ snapshot: post.snapshot, content: post.content }));
    assert.match(e1.message, /429/);
    assert.ok(!/AIza/.test(e1.message), "key-like string leaked");
    geminiMode = "noimage";
    const e2 = await thrown(() => MI.generateMedicalImage({ snapshot: post.snapshot, content: post.content }));
    assert.match(e2.message, /no image \(IMAGE_SAFETY\)/);
    geminiMode = "image";
  });
  // Cache the candidate on the post (what aiMedicalImageAction saves).
  post = await posts.applyChange({ postId: post.id, expectedRevision: post.revision, content: { ...post.content, imageCandidate: generated! }, note: "AI: medical image", actorId });
  await check("candidate is cached on the post; the carousel is NOT changed until Add", async () => {
    const fresh = await posts.getPostDto(post.id);
    assert.equal(fresh.content.imageCandidate?.key, generated.key);
    assert.equal(fresh.content.medicalImage, null);
    assert.ok(!fresh.design.modules.includes("MEDICAL_IMAGE"));
    assert.ok(!smartModules(fresh.content).includes("MEDICAL_IMAGE"), "smart layout never adds an unapproved image");
  });
  await check("save refuses an image key the server did not create (client can't inject files)", () => {
    const r = V.checkContentInput({ ...post.content, medicalImage: { ...generated, key: "q/aa/" + "a".repeat(64) + ".jpg" } }, post.content);
    assert.ok(!r.ok && /unknown image/.test(r.error));
    const r2 = V.checkContentInput({ ...post.content, imageCandidate: { ...generated, key: "q/bb/" + "b".repeat(64) + ".jpg" } }, post.content);
    assert.ok(r2.ok && r2.value.imageCandidate === null, "forged candidate dropped");
    const r3 = V.checkContentInput({ ...post.content, medicalImage: { ...generated, source: { kind: "reference", provider: "evil", createdAt: "" } } }, post.content);
    assert.ok(r3.ok && r3.value.medicalImage?.source.provider === "gemini", "source is server-owned");
  });
  await check("Skip Image clears the candidate (no slide, file not referenced)", () => {
    const r = V.checkContentInput({ ...post.content, imageCandidate: null }, post.content);
    assert.ok(r.ok && r.value.imageCandidate === null && r.value.medicalImage === null);
  });
  // Add to Carousel (+ edited title/tip) → Save.
  const added = V.checkContentInput({ ...post.content, imageCandidate: null, medicalImage: { ...generated!, title: "  Shoulder   abduction ", memoryTip: "First 15° supraspinatus, then deltoid." } }, post.content);
  const addedDesign = V.checkDesignInput({ ...post.design, modules: ["QUESTION", "ANSWER", "DIAGRAM", "PEARLS", "MISTAKES", "TRAP", "MEDICAL_IMAGE", "FOLLOW"] });
  await check("Add to Carousel: approved image + MEDICAL_IMAGE slide before Follow pass validation", () => {
    assert.ok(added.ok, added.ok ? "" : added.error);
    assert.ok(addedDesign.ok, addedDesign.ok ? "" : addedDesign.error);
    assert.equal(added.ok && added.value.medicalImage?.title, "Shoulder abduction");
  });
  post = await posts.applyChange({ postId: post.id, expectedRevision: post.revision, content: (added as { ok: true; value: typeof post.content }).value, design: (addedDesign as { ok: true; value: typeof post.design }).value, note: "add image", actorId });
  await check("image slide: renders 1080×1350 JPEG with the image; gate = review warning only", async () => {
    const seq = L.slideSequence(post.content, post.design);
    const idx = seq.findIndex((r) => r.module === "MEDICAL_IMAGE");
    assert.equal(seq[idx + 1].module, "FOLLOW");
    const jpg = await R.renderSlideJpeg(renderInput(post), idx);
    const m = await sharp(jpg).metadata();
    assert.equal(`${m.width}x${m.height}`, "1080x1350");
    // The red circle of the mock image must be on the slide (proves the picture was drawn).
    const { data, info } = await sharp(jpg).raw().toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] > 170 && data[i + 1] < 90 && data[i + 2] < 90) red++;
    assert.ok(red > 20000, `red pixels ${red}`);
    if (OUT) writeFileSync(path.join(OUT, `image-slide.jpg`), jpg);
    const errs = post.issues.filter((i) => i.severity === "error");
    assert.deepEqual(errs.map((e) => e.code), []);
    assert.ok(post.issues.some((i) => i.code === "MEDICAL_IMAGE_REVIEW" && i.severity === "warning"));
  });
  await check("image slide renders in every design mode (handwritten + professional)", async () => {
    for (const template of ["hw-doctor", "clean-clinical"] as const) {
      const idx = L.slideSequence(post.content, post.design).findIndex((r) => r.module === "MEDICAL_IMAGE");
      const jpg = await R.renderSlideJpeg({ ...renderInput(post), design: { ...post.design, template } }, idx);
      assert.equal((await sharp(jpg).metadata()).height, 1350);
      if (OUT) writeFileSync(path.join(OUT, `image-slide-${template}.jpg`), jpg);
    }
  });
  await check("image title / tip go through content safety (no invented years etc.)", () => {
    const g = Q.runQualityGate({ snapshot: post.snapshot, design: post.design, content: { ...post.content, medicalImage: { ...post.content.medicalImage!, memoryTip: "This is frequently asked and will definitely come" } }, series: "PYQ", seriesStats: null, questionNumber: null, questionNumberVerified: false, currentHash: "h", snapshotHash: "h", follow: { instagramHandle: "x", showInstagram: true, telegramUrl: "", showTelegram: false }, allowedDomains: [] });
    assert.ok(g.some((i) => i.code.startsWith("SAFETY:Medical image")), JSON.stringify(g.map((i) => i.code)));
  });
  await check("unreadable image file → render fails visibly (never publishes a slide without its image)", async () => {
    const idx = L.slideSequence(post.content, post.design).findIndex((r) => r.module === "MEDICAL_IMAGE");
    const e = await thrown(() => R.renderSlideJpeg({ ...renderInput(post), content: { ...post.content, medicalImage: { ...post.content.medicalImage!, key: "q/cc/" + "c".repeat(64) + ".jpg" } } }, idx));
    assert.match(e.message, /could not be loaded/);
  });
  await check("image slide without an image is reported missing (blocking) — never publishes empty", () => {
    const g = Q.runQualityGate({ snapshot: post.snapshot, design: post.design, content: { ...post.content, medicalImage: null }, series: "PYQ", seriesStats: null, questionNumber: null, questionNumberVerified: false, currentHash: "h", snapshotHash: "h", follow: { instagramHandle: "x", showInstagram: true, telegramUrl: "", showTelegram: false }, allowedDomains: [] });
    assert.ok(g.some((i) => i.code.startsWith("SLIDE_MISSING") && /Medical image/.test(i.message)));
  });
  await check("publish preflight includes the image slide (no real publication)", async () => {
    const row = await prisma.instagramPost.findUniqueOrThrow({ where: { id: post.id } });
    const pre = await checkPublishable(row, post.revision, "CAROUSEL");
    assert.equal(pre.slideCount, L.slideSequence(post.content, post.design).length);
    assert.ok(pre.slideCount <= T.MAX_SLIDES);
  });
  await check("smart layout keeps an approved image slide", () => {
    assert.ok(smartModules(post.content).includes("MEDICAL_IMAGE"));
  });
  await check("Remove Image: slide and image gone; the seven original slides remain", () => {
    const r = V.checkContentInput({ ...post.content, medicalImage: null }, post.content);
    const d = V.checkDesignInput({ ...post.design, modules: post.design.modules.filter((m) => m !== "MEDICAL_IMAGE") });
    assert.ok(r.ok && r.value.medicalImage === null);
    assert.ok(d.ok && JSON.stringify(d.value.modules) === JSON.stringify(T.DEFAULT_LAYOUTS[7]));
  });
  await check("undo restores the previous revision's image state", async () => {
    const u = await posts.undoLast(post.id, post.revision, actorId);
    assert.ok(!u.design.modules.includes("MEDICAL_IMAGE"));
    assert.equal(u.content.imageCandidate?.key, generated.key);
    post = u;
  });

  console.log("\nReference images — Wikimedia Commons, free licences only");
  await check("search returns only public-domain / CC0 / CC BY / CC BY-SA JPEG/PNG (no NC, fair use or SVG)", async () => {
    const r = await MI.searchReferenceImages("brachial plexus");
    assert.deepEqual(r.map((x) => x.fileTitle).sort(), ["File:Brachial plexus.png", "File:Plexus pd.jpg"]);
    assert.equal(r[0].author.includes("<"), false, "author HTML stripped");
    assert.ok(r.every((x) => x.thumbUrl.startsWith("https://upload.wikimedia.org/") && /\/320px-/.test(x.thumbUrl)));
    assert.ok(commonsRequests.some((u) => u.includes("filetype%3Abitmap")));
  });
  await check("licence rules", () => {
    for (const ok of ["Public domain", "CC0", "CC BY 4.0", "CC BY-SA 3.0", "PD-US"]) assert.ok(MC.licenseAllowed(ok), ok);
    for (const no of ["CC BY-NC 4.0", "CC BY-ND 2.0", "Fair use", "All rights reserved", ""]) assert.ok(!MC.licenseAllowed(no), no);
  });
  await check("import re-checks the licence server-side and refuses non-free files", async () => {
    const e = await thrown(() => MI.importReferenceImage({ snapshot: post.snapshot, content: post.content, fileTitle: "File:Plexus nc.png" }));
    assert.match(e.message, /free licence/);
    const e2 = await thrown(() => MI.importReferenceImage({ snapshot: post.snapshot, content: post.content, fileTitle: "https://evil.example/x.png" }));
    assert.match(e2.message, /Invalid reference image/);
  });
  await check("import: stored with author + licence credit on the slide", async () => {
    const r = await MI.importReferenceImage({ snapshot: post.snapshot, content: post.content, fileTitle: "File:Brachial plexus.png" });
    assert.equal(r.image.source.kind, "reference");
    assert.equal(r.image.source.license, "CC BY-SA 4.0");
    assert.equal(r.image.source.author, "Dr Grey");
    assert.match(r.image.source.pageUrl ?? "", /^https:\/\/commons\.wikimedia\.org\/wiki\//);
    const p2 = { ...post, content: { ...post.content, medicalImage: r.image }, design: { ...post.design, modules: [...post.design.modules.slice(0, -1), "MEDICAL_IMAGE" as const, "FOLLOW" as const], slideCount: 8 } };
    const idx = L.slideSequence(p2.content, p2.design).findIndex((x) => x.module === "MEDICAL_IMAGE");
    const jpg = await R.renderSlideJpeg(renderInput(p2), idx);
    if (OUT) writeFileSync(path.join(OUT, `reference-slide.jpg`), jpg);
    assert.equal((await sharp(jpg).metadata()).width, 1080);
  });

  console.log("\nSafety");
  await check("existing drafts (no image fields stored) still normalize and render unchanged", async () => {
    const legacy = T.normalizeContent({ ...baseContent, medicalImage: undefined, imageCandidate: undefined });
    assert.equal(legacy.medicalImage, null);
    assert.equal(legacy.imageCandidate, null);
    assert.equal(L.slideSequence(legacy, T.defaultDesign("midnight", 7)).length, 7);
  });
  await check("source question, options and answer key unchanged", async () => {
    assert.equal(await fingerprint(), fpBefore);
  });
  await check("no request left the loopback mocks (no Google / Wikimedia / Meta)", () => {
    assert.ok(geminiRequests.length >= 3 && commonsRequests.length >= 3);
  });

  await prisma.instagramPost.deleteMany({ where: { questionId: question.id } });
  await prisma.setting.deleteMany({ where: { key: "api.gemini" } });
  gem.close();
  com.close();
  console.log(`\n${passes} passed, ${fails} failed`);
  await prisma.$disconnect();
  process.exit(fails ? 1 : 0);
}

// Any real outbound host is a test failure.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = String(input instanceof Request ? input.url : input);
  if (!u.startsWith("http://127.0.0.1:")) throw new Error(`Blocked outbound request in test: ${u.slice(0, 60)}`);
  return realFetch(input, init);
}) as typeof fetch;

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
