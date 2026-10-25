/**
 * AI Video Studio — library regression (Phase 1). Runs against the LOCAL
 * OpenRouter + FX mock (scripts/mock-openrouter.mjs); every outbound fetch is
 * asserted to be loopback, so no paid request is possible. Runs only on an
 * *igstudio* scratch database (seed + scripts/ig-studio-fixture.ts setup first)
 * with VIDEO_STUDIO_DIR pointing at a scratch folder.
 *
 *   set -a; . ./.env; set +a
 *   VIDEO_STUDIO_DIR=/root/mts-scratch/video-studio/video-jobs \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-video-studio.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { startMockOpenRouter, mockKey } from "./mock-openrouter.mjs";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
const ROOT = process.env.VIDEO_STUDIO_DIR ?? "";
if (!ROOT.startsWith("/root/mts-scratch/")) {
  console.error("Refusing to run: VIDEO_STUDIO_DIR must be a /root/mts-scratch/ folder.");
  process.exit(2);
}
const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 3194);
process.env.OPENROUTER_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.FX_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;

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

const ENGINE_KEYS = ["api.openrouter", "ai.engine", "ai.fx", "ai.gateway", "ai.settings", "api.gemini", "api.openai", "api.anthropic", "video.studio", "video.voices", "video.worker"];

async function main() {
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push(url);
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error(`BLOCKED non-loopback fetch: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;

  const mock = await startMockOpenRouter(PORT);
  await prisma.setting.deleteMany({ where: { key: { in: ENGINE_KEYS } } });
  await prisma.aiGatewayCall.deleteMany({});
  await prisma.aiBudgetReservation.deleteMany({});
  await prisma.aiCostQuote.deleteMany({});
  await prisma.aiModel.deleteMany({});
  await prisma.videoJob.deleteMany({});
  await prisma.videoSkillPreset.deleteMany({});
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("@/lib/permissions");
  const text = await import("@/lib/video-studio/text");
  const quality = await import("@/lib/video-studio/quality");
  const tpl = await import("@/lib/video-studio/template");
  const designs = await import("@/lib/video-studio/designs");
  const skills = await import("@/lib/video-studio/skills");
  const storage = await import("@/lib/video-studio/storage");
  const jobs = await import("@/lib/video-studio/jobs");
  const autocfg = await import("@/lib/video-studio/autoconfig");
  const voices = await import("@/lib/video-studio/voices");
  const vsettings = await import("@/lib/video-studio/settings");
  const settings = await import("@/lib/ai-engine/settings");
  const cfg = await import("@/lib/ai-engine/config");
  const catalog = await import("@/lib/ai-engine/catalog");
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { username: "igmaster" } });
  const other = await prisma.adminUser.findFirstOrThrow({ where: { username: "igfull" } });

  console.log("\nA. Permissions");
  await check("MASTER_ADMIN holds VIEW, USE and MANAGE", () => {
    for (const k of [PERMISSIONS.VIDEO_STUDIO_VIEW, PERMISSIONS.VIDEO_STUDIO_USE, PERMISSIONS.VIDEO_STUDIO_MANAGE]) assert.ok(DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(k));
  });
  await check("FULL_ADMIN holds VIEW only; TEACHER nothing", () => {
    assert.ok(DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.VIDEO_STUDIO_VIEW));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.VIDEO_STUDIO_USE));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.VIDEO_STUDIO_MANAGE));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.TEACHER.some((k) => k.startsWith("video-studio")));
  });

  console.log("\nB. Hindi / Devanagari text handling");
  const HINDI = "क्षत्रिय प्रधानमंत्री हृदय द्विपक्षीय श्रृंखला ट्रेन कुर्सी";
  await check("conjuncts are single graphemes (क्ष, त्रि, द्वि, श्रृं are never split)", () => {
    assert.equal(text.graphemeCount("क्ष"), 1);
    assert.equal(text.graphemeCount("द्वि"), 1);
    assert.equal(text.graphemeCount("श्रृं"), 1);
    assert.ok(text.graphemeCount("क्षत्रिय") <= 4);
  });
  await check("word count works for Devanagari, Latin and Hinglish", () => {
    assert.equal(text.wordCount(HINDI), 7);
    assert.equal(text.wordCount("Myocardial infarction में troponin बढ़ता है।"), 6);
    assert.equal(text.scriptMix("Myocardial infarction में troponin बढ़ता है।"), "mixed");
    assert.equal(text.scriptMix(HINDI), "devanagari");
  });
  await check("subtitle lines never start with a combining mark and rejoin to the original", () => {
    const long = `${HINDI} ${HINDI} 2026 में Myocardial Infarction (हृदयाघात), ECG और troponin — 3 घंटे के अंदर!`;
    const lines = text.subtitleLines(long, 20);
    assert.ok(lines.length > 2);
    for (const l of lines) assert.ok(!/^\p{M}/u.test(l), `line starts with a mark: ${l}`);
    assert.equal(lines.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
    for (const l of lines) assert.ok(text.graphemeCount(l) <= 20 || !l.includes(" "), `line too long: ${l}`);
  });
  await check("cue timing covers the scene exactly", () => {
    const cues = text.timeCues(["एक दो तीन", "four five", "छह"], 1, 6);
    assert.equal(cues[0].startSec, 1);
    assert.equal(cues.at(-1)!.endSec, 7);
  });
  const glyphs = await import("@/lib/video-studio/glyphs");
  await check("glyph check uses the real font tables: ₹ · ° α → ↓ Devanagari digits OK; emoji and uncovered arrows refused", () => {
    assert.deepEqual(glyphs.unsupportedVideoChars("₹500 · 37°C · α-blocker → ↓ ठीक ३ क्ष"), []);
    assert.equal(glyphs.unsupportedVideoChars("great 😀").length, 1);
    assert.equal(glyphs.unsupportedVideoChars("⇶").length, 1);
  });

  console.log("\nC. Hook Scorer + Video Quality Checker");
  await check("Devanagari greeting is caught (no ASCII \\b bug)", () => {
    const r = quality.scoreHook("नमस्ते दोस्तों, आज हम MI पढ़ेंगे", "hinglish");
    assert.ok(r.flags.some((f) => f.includes("greeting")));
    assert.ok(r.flags.some((f) => f.includes("instead of the topic")));
  });
  await check("Latin greeting and 'in this video' are caught", () => {
    const r = quality.scoreHook("Hello guys, in this video we learn MI", "en");
    assert.equal(r.verdict, "weak");
  });
  await check("a direct, specific question hook scores strong", () => {
    const r = quality.scoreHook("क्या आप जानते हैं 90% MI में troponin पहले बढ़ता है?", "hinglish");
    assert.equal(r.verdict, "strong", JSON.stringify(r));
  });
  await check("over-long hook is flagged", () => {
    const r = quality.scoreHook("This is a very long opening line that keeps going and going without ever getting to the point at all", "en");
    assert.ok(r.flags.some((f) => f.includes("3 seconds")));
  });
  await check("script check: on-screen > 6 words, emoji, Latin-only Hindi narration, empty narration", () => {
    const rep = quality.checkScript(
      [
        { narration: "क्या आप जानते हैं troponin सबसे specific है?", onScreenText: "one two three four five six seven" },
        { narration: "Troponin sabse specific marker hai aur ye exam mein aata hai", onScreenText: "Troponin 😀" },
        { narration: "", onScreenText: "x" },
      ],
      "hinglish",
      30
    );
    assert.equal(rep.ok, false);
    assert.ok(rep.errors.some((e) => e.includes("cannot draw")));
    assert.ok(rep.errors.some((e) => e.includes("no narration")));
    assert.ok(rep.warnings.some((w) => w.includes("On-screen text has 7 words")));
    assert.ok(rep.warnings.some((w) => w.includes("Devanagari")));
  });

  console.log("\nD. Scene template (preview = render)");
  const theme = designs.DESIGN_MAP.medical_classroom.theme;
  const brand = { wordmark: "MockTestSeries.in", examLabel: "NEET PG", showBranding: true, cta: "" };
  await check("HTML injection in scene text is escaped; CSP forbids scripts and network", () => {
    const doc = tpl.sceneDocument(
      { narration: `<script>alert(1)</script>`, onScreenText: `"><img src=x onerror=alert(1)>`, visual: { kind: "bullets", title: "</style><script>x()</script>", items: ["<b>bold</b>"] }, durationSec: 4 },
      { aspect: "9:16", theme, brand, subtitles: true, fontBase: "/video-studio/fonts/", fontOrigin: "https://example.test" }
    );
    assert.ok(!/<script/i.test(doc));
    assert.ok(!/<img/i.test(doc));
    assert.ok(doc.includes("&lt;script&gt;"));
    assert.ok(doc.includes(`default-src &#39;none&#39;`));
    assert.ok(!doc.includes("script-src"));
  });
  await check("every ready design renders every aspect it claims, with Devanagari intact", () => {
    for (const d of designs.readyDesigns()) {
      for (const a of d.aspects) {
        const doc = tpl.sceneDocument({ narration: HINDI, onScreenText: "हृदय", visual: { kind: "diagram", nodes: ["क्षति", "Thrombus"] }, durationSec: 5 }, { aspect: a, theme: d.theme, brand, subtitles: true, fontBase: "/f/", fontOrigin: "file:" });
        assert.ok(doc.includes("क्षति") && doc.includes("श्रृंखला"), `${d.key} ${a}`);
      }
    }
  });
  await check("malicious theme values never reach CSS (overrides validated)", () => {
    const t = designs.applyOverrides(theme, { accent: "red;}</style><script>", background: "url(//evil)", motion: "explode" });
    assert.equal(t.accent, theme.accent);
    assert.equal(t.background, theme.background);
    assert.equal(t.motion, theme.motion);
  });
  await check("question scenes reveal ONLY the stored correct option; null answer reveals nothing", () => {
    const opts = { aspect: "9:16" as const, theme, brand, subtitles: false, fontBase: "/f/", fontOrigin: "file:" };
    const q = (correctLabel: string | null) =>
      tpl.sceneDocument({ narration: "x", onScreenText: "", visual: { kind: "question", stem: "Q", options: [{ label: "A", text: "a" }, { label: "B", text: "b" }], correctLabel, revealAtSec: 2 }, durationSec: 5 }, opts);
    assert.equal((q("B").match(/class="a correct"/g) ?? []).length, 1);
    assert.equal((q(null).match(/correct"/g) ?? []).length, 0);
  });

  console.log("\nE. Skill registry");
  await check("required Skills cannot be removed; unknown / unavailable keys are dropped", () => {
    const k = skills.normalizeSkillKeys(["hook_writer", "bogus", "paper_collage_director"], true);
    assert.ok(k.includes("medical_fact_checker") && k.includes("video_quality_checker") && k.includes("hook_writer"));
    assert.ok(!k.includes("bogus") && !k.includes("paper_collage_director"));
    assert.ok(!skills.normalizeSkillKeys([], false).includes("medical_fact_checker"), "fact checker is for medical videos");
  });
  await check("composed instructions carry versions", () => {
    const c = skills.composeSkillInstructions(["mcq_explainer", "medical_fact_checker"]);
    assert.deepEqual(c.versions, { mcq_explainer: 1, medical_fact_checker: 1 });
    assert.ok(c.text.includes("STORED CORRECT ANSWER is authoritative"));
  });

  console.log("\nF. Temporary storage safety");
  const jid = "c" + "a".repeat(24);
  await check("traversal, absolute paths and odd keys are refused", async () => {
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "..", "a//b", "A.MP4", "x/y/z/w.mp3", ""]) {
      assert.ok(await thrown(() => storage.resolveJobPath(jid, bad)), bad);
    }
    assert.ok(await thrown(() => storage.resolveJobPath("../../etc", "a.mp3")));
    const p = await storage.resolveJobPath(jid, "audio/scene-01.mp3");
    assert.equal(p, path.join(ROOT, jid, "audio/scene-01.mp3"));
  });
  await check("a planted symlink inside a job folder is refused", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "vs-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "s");
    await storage.ensureJobDir(jid);
    await symlink(outside, path.join(ROOT, jid, "audio"));
    assert.ok(await thrown(() => storage.resolveJobPath(jid, "audio/secret.txt", true)));
    assert.ok(await thrown(() => storage.resolveJobPath(jid, "audio/new.mp3")));
    await storage.deleteJobMedia(jid);
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "s", "deleting a job never follows links");
    await rm(outside, { recursive: true, force: true });
  });
  await check("a job folder that is itself a symlink is removed as a link only", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "vs-outside-"));
    await writeFile(path.join(outside, "keep.txt"), "k");
    await symlink(outside, path.join(ROOT, jid));
    await storage.deleteJobMedia(jid);
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "k");
    await rm(outside, { recursive: true, force: true });
  });

  console.log("\nG. Source validation");
  const exams = await prisma.exam.findMany({ take: 2, select: { id: true, name: true } });
  const questions = await prisma.question.findMany({ where: { status: "PUBLISHED" }, take: 6, select: { id: true, examId: true, options: { select: { isCorrect: true } } } });
  const base = { type: "topic", videoType: "teach_topic", audience: "neet_pg", language: "hinglish", topic: "Cardiac markers", aspect: "9:16", durationSec: 0 };
  await check("PDF / image sources parse, but Auto Configure is refused until the file is uploaded", async () => {
    assert.equal(jobs.parseSource({ ...base, type: "pdf", videoType: "pdf_to_video" }).type, "pdf");
    const j = await jobs.createJob({ source: { ...base, type: "pdf", videoType: "pdf_to_video" } }, admin.id);
    const e = await thrown(() => jobs.runAutoConfigure(j.id, admin.id));
    assert.ok(e && /Upload the PDF first/.test(e.message), e?.message);
    await prisma.videoJob.delete({ where: { id: j.id } });
  });
  await check("Explain an MCQ needs Question Bank questions; ids are validated", async () => {
    assert.ok(await thrown(async () => jobs.parseSource({ ...base, videoType: "explain_mcq" })));
    assert.ok(await thrown(async () => jobs.parseSource({ ...base, type: "questions", videoType: "explain_mcq", questionIds: ["'; drop table x"] })));
  });
  await check("durations are clamped; unknown fields ignored", () => {
    const s = jobs.parseSource({ ...base, durationSec: 9999, evil: true });
    assert.equal(s.durationSec, 180);
  });

  console.log("\nH. Auto Configure (free) without a configured AI provider");
  await check("no provider → script blocker in plain language, nothing paid", async () => {
    const c = await autocfg.autoConfigure({ source: jobs.parseSource(base), customPrompt: "Create a 60-second Hinglish teaching Reel about ECG in MI" });
    assert.equal(c.runnable, false);
    assert.ok(c.blockers[0].startsWith("Script:"));
    assert.equal(c.durationSec, 60, "duration from the prompt");
    assert.equal(c.designKey, "ecg_animation", "cardiology topic → ECG design");
    assert.equal(c.capabilities.find((x) => x.key === "voice")?.status, "missing");
    assert.equal(c.capabilities.find((x) => x.key === "render")?.status, "pending_approval");
    assert.ok(c.skillKeys.includes("medical_fact_checker"));
    assert.equal(c.examLabel, null, "no exam chosen → no label");
  });
  await check("exam label: from questions of ONE exam; none when they span exams", async () => {
    const sameExam = questions.filter((q) => q.examId === questions[0].examId).slice(0, 2);
    const one = await autocfg.autoConfigure({ source: jobs.parseSource({ ...base, type: "questions", videoType: "explain_mcq", questionIds: sameExam.map((q) => q.id) }), customPrompt: "" });
    assert.ok(one.examLabel);
    const examIds = new Set(questions.map((q) => q.examId));
    if (examIds.size > 1) {
      const mixed = [...examIds].map((e) => questions.find((q) => q.examId === e)!.id);
      const many = await autocfg.autoConfigure({ source: jobs.parseSource({ ...base, type: "questions", videoType: "explain_mcq", questionIds: mixed }), customPrompt: "" });
      assert.equal(many.examLabel, null);
    }
  });
  await check("exam picked by the admin becomes the label; the prompt's language hint never overrides the selection", async () => {
    const c = await autocfg.autoConfigure({ source: jobs.parseSource({ ...base, examId: exams[0].id, language: "en" }), customPrompt: "make it in Hinglish" });
    assert.equal(c.examLabel, exams[0].name);
    assert.equal(c.language, "en");
    assert.ok(c.reasons.some((r) => r.includes("is kept")));
  });

  console.log("\nI. Voice catalog (free read, injected fixture — no network)");
  const fixture = {
    data: [
      { id: "elevenlabs/eleven-multilingual-v2", name: "ElevenLabs: Eleven Multilingual v2", pricing: { prompt: "0.00008", completion: "0" }, supported_voices: ["george", "sarah"], description: "supports 29 languages" },
      { id: "microsoft/mai-voice-2.1", name: "Microsoft: MAI-Voice-2.1", pricing: { prompt: "0.000022", completion: "0" }, supported_voices: ["en-IN-Priya:MAI-Voice-2.1", "hi-IN-Kavya:MAI-Voice-2.1", "hi-IN-Arjun:MAI-Voice-2.1"], description: "15 languages" },
      { id: "google/gemini-3.8-flash-tts", name: "Gemini TTS", pricing: { prompt: "0.0000005", completion: "0.000009" }, supported_voices: ["Puck"], description: "" },
      { id: "bytedance-seed/seed-audio-1-0", name: "Seed Audio", pricing: { prompt: "0", completion: "0.0025" }, supported_voices: null, description: "" },
      { id: "bad id with spaces", name: "x", pricing: {} },
    ],
  };
  const fakeFetch = (async () => new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await check("sync parses price units honestly (per char / per second / unknown) and drops bad ids", async () => {
    const c = await voices.syncVoiceCatalog(fakeFetch);
    assert.equal(c.models.length, 4);
    const by = Object.fromEntries(c.models.map((m) => [m.id, m]));
    assert.equal(by["elevenlabs/eleven-multilingual-v2"].unit, "character");
    assert.equal(by["bytedance-seed/seed-audio-1-0"].unit, "second");
    assert.equal(by["google/gemini-3.8-flash-tts"].unit, "unknown", "token-priced audio cannot be estimated before generation");
    assert.equal(by["microsoft/mai-voice-2.1"].languages.hi, "locale");
    assert.equal(by["elevenlabs/eleven-multilingual-v2"].languages.hi, "multilingual");
  });
  await check("nothing approved → voice capability missing; approving a hi-IN model → ready with a hi-IN voice", async () => {
    assert.equal((await voices.speechCapability("hinglish")).check.status, "missing");
    await voices.setApprovedSpeechModels(["microsoft/mai-voice-2.1", "elevenlabs/eleven-multilingual-v2", "not/in-catalog"]);
    const p = await voices.speechCapability("hinglish");
    assert.equal(p.check.status, "ready");
    assert.equal(p.model, "microsoft/mai-voice-2.1", "locale voices beat multilingual even when pricier per char? (MAI is also cheaper here)");
    assert.ok(p.defaultVoiceId?.startsWith("hi-IN-"));
    const c = await voices.getVoiceCatalog();
    assert.ok(!c.approvedModels.includes("not/in-catalog"));
  });
  await check("re-sync keeps approvals of models still listed", async () => {
    const c = await voices.syncVoiceCatalog(fakeFetch);
    assert.deepEqual([...c.approvedModels].sort(), ["elevenlabs/eleven-multilingual-v2", "microsoft/mai-voice-2.1"]);
  });
  await check("speech cost: per character exact; unknown stays null (never ₹0)", async () => {
    const c = await voices.getVoiceCatalog();
    const mai = c.models.find((m) => m.id === "microsoft/mai-voice-2.1")!;
    assert.ok(Math.abs(voices.speechCostUsd(mai, 1000, 60).usd! - 0.022) < 1e-12);
    const gem = c.models.find((m) => m.id.startsWith("google/"))!;
    assert.equal(voices.speechCostUsd(gem, 1000, 60).usd, null);
  });

  console.log("\nJ. Job flow: configure → estimate → confirm (quote consumed once) → cancel");
  // OpenRouter through the local mock: key, catalog, one medically approved model, video_script routed to OpenRouter.
  await settings.saveOpenRouterKey(mockKey("ok"));
  await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('enabled', true) WHERE "key" = 'api.openrouter'`;
  await catalog.syncCatalog();
  await prisma.aiModel.update({ where: { id: "mockai/cheap" }, data: { approved: true, medicallyApproved: true } });
  await settings.saveFeatureConfig("video_script", cfg.normalizeFeatureConfig({ ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "cheapest" }));
  const callsBefore = await prisma.aiGatewayCall.count();
  const chatBefore = (await (await realFetch(`http://127.0.0.1:${PORT}/__mock/stats`)).json()).chat;

  let jobId = "";
  await check("create + Auto Configure → CONFIGURING, runnable, script on OpenRouter", async () => {
    const job = await jobs.createJob({ source: { ...base, examId: exams[0].id }, customPrompt: "45 second Hinglish reel" }, admin.id);
    jobId = job.id;
    const j = await jobs.runAutoConfigure(job.id, admin.id);
    assert.equal(j.status, "CONFIGURING");
    const c = j.config as unknown as { runnable: boolean; capabilities: { key: string; status: string; provider: string }[]; durationSec: number; speechModel: string };
    assert.equal(c.runnable, true, JSON.stringify(c));
    assert.ok(c.capabilities.find((x) => x.key === "script")?.provider.includes("mockai/cheap"));
    assert.equal(c.durationSec, 45);
    assert.equal(c.speechModel, "microsoft/mai-voice-2.1");
  });
  await check("confirm before an estimate is refused", async () => {
    const e = await thrown(() => jobs.confirmJob(jobId, admin.id, "x".repeat(25)));
    assert.match(e!.message, /Review the estimated price first/);
  });
  let quoteId = "";
  await check("estimate → AWAITING_CONFIRMATION with script INR, voice as a later stage, render at no provider charge", async () => {
    const j = await jobs.requestEstimate(jobId, admin.id);
    assert.equal(j.status, "AWAITING_CONFIRMATION");
    const est = j.estimate as unknown as import("@/lib/video-studio/jobs").JobEstimate;
    assert.equal(est.runnable, true, est.blockReason ?? "");
    assert.ok(est.quoteId);
    quoteId = est.quoteId!;
    const script = est.lines.find((l) => l.key === "script")!;
    assert.equal(script.state, "included");
    assert.ok(script.inr !== null && script.inr > 0);
    const voice = est.lines.find((l) => l.key === "voice")!;
    assert.equal(voice.state, "later");
    assert.ok(voice.inr !== null && voice.inr > 0);
    assert.equal(est.lines.find((l) => l.key === "render")!.inr, 0);
    assert.equal(est.totalInr, script.inr, "total covers only what this confirmation starts");
  });
  await check("editing the configuration invalidates the estimate and cancels its quote", async () => {
    await jobs.updateConfig(jobId, { durationSec: 50 }, admin.id);
    const j = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(j.status, "CONFIGURING");
    assert.equal(j.estimate, null);
    assert.equal((await prisma.aiCostQuote.findUniqueOrThrow({ where: { id: quoteId } })).status, "CANCELLED");
    const e = await thrown(() => jobs.confirmJob(jobId, admin.id, quoteId));
    assert.ok(e);
  });
  await check("config edits are validated (design/aspect/voice/exam label/music)", async () => {
    assert.ok(await thrown(() => jobs.updateConfig(jobId, { designKey: "paper_collage" }, admin.id)));
    assert.ok(await thrown(() => jobs.updateConfig(jobId, { aspect: "3:2" }, admin.id)));
    assert.ok(await thrown(() => jobs.updateConfig(jobId, { voiceId: "hi-IN-Kavya:MAI-Voice-2.1", speechModel: "google/gemini-3.8-flash-tts" }, admin.id)), "unapproved model");
    assert.ok(await thrown(() => jobs.updateConfig(jobId, { examLabel: "Made-up Exam 2099" }, admin.id)));
    await jobs.updateConfig(jobId, { music: true }, admin.id);
    assert.notEqual(((await prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } })).config as { music?: boolean }).music, true, "music only turns on with an uploaded licensed file (setMusic)");
    await jobs.updateConfig(jobId, { voiceId: "hi-IN-Arjun:MAI-Voice-2.1", speechModel: "microsoft/mai-voice-2.1", designKey: "minimal_editorial", examLabel: null }, admin.id);
    const c = (await prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } })).config as unknown as { voiceId: string; designKey: string; examLabel: string | null };
    assert.equal(c.voiceId, "hi-IN-Arjun:MAI-Voice-2.1");
    assert.equal(c.designKey, "minimal_editorial");
    assert.equal(c.examLabel, null);
  });
  await check("confirm with a stale / another admin's quote is refused", async () => {
    const j = await jobs.requestEstimate(jobId, admin.id);
    quoteId = (j.estimate as unknown as { quoteId: string }).quoteId;
    assert.ok(await thrown(() => jobs.confirmJob(jobId, admin.id, "z".repeat(25))));
    assert.ok(await thrown(() => jobs.confirmJob(jobId, other.id, quoteId)), "quote is bound to the admin who requested it");
  });
  await check("two simultaneous confirmations → exactly one succeeds; quote USED", async () => {
    const r = await Promise.allSettled([jobs.confirmJob(jobId, admin.id, quoteId), jobs.confirmJob(jobId, admin.id, quoteId)]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const j = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(j.status, "QUEUED");
    assert.deepEqual(j.quoteIds, [quoteId]);
    assert.equal((await prisma.aiCostQuote.findUniqueOrThrow({ where: { id: quoteId } })).status, "USED");
  });
  await check("no paid request was made by configure / estimate / confirm", async () => {
    assert.equal(await prisma.aiGatewayCall.count(), callsBefore);
    const chatAfter = (await (await realFetch(`http://127.0.0.1:${PORT}/__mock/stats`)).json()).chat;
    assert.equal(chatAfter, chatBefore);
  });
  await check("a queued job can no longer be edited, but can be cancelled; its media folder is removed", async () => {
    assert.ok(await thrown(() => jobs.updateConfig(jobId, { durationSec: 30 }, admin.id)));
    const dir = await storage.ensureJobDir(jobId);
    await writeFile(path.join(dir, "probe.txt"), "x");
    const j = await jobs.cancelJob(jobId, admin.id);
    assert.equal(j.status, "CANCELLED");
    assert.ok(j.mediaDeletedAt);
    assert.ok(await thrown(() => lstat(dir)), "folder removed");
    assert.ok(await thrown(() => jobs.cancelJob(jobId, admin.id)), "cannot cancel twice");
  });

  console.log("\nK. Disk headroom + cleanup policy");
  await check("new jobs are refused below the minimum free disk", async () => {
    await vsettings.saveVideoSettings({ minFreeDiskGb: 100 });
    const free = await storage.freeDiskBytes();
    const e = await thrown(() => jobs.createJob({ source: base }, admin.id));
    if (free < 100 * 1024 ** 3) assert.match(e!.message, /Not enough free disk space/);
    await vsettings.saveVideoSettings({});
  });
  await check("decideCleanup: retention policy — hard cap, cancelled, failed window, delivered/undelivered, review idle, abandoned drafts; leased jobs untouched", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const h = (n: number) => new Date(now.getTime() - n * 3600_000);
    const job = (id: string, o: Partial<{ status: string; leaseUntil: Date | null; deliveredAt: Date | null; finishedAt: Date | null; lastActivityAt: Date; expiresAt: Date | null; createdAt: Date }>) =>
      ({ id, status: "COMPLETED", leaseUntil: null, deliveredAt: null, finishedAt: null, lastActivityAt: now, expiresAt: null, mediaDeletedAt: null, createdAt: h(1), ...o }) as Parameters<typeof jobs.decideCleanup>[0][number];
    const out = jobs.decideCleanup(
      [
        job("leased", { status: "FAILED", finishedAt: h(500), leaseUntil: new Date(now.getTime() + 60_000) }),
        job("cancelled", { status: "CANCELLED" }),
        job("failed-old", { status: "FAILED", finishedAt: h(73) }),
        job("failed-new", { status: "FAILED", finishedAt: h(2) }),
        job("delivered-old", { deliveredAt: h(25) }),
        job("delivered-new", { deliveredAt: h(1) }),
        job("undelivered-old", { finishedAt: h(73) }),
        job("undelivered-new", { finishedAt: h(5) }),
        job("review-idle", { status: "REVIEW_REQUIRED", lastActivityAt: h(73) }),
        job("review-active", { status: "REVIEW_REQUIRED", lastActivityAt: h(3) }),
        job("draft-old", { status: "DRAFT", lastActivityAt: h(49) }),
        job("draft-new", { status: "CONFIGURING", lastActivityAt: h(2) }),
        job("running", { status: "RENDERING", lastActivityAt: h(100) }),
        job("capped-running", { status: "RENDERING", createdAt: h(24 * 14 + 1) }),
        job("capped-review", { status: "REVIEW_REQUIRED", createdAt: h(24 * 14 + 1) }),
        job("capped-draft", { status: "DRAFT", createdAt: h(24 * 14 + 1) }),
      ],
      { deliveredRetentionHours: 24, undeliveredRetentionHours: 72, abandonedAfterHours: 48, failedRetentionHours: 72, maxRetentionDays: 14 },
      now
    );
    const ids = out.map((c) => c.jobId).sort();
    assert.deepEqual(ids, ["cancelled", "capped-draft", "capped-review", "capped-running", "delivered-old", "draft-old", "failed-old", "review-idle", "undelivered-old"]);
    assert.equal(out.find((c) => c.jobId === "draft-old")!.abandon, true);
    assert.equal(out.find((c) => c.jobId === "capped-draft")!.abandon, true);
    assert.match(out.find((c) => c.jobId === "capped-running")!.reason, /maximum retention/);
  });
  await check("concurrent cleanup: two runCleanup calls at once both succeed (files vanishing mid-count are not errors)", async () => {
    const ids = ["cleanuprace00000000a1", "cleanuprace00000000b2"];
    for (const id of ids) {
      const dir = await storage.ensureJobDir(id);
      await mkdir(path.join(dir, "render/frames"), { recursive: true });
      for (let i = 0; i < 400; i++) await writeFile(path.join(dir, `render/frames/f${i}.jpg`), "x".repeat(64));
    }
    const r = await Promise.allSettled([jobs.runCleanup(null), jobs.runCleanup(null), jobs.runCleanup(null)]);
    assert.ok(r.every((x) => x.status === "fulfilled"), JSON.stringify(r.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason).slice(0, 120))));
  });
  await check("settings: retention values are clamped (failed ≤ 14 days, hard cap 1–30 days; never unlimited)", () => {
    const s = vsettings.parseVideoSettings({ failedRetentionHours: 99999, maxRetentionDays: 0 });
    assert.equal(s.failedRetentionHours, 24 * 14);
    assert.equal(s.maxRetentionDays, 1);
    assert.equal(vsettings.parseVideoSettings({}).maxRetentionDays, 14);
    assert.equal(vsettings.parseVideoSettings({ maxRetentionDays: 365 }).maxRetentionDays, 30);
  });

  await check("runCleanup: abandoned draft cancelled + quote cancelled; orphan folder deleted; stray entries untouched", async () => {
    const j = await jobs.createJob({ source: base }, admin.id);
    await jobs.runAutoConfigure(j.id, admin.id);
    const est = await jobs.requestEstimate(j.id, admin.id);
    const qid = (est.estimate as unknown as { quoteId: string }).quoteId;
    await prisma.videoJob.update({ where: { id: j.id }, data: { lastActivityAt: new Date(Date.now() - 49 * 3600_000) } });
    await storage.ensureJobDir(j.id);
    const orphan = "o".repeat(25);
    await mkdir(path.join(ROOT, orphan), { recursive: true });
    await writeFile(path.join(ROOT, orphan, "x.bin"), Buffer.alloc(2048));
    await writeFile(path.join(ROOT, "README-not-a-job.txt"), "keep me");
    const r = await jobs.runCleanup(admin.id);
    assert.ok(r.abandoned >= 1 && r.orphanFolders >= 1);
    assert.equal((await prisma.videoJob.findUniqueOrThrow({ where: { id: j.id } })).status, "CANCELLED");
    if (qid) assert.equal((await prisma.aiCostQuote.findUniqueOrThrow({ where: { id: qid } })).status, "CANCELLED");
    assert.ok(await thrown(() => lstat(path.join(ROOT, orphan))));
    assert.equal(await readFile(path.join(ROOT, "README-not-a-job.txt"), "utf8"), "keep me");
  });

  console.log("\nL. Isolation");
  await check("every outbound request went to the loopback mock", () => {
    assert.ok(outbound.every((u) => u.startsWith(`http://127.0.0.1:${PORT}/`)), outbound.filter((u) => !u.startsWith("http://127.0.0.1")).join(", "));
  });

  // Leave the scratch DB clean for the next run.
  await prisma.videoJob.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: { in: ENGINE_KEYS } } });
  await prisma.aiCostQuote.deleteMany({});
  await prisma.aiModel.deleteMany({});
  await rm(path.join(ROOT, "README-not-a-job.txt"), { force: true });
  await mock.close?.();
  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
