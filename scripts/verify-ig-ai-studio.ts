/**
 * Instagram AI Studio — library regression: design modes + rendering, the
 * universal carousel (Diagram / Pearls / Mistakes / Examiner Trap), AI
 * generation through the AI Gateway (Claude, via a LOCAL Anthropic mock),
 * validation and the quality gate, exam scope (NEET UG excluded), smart
 * selection, Bulk Studio and its attended publishing queue (LOCAL Meta mock),
 * metrics, and Trends & Competitors. Never talks to Anthropic or Meta.
 *
 *   set -a; . ./.env; set +a          # an *igstudio* scratch DB with scripts/ig-studio-fixture.ts setup
 *   export STORAGE_DIR=<scratch dir>
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ig-ai-studio.ts [render-out-dir]
 */
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { startMockAnthropic, mockKey } from "./mock-anthropic.mjs";
import { MOCK_USER_ID, mockToken, startMockGraph } from "./mock-meta-graph.mjs";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
if (!process.env.STORAGE_DIR || process.env.STORAGE_DIR.startsWith("/var/www")) {
  console.error("Refusing to run: export STORAGE_DIR=<scratch dir> (never production storage).");
  process.exit(2);
}
const A_PORT = 3188;
const G_PORT = 3187;
const M_PORT = 3186;
process.env.ANTHROPIC_TEST_BASE_URL = `http://127.0.0.1:${A_PORT}`;
process.env.INSTAGRAM_QUEUE_SPACING_MS = "1000";
const OUT = process.argv[2] ?? "";

let passes = 0;
let failures = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passes++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        → ${String((e as Error)?.stack ?? e).split("\n").slice(0, 5).join("\n          ")}`);
  }
}
const thrown = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
};

async function main() {
  const T = await import("@/lib/instagram/types");
  const { smartModules } = await import("@/lib/instagram/smart-layout");
  const D = await import("@/lib/instagram/diagram");
  const C = await import("@/lib/instagram/ai-studio-core");
  const TR = await import("@/lib/instagram/trap");
  const { parseAiResponse, buildPrompt } = await import("@/lib/instagram/ai-core");
  const scope = await import("@/lib/instagram/exam-scope");
  const { SAMPLE_INPUT, sampleWith, SAMPLE_SETTINGS } = await import("@/lib/instagram/sample");
  const { renderSlideJpeg } = await import("@/lib/instagram/render");
  const { TEMPLATES, resolveTheme } = await import("@/lib/instagram/templates");
  const { runQualityGate } = await import("@/lib/instagram/quality");
  const { checkContentInput, checkDesignInput } = await import("@/lib/instagram/validate");

  console.log("\n--- A. Types, layouts, design modes ---");
  await check("slide limits 3–10; 7-slide universal layout; Follow last", () => {
    assert.equal(T.validateModules(T.DEFAULT_LAYOUTS[7]), null);
    assert.deepEqual(T.DEFAULT_LAYOUTS[7], ["QUESTION", "ANSWER", "DIAGRAM", "PEARLS", "MISTAKES", "TRAP", "FOLLOW"]);
    assert.match(T.validateModules(["QUESTION", "FOLLOW"]) ?? "", /3 to 10/);
    assert.equal(T.validateModules(["HOOK", "QUESTION", "ANSWER", "EXPLANATION", "MEMORY_TRICK", "PEARL_REVISION", "PEARLS", "MISTAKES", "DIAGRAM", "FOLLOW"]), null);
    assert.match(T.validateModules(["QUESTION", "ANSWER", "DIAGRAM", "PEARLS", "MISTAKES", "TRAP", "HOOK", "EXPLANATION", "MEMORY_TRICK", "PEARL_REVISION", "FOLLOW"]) ?? "", /3 to 10/);
    for (const n of [3, 4, 5, 6] as const) assert.equal(T.validateModules(T.DEFAULT_LAYOUTS[n]), null, "old layouts still valid");
  });
  await check("existing posts keep working: old design JSON normalizes unchanged", () => {
    const old = { template: "midnight", slideCount: 5, modules: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "FOLLOW"], questionScale: 1, bodyScale: 1 };
    assert.deepEqual(T.normalizeDesign(old), old);
    const oldContent = { hooks: [], hookText: "x", explanation: "y", memoryTrick: "", clinicalPearl: "", quickRevision: [], finalTrick: "", showFinalTrick: false, caption: "c", hashtags: [], origin: { kind: "manual" }, aiFlags: [] };
    const c = T.normalizeContent(oldContent);
    assert.deepEqual(c.pearls, []);
    assert.equal(c.diagram, null);
    assert.equal(c.trap, null);
    assert.equal(c.explanation, "y");
  });
  await check("design overrides: only #rrggbb colours and known fonts survive", () => {
    const d = T.normalizeDesign({ ...T.defaultDesign("hw-doctor", 7), overrides: { background: "#ABCDEF", accent: "red", font: "kalam", card: "#12345", evil: "x" } });
    assert.deepEqual(d.overrides, { background: "#abcdef", font: "kalam" });
    assert.equal(T.normalizeDesign({ overrides: { font: "default" } }).overrides, undefined);
    assert.equal(resolveTheme(d).background, "#abcdef");
    assert.equal(resolveTheme({ template: "midnight", overrides: { font: "kalam" } }).font, "Kalam");
  });
  await check("modes: 4 original + 4 professional presets, 3 handwritten presets", () => {
    assert.deepEqual(T.TEMPLATE_KEYS.filter((k) => T.modeOfTemplate(k) === "handwritten"), ["hw-doctor", "hw-colorful", "hw-diagrams"]);
    assert.equal(T.TEMPLATE_KEYS.filter((k) => T.modeOfTemplate(k) === "professional").length, 8);
    for (const k of T.TEMPLATE_KEYS) assert.equal(TEMPLATES[k].mode, T.modeOfTemplate(k));
  });
  await check("smart slide count uses only the content that exists", () => {
    const base = T.emptyContent();
    assert.deepEqual(smartModules(base), ["QUESTION", "ANSWER", "FOLLOW"]);
    const full = SAMPLE_INPUT.content;
    assert.deepEqual(smartModules(full), ["QUESTION", "ANSWER", "DIAGRAM", "PEARLS", "MISTAKES", "TRAP", "FOLLOW"]);
    assert.deepEqual(smartModules({ ...full, trap: { ...full.trap!, status: "rejected" }, diagram: null }), ["QUESTION", "ANSWER", "PEARLS", "MISTAKES", "FOLLOW"]);
  });

  console.log("\n--- B. Rendering (deterministic SVG/HTML, 1080×1350 JPEG) ---");
  if (OUT) mkdirSync(OUT, { recursive: true });
  for (const k of T.TEMPLATE_KEYS) {
    await check(`template ${k}: all 7 universal slides render 1080×1350 JPEG`, async () => {
      const input = sampleWith(SAMPLE_SETTINGS, T.defaultDesign(k, 7));
      for (let i = 0; i < 7; i++) {
        const jpg = await renderSlideJpeg(input, i, 80);
        const m = await sharp(jpg).metadata();
        assert.equal(m.format, "jpeg");
        assert.equal(m.width, 1080);
        assert.equal(m.height, 1350);
        if (OUT) writeFileSync(path.join(OUT, `${k}-${i + 1}.jpg`), jpg);
      }
    });
  }
  const diagrams: Record<string, ReturnType<typeof T.normalizeDiagram>> = {
    flowchart: T.normalizeDiagram({
      kind: "flowchart",
      title: "Upper GI bleed: first steps",
      nodes: [
        { id: "a", label: "Haematemesis / melaena" },
        { id: "b", label: "Resuscitate: 2 large-bore IV lines" },
        { id: "c", label: "Variceal suspected", note: "start terlipressin" },
        { id: "d", label: "Non-variceal", note: "IV PPI" },
        { id: "e", label: "Endoscopy within 24 h" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c", label: "liver disease" },
        { from: "b", to: "d" },
        { from: "c", to: "e" },
        { from: "d", to: "e" },
      ],
    }),
    comparison: T.normalizeDiagram({ kind: "comparison", title: "Crohn's vs Ulcerative colitis", columns: ["Feature", "Crohn's", "UC"], rows: [{ label: "Site", cells: ["Mouth to anus", "Rectum upward"] }, { label: "Lesions", cells: ["Skip lesions", "Continuous"] }, { label: "Wall", cells: ["Transmural", "Mucosal"] }] }),
    ddx: T.normalizeDiagram({ kind: "ddx", title: "Fever with rash: key clues", columns: ["Feature", "Measles", "Rubella", "Chickenpox"], rows: [{ label: "Prodrome", cells: ["3 Cs", "Mild", "Mild"] }, { label: "Pathognomonic", cells: ["Koplik spots", "Forchheimer spots", "Crops of vesicles"] }] }),
    venn2: T.normalizeDiagram({ kind: "venn", title: "Nephritic vs nephrotic", sets: [{ label: "Nephritic", items: ["Haematuria", "RBC casts"] }, { label: "Nephrotic", items: ["Proteinuria >3.5 g", "Lipiduria"] }], overlap: ["Oedema"] }),
    venn3: T.normalizeDiagram({ kind: "venn", title: "HLA-B27 arthropathies", sets: [{ label: "Ankylosing spond.", items: ["Bamboo spine"] }, { label: "Reactive arthritis", items: ["Urethritis"] }, { label: "Psoriatic", items: ["Pencil-in-cup"] }], overlap: ["Sacroiliitis"] }),
    hub: T.normalizeDiagram({ kind: "hub", title: "Brachial plexus: cords → nerves", nodes: [{ id: "c", label: "Brachial plexus cords" }, { id: "l", label: "Lateral cord", note: "musculocutaneous" }, { id: "p", label: "Posterior cord", note: "radial, axillary" }, { id: "m", label: "Medial cord", note: "ulnar" }, { id: "x", label: "Median nerve", note: "lateral + medial" }] }),
  };
  for (const [name, d] of Object.entries(diagrams)) {
    await check(`diagram ${name}: valid, fits, renders in professional and handwritten`, async () => {
      assert.ok(d);
      assert.deepEqual(D.checkDiagram(d!), []);
      assert.equal(D.diagramLayout(d!).overflow, false);
      for (const tpl of ["minimal-infographic", "hw-diagrams"] as const) {
        const input = { ...sampleWith(SAMPLE_SETTINGS, { ...T.defaultDesign(tpl, 7) }), content: { ...SAMPLE_INPUT.content, diagram: { ...d!, reviewed: true } } };
        const jpg = await renderSlideJpeg(input, 2, 80);
        assert.equal((await sharp(jpg).metadata()).width, 1080);
        if (OUT) writeFileSync(path.join(OUT, `diagram-${name}-${tpl}.jpg`), jpg);
      }
    });
  }
  await check("diagram validation: loops, too many boxes, bad table shape, long labels", () => {
    const loop = T.normalizeDiagram({ kind: "flowchart", title: "x", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] })!;
    assert.ok(D.checkDiagram(loop).some((m) => /loops/.test(m)));
    const many = T.normalizeDiagram({ kind: "mechanism", title: "x", nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` })) })!;
    assert.ok(D.checkDiagram(many).some((m) => /At most 7/.test(m)));
    const table = T.normalizeDiagram({ kind: "comparison", title: "x", columns: ["F", "A", "B"], rows: [{ label: "r", cells: ["only one"] }, { label: "r2", cells: ["a", "b"] }] })!;
    assert.ok(D.checkDiagram(table).some((m) => /must have 2 cells/.test(m)));
    const long = T.normalizeDiagram({ kind: "mechanism", title: "x".repeat(70), nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })!;
    assert.ok(D.checkDiagram(long).some((m) => /Title is too long/.test(m)));
  });

  console.log("\n--- C. AI output parsing and validation ---");
  const snap = SAMPLE_INPUT.snapshot;
  await check("carousel AI: pearls and mistakes parsed with caps; NEET UG hashtags stripped", () => {
    const prompt = buildPrompt({ snapshot: snap, series: "PYQ", stats: null, targets: ["pearls", "mistakes", "hashtags"], current: T.emptyContent() });
    assert.match(prompt, /Exam style/);
    assert.match(prompt, /Never mention NEET UG/);
    const r = parseAiResponse(JSON.stringify({ answerLabel: "B", pearls: ["a", "b", "c"], mistakes: ["x".repeat(200)], hashtags: ["#NEETUG", "#MOExam", "#neet2026", "#Pharmacology"], confidence: "high", concerns: [] }), snap, ["pearls", "mistakes", "hashtags"], ["mocktestseries.in"]);
    assert.deepEqual(r.patch.pearls, ["a", "b", "c"]);
    assert.ok(r.rejected.some((x) => x.field === "mistakes"));
    assert.deepEqual(r.patch.hashtags, ["#MOExam", "#Pharmacology"]);
  });
  await check("diagram AI: valid spec accepted (reviewed=false); clinical-image claims and invalid specs rejected", () => {
    const ok = C.parseDiagram(JSON.stringify({ kind: "mechanism", title: "T", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], confidence: "high" }), snap, "auto");
    assert.ok(ok.ok && ok.diagram.reviewed === false);
    const img = C.parseDiagram(JSON.stringify({ kind: "mechanism", title: "Histology", nodes: [{ id: "a", label: "Histology slide shows" }, { id: "b", label: "Photomicrograph shows caseation" }] }), snap, "auto");
    assert.ok(!img.ok);
    assert.ok(!C.parseDiagram("not json", snap, "auto").ok);
    assert.ok(!C.parseDiagram(JSON.stringify({ kind: "venn", title: "T", sets: [{ label: "A", items: [] }], overlap: [] }), snap, "auto").ok);
    const wrongKind = C.parseDiagram(JSON.stringify({ kind: "mechanism", title: "T", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }), snap, "comparison");
    assert.ok(!wrongKind.ok);
    const lowConf = C.parseDiagram(JSON.stringify({ kind: "mechanism", title: "T", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], confidence: "low", concerns: ["unsure"] }), snap, "auto");
    assert.ok(lowConf.ok && lowConf.flags.some((f) => /low/.test(f)));
  });
  await check("trap AI: exactly 4 options + one correct; tempting ≠ correct; near-duplicate flagged; blind-solve disagreement flagged", () => {
    const good = TR.parseTrap(JSON.stringify({ text: "Q?", options: ["A", "B", "C", "D"].map((l, i) => ({ label: l, text: `opt ${l}`, isCorrect: i === 1 })), tempting: "A", trapExplanation: "e", avoidTip: "t", confidence: "high" }));
    assert.ok(good.ok);
    assert.ok(!TR.parseTrap(JSON.stringify({ text: "Q?", options: ["A", "B", "C", "D"].map((l) => ({ label: l, text: l, isCorrect: true })) })).ok);
    assert.ok(!TR.parseTrap(JSON.stringify({ text: "Q?", options: ["A", "B", "C"].map((l, i) => ({ label: l, text: l, isCorrect: i === 0 })) })).ok);
    if (!good.ok) return;
    assert.ok(TR.checkTrap({ ...good.trap, tempting: "B", status: "draft", checks: [] }).some((m) => /tempting/.test(m)));
    const dup = { ...good.trap, question: snap.text, options: snap.options.map((o) => ({ label: o.label, text: o.text })), correct: "B" };
    const checks = TR.trapChecks(dup, snap, "", { confidence: "high", concerns: [] }, { answer: "C", ambiguous: false, reason: "" });
    assert.equal(checks.find((c) => c.code === "ORIGINAL")?.ok, false);
    assert.equal(checks.find((c) => c.code === "BLIND_SOLVE")?.ok, false);
    const agree = TR.trapChecks(good.trap, snap, SAMPLE_INPUT.content.explanation, { confidence: "high", concerns: [] }, { answer: "B", ambiguous: false, reason: "" });
    assert.equal(agree.find((c) => c.code === "BLIND_SOLVE")?.ok, true);
  });
  await check("captions: 3 versions; 'trending' without evidence rejected; NEET UG text rejected; NEET UG keywords stripped", () => {
    const v = (style: string, caption: string) => ({ style, caption, hashtags: ["#MOExam", "#NEETUG"] });
    const r = C.parseCaptions(JSON.stringify({ versions: [v("professional", "Fine caption.\nComment below."), v("hook", "This topic is trending now!"), v("search", "Best for NEET UG biology")], keywords: ["MO exam PYQ", "NEET UG"] }), snap, ["mocktestseries.in"], []);
    assert.ok(!("error" in r));
    if ("error" in r) return;
    assert.deepEqual(r.variants.map((x) => x.style), ["professional"]);
    assert.deepEqual(r.variants[0].hashtags, ["#MOExam"]);
    assert.deepEqual(r.keywords, ["MO exam PYQ"]);
    assert.deepEqual(r.rejected.map((x) => x.style).sort(), ["hook", "search"]);
    const withEv = C.parseCaptions(JSON.stringify({ versions: [v("hook", "Antiepileptics are trending in our data.")], evidenceUsed: ["missed:0", "fake"] }), snap, ["mocktestseries.in"], [{ id: "missed:0", kind: "PLATFORM", summary: "s", source: "x", observedAt: null, quality: "medium" }]);
    assert.ok(!("error" in withEv) && withEv.variants.length === 1 && withEv.evidenceUsed.join() === "missed:0");
  });
  await check("exam scope: FMGE / NEET PG / INI-CET / AIIMS / CMS / State MO in; NEET UG and school level out", () => {
    for (const [n, c] of [["FMGE", "FMGE"], ["NEET PG 2027", "NEETPG"], ["INI-CET", "INICET"], ["AIIMS Medical Officer", "AIIMS-MO"], ["UPSC CMS", "CMS"], ["RUHS MEDICAL OFFICER EXAM 2026", "RUHSMO"], ["HARYANA MEDICAL OFFICER EXAM", "HR-MO"], ["PUNJAB MEDICAL OFFICER EXAM", "PUNJAB-MO"]]) {
      assert.ok(scope.isDefaultEligible(n, c), n);
    }
    for (const [n, c] of [["Neet UG", "NEETUG"], ["NEET-UG 2026", "X"], ["Class 12 Biology", "C12"]]) {
      assert.ok(!scope.isDefaultEligible(n, c), n);
      assert.ok(scope.isExcludedExam(n, c), n);
    }
    assert.ok(!scope.isDefaultEligible("RPSC ASST. PROFESSOR (MEDICAL EDU.)", "01"), "not auto-included, admin can add");
    assert.equal(scope.examProfile("NEET PG 2027", "X").key, "NEET_PG");
    assert.equal(scope.examProfile("RUHS MEDICAL OFFICER EXAM", "RUHSMO").key, "STATE_MO");
  });
  await check("server-side save: trap approval / checks / diagram review / caption versions can't be forged by the client", () => {
    const prev = { ...SAMPLE_INPUT.content, trap: { ...SAMPLE_INPUT.content.trap!, status: "draft" as const, checks: [{ code: "BLIND_SOLVE", ok: true, message: "ok" }] }, diagram: { ...SAMPLE_INPUT.content.diagram!, reviewed: false }, captionVariants: [] };
    const forged = { ...prev, trap: { ...prev.trap, status: "approved", checks: [] }, diagram: { ...prev.diagram, reviewed: true }, captionVariants: [{ style: "hook", caption: "forged", hashtags: [] }] };
    const r = checkContentInput(forged, prev);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.trap?.status, "draft");
    assert.equal(r.value.trap?.checks.length, 1);
    assert.equal(r.value.diagram?.reviewed, false);
    assert.deepEqual(r.value.captionVariants, []);
    // Editing an approved trap sends it back to draft with an EDITED note.
    const approved = { ...prev, trap: { ...prev.trap, status: "approved" as const } };
    const edited = checkContentInput({ ...approved, trap: { ...approved.trap, question: "Changed question?" } }, approved);
    assert.ok(edited.ok && edited.value.trap?.status === "draft" && edited.value.trap.checks.some((c) => c.code === "EDITED"));
    // Editing a reviewed diagram removes the review.
    const reviewed = { ...prev, diagram: { ...prev.diagram, reviewed: true } };
    const ed = checkContentInput({ ...reviewed, diagram: { ...reviewed.diagram, title: "New title" } }, reviewed);
    assert.ok(ed.ok && ed.value.diagram?.reviewed === false);
    const same = checkContentInput(reviewed, reviewed);
    assert.ok(same.ok && same.value.diagram?.reviewed === true);
    assert.ok(checkDesignInput({ ...T.defaultDesign("hw-doctor", 7) }).ok);
  });
  await check("quality gate: unreviewed diagram, unapproved trap, NEET UG exam/caption block Ready; trend claim warns", () => {
    const base = {
      snapshot: snap,
      design: T.defaultDesign("hw-doctor", 7),
      series: "PYQ" as const,
      seriesStats: null,
      questionNumber: 12,
      questionNumberVerified: true,
      currentHash: "h",
      snapshotHash: "h",
      follow: { instagramHandle: "mocktestseries.in", showInstagram: true, telegramUrl: "", showTelegram: false },
      allowedDomains: ["mocktestseries.in"],
    };
    const content = { ...SAMPLE_INPUT.content, caption: "Comment your answer.", diagram: { ...SAMPLE_INPUT.content.diagram!, reviewed: false }, trap: { ...SAMPLE_INPUT.content.trap!, status: "draft" as const } };
    const codes = runQualityGate({ ...base, content }).filter((i) => i.severity === "error").map((i) => i.code);
    assert.ok(codes.includes("DIAGRAM_UNREVIEWED"));
    assert.ok(codes.includes("TRAP_UNAPPROVED"));
    const ok = runQualityGate({ ...base, content: { ...content, diagram: { ...content.diagram, reviewed: true }, trap: { ...content.trap, status: "approved" as const } } }).filter((i) => i.severity === "error");
    assert.deepEqual(ok.map((i) => i.code), []);
    const ug = runQualityGate({ ...base, snapshot: { ...snap, examName: "Neet UG", examCode: "NEETUG" }, content: { ...content, caption: "Great for #NEETUG" } }).map((i) => i.code);
    assert.ok(ug.includes("EXAM_OUT_OF_SCOPE") && ug.includes("CAPTION_OUT_OF_SCOPE"));
    const trend = runQualityGate({ ...base, content: { ...content, caption: "This is trending!" } });
    assert.ok(trend.some((i) => i.code === "CAPTION_TREND_CLAIM" && i.severity === "warning"));
  });

  // ---- DB / gateway / queue ------------------------------------------------------------
  const { server: anth } = await startMockAnthropic(A_PORT);
  const { server: graph, base: graphBase } = await startMockGraph(G_PORT);
  const { readPublishMedia, setPublishingSwitch, runPublishJob } = await import("@/lib/instagram/publish");
  const media = http.createServer(async (req, res) => {
    const m = /^\/api\/instagram-media\/([^/]+)\/([^/]+)$/.exec(req.url ?? "");
    const buf = m ? await readPublishMedia(m[1], m[2]) : null;
    if (!buf) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(buf);
  });
  await new Promise<void>((r) => media.listen(M_PORT, "127.0.0.1", () => r()));
  const realFetch = globalThis.fetch;
  const stray: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (![A_PORT, G_PORT, M_PORT].some((p) => u.startsWith(`http://127.0.0.1:${p}/`)) && !u.startsWith("data:")) {
      stray.push(u.slice(0, 80));
      throw new Error(`blocked outbound request to ${u.slice(0, 40)}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  Object.assign(process.env, {
    INSTAGRAM_GRAPH_API_BASE: graphBase,
    INSTAGRAM_USER_ID: MOCK_USER_ID,
    INSTAGRAM_MEDIA_BASE_URL: `http://127.0.0.1:${M_PORT}`,
    INSTAGRAM_PUBLISH_POLL_MS: "150",
    INSTAGRAM_WRITE_TIMEOUT_MS: "1500",
    INSTAGRAM_ACCESS_TOKEN: mockToken("valid"),
  });

  const cfg = await import("@/lib/anthropic-config");
  const gw = await import("@/lib/ai-gateway");
  const posts = await import("@/lib/instagram/posts");
  const studio = await import("@/lib/instagram/ai-studio");
  const { generateContent } = await import("@/lib/instagram/ai");
  const { saveStudioSettings, getStudioSettings, allowedCaptionDomains } = await import("@/lib/instagram/config");
  const batch = await import("@/lib/instagram/batch");
  const sel = await import("@/lib/instagram/selection");
  const trends = await import("@/lib/instagram/trends");
  const metrics = await import("@/lib/instagram/metrics");
  const scopeDb = await import("@/lib/instagram/scope");
  const presets = await import("@/lib/instagram/presets");
  const { REVIEW_CHECKLIST } = await import("@/lib/instagram/quality");
  const { saveAiSettings } = await import("@/lib/ai-settings");

  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: "igmaster" } });
  const actorId = admin.id;
  await saveStudioSettings({ instagramHandle: "mocktestseries.in", telegramUrl: "https://t.me/mocktestseries_fixture" });
  await saveAiSettings({ askAiEnabled: true });
  await prisma.setting.deleteMany({ where: { key: { in: ["api.anthropic", "ai.gateway", "instagram.scope", "instagram.designPresets"] } } });
  await prisma.instagramBatch.deleteMany({});
  await prisma.instagramReference.deleteMany({});
  await prisma.instagramInsightReport.deleteMany({});
  await cfg.saveClaudeKey(mockKey("valid"));
  await cfg.saveClaudeSettings({ enabled: true });
  const IG = ["ig_carousel", "ig_trap", "ig_diagram", "ig_caption", "ig_trends", "ig_competitors"] as const;
  await gw.saveGatewayConfig({ routes: Object.fromEntries(IG.map((f) => [f, { mode: "custom", primary: "anthropic", timeoutMs: 20000, maxRetries: 0 }])) });

  const q = (code: string) => prisma.question.findUniqueOrThrow({ where: { code } });
  const GOOD = ["IGFIX-RUHS21-W01", "IGFIX-RUHS19-W01", "IGFIX-RUHS19-W02", "IGFIX-RUHS21-W05", "IGFIX-RPSC24I-W01"];
  const goodIds = await Promise.all(GOOD.map(async (c) => (await q(c)).id));
  await prisma.instagramPost.deleteMany({ where: { questionId: { in: goodIds } } });

  // A NEET UG exam + PYQ question that the studio must refuse.
  const ug = await prisma.exam.upsert({ where: { code: "IGFIX-NEETUG" }, update: {}, create: { name: "IGFIX Neet UG", code: "IGFIX-NEETUG", isActive: true } });
  const ruhs = await prisma.exam.findUniqueOrThrow({ where: { code: "IGFIX-RUHS" } });
  const goodQ = await q("IGFIX-RUHS21-W01");
  const ugPaper = await prisma.previousYearPaper.upsert({ where: { id: "igfixneetugpaper0001" }, update: {}, create: { id: "igfixneetugpaper0001", examId: ug.id, title: "IGFIX NEET UG 2024", year: 2024 } }).catch(() => prisma.previousYearPaper.findFirstOrThrow({ where: { examId: ug.id } }));
  const ugQ = await prisma.question.upsert({
    where: { code: "IGFIX-NEETUG-Q1" },
    update: {},
    create: { code: "IGFIX-NEETUG-Q1", examId: ug.id, subjectId: goodQ.subjectId, previousYearPaperId: ugPaper.id, text: "Powerhouse of the cell is:", status: "PUBLISHED", options: { create: [{ label: "A", text: "Mitochondria", isCorrect: true, order: 0 }, { label: "B", text: "Ribosome", isCorrect: false, order: 1 }] } },
  });

  console.log("\n--- D. Exam scope (DB) ---");
  await check("NEET UG question: createDraft refused; fixture MO exams in scope", async () => {
    const ids = await scopeDb.eligibleExamIds();
    assert.ok(ids.has(ruhs.id));
    assert.ok(!ids.has(ug.id));
    const e = await thrown(() => posts.createDraft({ questionId: ugQ.id, series: "PYQ", stats: null, actorId }));
    assert.ok(e instanceof posts.StudioError && /exam scope/.test(e.message));
  });
  await check("custom scope: excluded exams can't be enabled; going back to automatic works", async () => {
    await scopeDb.saveScope([ruhs.id, ug.id]);
    const { exams, mode } = await scopeDb.listScopedExams();
    assert.equal(mode, "custom");
    assert.equal(exams.find((e) => e.id === ug.id)?.eligible, false);
    assert.equal(exams.find((e) => e.code === "IGFIX-RPSC")?.eligible, false);
    await scopeDb.saveScope(null);
    assert.equal((await scopeDb.listScopedExams()).mode, "auto");
  });

  console.log("\n--- E. Single post: full AI Studio flow through Claude (mock) ---");
  let postId = "";
  await check("create draft → carousel text (Claude) incl. pearls & mistakes; origin = anthropic", async () => {
    const { post } = await posts.createDraft({ questionId: goodIds[0], series: "PYQ", stats: null, actorId, design: T.defaultDesign("hw-doctor", 7) });
    postId = post.id;
    assert.equal(post.design.template, "hw-doctor");
    const s = await getStudioSettings();
    const out = await generateContent({ snapshot: post.snapshot, series: "PYQ", stats: null, current: post.content, targets: [...T.CONTENT_FIELDS], reference: null, allowedDomains: allowedCaptionDomains(s), actorId, provider: "anthropic" });
    assert.equal(out.content.origin.provider, "anthropic");
    assert.ok(out.content.pearls.length >= 3 && out.content.mistakes.length >= 2);
    const saved = await posts.applyChange({ postId, expectedRevision: post.revision, content: out.content, note: "AI", actorId });
    assert.equal(saved.revision, 2);
  });
  const gen = studio.gatewayGenerator({ actorId, provider: null });
  await check("diagram via gateway (ig_diagram → Claude): stored on the post, reviewed=false, never in the Question Bank", async () => {
    const p = await posts.getPostDto(postId);
    const qBefore = JSON.stringify(await prisma.question.findUnique({ where: { id: goodIds[0] }, include: { options: true } }));
    const r = await studio.generateDiagram({ snapshot: p.snapshot, content: p.content, kind: "auto", gen });
    assert.equal(r.content.diagram?.kind, "mechanism");
    assert.equal(r.content.diagram?.reviewed, false);
    assert.equal(r.content.diagram?.origin?.provider, "anthropic");
    await posts.applyChange({ postId, expectedRevision: p.revision, content: r.content, note: "diagram", actorId });
    const r2 = await studio.generateDiagram({ snapshot: p.snapshot, content: r.content, kind: "comparison", gen });
    assert.equal(r2.content.diagram?.kind, "comparison");
    assert.equal(JSON.stringify(await prisma.question.findUnique({ where: { id: goodIds[0] }, include: { options: true } })), qBefore);
  });
  await check("examiner trap via gateway: validated, blind re-solve agrees, status draft; source question unchanged", async () => {
    const p = await posts.getPostDto(postId);
    const before = await prisma.question.count();
    const r = await studio.generateTrap({ snapshot: p.snapshot, content: p.content, gen });
    assert.equal(r.content.trap?.status, "draft");
    assert.equal(r.content.trap?.correct, "B");
    assert.equal(r.content.trap?.tempting, "A");
    assert.equal(r.content.trap?.checks.find((c) => c.code === "BLIND_SOLVE")?.ok, true);
    assert.equal(await prisma.question.count(), before, "no Question Bank rows created");
    await posts.applyChange({ postId, expectedRevision: p.revision, content: r.content, note: "trap", actorId });
  });
  await check("blind re-solve disagreement is flagged (wrongsolve key)", async () => {
    const p = await posts.getPostDto(postId);
    await cfg.saveClaudeKey(mockKey("wrongsolve"));
    await cfg.saveClaudeSettings({ enabled: true });
    const r = await studio.generateTrap({ snapshot: p.snapshot, content: p.content, gen });
    assert.equal(r.content.trap?.checks.find((c) => c.code === "BLIND_SOLVE")?.ok, false);
    assert.match(r.summary, /need your attention/);
    await cfg.saveClaudeKey(mockKey("valid"));
    await cfg.saveClaudeSettings({ enabled: true });
  });
  await check("captions via gateway: 3 versions, NEET UG hashtag/keyword stripped, empty caption filled", async () => {
    const p = await posts.getPostDto(postId);
    const s = await getStudioSettings();
    const r = await studio.generateCaptions({ snapshot: p.snapshot, content: { ...p.content, caption: "" }, evidence: [], allowedDomains: allowedCaptionDomains(s), websiteLabel: s.websiteLabel, gen });
    assert.deepEqual(r.content.captionVariants.map((v) => v.style), ["professional", "hook", "search"]);
    assert.ok(r.content.captionVariants.every((v) => !v.hashtags.includes("#NEETUG")));
    assert.ok(!r.content.keywords.some((k) => /neet ug/i.test(k)));
    assert.equal(r.content.captionStyle, "professional");
    await posts.applyChange({ postId, expectedRevision: p.revision, content: r.content, note: "captions", actorId });
  });
  await check("Ready flow: blocked until trap approved + diagram reviewed; then READY", async () => {
    let p = await posts.getPostDto(postId);
    const all = Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.key, true]));
    let r = await posts.markReady({ postId, expectedRevision: p.revision, checklist: all, acknowledged: p.issues.filter((i) => i.severity === "warning").map((i) => i.code), actorId });
    assert.ok(r.blocked.some((b) => b.code === "TRAP_UNAPPROVED"));
    assert.ok(r.blocked.some((b) => b.code === "DIAGRAM_UNREVIEWED"));
    p = await posts.getPostDto(postId);
    const content = { ...p.content, trap: { ...p.content.trap!, status: "approved" as const }, diagram: { ...p.content.diagram!, reviewed: true } };
    p = await posts.applyChange({ postId, expectedRevision: p.revision, content, note: "approve", actorId });
    p = await posts.setQuestionNumber(postId, p.revision, 1, true, actorId);
    const errs = p.issues.filter((i) => i.severity === "error");
    assert.deepEqual(errs.map((e) => e.code), []);
    r = await posts.markReady({ postId, expectedRevision: p.revision, checklist: all, acknowledged: p.issues.filter((i) => i.severity === "warning").map((i) => i.code), actorId });
    assert.equal(r.post.status, "READY", JSON.stringify(r.blocked));
  });
  await check("switching design (handwritten ↔ professional) never changes the medical content", async () => {
    const p = await posts.getPostDto(postId);
    const r = await posts.applyChange({ postId, expectedRevision: p.revision, design: { ...p.design, template: "navy-premium" }, note: "design", actorId, confirmReplaceApproved: true });
    assert.deepEqual(r.content, p.content);
    assert.equal(r.status, "DRAFT", "a Ready post that changes goes back to Draft");
  });

  console.log("\n--- F. Bulk Studio + attended queue (Meta mock) ---");
  let batchId = "";
  await check("smart selection: in-scope exam only, transparent score parts that add up", async () => {
    const r = await sel.selectCandidates({ examId: ruhs.id, published: "any", limit: 50 });
    assert.ok(r.candidates.length >= 5);
    for (const c of r.candidates) {
      const sum = c.parts.reduce((a, p) => a + p.points, 0) - (c.blockers.length ? 30 : 0);
      assert.equal(c.score, Math.max(0, sum));
      assert.ok(c.parts.every((p) => p.points <= p.max && p.why));
    }
    assert.ok(r.candidates.find((c) => c.code === "IGFIX-RUHS21-W03")?.blockers.some((b) => /images/.test(b)));
    assert.equal((await sel.selectCandidates({ examId: ug.id })).candidates.length, 0);
  });
  await check("createBatch: 5 separate posts, mixed designs; existing drafts reused (no duplicates)", async () => {
    const ids = goodIds.slice(1);
    await prisma.instagramPost.deleteMany({ where: { questionId: { in: ids } } });
    const r = await batch.createBatch({ name: "Fixture batch", examId: ruhs.id, questionIds: [goodIds[0], ...ids], template: "default", perQuestion: { [ids[0]]: "hw-colorful" }, actorId });
    batchId = r.batchId;
    const v = await batch.getBatchView(batchId);
    assert.equal(v.items.length, 5);
    assert.equal(new Set(v.items.map((i) => i.postId)).size, 5);
    assert.equal(v.items.find((i) => i.questionId === ids[0])?.post?.design.template, "hw-colorful");
    assert.equal(v.items[0].postId, postId, "existing draft reused");
    const e = await thrown(() => batch.createBatch({ name: "x", examId: null, questionIds: Array.from({ length: 21 }, (_, i) => `q${i}xxxxxxxxxxx`), template: "default", actorId }));
    assert.ok(e instanceof posts.StudioError);
  });
  await check("Apply Handwritten / Professional / Default to All (Ready posts skipped unless asked)", async () => {
    let r = await batch.applyDesignToBatch({ batchId, target: "handwritten", includeReady: false, actorId });
    let v = await batch.getBatchView(batchId);
    assert.ok(v.items.filter((i) => i.post?.status === "DRAFT").every((i) => T.modeOfTemplate(i.post!.design.template) === "handwritten"));
    r = await batch.applyDesignToBatch({ batchId, target: "professional", includeReady: false, actorId });
    v = await batch.getBatchView(batchId);
    assert.ok(v.items.filter((i) => i.post?.status === "DRAFT").every((i) => T.modeOfTemplate(i.post!.design.template) === "professional"));
    assert.ok(r.changed >= 4);
    await batch.applyDesignToBatch({ batchId, target: "hw-diagrams", postIds: [v.items[2].postId], includeReady: false, actorId });
    v = await batch.getBatchView(batchId);
    assert.equal(v.items[2].post?.design.template, "hw-diagrams", "individual override");
  });
  /** Makes every batch post Ready with simple manual content (no diagram/trap slide). */
  async function readyAll() {
    const v = await batch.getBatchView(batchId);
    const all = Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.key, true]));
    for (const it of v.items) {
      let p = it.post!;
      if (p.status !== "DRAFT") continue;
      const content = { ...p.content, hookText: "Can You Solve This PYQ?", explanation: "Short fixture explanation.", memoryTrick: "Trick.", caption: `Fixture ${p.questionCode} ${crypto.randomUUID().slice(0, 6)}\nComment your answer.`, hashtags: ["#MOExam"], origin: { kind: "manual" as const }, aiFlags: [] };
      p = await posts.applyChange({ postId: p.id, expectedRevision: p.revision, content, design: T.defaultDesign(p.design.template, 4), note: "fixture", actorId });
      p = await posts.setQuestionNumber(p.id, p.revision, 1, true, actorId);
      const r = await posts.markReady({ postId: p.id, expectedRevision: p.revision, checklist: all, acknowledged: p.issues.filter((i) => i.severity === "warning").map((i) => i.code), actorId });
      assert.equal(r.post.status, "READY", `${p.questionCode}: ${JSON.stringify(r.blocked.map((b) => b.code))}`);
    }
  }
  await check("queue: refused while publishing switch is OFF; Draft posts can't be queued", async () => {
    await setPublishingSwitch(false, actorId);
    const v = await batch.getBatchView(batchId);
    const e = await thrown(() => batch.confirmQueue({ batchId, postIds: v.items.map((i) => i.postId), actorId }));
    assert.ok(e instanceof posts.StudioError && /turned off/.test(e.message));
    await setPublishingSwitch(true, actorId);
    const e2 = await thrown(() => batch.confirmQueue({ batchId, postIds: v.items.map((i) => i.postId), actorId }));
    assert.ok(e2 instanceof posts.StudioError && /Ready/.test(e2.message));
  });
  async function drive(maxSteps = 60) {
    for (let i = 0; i < maxSteps; i++) {
      const { view, started } = await batch.advanceQueue({ batchId, actorId });
      if (started) await runPublishJob(started.postId, started.job.leaseId);
      if (view.batch.status !== "QUEUE_RUNNING") return view;
      await new Promise((r) => setTimeout(r, 250));
    }
    return batch.getBatchView(batchId);
  }
  await check("confirmed queue publishes each post exactly once, spaced, then COMPLETE", async () => {
    await readyAll();
    const v = await batch.getBatchView(batchId);
    const pick = v.items.slice(0, 3).map((i) => i.postId);
    const c = await batch.confirmQueue({ batchId, postIds: pick, actorId });
    assert.equal(c.batch.status, "QUEUE_RUNNING");
    const end = await drive();
    assert.equal(end.batch.status, "COMPLETE");
    const done = end.items.filter((i) => i.queueState === "DONE");
    assert.equal(done.length, 3);
    const state = (await realFetch(`${graphBase}/__mock/state`).then((r) => r.json())) as { media: { caption: string }[] };
    for (const it of done) assert.equal(state.media.filter((m) => m.caption.includes(it.post!.questionCode)).length, 1, "published once");
    assert.ok(end.items.filter((i) => !pick.includes(i.postId)).every((i) => i.queueState === "NONE"));
  });
  await check("advance is idempotent: repeated calls never start a second publish of the same post", async () => {
    const before = ((await realFetch(`${graphBase}/__mock/state`).then((r) => r.json())) as { media: unknown[] }).media.length;
    for (let i = 0; i < 3; i++) await batch.advanceQueue({ batchId, actorId });
    const after = ((await realFetch(`${graphBase}/__mock/state`).then((r) => r.json())) as { media: unknown[] }).media.length;
    assert.equal(after, before);
  });
  await check("a failure pauses the queue; FAILED = nothing published; Safe Retry; Stop Pending skips the rest", async () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = mockToken("procerror");
    const v = await batch.getBatchView(batchId);
    const rest = v.items.filter((i) => i.post?.status === "READY").map((i) => i.postId);
    assert.equal(rest.length, 2);
    await batch.confirmQueue({ batchId, postIds: rest, actorId });
    const end = await drive();
    assert.equal(end.batch.status, "QUEUE_PAUSED");
    const failed = end.items.find((i) => i.queueState === "FAILED");
    assert.ok(failed, "one item failed");
    assert.equal(end.items.filter((i) => rest.includes(i.postId) && i.queueState === "QUEUED").length, 1, "next one still queued (paused)");
    process.env.INSTAGRAM_ACCESS_TOKEN = mockToken("valid");
    const retried = await batch.retryItem({ batchId, itemId: failed!.id, actorId });
    assert.equal(retried.items.find((i) => i.id === failed!.id)?.queueState, "QUEUED");
    const stopped = await batch.setQueueStatus({ batchId, action: "stop", actorId });
    assert.equal(stopped.batch.status, "QUEUE_STOPPED");
    assert.ok(stopped.items.filter((i) => rest.includes(i.postId)).every((i) => i.queueState === "SKIPPED"));
  });
  await check("pause / resume; resume refused while an item is UNCERTAIN; Check Instagram status resolves it", async () => {
    const v = await batch.getBatchView(batchId);
    const item = v.items.find((i) => i.post?.status === "READY" || i.post?.status === "FAILED")!;
    await prisma.instagramBatchItem.update({ where: { id: item.id }, data: { queueState: "UNCERTAIN" } });
    await prisma.instagramBatch.update({ where: { id: batchId }, data: { status: "QUEUE_PAUSED" } });
    const e = await thrown(() => batch.setQueueStatus({ batchId, action: "resume", actorId }));
    assert.ok(e instanceof posts.StudioError && /unclear/.test(e.message));
    const after = await batch.checkItemStatus({ batchId, itemId: item.id, actorId });
    assert.notEqual(after.items.find((i) => i.id === item.id)?.queueState, "PUBLISHING");
    await prisma.instagramBatchItem.update({ where: { id: item.id }, data: { queueState: "SKIPPED" } });
    const resumed = await batch.setQueueStatus({ batchId, action: "resume", actorId });
    assert.equal(resumed.batch.status, "QUEUE_RUNNING");
    const paused = await batch.setQueueStatus({ batchId, action: "pause", actorId });
    assert.equal(paused.batch.status, "QUEUE_PAUSED");
  });

  console.log("\n--- G. Metrics + analytics ---");
  await check("metrics: unsupported metrics stay null with a reason; engagement from real numbers only", async () => {
    const published = await prisma.instagramPost.findFirstOrThrow({ where: { status: "PUBLISHED", igMediaId: { not: null } } });
    const fake = {
      mediaCounts: async () => ({ ok: true as const, body: { id: published.igMediaId!, like_count: 40, comments_count: 5 } }),
      mediaInsights: async (_id: string, ms: string[]) =>
        ms.length > 1
          ? { ok: false as const, kind: "http" as const, httpStatus: 400, code: 100, subcode: null, message: "(#100) views is not supported" }
          : ms[0] === "views"
            ? { ok: false as const, kind: "http" as const, httpStatus: 400, code: 100, subcode: null, message: "(#100) views is not supported for this media" }
            : { ok: true as const, body: { data: [{ name: ms[0], values: [{ value: ms[0] === "reach" ? 1000 : 7 }] }] } },
    };
    const row = await metrics.refreshPostMetrics(published.id, fake);
    assert.equal(row.views, null);
    assert.equal(row.reach, 1000);
    assert.equal(row.saves, 7);
    assert.ok((row.unavailable as Record<string, string>).views);
    assert.equal(metrics.engagementRate({ views: null, reach: 1000, likes: 40, comments: 5, saves: 7, shares: 7 }), 5.9);
    const e = await thrown(() => metrics.refreshPostMetrics(published.id, fake));
    assert.ok(e instanceof posts.StudioError && /10 minutes/.test(e.message));
    const perf = await metrics.listPublishedPerformance();
    const mine = perf.find((p) => p.postId === published.id);
    assert.equal(mine?.engagement, 5.9);
    const byMode = metrics.compareBy(perf, "designMode");
    assert.ok(byMode.length >= 1 && byMode.every((g) => g.posts >= 1));
    const draft = await prisma.instagramPost.findFirstOrThrow({ where: { status: { not: "PUBLISHED" } } });
    assert.ok((await thrown(() => metrics.refreshPostMetrics(draft.id, fake))) instanceof posts.StudioError);
  });

  console.log("\n--- H. Trends & Competitors (evidence only) ---");
  await check("references + evidence: sourced, timestamped; NEET UG topics skipped", async () => {
    await prisma.instagramReference.createMany({
      data: [
        { kind: "POST", handle: "comp.one", topic: "Antiepileptics", format: "carousel", captionStyle: "question hook", keywords: ["mo exam"], likes: 900, comments: 40, observedAt: new Date(), examTags: ["RUHS MO"], createdById: actorId },
        { kind: "POST", handle: "comp.two", topic: "NEET UG biology", format: "reel", likes: 5000, observedAt: new Date(), examTags: [], keywords: [], createdById: actorId },
        { kind: "HANDLE", handle: "comp.one", examTags: ["RUHS MO"], keywords: [], createdById: actorId },
      ],
    });
    const ev = await trends.getTrendEvidence({ examId: ruhs.id });
    assert.ok(ev.some((e) => e.kind === "REFERENCE" && /comp\.one/.test(e.summary) && e.source.startsWith("Manually entered") && e.observedAt));
    assert.ok(!ev.some((e) => /NEET UG/i.test(e.summary)));
    assert.ok(ev.some((e) => e.kind === "PLATFORM" && /previous-year-paper questions/.test(e.summary)));
    assert.ok(ev.some((e) => e.kind === "OWN_PERFORMANCE"));
    assert.equal(trends.BUSINESS_DISCOVERY_STATUS.configured, false);
  });
  await check("trend analysis keeps only items citing real evidence ids", async () => {
    const r = await trends.runTrendAnalysis({ actorId, examId: ruhs.id, examName: "IGFIX RUHS MO" });
    const res = r.result as unknown as { evidenceBacked: { evidence: string[] }[]; emerging: unknown[]; dropped: number };
    assert.equal(res.evidenceBacked.length, 1);
    assert.equal(res.emerging.length, 0);
    assert.ok(res.dropped >= 1);
    await cfg.saveClaudeKey(mockKey("trendlies"));
    await cfg.saveClaudeSettings({ enabled: true });
    const lies = await trends.runTrendAnalysis({ actorId, examId: ruhs.id, examName: null });
    assert.equal((lies.result as unknown as { evidenceBacked: unknown[] }).evidenceBacked.length, 0, "invented evidence ids are dropped");
    await cfg.saveClaudeKey(mockKey("valid"));
    await cfg.saveClaudeSettings({ enabled: true });
  });
  await check("competitor analysis: deterministic stats + only cited observations kept", async () => {
    const stats = await trends.getCompetitorStats();
    assert.equal(stats.totalPosts, 2);
    assert.ok(stats.formats.some((f) => f.format === "carousel"));
    const r = await trends.runCompetitorAnalysis({ actorId });
    const res = r.result as unknown as { contentGaps: { evidence: string[] }[] };
    assert.equal(res.contentGaps.length, 1, "uncited idea dropped");
  });

  console.log("\n--- I. Presets ---");
  await check("design presets: save (validated), replace by name, delete; cap enforced", async () => {
    const p = await presets.savePreset({ name: "Pharma notes", template: "hw-colorful", overrides: { accent: "#123456", font: "kalam" }, questionScale: 3 });
    assert.equal(p.questionScale, 1.25);
    await presets.savePreset({ name: "pharma NOTES", template: "navy-premium" });
    const list = await presets.listPresets();
    assert.equal(list.length, 1);
    assert.equal(list[0].template, "navy-premium");
    assert.ok((await thrown(() => presets.savePreset({ name: "x", template: "nope" }))) !== null);
    await presets.deletePreset(list[0].id);
    assert.equal((await presets.listPresets()).length, 0);
  });

  await check("no request ever left the loopback mocks", () => assert.deepEqual(stray, []));

  // cleanup
  await prisma.instagramBatch.deleteMany({});
  await prisma.instagramReference.deleteMany({});
  await prisma.instagramInsightReport.deleteMany({});
  await prisma.instagramPostMetric.deleteMany({});
  await prisma.instagramPost.deleteMany({ where: { questionId: { in: [...goodIds, ugQ.id] } } });
  await prisma.questionOption.deleteMany({ where: { questionId: ugQ.id } });
  await prisma.question.delete({ where: { id: ugQ.id } });
  await prisma.previousYearPaper.deleteMany({ where: { examId: ug.id } });
  await prisma.exam.delete({ where: { id: ug.id } });
  await prisma.setting.deleteMany({ where: { key: { in: ["api.anthropic", "ai.gateway", "instagram.scope", "instagram.designPresets"] } } });
  await setPublishingSwitch(false, actorId);
  anth.close();
  graph.close();
  media.close();
  globalThis.fetch = realFetch;
  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
