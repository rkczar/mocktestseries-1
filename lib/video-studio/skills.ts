import type { VideoType } from "@/lib/video-studio/types";
import { MOTION_SKILLS } from "@/lib/video-studio/motion/skills";

/**
 * AI Video Studio — Skill Library (client-safe registry).
 *
 * A Skill is a versioned set of instructions (kind "prompt"), a validated
 * processing step written in this codebase (kind "logic"), or a planning
 * step whose output the admin reviews (kind "planner"). Skills are NOT
 * separate AI models: prompt Skills are composed into the one script request
 * the job makes through the existing AI Gateway.
 *
 * Scripting ideas (hook-first structure, one idea per Reel, two key points,
 * on-screen text as a separate track, safe zones, "never fabricate") are
 * adapted from charlie947/social-media-skills (reels-scripting, MIT) and
 * Jakeschincariol/instagram-agent-skill (ig-reel / ig-human, MIT). No code or
 * data files were copied; see docs/ai-video-studio/THIRD-PARTY.md.
 *
 * Bump `version` whenever a Skill's instructions change: jobs record the
 * version they ran with, so an old video is never silently re-explained.
 */

export type SkillKind = "prompt" | "logic" | "planner";
export type SkillCategory = "Teaching" | "Scripting" | "Visual" | "Voice & Audio" | "Quality" | "Editing" | "Motion Workflow";
/** ready = used by the Generator today; editor = part of the AI Video Editor (Phase 4); later = planned, not usable yet. */
export type SkillAvailability = "ready" | "editor" | "later";

export interface VideoSkill {
  key: string;
  version: number;
  name: string;
  category: SkillCategory;
  kind: SkillKind;
  availability: SkillAvailability;
  description: string;
  /** Always applied (cannot be switched off): safety and accuracy rules. */
  required?: boolean;
  /** Video types Auto Configure recommends this Skill for. */
  recommendFor: VideoType[] | "all";
  /** Instructions composed into the script request (prompt Skills only). */
  instructions: string;
  /** "motion" = used only by Motion Workflow Studio (never offered to the Generator). */
  module?: "motion";
  /** An existing Skill this one builds on (reused, not duplicated). */
  extends?: string;
}

const MEDICAL: VideoType[] = ["teach_topic", "explain_mcq", "clinical_case", "exam_revision", "medical_awareness", "diagram_explanation", "animated_explainer", "question_paper"];

export const VIDEO_SKILLS: VideoSkill[] = [
  {
    key: "medical_teacher",
    version: 1,
    name: "Medical Teacher",
    category: "Teaching",
    kind: "prompt",
    availability: "ready",
    description: "Explains one concept the way a good Indian medical teacher would: mechanism first, then the exam-relevant fact, then a memory hook.",
    recommendFor: ["teach_topic", "exam_revision", "diagram_explanation", "animated_explainer"],
    instructions:
      "Teach ONE concept. Order: why it matters (one line) → mechanism in plain words → the single most exam-relevant fact → a memory aid. Use standard textbook terminology (Harrison, Robbins, Guyton level) and keep drug names, doses and values exactly as in standard references. Never invent statistics, guideline years or eponyms.",
  },
  {
    key: "mcq_explainer",
    version: 1,
    name: "MCQ Explainer",
    category: "Teaching",
    kind: "prompt",
    availability: "ready",
    description: "Walks through a Question Bank MCQ: the clue, why the stored answer is right, why each distractor is wrong.",
    recommendFor: ["explain_mcq", "question_paper"],
    instructions:
      "Read the question and the options exactly as given. The STORED CORRECT ANSWER is authoritative: never change it, never argue against it. Scene order: the question's key clue → reveal the correct option → why it is correct → one line per distractor on why it is wrong → the take-away fact. If the stored answer is missing or the question looks ambiguous, say so in a reviewNote and set needsReview=true for that scene instead of guessing.",
  },
  {
    key: "clinical_case_tutor",
    version: 1,
    name: "Clinical Case Tutor",
    category: "Teaching",
    kind: "prompt",
    availability: "ready",
    description: "Builds a short case vignette: presentation → key finding → diagnosis → next step, with a reveal moment.",
    recommendFor: ["clinical_case"],
    instructions:
      "Open with a realistic but fictional patient (age, sex, chief complaint, one or two decisive findings). Build suspense to a reveal of the diagnosis, then the next best step. Mark the case as illustrative. Never use real patient data or identifiable details.",
  },
  {
    key: "hook_writer",
    version: 1,
    name: "Hook Writer",
    category: "Scripting",
    kind: "prompt",
    availability: "ready",
    description: "Writes the first 2–3 seconds: a clinical clue, a surprising fact or a direct question. Scored by the Hook Scorer.",
    recommendFor: "all",
    instructions:
      "The first scene is the hook and must work in under 3 seconds of speech (Hindi/Hinglish: about 8–10 words; English: about 8–12 words). Use one of: a clinical clue, a counter-intuitive fact, a direct question to the viewer, a number, or an exam trap ('Ye galti 90% students karte hain' only if the claim is true and general). Never open with a greeting, the channel name or 'In this video'.",
  },
  {
    key: "reel_script_writer",
    version: 1,
    name: "Reel Script Writer",
    category: "Scripting",
    kind: "prompt",
    availability: "ready",
    description: "Short-form structure: hook → stake → two key points → payoff → one call to action. One idea per video.",
    recommendFor: "all",
    instructions:
      "Structure: HOOK (scene 1) → STAKE: why the viewer should care (one line) → at most TWO key points, one per scene → PAYOFF that delivers what the hook promised → ONE call to action. One idea per video: if the topic needs two ideas, keep the first and mention the second as a follow-up. Short spoken sentences. Do not state the conclusion before the facts. Write narration (what is spoken) and onScreenText (what is read) separately: onScreenText is at most 6 words per scene and never repeats the whole narration.",
  },
  {
    key: "diagram_explainer",
    version: 1,
    name: "Diagram Explainer",
    category: "Visual",
    kind: "planner",
    availability: "ready",
    description: "Plans labelled boxes-and-arrows diagrams (flows, pathways, classifications) that the renderer draws from text — no generated anatomy.",
    recommendFor: ["diagram_explanation", "teach_topic", "animated_explainer"],
    instructions:
      "When a scene explains a pathway, mechanism, classification or comparison, set its visual to kind 'diagram' with up to 6 short node labels and the arrows between them. Diagrams are schematic (boxes and arrows), never anatomical drawings. Every label must be a standard term.",
  },
  {
    key: "visual_planner",
    version: 1,
    name: "Visual Planner",
    category: "Visual",
    kind: "planner",
    availability: "ready",
    description: "Chooses each scene's layout (title, bullets, diagram, question card, CTA) so the frame changes every scene.",
    recommendFor: "all",
    instructions:
      "Give every scene a visual of kind title | bullets | diagram | question | cta. Change the visual kind or content every scene. Keep important text inside the safe zone (it is enforced by the renderer). Use at most 3 bullets of at most 6 words each.",
  },
  {
    key: "voice_director",
    version: 1,
    name: "Voice Director",
    category: "Voice & Audio",
    kind: "prompt",
    availability: "ready",
    description: "Writes narration that sounds natural when spoken: contractions, spoken Hinglish, numbers and abbreviations spelled for the voice.",
    recommendFor: "all",
    instructions:
      "Write narration for the ear. Natural, confident, conversational; no dramatic pauses, no filler. Hinglish = Hindi sentence flow with English medical terms (e.g. 'Myocardial infarction mein sabse pehle troponin badhta hai'). Write Hindi in Devanagari and English terms in Latin script. Spell out abbreviations the first time if they are ambiguous when spoken. Keep each scene's narration under about 25 spoken words.",
  },
  {
    key: "subtitle_generator",
    version: 1,
    name: "Subtitle Generator",
    category: "Voice & Audio",
    kind: "logic",
    availability: "ready",
    description: "Splits narration into readable subtitle lines by grapheme count (Devanagari-safe) and times them to the scene audio.",
    recommendFor: "all",
    instructions: "",
  },
  {
    key: "caption_writer",
    version: 1,
    name: "Caption Writer",
    category: "Scripting",
    kind: "prompt",
    availability: "ready",
    description: "Writes the post caption: first line that works before '…more', a summary of the video, and relevant hashtags.",
    recommendFor: "all",
    instructions:
      "Also write a caption: the first 125 characters must stand alone (it is what the feed shows before '…more'), then 2–3 lines summarising the video, then at most 8 relevant hashtags. No links, no invented claims.",
  },
  {
    key: "exam_revision_creator",
    version: 1,
    name: "Exam Revision Creator",
    category: "Teaching",
    kind: "prompt",
    availability: "ready",
    description: "Rapid revision format: high-yield facts, one per scene, with a recall question at the end.",
    recommendFor: ["exam_revision", "question_paper"],
    instructions: "Revision format: one high-yield fact per scene, stated crisply, then a final recall question the viewer should answer in their head. Prefer facts that are commonly asked in the selected exam; do not claim a fact was asked in a specific year unless the source says so.",
  },
  {
    key: "promo_creator",
    version: 1,
    name: "Promotional Content Creator",
    category: "Scripting",
    kind: "prompt",
    availability: "ready",
    description: "Energetic promo for MockTestSeries.in features, using only real product facts the admin provides.",
    recommendFor: ["promo_reel"],
    instructions:
      "Promote only what the admin's prompt states about the product (features, prices, dates). Never invent offers, discounts, ranks, results or testimonials. End with one clear call to action.",
  },
  {
    key: "medical_fact_checker",
    version: 1,
    name: "Medical Fact Checker",
    category: "Quality",
    kind: "prompt",
    availability: "ready",
    required: true,
    description: "Always on for medical videos: flags any claim it is not certain of for human review instead of presenting it as fact.",
    recommendFor: MEDICAL,
    instructions:
      "Accuracy rules (mandatory): state only facts consistent with standard references. If you are not certain of a value, dose, criterion or association, do not state it — or state it and set needsReview=true with a reviewNote naming the doubt. Never fabricate references, statistics, guideline names or exam-question history. A human reviews every flagged scene before rendering.",
  },
  {
    key: "video_quality_checker",
    version: 1,
    name: "Video Quality Checker",
    category: "Quality",
    kind: "logic",
    availability: "ready",
    required: true,
    description: "Checks the script before any paid step: hook length, scene pacing against the target duration, on-screen text length, missing narration.",
    recommendFor: "all",
    instructions: "",
  },
  {
    key: "educational_broll_planner",
    version: 1,
    name: "Educational B-Roll Planner",
    category: "Visual",
    kind: "planner",
    availability: "later",
    description: "Suggests supporting visuals (approved Question Bank images, licensed stock) per scene. Needs a licensed media source — not configured yet.",
    recommendFor: [],
    instructions: "",
  },
  {
    key: "cinematic_motion_director",
    version: 1,
    name: "Cinematic Motion Director",
    category: "Visual",
    kind: "planner",
    availability: "ready",
    description: "Chooses entrance motion and transitions per scene from the design's motion set (subtle by default).",
    recommendFor: ["animated_explainer", "promo_reel"],
    instructions: "",
  },
  {
    key: "paper_collage_director",
    version: 1,
    name: "Paper Collage Director",
    category: "Visual",
    kind: "planner",
    availability: "later",
    description: "Visual-metaphor planning for the Paper Collage style (metaphor → still → motion, with approval between steps). Needs an approved image provider.",
    recommendFor: [],
    instructions: "",
  },
  {
    key: "background_replacement_planner",
    version: 1,
    name: "Background Replacement Planner",
    category: "Editing",
    kind: "planner",
    availability: "editor",
    description: "AI Video Editor: plans blur / replacement of the background in a recorded video. Requires the render worker.",
    recommendFor: [],
    instructions: "",
  },
  {
    key: "talking_head_editor",
    version: 1,
    name: "Talking-Head Video Editor",
    category: "Editing",
    kind: "planner",
    availability: "editor",
    description: "AI Video Editor: trims pauses, adds captions, highlights and B-roll to a recorded lecture without changing what was said.",
    recommendFor: [],
    instructions: "",
  },
  {
    key: "audio_cleanup_planner",
    version: 1,
    name: "Audio Cleanup Planner",
    category: "Editing",
    kind: "planner",
    availability: "editor",
    description: "AI Video Editor: loudness normalisation, noise reduction and music ducking for recorded audio. Requires the render worker.",
    recommendFor: [],
    instructions: "",
  },
  ...MOTION_SKILLS,
];

export const SKILL_MAP: Record<string, VideoSkill> = Object.fromEntries(VIDEO_SKILLS.map((s) => [s.key, s]));

/** Skills the admin may select for a Generator job right now. */
export function selectableSkills(): VideoSkill[] {
  return VIDEO_SKILLS.filter((s) => s.availability === "ready" && !s.module);
}

/** Recommended Skill keys for a video type (required Skills always included, in registry order). */
export function recommendedSkillKeys(videoType: VideoType, medical: boolean): string[] {
  return VIDEO_SKILLS.filter(
    (s) => s.availability === "ready" && !s.module && (s.required ? s.recommendFor === "all" || medical : s.recommendFor === "all" || s.recommendFor.includes(videoType))
  ).map((s) => s.key);
}

/**
 * Normalises a requested Skill selection: unknown / unavailable keys are
 * dropped, required Skills are always present (medical fact-check only for
 * medical videos), order follows the registry.
 */
export function normalizeSkillKeys(keys: unknown, medical: boolean): string[] {
  const want = new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
  return VIDEO_SKILLS.filter((s) => s.availability === "ready" && !s.module && (want.has(s.key) || (s.required && (s.recommendFor === "all" || medical)))).map((s) => s.key);
}

/** Prompt-Skill instructions for a selection, with their versions (stored on the job). */
export function composeSkillInstructions(keys: string[]): { text: string; versions: Record<string, number> } {
  const versions: Record<string, number> = {};
  const parts: string[] = [];
  for (const k of keys) {
    const s = SKILL_MAP[k];
    if (!s) continue;
    versions[k] = s.version;
    if (s.instructions) parts.push(`[${s.name} v${s.version}] ${s.instructions}`);
  }
  return { text: parts.join("\n"), versions };
}

/** Existing Generator Skills that Motion Workflow Studio reuses as they are (shared, not duplicated). */
export const MOTION_SHARED_SKILLS = ["medical_fact_checker", "medical_teacher", "mcq_explainer", "clinical_case_tutor", "hook_writer", "voice_director", "caption_writer", "exam_revision_creator", "promo_creator"] as const;

/** Skills of a motion video: every motion Skill + the chosen shared ones (the medical fact checker always for medical videos). */
export function motionSkillKeys(keys: unknown, medical: boolean): string[] {
  const want = new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
  const shared = new Set<string>(MOTION_SHARED_SKILLS);
  return VIDEO_SKILLS.filter((s) => s.availability === "ready" && (s.module === "motion" || (shared.has(s.key) && (want.has(s.key) || (s.required && medical))))).map((s) => s.key);
}
