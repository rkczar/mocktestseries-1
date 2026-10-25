/**
 * AI Video Studio — scratch fixture for the browser suite (never production).
 * `setup` configures the AI Engine against the LOCAL OpenRouter mock (fake key,
 * mock catalog, one medically approved model, video_script → OpenRouter) and a
 * voice catalog from an inline fixture (no network). `cleanup` removes it.
 *
 *   node -e "import('./scripts/mock-openrouter.mjs').then(m => m.startMockOpenRouter(3195))" &
 *   set -a; . ./.env; set +a
 *   OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3195 FX_TEST_BASE_URL=http://127.0.0.1:3195 \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/video-studio-fixture.ts setup
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { mockKey } from "./mock-openrouter.mjs";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.OPENROUTER_TEST_BASE_URL ?? "")) {
  console.error("Refusing to run: OPENROUTER_TEST_BASE_URL must point at the loopback mock.");
  process.exit(2);
}

const KEYS = ["api.openrouter", "ai.engine", "ai.fx", "video.studio", "video.voices", "video.worker"];

export const VOICE_FIXTURE = {
  data: [
    { id: "microsoft/mai-voice-2.1", name: "Microsoft: MAI-Voice-2.1", pricing: { prompt: "0.000022", completion: "0" }, supported_voices: ["en-IN-Priya:MAI-Voice-2.1", "hi-IN-Kavya:MAI-Voice-2.1", "hi-IN-Arjun:MAI-Voice-2.1"], description: "15 languages" },
    { id: "elevenlabs/eleven-multilingual-v2", name: "ElevenLabs: Eleven Multilingual v2", pricing: { prompt: "0.00008", completion: "0" }, supported_voices: ["george", "sarah"], description: "supports 29 languages" },
    { id: "google/gemini-3.8-flash-tts", name: "Google: Gemini 3.8 Flash TTS", pricing: { prompt: "0.0000005", completion: "0.000009" }, supported_voices: ["Puck"], description: "" },
  ],
};

export const STT_FIXTURE = { data: [{ id: "openai/whisper-large-v3", name: "Whisper large v3", pricing: { prompt: "0.0001", completion: "0" }, description: "per second" }] };

async function cleanup() {
  await prisma.videoJob.deleteMany({});
  await prisma.videoSkillPreset.deleteMany({});
  await prisma.aiCostQuote.deleteMany({});
  await prisma.aiGatewayCall.deleteMany({});
  await prisma.aiBudgetReservation.deleteMany({});
  await prisma.aiModel.deleteMany({});
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } });
}

async function setup() {
  await cleanup();
  const settings = await import("@/lib/ai-engine/settings");
  const cfg = await import("@/lib/ai-engine/config");
  const catalog = await import("@/lib/ai-engine/catalog");
  const voices = await import("@/lib/video-studio/voices");
  await settings.saveOpenRouterKey(mockKey("ok"));
  await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('enabled', true) WHERE "key" = 'api.openrouter'`;
  await catalog.syncCatalog();
  await prisma.aiModel.update({ where: { id: "mockai/cheap" }, data: { approved: true, medicallyApproved: true } });
  await settings.saveFeatureConfig("video_script", cfg.normalizeFeatureConfig({ ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "cheapest" }));
  const fakeFetch = (async (url: string) => new Response(JSON.stringify(String(url).includes("transcription") ? STT_FIXTURE : VOICE_FIXTURE), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await voices.syncVoiceCatalog(fakeFetch);
  console.log("video-studio fixture: ready (OpenRouter mock, mockai/cheap approved, voice catalog synced, nothing approved for voice yet)");
}

const cmd = process.argv[2];
// Imported by other suites for VOICE_FIXTURE: only act when run directly.
if (/video-studio-fixture\.ts$/.test(process.argv[1] ?? "")) (cmd === "setup" ? setup() : cmd === "cleanup" ? cleanup().then(() => console.log("video-studio fixture: cleaned")) : Promise.reject(new Error("usage: setup | cleanup")))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
