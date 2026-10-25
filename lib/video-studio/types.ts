/**
 * AI Video Studio — shared, client-safe definitions (video types, audiences,
 * languages, aspect ratios, job status labels, the job configuration shape).
 * The server side lives in the other lib/video-studio/*.ts modules.
 */

export const VIDEO_TYPES = [
  { key: "teach_topic", label: "Teach a Topic", needs: "topic" },
  { key: "explain_mcq", label: "Explain an MCQ", needs: "questions" },
  { key: "clinical_case", label: "Clinical Case", needs: "topic" },
  { key: "exam_revision", label: "Exam Revision", needs: "topic" },
  { key: "medical_awareness", label: "Medical Awareness", needs: "topic" },
  { key: "diagram_explanation", label: "Diagram Explanation", needs: "topic" },
  { key: "animated_explainer", label: "Animated Explainer", needs: "topic" },
  { key: "text_to_video", label: "Text to Video", needs: "prompt" },
  { key: "pdf_to_video", label: "PDF to Video", needs: "pdf" },
  { key: "image_to_video", label: "Image to Video", needs: "image" },
  { key: "question_paper", label: "Question Paper to Video", needs: "questions" },
  { key: "promo_reel", label: "Promotional Reel", needs: "prompt" },
  { key: "custom", label: "Custom Video", needs: "prompt" },
] as const;
export type VideoType = (typeof VIDEO_TYPES)[number]["key"];
export const VIDEO_TYPE_KEYS = VIDEO_TYPES.map((t) => t.key) as VideoType[];
export const VIDEO_TYPE_MAP = Object.fromEntries(VIDEO_TYPES.map((t) => [t.key, t])) as Record<VideoType, (typeof VIDEO_TYPES)[number]>;

/** Medical teaching content: scripts need a medically approved model and a fact-check pass. */
export const MEDICAL_VIDEO_TYPES: VideoType[] = ["teach_topic", "explain_mcq", "clinical_case", "exam_revision", "medical_awareness", "diagram_explanation", "animated_explainer", "question_paper"];

export const AUDIENCES = [
  { key: "mbbs", label: "MBBS students" },
  { key: "neet_pg", label: "NEET PG" },
  { key: "fmge", label: "FMGE" },
  { key: "ini_cet", label: "INI-CET" },
  { key: "ruhs_mo", label: "RUHS MO" },
  { key: "other_exam", label: "Other configured exam" },
  { key: "general_public", label: "General public" },
] as const;
export type Audience = (typeof AUDIENCES)[number]["key"];
export const AUDIENCE_KEYS = AUDIENCES.map((a) => a.key) as Audience[];

export const LANGUAGES = [
  { key: "hinglish", label: "Hinglish (Hindi + English terms)" },
  { key: "hi", label: "Hindi" },
  { key: "en", label: "English (Indian)" },
] as const;
export type Language = (typeof LANGUAGES)[number]["key"];
export const LANGUAGE_KEYS = LANGUAGES.map((l) => l.key) as Language[];

/** Validated output sizes. 9:16 1080×1920 is the primary target. */
export const ASPECTS = [
  { key: "9:16", label: "9:16 Vertical (Reels / Shorts)", width: 1080, height: 1920 },
  { key: "1:1", label: "1:1 Square", width: 1080, height: 1080 },
  { key: "4:5", label: "4:5 Portrait feed", width: 1080, height: 1350 },
  { key: "16:9", label: "16:9 Landscape (YouTube)", width: 1920, height: 1080 },
] as const;
export type AspectRatio = (typeof ASPECTS)[number]["key"];
export const ASPECT_KEYS = ASPECTS.map((a) => a.key) as AspectRatio[];
export const ASPECT_MAP = Object.fromEntries(ASPECTS.map((a) => [a.key, a])) as Record<AspectRatio, (typeof ASPECTS)[number]>;

export const DURATION_LIMITS = { minSec: 15, maxSec: 180 } as const;

export const SOURCE_TYPES = ["topic", "prompt", "questions", "pdf", "image"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Source types the Generator accepts (PDF / image need an uploaded file on the job before Auto Configure). */
export const READY_SOURCE_TYPES: SourceType[] = ["topic", "prompt", "questions", "pdf", "image"];

export interface VideoSource {
  type: SourceType;
  videoType: VideoType;
  audience: Audience;
  language: Language;
  topic: string;
  prompt: string;
  questionIds: string[];
  /** Exam picked by the admin (custom topics) — the label comes from the exam itself. */
  examId: string | null;
  aspect: AspectRatio;
  durationSec: number;
}

export type VoiceStyle = "calm_teacher" | "conversational" | "radio_jockey" | "energetic" | "professional";
export const VOICE_STYLES: { key: VoiceStyle; label: string }[] = [
  { key: "conversational", label: "Conversational Educator" },
  { key: "calm_teacher", label: "Calm Teacher" },
  { key: "professional", label: "Professional Narrator" },
  { key: "energetic", label: "Energetic Presenter" },
  { key: "radio_jockey", label: "Radio-Jockey Style" },
];

export type CapabilityStatus = "ready" | "missing" | "pending_approval" | "not_built";

/** One capability Auto Configure needs, and whether the platform can provide it right now. */
export interface CapabilityCheck {
  key: "script" | "voice" | "render" | "subtitles" | "images" | "publish";
  label: string;
  status: CapabilityStatus;
  /** Provider / engine that would do it (never a guess: only something that exists and is configured). */
  provider: string | null;
  detail: string;
}

/** The editable configuration (Auto Configure proposal + the admin's changes). */
export interface VideoConfig {
  version: 1;
  videoType: VideoType;
  audience: Audience;
  language: Language;
  aspect: AspectRatio;
  durationSec: number;
  skillKeys: string[];
  designKey: string;
  voiceStyle: VoiceStyle;
  /** Voice id at the chosen provider; null until a speech provider is available. */
  voiceId: string | null;
  speechModel: string | null;
  subtitles: boolean;
  subtitleStyle: "clean" | "highlight" | "boxed";
  music: boolean;
  branding: boolean;
  examLabel: string | null;
  cta: string;
  sceneCount: number;
  needsDiagrams: boolean;
  /** Why each choice was made (shown under "Why this configuration"). */
  reasons: string[];
  capabilities: CapabilityCheck[];
  /** True when every capability needed for a paid run is ready. */
  runnable: boolean;
  blockers: string[];
  generatedAt: string;
}

export const JOB_STATUS_LABELS: Record<string, { label: string; tone: "neutral" | "progress" | "review" | "done" | "failed" }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  CONFIGURING: { label: "Configuring", tone: "progress" },
  AWAITING_CONFIRMATION: { label: "Awaiting cost confirmation", tone: "review" },
  QUEUED: { label: "Queued", tone: "progress" },
  GENERATING_SCRIPT: { label: "Writing script", tone: "progress" },
  GENERATING_AUDIO: { label: "Generating voice", tone: "progress" },
  RENDERING: { label: "Rendering", tone: "progress" },
  REVIEW_REQUIRED: { label: "Requires review", tone: "review" },
  COMPLETED: { label: "Completed", tone: "done" },
  FAILED: { label: "Failed", tone: "failed" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  CLEANUP_PENDING: { label: "Cleanup pending", tone: "neutral" },
};

/** Statuses a job can be cancelled from (work not yet finished). */
export const CANCELLABLE = ["DRAFT", "CONFIGURING", "AWAITING_CONFIRMATION", "QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING", "REVIEW_REQUIRED"] as const;
/** Statuses where the admin may still edit the configuration (nothing paid has started). */
export const EDITABLE = ["DRAFT", "CONFIGURING", "AWAITING_CONFIRMATION"] as const;
