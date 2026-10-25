import type { VideoSkill } from "@/lib/video-studio/skills";

/**
 * Motion Workflow Studio Skills (module "motion"), part of the one Skill
 * Library registry (lib/video-studio/skills.ts spreads them into
 * VIDEO_SKILLS). Ideas adapted from the publicly described "Motion Graphics
 * Workflow" (go.theonlyworkshop.com/get/motion-workflow, read 2026-10-25);
 * nothing copied. Prompt Skills are composed into the ONE script + storyboard
 * request of a motion video; logic Skills are code in lib/video-studio/motion/.
 * `extends` names the existing Skill a motion Skill builds on (reused, not duplicated).
 */
const motion = (s: Omit<VideoSkill, "version" | "category" | "availability" | "module" | "recommendFor"> & { version?: number }): VideoSkill => ({
  version: 1,
  category: "Motion Workflow",
  availability: "ready",
  module: "motion",
  recommendFor: "all",
  ...s,
});

export const MOTION_SKILLS: VideoSkill[] = [
  motion({
    key: "script_to_storyboard",
    name: "Script-to-Storyboard",
    kind: "prompt",
    description: "Writes the script and its storyboard together: one spoken sentence per frame, and for each frame one on-screen idea, one motion and one highlighted word.",
    instructions:
      "Plan the video frame by frame before anything is built. Every frame = exactly one spoken sentence. For each frame decide four things: the sentence, the ONE idea on screen (≤ 6 words), the ONE motion, and the ONE word that is highlighted when it is spoken. If a frame needs two ideas, make it two frames. Read the plan like a film: two frames in a row must not look the same.",
  }),
  motion({
    key: "sentence_frame_planner",
    name: "Sentence-by-Sentence Planner",
    kind: "logic",
    description: "Free re-plan without AI: splits an edited script into sentences (Devanagari danda aware), keeps edited frames, picks key words, numbers become count-up stats, lists become steps.",
    instructions: "",
  }),
  motion({
    key: "opening_frame_designer",
    name: "Hook & Opening Frame",
    kind: "prompt",
    extends: "hook_writer",
    description: "The first frame states the problem or a clinical clue in one sentence, with a big on-screen line and a single highlighted word. Builds on Hook Writer.",
    instructions: "Frame 1 opens with the problem the viewer has (or a decisive clinical clue) in ONE spoken sentence of at most 14 words. Its on-screen idea is the question itself in ≤ 6 words; highlight the word that creates the tension. No greeting, no channel name.",
  }),
  motion({
    key: "typography_hierarchy",
    name: "Visual Hierarchy & Typography",
    kind: "logic",
    description: "One big line per frame sized by its length, a supporting card below, captions at the bottom edge of the safe zone; bundled Geist / Noto Sans Devanagari / Kalam fonts only.",
    instructions: "",
  }),
  motion({
    key: "kinetic_typography",
    name: "Kinetic Typography",
    kind: "logic",
    description: "Every spoken word appears at the second it is spoken; the highlighted word lands with a marker sweep at its spoken time.",
    instructions: "",
  }),
  motion({
    key: "animated_diagrams",
    name: "Animated Educational Diagrams",
    kind: "logic",
    extends: "diagram_explainer",
    description: "Flow nodes and arrows draw in one by one as their label is spoken; the Concept Map style moves the camera across the map. Builds on Diagram Explainer (schematic only, no anatomy).",
    instructions: "",
  }),
  motion({
    key: "medical_infographics",
    name: "Medical Infographic Animation",
    kind: "prompt",
    description: "Turns numbers, comparisons and sequences into count-up stats, compare cards and step lists — only with values the model is sure of.",
    instructions: "Use a stat frame only for a number you are certain of from standard references (otherwise set needsReview true). Use compare frames for two things students confuse (e.g. Troponin vs CK-MB). Use steps for sequences (2–4 items, ≤ 5 words each).",
  }),
  motion({
    key: "mcq_reveal",
    name: "MCQ Question & Answer Reveal",
    kind: "logic",
    extends: "mcq_explainer",
    description: "Question frames show the Question Bank stem and options exactly as stored; only the STORED answer is revealed, after a pause. No stored answer = no reveal. Builds on MCQ Explainer.",
    instructions: "",
  }),
  motion({
    key: "style_transitions",
    name: "Scene Transitions",
    kind: "logic",
    extends: "cinematic_motion_director",
    description: "One transition for the whole video, set by the style (continuous camera, slide, smooth-up, fade through black…) — never mixed.",
    instructions: "",
  }),
  motion({
    key: "timing_pacing",
    name: "Timing & Pacing",
    kind: "logic",
    description: "Frame lengths come from the narration itself; every frame gets enough reading time; the total stays near the target length.",
    instructions: "",
  }),
  motion({
    key: "voiceover_sync",
    name: "Voice-over Synchronisation",
    kind: "logic",
    extends: "voice_director",
    description: "One continuous narration take (steady tone), then optional word timestamps from transcribing it, so captions and highlights land exactly when spoken. Without the transcription the words follow an estimate.",
    instructions: "",
  }),
  motion({
    key: "safe_zone_captions",
    name: "Subtitle Placement & Safe Zones",
    kind: "logic",
    extends: "subtitle_generator",
    description: "9:16 keeps everything out of the top 14 % and the bottom 35 % (269 / 672 px) and 6 % clear at each side (65 px); captions sit at the bottom edge of the safe zone.",
    instructions: "",
  }),
  motion({
    key: "style_consistency",
    name: "Backgrounds & Visual Consistency",
    kind: "logic",
    description: "Style lock: one palette, one layout, one texture (grain only where the style has it) and one highlight treatment from the first frame to the last.",
    instructions: "",
  }),
  motion({
    key: "sound_timing",
    name: "Sound Effects & Music Timing",
    kind: "planner",
    description: "Voice first: no background music by default (a clean voice with the words landing on time feels more premium). Licensed music, if added, is ducked under the voice. Sound effects need a licensed library — none is configured.",
    instructions: "",
  }),
  motion({
    key: "end_card_cta",
    name: "End Card & Call to Action",
    kind: "prompt",
    description: "The last frame tells the viewer exactly what to do (one action), with the brand on screen.",
    instructions: "The last frame is the end card: ONE action for the viewer in one spoken sentence (the call to action given), on-screen ≤ 5 words, visual type cta. Never promise offers, prices or results that were not given.",
  }),
  motion({
    key: "motion_quality_checker",
    name: "Video Quality Assurance",
    kind: "logic",
    required: true,
    extends: "video_quality_checker",
    description: "“Check it like a stranger”, automated: one idea per frame, highlight present, no look-alike frames, safe zone, reading time, contrast, glyphs, words never after they are spoken, stored answers only, CTA last — before anything paid, and again on the MP4.",
    instructions: "",
  }),
];
