import "server-only";
import { QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isAiGenerationConfigured } from "@/lib/ai-provider";
import { ENGINE_FEATURE_MAP } from "@/lib/ai-engine/config";
import { getEngineConfig, resolveOpenRouterKey } from "@/lib/ai-engine/settings";
import { textCandidates } from "@/lib/ai-engine/router";
import { DESIGN_MAP, readyDesigns } from "@/lib/video-studio/designs";
import { recommendedSkillKeys, normalizeSkillKeys } from "@/lib/video-studio/skills";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { speechCapability } from "@/lib/video-studio/voices";
import { renderCapability } from "@/lib/video-studio/worker-status";
import {
  DURATION_LIMITS,
  MEDICAL_VIDEO_TYPES,
  type CapabilityCheck,
  type Language,
  type VideoConfig,
  type VideoSource,
  type VideoType,
  type VoiceStyle,
} from "@/lib/video-studio/types";

/**
 * Auto Configure AI — proposes a complete, editable configuration from the
 * job's source and basic preferences. It is deterministic and FREE: it reads
 * settings, the approved model catalog and the Question Bank, and never calls
 * a paid provider. It only proposes a provider that exists, is configured and
 * supports the capability (a text model is never assumed to speak or render);
 * anything missing is reported as a blocker in plain language.
 */

const DEFAULT_DURATION: Record<VideoType, number> = {
  teach_topic: 60,
  explain_mcq: 45,
  clinical_case: 60,
  exam_revision: 45,
  medical_awareness: 45,
  diagram_explanation: 60,
  animated_explainer: 45,
  text_to_video: 45,
  pdf_to_video: 60,
  image_to_video: 30,
  question_paper: 60,
  promo_reel: 30,
  custom: 45,
};

const DESIGN_FOR: Record<VideoType, string> = {
  teach_topic: "medical_classroom",
  explain_mcq: "exam_revision",
  clinical_case: "clinical_case",
  exam_revision: "exam_revision",
  medical_awareness: "minimal_professional",
  diagram_explanation: "diagram_explainer",
  animated_explainer: "motion_graphics",
  text_to_video: "minimal_professional",
  pdf_to_video: "medical_classroom",
  image_to_video: "minimal_professional",
  question_paper: "exam_revision",
  promo_reel: "brand_promotion",
  custom: "medical_classroom",
};

const CARDIO = /\b(?:ecg|ekg|cardiac|heart|myocardial|arrhythmi\w*|infarct\w*|angina|atrial|ventricular)\b|हृदय|दिल/iu;
const DIAGRAM_HINT = /\b(?:pathway|mechanism|cycle|cascade|classification|flow ?chart|algorithm|steps?|axis|vs\.?|versus)\b|प्रक्रिया|चक्र|वर्गीकरण/iu;

/** "60-second", "45 sec", "1 minute", "2 min" in the admin's prompt. */
export function durationHint(text: string): number | null {
  const sec = text.match(/(\d{2,3})\s*-?\s*(?:seconds?|secs?|s)\b/i);
  if (sec) return Number(sec[1]);
  const min = text.match(/(\d(?:\.\d)?)\s*-?\s*(?:minutes?|mins?)\b/i);
  if (min) return Math.round(Number(min[1]) * 60);
  return null;
}

export function languageHint(text: string): Language | null {
  if (/\bhinglish\b/i.test(text)) return "hinglish";
  if (/\bhindi\b|हिंदी|हिन्दी/i.test(text)) return "hi";
  if (/\benglish\b/i.test(text) && !/hindi|hinglish/i.test(text)) return "en";
  return null;
}

const clampDuration = (n: number) => Math.min(DURATION_LIMITS.maxSec, Math.max(DURATION_LIMITS.minSec, Math.round(n)));

export interface QuestionSummary {
  id: string;
  code: string;
  examId: string;
  examName: string;
  hasCorrectAnswer: boolean;
  published: boolean;
}

export async function loadQuestionSummaries(ids: string[]): Promise<QuestionSummary[]> {
  if (!ids.length) return [];
  const rows = await prisma.question.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, examId: true, status: true, exam: { select: { name: true } }, options: { select: { isCorrect: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ id: r.id, code: r.code, examId: r.examId, examName: r.exam.name, hasCorrectAnswer: r.options.some((o) => o.isCorrect), published: r.status === QuestionStatus.PUBLISHED }));
}

/** Can the platform write the script right now, and with what? (Same rules the AI Engine applies at run time.) */
export async function scriptCapability(medical: boolean): Promise<CapabilityCheck> {
  const engine = await getEngineConfig();
  const cfg = engine.features.video_script;
  const label = "Script writing (text AI)";
  if (engine.budgets.emergencyStop) return { key: "script", label, status: "missing", provider: null, detail: "AI generation is stopped by the AI emergency stop (AI → Budgets)." };
  if (!cfg.enabled) return { key: "script", label, status: "missing", provider: null, detail: "“AI Video Studio Script” is turned off in AI → Features." };
  if (cfg.provider === "legacy") {
    const ok = await isAiGenerationConfigured();
    return ok
      ? { key: "script", label, status: "ready", provider: "Existing AI provider (legacy route)", detail: "Works, but the legacy route reports no cost, so no INR estimate can be shown. Switch “AI Video Studio Script” to OpenRouter in AI → Features for cost estimates and actual-cost tracking." }
      : { key: "script", label, status: "missing", provider: null, detail: "No AI provider is configured. Configure OpenRouter (AI → Providers) and route “AI Video Studio Script” to it in AI → Features." };
  }
  if (!(await resolveOpenRouterKey())) return { key: "script", label, status: "missing", provider: null, detail: "OpenRouter is not configured or is disabled (AI → Providers)." };
  const def = ENGINE_FEATURE_MAP.video_script;
  const maxOut = cfg.maxOutputTokens ?? def.defaultMaxOutputTokens;
  const cands = await textCandidates("video_script", def.typicalInputTokens, maxOut, Math.round(maxOut / 2));
  if (!cands.length) {
    return { key: "script", label, status: "missing", provider: null, detail: `No approved OpenRouter text model passes the checks for this feature${medical ? " (medical videos need a medically approved model)" : ""}. Approve one in AI → Models.` };
  }
  return { key: "script", label, status: "ready", provider: `OpenRouter (${cfg.mode === "manual" && cfg.model ? cfg.model : `${cfg.mode} routing, cheapest suitable: ${cands[0].model.id}`})`, detail: "Priced from the synced catalog; the exact estimate is shown before you confirm." };
}

export interface AutoConfigInput {
  source: VideoSource;
  customPrompt: string;
  /** Skill keys the admin pre-selected (kept, plus required Skills); empty = recommend. */
  skillKeys?: string[];
  designKey?: string | null;
}

export async function autoConfigure(input: AutoConfigInput): Promise<VideoConfig> {
  const { source } = input;
  const prompt = `${source.topic} ${source.prompt} ${input.customPrompt}`;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const medical = MEDICAL_VIDEO_TYPES.includes(source.videoType);

  // Language: the admin's explicit choice wins; a clear hint in the prompt is only used when it agrees or nothing was chosen.
  const hintLang = languageHint(input.customPrompt);
  const language = source.language;
  if (hintLang && hintLang !== language) reasons.push(`Your prompt mentions ${hintLang === "hi" ? "Hindi" : hintLang === "en" ? "English" : "Hinglish"}, but the selected language (${language}) is kept — change it in the configuration if needed.`);

  // Duration: prompt hint ("60-second") > admin's value > per-type default.
  const hinted = durationHint(input.customPrompt);
  const durationSec = clampDuration(hinted ?? (source.durationSec || DEFAULT_DURATION[source.videoType]));
  reasons.push(hinted ? `Duration ${durationSec}s taken from your prompt.` : `Duration ${durationSec}s (${source.durationSec ? "your choice" : "typical for this video type"}).`);
  const sceneCount = Math.min(12, Math.max(4, Math.round(durationSec / 7)));

  // Skills.
  const skillKeys = input.skillKeys?.length ? normalizeSkillKeys(input.skillKeys, medical) : recommendedSkillKeys(source.videoType, medical);
  if (medical) reasons.push("Medical Fact Checker is always on for medical videos: uncertain claims are flagged for your review instead of stated as fact.");

  // Design.
  let designKey = input.designKey && DESIGN_MAP[input.designKey]?.status === "ready" ? input.designKey : DESIGN_FOR[source.videoType];
  if (!input.designKey && CARDIO.test(prompt) && source.videoType !== "promo_reel") {
    designKey = "ecg_animation";
    reasons.push("Cardiology topic detected → ECG Animation design.");
  }
  if (!DESIGN_MAP[designKey]?.aspects.includes(source.aspect)) designKey = readyDesigns(source.aspect)[0]?.key ?? "minimal_professional";
  reasons.push(`Design: ${DESIGN_MAP[designKey].name}.`);

  const needsDiagrams = source.videoType === "diagram_explanation" || DIAGRAM_HINT.test(prompt);
  if (needsDiagrams) reasons.push("Schematic diagrams (boxes and arrows drawn from text) will be planned — no generated anatomy.");

  const voiceStyle: VoiceStyle = source.videoType === "promo_reel" ? "energetic" : source.videoType === "clinical_case" ? "calm_teacher" : "conversational";

  // Exam label: only from reliable data (the selected questions' exam, or the exam the admin picked).
  let examLabel: string | null = null;
  if (source.questionIds.length) {
    const qs = await loadQuestionSummaries(source.questionIds);
    const missing = source.questionIds.length - qs.length;
    if (missing) blockers.push(`${missing} selected question(s) no longer exist.`);
    const exams = new Set(qs.map((q) => q.examId));
    if (exams.size === 1 && qs[0]) {
      examLabel = qs[0].examName;
      reasons.push(`Exam label “${examLabel}” comes from the selected questions.`);
    } else if (exams.size > 1) reasons.push("The selected questions belong to different exams, so no exam label is added (general format).");
    const noAnswer = qs.filter((q) => !q.hasCorrectAnswer);
    if (noAnswer.length) reasons.push(`${noAnswer.length} question(s) have no stored correct answer: their scenes will be flagged for review — the AI never invents an answer.`);
    const unpublished = qs.filter((q) => !q.published);
    if (unpublished.length) reasons.push(`${unpublished.length} question(s) are not published (draft / review) — check them before publishing the video.`);
  } else if (source.examId) {
    const exam = await prisma.exam.findUnique({ where: { id: source.examId }, select: { name: true } });
    if (exam) {
      examLabel = exam.name;
      reasons.push(`Exam label “${examLabel}” from the exam you selected.`);
    }
  } else reasons.push("No exam selected: general educational format (no exam label).");

  const settings = await getVideoSettings();
  const [script, voice, render] = await Promise.all([scriptCapability(medical), speechCapability(language), renderCapability()]);
  const capabilities: CapabilityCheck[] = [
    script,
    voice.check,
    { key: "subtitles", label: "Subtitles", status: "ready", provider: "Built-in (Devanagari-safe line breaking)", detail: "Timed per scene; exact sync is checked against the measured narration audio." },
    render,
    { key: "images", label: "AI images", status: "missing", provider: null, detail: "Not used: diagrams are drawn from text. AI image generation for videos needs a separately approved image model." },
    { key: "publish", label: "Publishing", status: "not_built", provider: null, detail: "Download only. Instagram Reels / YouTube Shorts publishing is a later phase." },
  ];
  if (script.status !== "ready") blockers.push(`Script: ${script.detail}`);

  return {
    version: 1,
    videoType: source.videoType,
    audience: source.audience,
    language,
    aspect: source.aspect,
    durationSec,
    skillKeys,
    designKey,
    voiceStyle,
    voiceId: voice.defaultVoiceId,
    speechModel: voice.model,
    subtitles: true,
    subtitleStyle: DESIGN_MAP[designKey].theme.subtitleStyle,
    music: false,
    branding: settings.brand.showBranding,
    examLabel,
    cta: settings.brand.cta,
    sceneCount,
    needsDiagrams,
    reasons,
    capabilities,
    // The script stage is the first paid step; voice and render run as later stages with their own estimate.
    runnable: blockers.length === 0,
    blockers,
    generatedAt: new Date().toISOString(),
  };
}
