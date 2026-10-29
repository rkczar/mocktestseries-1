/**
 * AI Video Studio — end-to-end pipeline regression with REAL renders.
 *
 * Drives jobs through the real worker (lib/video-studio/pipeline.ts) and the
 * isolated render container (Docker image mts-video-render:1, --network none),
 * against the LOCAL OpenRouter mock (script JSON, WAV "narration", word-timed
 * transcription). Every outbound fetch is asserted to be loopback: no paid
 * request is possible. Scratch database (*igstudio*) and scratch folder only.
 *
 *   set -a; . ./.env; set +a
 *   VIDEO_STUDIO_DIR=/root/mts-scratch/video-studio/video-jobs SHOTS=/root/mts-scratch/video-studio/shots/pipeline \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-video-pipeline.ts
 *
 * Covers: topic → script → narration → MP4 (9:16); Question Bank MCQ → stored
 * answer only → MP4 (16:9); image upload → MP4; PDF upload → script from its
 * text; Hindi/Hinglish frames (Devanagari) saved for review; confirmation
 * gates, cancellation, retry, budget stop; the AI Video Editor (upload →
 * ingest → trim/split/overlay/subtitles → paid transcription confirm → export).
 * Leaves the scratch DB with the fixture state (re-run video-studio-fixture.ts
 * setup before the UI suite).
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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
const SHOTS = process.env.SHOTS ?? "/root/mts-scratch/video-studio/shots/pipeline";
const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 3196);
process.env.OPENROUTER_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.FX_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.VIDEO_STUDIO_DISABLE_KICK = "1";
// Own container label: this run never sweeps production renders, and production never sweeps these.
if (!process.env.VIDEO_RENDER_INSTANCE || process.env.VIDEO_RENDER_INSTANCE === "1") process.env.VIDEO_RENDER_INSTANCE = "scratch-test";

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
async function check(label: string, fn: () => Promise<void>) {
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

/** A minimal text PDF (one page per string), valid for pdf.js. */
function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const lines = text.split("\n").map((l, j) => `BT /F1 16 Tf 60 ${740 - j * 26} Td (${l.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** One frame of an MP4 as PNG, decoded in the render image (no network, read-only mount). */
function frameAt(file: string, sec: number): Buffer {
  return execFileSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${path.dirname(file)}:/w:ro`, "--entrypoint", "ffmpeg", "mts-video-render:1", "-v", "error", "-ss", String(sec), "-i", `/w/${path.basename(file)}`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 64 * 1024 * 1024 });
}

function ffprobe(file: string): { streams: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }[]; format: { duration: string } } {
  return JSON.parse(execFileSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${path.dirname(file)}:/w:ro`, "--entrypoint", "ffprobe", "mts-video-render:1", "-v", "error", "-show_streams", "-show_format", "-of", "json", `/w/${path.basename(file)}`], { encoding: "utf8" }));
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const { startMockOpenRouter, mockKey } = await import("./mock-openrouter.mjs");
  const mock = await startMockOpenRouter(PORT);
  const { prisma } = await import("@/lib/prisma");
  const settings = await import("@/lib/ai-engine/settings");
  const cfgLib = await import("@/lib/ai-engine/config");
  const catalog = await import("@/lib/ai-engine/catalog");
  const voices = await import("@/lib/video-studio/voices");
  const jobs = await import("@/lib/video-studio/jobs");
  const stages = await import("@/lib/video-studio/stages");
  const pipeline = await import("@/lib/video-studio/pipeline");
  const assetsLib = await import("@/lib/video-studio/assets");
  const storage = await import("@/lib/video-studio/storage");
  const vs = await import("@/lib/video-studio/settings");
  const { VOICE_FIXTURE } = await import("./video-studio-fixture");

  const admin = await prisma.adminUser.findFirstOrThrow({ where: { username: "igmaster" } });
  const worker = async () => {
    const r = await pipeline.runVideoWorker(10 * 60_000);
    return r;
  };
  const reload = (id: string) => prisma.videoJob.findUniqueOrThrow({ where: { id }, include: { scenes: { orderBy: { index: "asc" } } } });
  const upload = async (jobId: string, name: string, bytes: Buffer) => {
    const job = await prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } });
    const plan = await assetsLib.startUpload({ job, actorId: admin.id, name, size: bytes.length });
    for (let i = 0; i < plan.chunks; i++) await assetsLib.putChunk({ jobId, uploadId: plan.uploadId, actorId: admin.id, index: i, bytes: bytes.subarray(i * plan.chunkBytes, (i + 1) * plan.chunkBytes) });
    return assetsLib.completeUpload({ job: await prisma.videoJob.findUniqueOrThrow({ where: { id: jobId } }), uploadId: plan.uploadId, actorId: admin.id });
  };
  const outFile = async (id: string) => storage.resolveJobPath(id, (await reload(id)).outputKey!, true);

  console.log("\n0. Fixture (scratch, loopback mock)");
  await prisma.videoJob.deleteMany({});
  await prisma.aiCostQuote.deleteMany({});
  await prisma.aiGatewayCall.deleteMany({});
  await prisma.aiBudgetReservation.deleteMany({});
  await prisma.aiModel.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: { in: ["api.openrouter", "ai.engine", "ai.fx", "video.studio", "video.voices", "video.worker"] } } });
  await settings.saveOpenRouterKey(mockKey("ok"));
  await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('enabled', true) WHERE "key" = 'api.openrouter'`;
  await catalog.syncCatalog();
  await prisma.aiModel.update({ where: { id: "mockai/cheap" }, data: { approved: true, medicallyApproved: true } });
  // A second approved model that accepts images (image sources need vision).
  await prisma.aiModel.update({ where: { id: "mockai/mid" }, data: { approved: true, medicallyApproved: true, inputModalities: ["text", "image"] } });
  await settings.saveFeatureConfig("video_script", cfgLib.normalizeFeatureConfig({ ...cfgLib.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "cheapest" }));
  const fixtureFetch = (async (url: string) =>
    new Response(JSON.stringify(String(url).includes("transcription") ? { data: [{ id: "openai/whisper-large-v3", name: "Whisper large v3", pricing: { prompt: "0.0001", completion: "0" } }, { id: "mistralai/voxtral-mini", name: "Voxtral Mini (per token)", pricing: { prompt: "0.000001", completion: "0.000002" } }] } : VOICE_FIXTURE), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await voices.syncVoiceCatalog(fixtureFetch);
  await voices.setApprovedSpeechModels(["microsoft/mai-voice-2.1"]);
  await vs.saveVideoSettings({ ...(await vs.getVideoSettings()), transcriptionModel: "openai/whisper-large-v3" });
  const hb = await pipeline.writeHeartbeat();
  await check("render worker heartbeat: image present, FFmpeg + Chromium detected", async () => {
    assert.equal(hb.ok, true, hb.error ?? "");
  });

  const exam = await prisma.exam.findFirstOrThrow({ where: { isActive: true }, select: { id: true, name: true } });
  const base = { type: "topic", videoType: "teach_topic", audience: "neet_pg", language: "hinglish", topic: "Cardiac markers in myocardial infarction", prompt: "", questionIds: [], examId: exam.id, aspect: "9:16", durationSec: 45 };

  /** create → Auto Configure → estimate → confirm (consumes the quote) → worker: script. */
  async function scriptJob(source: Record<string, unknown>, title: string, before?: (id: string) => Promise<void>) {
    const j = await jobs.createJob({ source, title }, admin.id);
    if (before) await before(j.id);
    await jobs.runAutoConfigure(j.id, admin.id);
    await jobs.requestEstimate(j.id, admin.id);
    const est = (await reload(j.id)).estimate as { quoteId: string; runnable: boolean; blockReason: string | null };
    assert.ok(est.runnable, est.blockReason ?? "estimate not runnable");
    await jobs.confirmJob(j.id, admin.id, est.quoteId);
    await worker();
    return reload(j.id);
  }

  console.log("\nA. Topic → script → narration → MP4 (9:16, Hinglish)");
  let topicId = "";
  await check("confirmed job: script written by the approved OpenRouter model, flagged scene kept for review", async () => {
    const before = mock.stats.chat;
    const j = await scriptJob(base, "E2E topic");
    topicId = j.id;
    assert.equal(j.status, "REVIEW_REQUIRED", j.errorMessage ?? "");
    assert.equal(mock.stats.chat, before + 1, "exactly one paid script call");
    assert.ok(j.scenes.length >= 4, `${j.scenes.length} scenes`);
    assert.ok(j.scenes.some((s) => s.needsReview && s.reviewNote), "the fact-check flag survives");
    assert.ok(j.actualInr > 0, "script cost recorded from usage.cost");
  });
  await check("narration needs its own estimate + confirmation; a stale nonce is refused", async () => {
    const speech = mock.stats.speech;
    assert.ok(await thrown(() => stages.confirmVoice(topicId, "0".repeat(24), admin.id)));
    const vp = await stages.estimateVoice(topicId, admin.id, { model: "microsoft/mai-voice-2.1", voice: "hi-IN-Kavya:MAI-Voice-2.1" });
    assert.ok(vp.runnable && vp.estInr > 0 && vp.maxInr >= vp.estInr, JSON.stringify(vp));
    assert.equal(mock.stats.speech, speech, "estimating is free");
    // Editing the narration after the estimate invalidates it.
    const s0 = (await reload(topicId)).scenes[0];
    await stages.updateScene(topicId, s0.id, { narration: `${s0.narration} जल्दी देखिए।` }, admin.id);
    assert.ok(await thrown(() => stages.confirmVoice(topicId, vp.nonce, admin.id)), "changed script must be re-estimated");
  });
  await check("confirmed narration → one speech call per scene → real MP4 (H.264/AAC, 1080×1920)", async () => {
    const speech = mock.stats.speech;
    const vp = await stages.estimateVoice(topicId, admin.id, { model: "microsoft/mai-voice-2.1", voice: "hi-IN-Kavya:MAI-Voice-2.1" });
    await stages.confirmVoice(topicId, vp.nonce, admin.id);
    await worker();
    const j = await reload(topicId);
    assert.equal(j.status, "COMPLETED", `${j.status} ${j.failedStage}: ${j.errorMessage}`);
    assert.equal(mock.stats.speech - speech, j.scenes.filter((s) => s.narration.trim()).length);
    assert.ok(j.scenes.every((s) => s.audioKey && s.audioSec && s.audioSec > 1), "every scene has measured narration");
    const file = await outFile(topicId);
    const p = ffprobe(file);
    const v = p.streams.find((s) => s.codec_type === "video");
    const a = p.streams.find((s) => s.codec_type === "audio");
    assert.equal(v?.codec_name, "h264");
    assert.equal(v?.pix_fmt, "yuv420p");
    assert.equal(`${v?.width}x${v?.height}`, "1080x1920");
    assert.equal(a?.codec_name, "aac");
    const dur = Number(p.format.duration);
    const planned = j.scenes.reduce((x, s) => x + s.durationSec, 0);
    assert.ok(Math.abs(dur - planned) < 3, `duration ${dur} vs scenes ${planned}`);
    assert.ok(j.renderMs && j.renderMs > 0 && j.outputSec);
    await writeFile(path.join(SHOTS, "A-topic.mp4"), await readFile(file));
    for (const t of [1, 6, 12]) await writeFile(path.join(SHOTS, `A-topic-${t}s.png`), frameAt(file, t));
    console.log(`        ${dur.toFixed(1)} s, ${((await stat(file)).size / 1024 / 1024).toFixed(2)} MB, rendered in ${Math.round((j.renderMs ?? 0) / 1000)} s`);
  });
  await check("re-render with the existing narration is free (no new speech calls)", async () => {
    const speech = mock.stats.speech;
    await stages.rerender(topicId, admin.id);
    await worker();
    const j = await reload(topicId);
    assert.equal(j.status, "COMPLETED", j.errorMessage ?? "");
    assert.equal(mock.stats.speech, speech);
  });

  console.log("\nB. Question Bank MCQ → stored answer only → MP4 (16:9)");
  const q = await prisma.question.findFirstOrThrow({ where: { status: "PUBLISHED", parentQuestionId: null, options: { some: { isCorrect: true } } }, select: { id: true, options: { select: { label: true, isCorrect: true } } } });
  const correct = q.options.filter((o) => o.isCorrect);
  let mcqId = "";
  await check("question scene uses the stored stem/options/answer (never the model's)", async () => {
    const j = await scriptJob({ ...base, type: "questions", videoType: "explain_mcq", questionIds: [q.id], aspect: "16:9" }, "E2E MCQ");
    mcqId = j.id;
    assert.equal(j.status, "REVIEW_REQUIRED", j.errorMessage ?? "");
    const qs = j.scenes.find((s) => (s.visual as { kind?: string } | null)?.kind === "question");
    assert.ok(qs, "has a question scene");
    const v = qs!.visual as { correctLabel: string | null; options: { label: string }[]; stem: string };
    if (correct.length === 1) assert.equal(v.correctLabel, correct[0].label.trim().slice(0, 3));
    else assert.equal(v.correctLabel, null);
    assert.equal(v.options.length, q.options.length);
  });
  await check("silent render (free, no speech calls) → 1920×1080 MP4; reveal frame saved", async () => {
    const speech = mock.stats.speech;
    for (const s of (await reload(mcqId)).scenes.filter((x) => x.needsReview)) await stages.updateScene(mcqId, s.id, { reviewed: true, ...((s.visual as { kind?: string } | null)?.kind === "question" ? { visual: { confirmAnswer: true } } : {}) }, admin.id);
    await stages.renderSilent(mcqId, admin.id);
    await worker();
    const j = await reload(mcqId);
    assert.equal(j.status, "COMPLETED", `${j.failedStage}: ${j.errorMessage}`);
    assert.equal(mock.stats.speech, speech);
    const file = await outFile(mcqId);
    const v = ffprobe(file).streams.find((s) => s.codec_type === "video");
    assert.equal(`${v?.width}x${v?.height}`, "1920x1080");
    const idx = j.scenes.findIndex((s) => (s.visual as { kind?: string } | null)?.kind === "question");
    const start = j.scenes.slice(0, idx).reduce((a, s) => a + s.durationSec, 0);
    const reveal = (j.scenes[idx].visual as { revealAtSec?: number }).revealAtSec ?? 0;
    if (correct.length === 1) assert.ok(j.scenes[idx].durationSec >= reveal + 2.4, `question scene ${j.scenes[idx].durationSec}s ends before its reveal at ${reveal}s`);
    await writeFile(path.join(SHOTS, "B-mcq-before-reveal.png"), frameAt(file, start + 1));
    await writeFile(path.join(SHOTS, "B-mcq-after-reveal.png"), frameAt(file, start + reveal + 1.5));
    await writeFile(path.join(SHOTS, "B-mcq.mp4"), await readFile(file));
  });

  console.log("\nC. Image upload → educational video");
  await check("image sources: refused before upload; uploaded PNG is shown to a vision model and on screen", async () => {
    const { default: sharp } = await import("sharp");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#fff"/><path d="M0 400 L300 400 L340 300 L380 520 L420 200 L460 400 L1200 400" stroke="#c00" stroke-width="8" fill="none"/><text x="60" y="120" font-size="64" font-family="sans-serif">ECG lead II: ST elevation</text></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const j = await jobs.createJob({ source: { ...base, type: "image", videoType: "image_to_video" }, title: "E2E image" }, admin.id);
    assert.ok(await thrown(() => jobs.runAutoConfigure(j.id, admin.id)), "refused before upload");
    const a = await upload(j.id, "ecg.png", png);
    assert.equal(a.kind, "image");
    await jobs.runAutoConfigure(j.id, admin.id);
    await jobs.requestEstimate(j.id, admin.id);
    const est = (await reload(j.id)).estimate as { quoteId: string };
    await jobs.confirmJob(j.id, admin.id, est.quoteId);
    const before = mock.stats.bodies.length;
    await worker();
    let r = await reload(j.id);
    assert.equal(r.status, "REVIEW_REQUIRED", `${r.failedStage}: ${r.errorMessage}`);
    const call = mock.stats.bodies.slice(before).find((b: { model?: string }) => b.model);
    assert.equal(call?.model, "mockai/mid", "image source → the approved model that accepts images");
    const img = r.scenes.find((s) => (s.visual as { kind?: string } | null)?.kind === "image");
    assert.ok(img && (img.visual as { assetKey: string }).assetKey === a.key, "the uploaded image is on screen");
    await stages.renderSilent(j.id, admin.id);
    await worker();
    r = await reload(j.id);
    assert.equal(r.status, "COMPLETED", `${r.failedStage}: ${r.errorMessage}`);
    const file = await outFile(j.id);
    const ii = r.scenes.findIndex((s) => s.id === img!.id);
    await writeFile(path.join(SHOTS, "C-image-scene.png"), frameAt(file, r.scenes.slice(0, ii).reduce((x, s) => x + s.durationSec, 0) + 1.5));
  });

  console.log("\nD. PDF upload → script from its text");
  await check("PDF text of the selected pages reaches the script prompt; page images become on-screen assets", async () => {
    const pdf = makePdf(["Cardiac biomarkers - page one\nTroponin I rises 3-6 hours after injury\nPeaks at 24 hours", "Page two\nCK-MB returns to normal in 48-72 hours\nUseful for reinfarction"]);
    const j = await jobs.createJob({ source: { ...base, type: "pdf", videoType: "pdf_to_video" }, title: "E2E PDF" }, admin.id);
    const a = await upload(j.id, "markers.pdf", pdf);
    assert.equal(a.pages, 2);
    await stages.setPdfPages(j.id, a.key, [2], admin.id);
    await jobs.runAutoConfigure(j.id, admin.id);
    await jobs.requestEstimate(j.id, admin.id);
    await jobs.confirmJob(j.id, admin.id, ((await reload(j.id)).estimate as { quoteId: string }).quoteId);
    const { __test } = pipeline;
    const mat = await __test.gatherMaterial(await prisma.videoJob.findUniqueOrThrow({ where: { id: j.id } }), (await reload(j.id)).source as never);
    assert.ok(/CK-MB returns to normal/.test(mat.material.documentText), mat.material.documentText.slice(0, 200));
    assert.ok(!/page one/.test(mat.material.documentText), "unselected page excluded");
    await worker();
    const r = await reload(j.id);
    assert.equal(r.status, "REVIEW_REQUIRED", `${r.failedStage}: ${r.errorMessage}`);
    assert.ok(assetsLib.readAssets(r).some((x) => x.key.startsWith("inputs/pdfpage-") && x.kind === "image"), "page image asset");
  });

  console.log("\nE. Safety: budget stop, cancellation, retry");
  await check("AI emergency stop blocks the narration estimate from running (nothing sent)", async () => {
    const j = await scriptJob(base, "E2E budget");
    const eng = await settings.getEngineConfig();
    await settings.saveBudgets({ ...eng.budgets, emergencyStop: true });
    try {
      const vp = await stages.estimateVoice(j.id, admin.id, { model: "microsoft/mai-voice-2.1", voice: "hi-IN-Kavya:MAI-Voice-2.1" });
      assert.equal(vp.runnable, false);
      assert.ok(await thrown(() => stages.confirmVoice(j.id, vp.nonce, admin.id)));
    } finally {
      await settings.saveBudgets(eng.budgets);
    }
  });
  await check("cancel during the queue: worker skips it, media folder removed, no paid call", async () => {
    const j = await jobs.createJob({ source: base, title: "E2E cancel" }, admin.id);
    await jobs.runAutoConfigure(j.id, admin.id);
    await jobs.requestEstimate(j.id, admin.id);
    await jobs.confirmJob(j.id, admin.id, ((await reload(j.id)).estimate as { quoteId: string }).quoteId);
    const chat = mock.stats.chat;
    await jobs.cancelJob(j.id, admin.id);
    await worker();
    assert.equal((await reload(j.id)).status, "CANCELLED");
    assert.equal(mock.stats.chat, chat);
  });
  await check("a failed render can be retried from the render step without new narration charges", async () => {
    const j = await reload(topicId);
    await prisma.videoJob.update({ where: { id: j.id }, data: { status: "FAILED", failedStage: "render", errorMessage: "simulated" } });
    const speech = mock.stats.speech;
    await stages.retryJob(j.id, admin.id);
    await worker();
    const r = await reload(j.id);
    assert.equal(r.status, "COMPLETED", r.errorMessage ?? "");
    assert.equal(mock.stats.speech, speech);
  });

  console.log("\nF. AI Video Editor: upload → ingest → edit → paid transcription (confirmed) → export");
  let editId = "";
  await check("upload a recording → worker probes it and makes a preview proxy + thumbnails", async () => {
    const rec = await readFile(path.join(SHOTS, "A-topic.mp4"));
    const j = await stages.createEditJob("E2E edit", admin.id);
    editId = j.id;
    const a = await upload(j.id, "lecture.mp4", rec);
    assert.equal(a.kind, "video");
    await stages.processUploads(j.id, admin.id);
    await worker();
    const r = await reload(j.id);
    const ready = assetsLib.readAssets(r).find((x) => x.key === a.key)!;
    assert.equal(ready.state, "ready", ready.error ?? r.errorMessage ?? "");
    assert.ok(ready.durationSec && ready.durationSec > 10 && ready.hasAudio && ready.proxyKey && ready.thumbsKey);
    assert.equal(r.status, "REVIEW_REQUIRED", r.errorMessage ?? "");
  });
  await check("edit: trim, split, delete a piece, text + diagram overlays, Hindi cue; invalid edits refused", async () => {
    await stages.resetEdit(editId, admin.id);
    const { splitAt } = await import("@/lib/video-studio/editor-model");
    let p = (await reload(editId)).edit as unknown as import("@/lib/video-studio/editor-model").EditProject;
    p = { ...p, segments: [{ ...p.segments[0], in: 0.5, out: Math.min(p.segments[0].out, 14) }] };
    p = splitAt(p, 6)!;
    p = splitAt(p, 9)!;
    p = { ...p, segments: [p.segments[0], p.segments[2]], transition: "fade", aspect: "9:16" };
    p.overlays = [
      { id: "ovtext01", kind: "text", start: 0.5, end: 4, text: "Troponin I — सबसे specific", style: "title", position: "top" },
      { id: "ovdiag01", kind: "diagram", start: 4, end: 8, text: "MI pathway", nodes: ["Plaque", "Thrombus", "Necrosis"], position: "center" },
    ];
    p.subtitles = { on: true, style: "boxed", cues: [{ id: "cue00001", start: 1, end: 3.5, text: "हृदय की मांसपेशी को नुकसान" }] };
    const saved = await stages.saveEdit(editId, p, admin.id);
    assert.equal(saved.segments.length, 2);
    assert.ok(await thrown(() => stages.saveEdit(editId, { ...p, segments: [{ ...p.segments[0], src: "inputs/../../etc/passwd" }] }, admin.id)), "unknown file refused");
    assert.ok(await thrown(() => stages.saveEdit(editId, { ...p, segments: [] }, admin.id)), "empty edit refused");
  });
  await check("transcription: price shown first, confirm → one OpenRouter STT call → word-timed cues", async () => {
    const stt = mock.stats.transcriptions;
    const tp = await stages.estimateTranscription(editId, { model: "openai/whisper-large-v3", language: "hi" }, admin.id);
    assert.ok(tp.runnable && tp.estInr > 0, JSON.stringify(tp));
    assert.ok(await thrown(() => stages.estimateTranscription(editId, { model: "mistralai/voxtral-mini" }, admin.id)), "per-token STT refused (no honest estimate)");
    assert.equal(mock.stats.transcriptions, stt, "estimates are free");
    const tp2 = await stages.estimateTranscription(editId, { model: "openai/whisper-large-v3", language: "hi" }, admin.id);
    assert.ok(await thrown(() => stages.confirmTranscription(editId, tp.nonce, admin.id)), "superseded nonce refused");
    await stages.confirmTranscription(editId, tp2.nonce, admin.id);
    await worker();
    const r = await reload(editId);
    assert.equal(r.status, "REVIEW_REQUIRED", `${r.failedStage}: ${r.errorMessage}`);
    assert.equal(mock.stats.transcriptions, stt + 1);
    const cues = (r.edit as { subtitles: { cues: { text: string }[] } }).subtitles.cues;
    assert.ok(cues.length >= 2 && cues.some((c) => /[ऀ-ॿ]/.test(c.text)), JSON.stringify(cues).slice(0, 200));
    assert.ok(r.actualInr > 0, "transcription cost recorded");
  });
  await check("export → real 1080×1920 MP4 with the edit's duration; frames saved", async () => {
    const p = (await reload(editId)).edit as unknown as import("@/lib/video-studio/editor-model").EditProject;
    p.overlays = [{ id: "ovtext01", kind: "text", start: 0.5, end: 4, text: "Troponin I — सबसे specific", style: "title", position: "top" }, { id: "ovdiag01", kind: "diagram", start: 4, end: 8, text: "MI pathway", nodes: ["Plaque", "Thrombus", "Necrosis"], position: "center" }];
    await stages.exportEdit(editId, p, admin.id);
    await worker();
    const r = await reload(editId);
    assert.equal(r.status, "COMPLETED", `${r.failedStage}: ${r.errorMessage}`);
    const { outputDuration } = await import("@/lib/video-studio/editor-model");
    const file = await outFile(editId);
    const pr = ffprobe(file);
    const v = pr.streams.find((s) => s.codec_type === "video");
    assert.equal(`${v?.width}x${v?.height}`, "1080x1920");
    assert.ok(pr.streams.some((s) => s.codec_type === "audio"));
    const want = outputDuration(r.edit as never);
    assert.ok(Math.abs(Number(pr.format.duration) - want) < 0.6, `${pr.format.duration} vs ${want}`);
    await writeFile(path.join(SHOTS, "F-edit.mp4"), await readFile(file));
    await writeFile(path.join(SHOTS, "F-edit-2s.png"), frameAt(file, 2));
    await writeFile(path.join(SHOTS, "F-edit-6s.png"), frameAt(file, 6));
  });
  await check("export with sound effects: an effect anchored to the cut + a fixed one → mixed MP4, audio_checked event with measured loudness", async () => {
    const em = await import("@/lib/video-studio/editor-model");
    const p = (await reload(editId)).edit as unknown as import("@/lib/video-studio/editor-model").EditProject;
    assert.deepEqual(p.sfx ?? [], [], "no effect was ever added automatically");
    p.sfx = [
      { id: "sfxwhoosh1", key: "transition_whoosh", start: 0, anchor: { kind: "cut", id: p.segments[1].id }, offsetSec: -0.136, trimIn: 0, trimOut: 1.056, volume: 0.8, fadeInSec: 0, fadeOutSec: 0.1 },
      { id: "sfxpop0001", key: "text_pop", start: 1, anchor: null, offsetSec: 0, trimIn: 0, trimOut: 0.172, volume: 0.8, fadeInSec: 0, fadeOutSec: 0 },
    ];
    await stages.exportEdit(editId, p, admin.id);
    await worker();
    const r = await reload(editId);
    assert.equal(r.status, "COMPLETED", `${r.failedStage}: ${r.errorMessage}`);
    const saved = r.edit as unknown as import("@/lib/video-studio/editor-model").EditProject;
    assert.equal(saved.sfx.length, 2);
    const ev = await prisma.videoJobEvent.findMany({ where: { jobId: editId }, orderBy: { createdAt: "desc" }, take: 10 });
    assert.ok(ev.some((e) => e.type === "export_started" && /2 sound effect\(s\)/.test(e.message)), ev.map((e) => e.message).join(" | "));
    const ac = ev.find((e) => e.type === "audio_checked");
    assert.ok(ac && /LUFS, true peak -?[\d.]+ dBTP/.test(ac.message), ac?.message ?? "no audio_checked event");
    const d = ac.data as { lufs: number; audioSec: number; videoSec: number };
    assert.ok(Math.abs(d.audioSec - d.videoSec) < 0.1, JSON.stringify(d));
    const pr = ffprobe(await outFile(editId));
    assert.ok(Math.abs(Number(pr.format.duration) - em.outputDuration(saved)) < 0.6);
    await writeFile(path.join(SHOTS, "F-edit-sfx.mp4"), await readFile(await outFile(editId)));
  });

  console.log("\nI. Live CBT protection (scratch LiveTest rows, removed afterwards)");
  const liveRow = (status: "LIVE" | "SCHEDULED", startInMin: number) =>
    prisma.liveTest.create({ data: { examId: exam.id, title: "E2E video-worker guard", startAt: new Date(Date.now() + startInMin * 60_000), endAt: new Date(Date.now() + 120 * 60_000), studentDurationMinutes: 60, questionCount: 1, status } });
  await check("a running or imminent Live CBT pauses the worker: nothing starts, the job waits, no AI call", async () => {
    const j = await jobs.createJob({ source: base, title: "E2E live guard" }, admin.id);
    await jobs.runAutoConfigure(j.id, admin.id);
    await jobs.requestEstimate(j.id, admin.id);
    await jobs.confirmJob(j.id, admin.id, ((await reload(j.id)).estimate as { quoteId: string }).quoteId);
    const chat = mock.stats.chat;
    for (const [st, min] of [["LIVE", -5], ["SCHEDULED", 10]] as const) {
      const lt = await liveRow(st, min);
      try {
        const r = await worker();
        assert.equal(r.paused, true, st);
        assert.equal((await reload(j.id)).status, "QUEUED");
        assert.equal(mock.stats.chat, chat);
      } finally {
        await prisma.liveTest.delete({ where: { id: lt.id } });
      }
    }
    await jobs.cancelJob(j.id, admin.id);
  });
  await check("a Live CBT that starts during a render stops the render container; the job is re-queued and completes afterwards", async () => {
    await stages.renderSilent(mcqId, admin.id);
    const run = worker();
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const j = await prisma.videoJob.findUniqueOrThrow({ where: { id: mcqId } });
      if (j.stage === "render" && j.progressPct > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const lt = await liveRow("LIVE", -1);
    try {
      await run;
      const j = await reload(mcqId);
      assert.equal(j.status, "RENDERING", `${j.status} ${j.errorMessage}`);
      assert.ok((await prisma.videoJobEvent.findMany({ where: { jobId: mcqId, type: "paused" } })).length > 0, "paused event");
      const containers = execFileSync("/usr/bin/docker", ["ps", "-q", "--filter", `label=mts.video=${process.env.VIDEO_RENDER_INSTANCE}`], { encoding: "utf8" }).trim();
      assert.equal(containers, "", "no render container left running");
    } finally {
      await prisma.liveTest.delete({ where: { id: lt.id } });
    }
    await worker();
    assert.equal((await reload(mcqId)).status, "COMPLETED");
  });

  console.log("\nH. Storage policy on real job rows and folders (runCleanup)");
  const { existsSync } = await import("node:fs");
  const folder = (id: string) => path.join(ROOT, id);
  await check("retry window: a fresh failure keeps its files through cleanup, and Retry then completes", async () => {
    await prisma.videoJob.update({ where: { id: mcqId }, data: { status: "FAILED", failedStage: "render", errorMessage: "simulated", finishedAt: new Date() } });
    await jobs.runCleanup(null);
    assert.ok(existsSync(folder(mcqId)) && !(await reload(mcqId)).mediaDeletedAt, "kept for Retry");
    await stages.retryJob(mcqId, admin.id);
    await worker();
    assert.equal((await reload(mcqId)).status, "COMPLETED");
  });
  await check("failed past the window → files deleted; Retry is then refused", async () => {
    const s = await vs.getVideoSettings();
    await prisma.videoJob.update({ where: { id: mcqId }, data: { status: "FAILED", failedStage: "render", errorMessage: "simulated", finishedAt: new Date(Date.now() - (s.failedRetentionHours + 1) * 3600_000) } });
    await jobs.runCleanup(null);
    assert.ok(!existsSync(folder(mcqId)) && (await reload(mcqId)).mediaDeletedAt);
    assert.ok(await thrown(() => stages.retryJob(mcqId, admin.id)));
  });
  await check("delivered: kept for the delivered window after download, then deleted", async () => {
    await jobs.markDelivered(topicId, admin.id, "download");
    await jobs.runCleanup(null);
    assert.ok(existsSync(folder(topicId)), "still inside the delivered window");
    const s = await vs.getVideoSettings();
    await prisma.videoJob.update({ where: { id: topicId }, data: { deliveredAt: new Date(Date.now() - (s.deliveredRetentionHours + 1) * 3600_000) } });
    await jobs.runCleanup(null);
    assert.ok(!existsSync(folder(topicId)) && (await reload(topicId)).mediaDeletedAt);
  });
  await check("hard cap: a job older than the maximum retention loses its files whatever its state (a queued one is stopped)", async () => {
    const j = await jobs.createJob({ source: base, title: "E2E capped" }, admin.id);
    await storage.ensureJobDir(j.id);
    await writeFile(path.join(folder(j.id), "probe.txt"), "x");
    const s = await vs.getVideoSettings();
    await prisma.videoJob.update({ where: { id: j.id }, data: { status: "QUEUED", createdAt: new Date(Date.now() - (s.maxRetentionDays * 24 + 1) * 3600_000) } });
    await jobs.runCleanup(null);
    const r = await reload(j.id);
    assert.ok(!existsSync(folder(j.id)) && r.mediaDeletedAt);
    assert.equal(r.status, "FAILED");
    assert.match(r.errorMessage ?? "", /maximum retention/);
  });
  await check("waiting for review with no activity → files deleted; cancelled → deleted at once", async () => {
    const r1 = await reload(editId);
    await prisma.videoJob.update({ where: { id: r1.id }, data: { status: "REVIEW_REQUIRED", lastActivityAt: new Date(Date.now() - 73 * 3600_000) } });
    await jobs.runCleanup(null);
    assert.ok(!existsSync(folder(editId)) && (await reload(editId)).mediaDeletedAt);
    const c = await jobs.createJob({ source: base, title: "E2E cancel files" }, admin.id);
    await storage.ensureJobDir(c.id);
    await writeFile(path.join(folder(c.id), "probe.txt"), "x");
    await jobs.cancelJob(c.id, admin.id);
    assert.ok(!existsSync(folder(c.id)));
  });

  console.log("\nG. Isolation");
  await check("every outbound request went to the loopback mock", async () => {
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
