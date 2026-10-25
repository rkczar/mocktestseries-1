/**
 * Motion Workflow Studio — regression: pure logic + end-to-end with REAL renders.
 *
 * Pure part: styles, storyboard parsing (Question Bank trust), re-planning,
 * timing and word alignment, safe zones, QA checks, the frame template
 * (escaping / CSP), the Skill Library (Generator selection unchanged).
 * End-to-end part: MOTION jobs through the real worker and the isolated
 * render container against the LOCAL OpenRouter mock (script JSON, a WAV
 * "narration" that carries its text, a transcription that returns those words
 * with times). Every outbound fetch must be loopback: no paid request is
 * possible. Scratch database (*igstudio*) and scratch folder only.
 *
 *   set -a; . ./.env; set +a
 *   VIDEO_STUDIO_DIR=/root/mts-scratch/video-studio/video-jobs SHOTS=/root/mts-scratch/video-studio/shots/motion \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-motion-studio.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
if (!(process.env.VIDEO_STUDIO_DIR ?? "").startsWith("/root/mts-scratch/")) {
  console.error("Refusing to run: VIDEO_STUDIO_DIR must be a /root/mts-scratch/ folder.");
  process.exit(2);
}
const SHOTS = process.env.SHOTS ?? "/root/mts-scratch/video-studio/shots/motion";
const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 3197);
process.env.OPENROUTER_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.FX_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.VIDEO_STUDIO_DISABLE_KICK = "1";

const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outbound.push(url);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error(`blocked non-loopback request: ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}\n        → ${(e instanceof Error ? (e.stack ?? e.message) : String(e)).split("\n").slice(0, 4).join("\n          ")}`);
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
const docker = (dir: string, args: string[], entry: string) =>
  execFileSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${dir}:/w:ro`, "--entrypoint", entry, "mts-video-render:1", ...args], { maxBuffer: 64 * 1024 * 1024 });
const frameAt = (file: string, sec: number) => docker(path.dirname(file), ["-v", "error", "-ss", String(sec), "-i", `/w/${path.basename(file)}`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], "ffmpeg");
const ffprobe = (file: string) => JSON.parse(docker(path.dirname(file), ["-v", "error", "-show_streams", "-show_format", "-of", "json", `/w/${path.basename(file)}`], "ffprobe").toString()) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string } };

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const styles = await import("@/lib/video-studio/motion/styles");
  const sb = await import("@/lib/video-studio/motion/storyboard");
  const qa = await import("@/lib/video-studio/motion/quality");
  const tpl = await import("@/lib/video-studio/motion/template");
  const skills = await import("@/lib/video-studio/skills");

  console.log("\nA. Styles, skills");
  await check("six styles, each with a motion set, a transition and readable contrast", () => {
    assert.equal(styles.MOTION_STYLES.length, 6);
    for (const s of styles.MOTION_STYLES) {
      assert.ok(s.motions.length >= 2, s.key);
      assert.ok((styles.TRANSITIONS as readonly string[]).includes(s.transition.type), s.key);
      const c = styles.contrastRatio(s.palette.text, s.palette.background);
      assert.ok(c !== null && c >= 4.5, `${s.key} contrast ${c}`);
    }
  });
  await check("Skill Library: motion Skills are in the one registry, the Generator never offers them, every `extends` exists", () => {
    const motion = skills.VIDEO_SKILLS.filter((s) => s.module === "motion");
    assert.ok(motion.length >= 16);
    assert.equal(new Set(skills.VIDEO_SKILLS.map((s) => s.key)).size, skills.VIDEO_SKILLS.length, "unique keys");
    assert.ok(skills.selectableSkills().every((s) => !s.module));
    assert.ok(skills.normalizeSkillKeys(motion.map((s) => s.key), true).every((k) => !skills.SKILL_MAP[k].module));
    assert.ok(skills.recommendedSkillKeys("teach_topic", true).every((k) => !skills.SKILL_MAP[k].module));
    for (const s of motion) if (s.extends) assert.ok(skills.SKILL_MAP[s.extends] && !skills.SKILL_MAP[s.extends].module, `${s.key} extends ${s.extends}`);
    const keys = skills.motionSkillKeys(["medical_teacher", "talking_head_editor"], true);
    assert.ok(keys.includes("motion_quality_checker") && keys.includes("medical_fact_checker") && keys.includes("medical_teacher") && !keys.includes("talking_head_editor"));
    assert.ok(!skills.motionSkillKeys([], false).includes("medical_fact_checker"), "fact checker only for medical videos");
  });

  console.log("\nB. Storyboard model");
  const Q = { id: "q".repeat(25), code: "Q-1", stem: "Most specific marker of MI?", options: [{ label: "A", text: "Myoglobin" }, { label: "B", text: "Troponin I" }], correctLabel: "B", explanation: null };
  const cfg = { language: "hinglish" as const, styleKey: "level_up", targetSec: 40 };
  await check("sentences split on . ! ? and the Devanagari danda; tiny pieces join the previous sentence", () => {
    assert.deepEqual(sb.splitSentences("Troponin I सबसे specific है। CK-MB भी. Ok! Myoglobin सबसे पहले बढ़ता है?"), ["Troponin I सबसे specific है।", "CK-MB भी. Ok!", "Myoglobin सबसे पहले बढ़ता है?"]);
  });
  await check("parse: question frames take stem/options/answer from the Question Bank only; unknown ids become statements", () => {
    const p = sb.parseMotionAnswer(
      {
        frames: [
          { sentence: "Hook sentence here please.", onScreen: "Hook", highlight: "Hook", motion: "pop", visual: { type: "statement" } },
          { sentence: "Answer this question now.", onScreen: "Boss", motion: "flip", visual: { type: "question", questionId: Q.id, revealAtSec: 4, correctLabel: "A", stem: "FAKE" } },
          { sentence: "Unknown question here.", onScreen: "X", visual: { type: "question", questionId: "z".repeat(25) } },
          { sentence: "Practice on MockTestSeries.in today.", onScreen: "Practice", visual: { type: "steps", items: ["a"] } },
        ],
      },
      cfg,
      [Q],
      []
    );
    const q = p.frames[1].visual;
    assert.equal(q.type, "question");
    assert.equal(q.correctLabel, "B");
    assert.equal(q.stem, Q.stem);
    assert.equal(p.frames[2].visual.type, "statement");
    assert.equal(p.frames[3].visual.type, "cta", "last frame forced to CTA");
    assert.ok(p.warnings.some((w) => /not supplied/.test(w)));
  });
  await check("parse: motions outside the style are replaced; the same motion never repeats when avoidable; highlight must occur in the frame", () => {
    const p = sb.parseMotionAnswer({ frames: Array.from({ length: 4 }, (_, i) => ({ sentence: `Sentence number ${i} about Troponin.`, onScreen: `Troponin fact ${i}`, highlight: "Banana", motion: "ken_burns", visual: { type: "statement" } })) }, cfg, [], []);
    const style = styles.MOTION_STYLE_MAP.level_up;
    for (const [i, f] of p.frames.entries()) {
      assert.ok(style.motions.includes(f.visual.motion), f.visual.motion);
      if (i) assert.notEqual(f.visual.motion, p.frames[i - 1].visual.motion);
      assert.ok(`${f.onScreen} ${f.sentence}`.includes(f.visual.highlight), f.visual.highlight);
    }
  });
  await check("free re-plan: one frame per sentence, numbers → count-up stat, edited frames kept, last frame CTA-ready", () => {
    const script = "Heart attack के बाद कौन सा marker पहले बढ़ता है? Troponin I 6 घंटे में बढ़ता है। Myoglobin, CK-MB और Troponin तीन markers हैं। MockTestSeries.in पर practice कीजिए।";
    const f = sb.planStoryboard(script, cfg);
    assert.equal(f.length, 4);
    assert.equal(f[1].visual.type, "stat");
    assert.equal(f[1].visual.value, "6");
    assert.equal(f[2].visual.type, "steps");
    // Devanagari matras survive (के / को are vowel signs, not punctuation) and Hindi stop words are dropped.
    const hi = sb.planStoryboard("55 साल के patient को सीने में तेज़ दर्द है। MockTestSeries.in पर practice कीजिए।", cfg);
    assert.equal(hi[0].onScreen, "55 साल patient सीने तेज़", hi[0].onScreen);
    const kept = sb.planStoryboard(script, cfg, [{ ...f[0], onScreen: "EDITED" }]);
    assert.equal(kept[0].onScreen, "EDITED");
  });
  await check("estimated timing: frames back to back, words inside their frame and in order, scaled to the take length", () => {
    const t = sb.estimateTiming(["एक दो तीन चार।", "Five six seven eight nine ten."], "hinglish", 12, "estimated");
    assert.equal(t.frames[0].start, 0);
    assert.equal(t.frames[0].end, t.frames[1].start);
    assert.ok(Math.abs(t.totalSec - 12) < 0.01);
    let prev = -1;
    for (const w of t.words) {
      const fr = t.frames[w.frame];
      assert.ok(w.start >= fr.start && w.end <= fr.end + 1e-6 && w.start >= prev);
      prev = w.start;
    }
  });
  await check("precise alignment: transcribed word times drive frame boundaries; a poor match falls back to the estimate", () => {
    const sentences = ["Troponin I सबसे specific है।", "CK-MB reinfarction में useful है।"];
    const words = ["Troponin", "I", "सबसे", "specific", "है।", "CK-MB", "reinfarction", "में", "useful", "है।"].map((w, i) => ({ word: w, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5 }));
    const t = sb.alignTiming(sentences, words, 6, "hinglish");
    assert.equal(t.mode, "precise");
    assert.ok(Math.abs(t.frames[1].start - (3 - 0.12)) < 0.01, JSON.stringify(t.frames));
    assert.equal(t.words.find((w) => w.text === "reinfarction")?.start, 3.5);
    const bad = sb.alignTiming(sentences, [{ word: "lorem", start: 0, end: 1 }, { word: "ipsum", start: 1, end: 2 }], 6, "hinglish");
    assert.equal(bad.mode, "estimated");
  });
  await check("safe zone 9:16 = 65 px sides, 269 px top, 672 px bottom", () => {
    const z = sb.safeZone("9:16");
    assert.deepEqual([z.side, z.top, z.bottom], [65, 269, 672]);
  });

  console.log("\nC. Quality checks and the frame template");
  await check("QA: flags two ideas, missing highlight, look-alike frames, unsupported glyphs, missing CTA, non-QB questions", () => {
    const v = (o: Partial<import("@/lib/video-studio/motion/storyboard").MotionVisual>) => ({ kind: "motion" as const, type: "steps" as const, motion: "pop" as const, highlight: "x", tag: null, ...o });
    const frames = [
      { sentence: "a b c", onScreen: "one two three four five six seven eight nine", visual: v({ highlight: "zzz" }), durationSec: 2, needsReview: false, reviewNote: null },
      { sentence: "d e f 😀", onScreen: "x", visual: v({}), durationSec: 2, needsReview: false, reviewNote: null },
      { sentence: "g h", onScreen: "x", visual: v({ type: "question", motion: "flip", revealAtSec: 3, correctLabel: null }), durationSec: 2, needsReview: true, reviewNote: "?" },
    ];
    const c = qa.storyboardChecks({ styleKey: "level_up", targetSec: 40, language: "en", aspect: "9:16" }, frames, null, (t) => (t.includes("😀") ? ["😀"] : []));
    const st = (k: string) => c.find((x) => x.key === k)?.status;
    assert.equal(st("one_idea"), "warn");
    assert.equal(st("highlight"), "warn");
    assert.equal(st("variety"), "warn");
    assert.equal(st("glyphs"), "fail");
    assert.equal(st("questions"), "fail");
    assert.equal(st("cta"), "warn");
    assert.equal(st("review"), "warn");
  });
  await check("template: text escaped, no <script>, CSP with font-src only, one span per spoken word, the highlight marked once", () => {
    const html = tpl.motionFrameDocument(
      { sentence: "Troponin <b>I</b>", onScreen: "Troponin <script>x</script>", visual: { kind: "motion", type: "statement", motion: "pop", highlight: "Troponin", tag: null } },
      { aspect: "9:16", styleKey: "big_sentence", index: 0, all: [{ onScreen: "a", tag: null }], durationSec: 3, words: [{ text: "Troponin", start: 0.2, end: 0.6 }, { text: "<b>I</b>", start: 0.7, end: 1 }], subtitles: true, brand: { wordmark: "MockTestSeries.in", examLabel: null, showBranding: true, cta: "" }, fontBase: "http://render.local/fonts/", fontOrigin: "http://render.local" }
    );
    assert.ok(!/<script/i.test(html));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("default-src &#39;none&#39;") || html.includes("default-src 'none'"));
    assert.equal((html.match(/class="w( hw)?"/g) ?? []).length, 2);
    assert.equal((html.match(/<mark /g) ?? []).length, 1);
    assert.ok(/--h:0\.20s/.test(html), "highlight lands when the word is spoken");
  });
  await check("every style renders every frame type without throwing (map camera, levels HUD, case file, calendar, cards, photo)", () => {
    for (const s of styles.MOTION_STYLES)
      for (const type of sb.FRAME_TYPES) {
        const html = tpl.motionFrameDocument({ sentence: "Plaque rupture फिर thrombus।", onScreen: "MI pathway", visual: { kind: "motion", type, motion: s.motions[0], highlight: "pathway", tag: "Level 1", nodes: ["A", "B", "C"], items: ["A", "B"], value: "6", left: "L", right: "R", stem: "Q?", options: [{ label: "A", text: "x" }, { label: "B", text: "y" }], correctLabel: "B", revealAtSec: 1 } }, { aspect: "16:9", styleKey: s.key, index: 1, all: [{ onScreen: "a", tag: null }, { onScreen: "b", tag: null }, { onScreen: "c", tag: null }], durationSec: 3, words: [], subtitles: true, brand: { wordmark: "M", examLabel: null, showBranding: true, cta: "" }, imageSrc: null, fontBase: "/f/", fontOrigin: "http://x" });
        assert.ok(html.startsWith("<!doctype html>"), `${s.key}/${type}`);
      }
  });

  // ---- end to end ---------------------------------------------------------------------------
  const { startMockOpenRouter, mockKey } = await import("./mock-openrouter.mjs");
  const mock = await startMockOpenRouter(PORT);
  const { prisma } = await import("@/lib/prisma");
  const settings = await import("@/lib/ai-engine/settings");
  const cfgLib = await import("@/lib/ai-engine/config");
  const catalog = await import("@/lib/ai-engine/catalog");
  const voices = await import("@/lib/video-studio/voices");
  const vs = await import("@/lib/video-studio/settings");
  const pipeline = await import("@/lib/video-studio/pipeline");
  const mj = await import("@/lib/video-studio/motion/jobs");
  const jobsLib = await import("@/lib/video-studio/jobs");
  const assetsLib = await import("@/lib/video-studio/assets");
  const storage = await import("@/lib/video-studio/storage");
  const { VOICE_FIXTURE } = await import("./video-studio-fixture");
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { username: "igmaster" } });
  const worker = () => pipeline.runVideoWorker(10 * 60_000);
  const reload = (id: string) => prisma.videoJob.findUniqueOrThrow({ where: { id }, include: { scenes: { orderBy: { index: "asc" } } } });
  const mcfg = async (id: string) => (await reload(id)).config as unknown as import("@/lib/video-studio/motion/storyboard").MotionConfig & { take?: { key: string; sec: number; hash: string }; renderQa?: { key: string; status: string }[] };
  const VOICE = { model: "microsoft/mai-voice-2.1", voice: "hi-IN-Kavya:MAI-Voice-2.1" };

  console.log("\nD. Fixture (scratch, loopback mock)");
  await prisma.videoJob.deleteMany({ where: { kind: "MOTION" } });
  await settings.saveOpenRouterKey(mockKey("ok"));
  await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('enabled', true) WHERE "key" = 'api.openrouter'`;
  await catalog.syncCatalog();
  await prisma.aiModel.update({ where: { id: "mockai/cheap" }, data: { approved: true, medicallyApproved: true } });
  await settings.saveFeatureConfig("video_script", cfgLib.normalizeFeatureConfig({ ...cfgLib.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "cheapest" }));
  const fixtureFetch = (async (url: string) => new Response(JSON.stringify(String(url).includes("transcription") ? { data: [{ id: "openai/whisper-large-v3", name: "Whisper large v3", pricing: { prompt: "0.0001", completion: "0" } }] } : VOICE_FIXTURE), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await voices.syncVoiceCatalog(fixtureFetch);
  await voices.setApprovedSpeechModels(["microsoft/mai-voice-2.1"]);
  await vs.saveVideoSettings({ ...(await vs.getVideoSettings()), transcriptionModel: "openai/whisper-large-v3" });
  const hb = await pipeline.writeHeartbeat();
  await check("render worker available (image + FFmpeg + Chromium)", () => assert.equal(hb.ok, true, hb.error ?? ""));
  const q = await prisma.question.findFirstOrThrow({ where: { status: "PUBLISHED", parentQuestionId: null, options: { some: { isCorrect: true } } }, select: { id: true, options: { select: { label: true, isCorrect: true } } } });
  const stored = q.options.filter((o) => o.isCorrect);

  console.log("\nE. AI script + storyboard → one-take narration → precise sync → MP4 (9:16, Level Up)");
  let id = "";
  await check("create: MCQ explainer needs a question; empty input refused; config locked to one style", async () => {
    assert.ok(await thrown(() => mj.createMotionJob({ videoType: "mcq_explainer", topic: "x" }, admin.id)));
    assert.ok(await thrown(() => mj.createMotionJob({ videoType: "medical_explainer" }, admin.id)));
    const j = await mj.createMotionJob({ videoType: "exam_prep", topic: "Cardiac markers", questionIds: [q.id], targetSec: 40 }, admin.id);
    id = j.id;
    assert.equal(j.kind, "MOTION");
    assert.equal((j.config as { styleKey: string }).styleKey, "level_up");
  });
  await check("script: estimate → wrong quote refused → confirm → ONE paid call → storyboard with the stored answer and a flagged frame", async () => {
    const chat = mock.stats.chat;
    const quote = await mj.requestMotionEstimate(id, admin.id);
    assert.ok(quote.runnable, quote.blockReason ?? "");
    assert.equal(mock.stats.chat, chat, "estimating is free");
    assert.ok(await thrown(() => mj.confirmMotionScript(id, "x".repeat(25), admin.id)));
    await mj.confirmMotionScript(id, quote.id, admin.id);
    assert.ok(await thrown(() => mj.confirmMotionScript(id, quote.id, admin.id)), "a quote is consumed once");
    await worker();
    const j = await reload(id);
    assert.equal(j.status, "REVIEW_REQUIRED", `${j.failedStage}: ${j.errorMessage}`);
    assert.equal(mock.stats.chat, chat + 1);
    const qf = j.scenes.find((s) => (s.visual as { type?: string }).type === "question");
    assert.ok(qf, "boss frame");
    assert.equal((qf!.visual as { correctLabel: string | null }).correctLabel, stored.length === 1 ? stored[0].label.trim() : null);
    assert.ok(j.scenes.some((s) => s.needsReview));
    assert.equal((j.scenes.at(-1)!.visual as { type: string }).type, "cta");
    const style = styles.MOTION_STYLE_MAP.level_up;
    assert.ok(j.scenes.every((s) => style.motions.includes((s.visual as { motion: never }).motion)));
  });
  await check("frame edits are validated: emoji refused; the question keeps its stored answer; mark reviewed", async () => {
    const j = await reload(id);
    assert.ok(await thrown(() => mj.updateMotionFrame(id, j.scenes[0].id, { sentence: "Hello 😀 world." }, admin.id)));
    const qf = j.scenes.find((s) => (s.visual as { type?: string }).type === "question")!;
    await mj.updateMotionFrame(id, qf.id, { visual: { type: "question", correctLabel: "A", stem: "HACKED" } }, admin.id);
    const after = (await prisma.videoScene.findUniqueOrThrow({ where: { id: qf.id } })).visual as { stem: string; correctLabel: string | null };
    assert.notEqual(after.stem, "HACKED");
    assert.equal(after.correctLabel, stored.length === 1 ? stored[0].label.trim() : null);
    for (const s of (await reload(id)).scenes.filter((x) => x.needsReview)) await mj.updateMotionFrame(id, s.id, { reviewed: true }, admin.id);
    const checks = await mj.motionChecks(await prisma.videoJob.findUniqueOrThrow({ where: { id } }));
    assert.equal(checks.filter((c) => c.status === "fail").length, 0, JSON.stringify(checks.filter((c) => c.status === "fail")));
  });
  await check("narration: estimate is free; changing a sentence invalidates it; precise sync priced with the transcription", async () => {
    const speech = mock.stats.speech;
    const p1 = await mj.estimateMotionVoice(id, { ...VOICE, sync: "precise" }, admin.id);
    assert.ok(p1.runnable && p1.stt && p1.totalInr > p1.estInr, JSON.stringify(p1));
    const s0 = (await reload(id)).scenes[0];
    await mj.updateMotionFrame(id, s0.id, { sentence: `${s0.narration.replace(/\?$/, "")} — जल्दी बताइए?` }, admin.id);
    assert.ok(await thrown(() => mj.confirmMotionVoice(id, p1.nonce, admin.id)), "stale script refused");
    assert.equal(mock.stats.speech, speech);
  });
  await check("confirmed: ONE speech call for the whole script + ONE transcription → precise word timing → real MP4", async () => {
    const [speech, stt] = [mock.stats.speech, mock.stats.transcriptions];
    const p = await mj.estimateMotionVoice(id, { ...VOICE, sync: "precise" }, admin.id);
    await mj.confirmMotionVoice(id, p.nonce, admin.id);
    await worker();
    const j = await reload(id);
    assert.equal(j.status, "COMPLETED", `${j.failedStage}: ${j.errorMessage}`);
    assert.equal(mock.stats.speech - speech, 1, "one take");
    assert.equal(mock.stats.transcriptions - stt, 1, "one transcription");
    const c = await mcfg(id);
    assert.equal(c.timing?.mode, "precise");
    assert.ok(c.take && c.take.sec > 10);
    const file = await storage.resolveJobPath(id, j.outputKey!, true);
    const pr = ffprobe(file);
    const v = pr.streams.find((s) => s.codec_type === "video");
    assert.equal(`${v?.width}x${v?.height}`, "1080x1920");
    assert.equal(pr.streams.find((s) => s.codec_type === "audio")?.codec_name, "aac");
    assert.ok(Math.abs(Number(pr.format.duration) - c.timing!.totalSec) < 0.7, `${pr.format.duration} vs ${c.timing!.totalSec}`);
    assert.ok(c.renderQa?.every((x) => x.status === "pass"), JSON.stringify(c.renderQa));
    await writeFile(path.join(SHOTS, "E-levelup.mp4"), await readFile(file));
    for (const [i, f] of c.timing!.frames.entries()) await writeFile(path.join(SHOTS, `E-levelup-f${i + 1}.png`), frameAt(file, Math.min(f.end - 0.15, f.start + Math.max(1.2, (f.end - f.start) * 0.75))));
    console.log(`        ${Number(pr.format.duration).toFixed(1)} s, ${j.scenes.length} frames, rendered in ${Math.round((j.renderMs ?? 0) / 1000)} s`);
  });
  await check("free re-render and a style + aspect switch (Concept Map, 16:9): no new paid calls, 1920×1080", async () => {
    const [speech, stt, chat] = [mock.stats.speech, mock.stats.transcriptions, mock.stats.chat];
    await mj.updateMotionConfig(id, { styleKey: "concept_map", aspect: "16:9" }, admin.id);
    const j0 = await reload(id);
    assert.ok(j0.scenes.every((s) => styles.MOTION_STYLE_MAP.concept_map.motions.includes((s.visual as { motion: never }).motion)), "frames re-locked to the new style");
    await mj.rerenderMotion(id, admin.id);
    await worker();
    const j = await reload(id);
    assert.equal(j.status, "COMPLETED", `${j.failedStage}: ${j.errorMessage}`);
    assert.deepEqual([mock.stats.speech, mock.stats.transcriptions, mock.stats.chat], [speech, stt, chat]);
    const file = await storage.resolveJobPath(id, j.outputKey!, true);
    const v = ffprobe(file).streams.find((s) => s.codec_type === "video");
    assert.equal(`${v?.width}x${v?.height}`, "1920x1080");
    const c = await mcfg(id);
    await writeFile(path.join(SHOTS, "E-conceptmap-16x9.mp4"), await readFile(file));
    for (const i of [1, 2, c.timing!.frames.length - 1]) {
      const f = c.timing!.frames[i];
      await writeFile(path.join(SHOTS, `E-conceptmap-f${i + 1}.png`), frameAt(file, f.start + Math.min(1.6, (f.end - f.start) * 0.7)));
    }
  });

  await check("a free re-render never records new narration: with the take file missing it fails safely, zero speech calls", async () => {
    const c = await mcfg(id);
    const { rm } = await import("node:fs/promises");
    await rm(await storage.resolveJobPath(id, c.take!.key, true));
    await prisma.videoJob.update({ where: { id }, data: { config: { ...c, timing: null } as never } });
    const speech = mock.stats.speech;
    await mj.rerenderMotion(id, admin.id);
    await worker();
    const j = await reload(id);
    assert.equal(j.status, "FAILED");
    assert.match(j.errorMessage ?? "", /never records new narration/);
    assert.equal(mock.stats.speech, speech);
  });

  console.log("\nF. Your own script (free) → silent render (free)");
  let own = "";
  await check("own script → storyboard without AI; silent render → MP4; zero paid calls", async () => {
    const [chat, speech, stt] = [mock.stats.chat, mock.stats.speech, mock.stats.transcriptions];
    const j = await mj.createMotionJob({ videoType: "revision_reel", topic: "Time course of cardiac markers", styleKey: "time_course", aspect: "9:16", targetSec: 25 }, admin.id);
    own = j.id;
    await mj.planFromScript(own, "क्या आप markers की timeline जानते हैं? Myoglobin 2 घंटे में बढ़ता है। Troponin I 6 घंटे में बढ़ता है। CK-MB 3 दिन में normal हो जाता है। MockTestSeries.in पर revise कीजिए।", admin.id);
    const r = await reload(own);
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.equal(r.scenes.length, 5);
    assert.equal((r.scenes[1].visual as { type: string }).type, "stat");
    await mj.renderMotionSilent(own, admin.id);
    await worker();
    const d = await reload(own);
    assert.equal(d.status, "COMPLETED", `${d.failedStage}: ${d.errorMessage}`);
    assert.deepEqual([mock.stats.chat, mock.stats.speech, mock.stats.transcriptions], [chat, speech, stt]);
    assert.equal((await mcfg(own)).timing?.mode, "reading");
    const file = await storage.resolveJobPath(own, d.outputKey!, true);
    await writeFile(path.join(SHOTS, "F-timecourse.mp4"), await readFile(file));
    const t = (await mcfg(own)).timing!;
    for (const i of [0, 1, 3]) await writeFile(path.join(SHOTS, `F-timecourse-f${i + 1}.png`), frameAt(file, t.frames[i].start + Math.min(1.8, (t.frames[i].end - t.frames[i].start) * 0.8)));
  });

  console.log("\nG. Photo Story needs images; failures are reported and retried");
  await check("Photo Story without an image fails at render with a clear error; after an upload, Retry completes", async () => {
    const j = await mj.createMotionJob({ videoType: "promo", topic: "Practice daily", styleKey: "photo_story", targetSec: 20 }, admin.id);
    await mj.planFromScript(j.id, "रोज़ practice से confidence आता है। हर दिन एक mock test दीजिए। MockTestSeries.in पर आज शुरू कीजिए।", admin.id);
    await mj.renderMotionSilent(j.id, admin.id);
    await worker();
    let r = await reload(j.id);
    assert.equal(r.status, "FAILED");
    assert.ok(/needs at least one uploaded image/.test(r.errorMessage ?? ""), r.errorMessage ?? "");
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer();
    const job = await prisma.videoJob.findUniqueOrThrow({ where: { id: j.id } });
    const plan = await assetsLib.startUpload({ job, actorId: admin.id, name: "study.png", size: png.length });
    await assetsLib.putChunk({ jobId: j.id, uploadId: plan.uploadId, actorId: admin.id, index: 0, bytes: png });
    await assetsLib.completeUpload({ job: await prisma.videoJob.findUniqueOrThrow({ where: { id: j.id } }), uploadId: plan.uploadId, actorId: admin.id });
    await mj.retryMotion(j.id, admin.id);
    await worker();
    r = await reload(j.id);
    assert.equal(r.status, "COMPLETED", `${r.failedStage}: ${r.errorMessage}`);
    await writeFile(path.join(SHOTS, "G-photostory-f1.png"), frameAt(await storage.resolveJobPath(j.id, r.outputKey!, true), 2));
  });

  console.log("\nH. Safety");
  await check("AI emergency stop blocks the narration; cancelling a queued script makes no paid call", async () => {
    const eng = await settings.getEngineConfig();
    await settings.saveBudgets({ ...eng.budgets, emergencyStop: true });
    try {
      const p = await mj.estimateMotionVoice(own, { ...VOICE, sync: "estimated" }, admin.id);
      assert.equal(p.runnable, false);
      assert.ok(await thrown(() => mj.confirmMotionVoice(own, p.nonce, admin.id)));
    } finally {
      await settings.saveBudgets(eng.budgets);
    }
    const j = await mj.createMotionJob({ topic: "Cancel me" }, admin.id);
    const quote = await mj.requestMotionEstimate(j.id, admin.id);
    await mj.confirmMotionScript(j.id, quote.id, admin.id);
    const chat = mock.stats.chat;
    await jobsLib.cancelJob(j.id, admin.id);
    await worker();
    assert.equal((await reload(j.id)).status, "CANCELLED");
    assert.equal(mock.stats.chat, chat);
  });
  await check("motion actions refuse Generator / Editor jobs, and Generator stages refuse motion jobs", async () => {
    const g = await prisma.videoJob.findFirst({ where: { kind: { not: "MOTION" } } });
    if (g) assert.ok(await thrown(() => mj.updateMotionConfig(g.id, { styleKey: "level_up" }, admin.id)));
    const stages = await import("@/lib/video-studio/stages");
    assert.ok(await thrown(() => stages.renderSilent(own, admin.id)));
  });
  await check("every outbound request went to the loopback mock", () => {
    assert.ok(outbound.length > 0);
    assert.ok(outbound.every((u) => u.startsWith(`http://127.0.0.1:${PORT}/`)), outbound.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}/`)).join(", "));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  mock.server.close();
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
