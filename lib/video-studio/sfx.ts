/**
 * Sound-effect library for the AI Video Editor (client-safe, pure).
 *
 * Pre-rendered WAVs in public/video-studio/sfx (48 kHz, 24-bit, peak −3 dBFS), generated once, offline,
 * with Earshot 0.4.0 (MIT, github.com/Leonxlnx/earshot @ 591fa3e) from its procedural sound bank and
 * audited with its model-free check (clicks, clipping, DC, ring, truncation). Rendering never runs
 * Earshot: the render container mixes these files with FFmpeg. Install record and regeneration
 * commands: /opt/tools/earshot/INSTALL-RECORD.md (pack mts-edu-v1).
 *
 * Effects are optional: nothing here is ever added to a video unless the editor puts it on the timeline.
 */

export const SFX_CATEGORIES = ["transition", "text", "emphasis", "reveal", "typing"] as const;
export type SfxCategory = (typeof SFX_CATEGORIES)[number];
export const SFX_CATEGORY_LABELS: Record<SfxCategory, string> = {
  transition: "Transitions",
  text: "Text & lists",
  emphasis: "Emphasis",
  reveal: "Answer reveal",
  typing: "Typing & writing",
};

export interface SfxSound {
  key: string;
  label: string;
  category: SfxCategory;
  /** File name in public/video-studio/sfx (served at /video-studio/sfx/<file>, mounted at /sfx in the render container). */
  file: string;
  durationSec: number;
  /**
   * Seconds from the start of the file to its loudest sample (line a whoosh's peak up with a cut).
   * Measured on the bundled files (scripts/verify-video-sfx.ts re-checks it, ±2 ms); Earshot's
   * manifest peakAtS uses a different estimate and is up to 27 ms off.
   */
  peakAtSec: number;
  peakDbfs: number;
  /** Earshot bank id the file was rendered from. */
  source: string;
  sha256: string;
}

const S = (key: string, label: string, category: SfxCategory, durationSec: number, peakAtSec: number, source: string, sha256: string): SfxSound => ({
  key,
  label,
  category,
  file: `${key}.wav`,
  durationSec,
  peakAtSec,
  peakDbfs: -3,
  source,
  sha256,
});

export const SFX_LIBRARY: SfxSound[] = [
  S("transition_whoosh", "Whoosh (crisp)", "transition", 1.056, 0.136, "whoosh_fast/crisp", "808829954b26fe2931211c06279b85e040d82c97e4bbbc4ca3e39473b4274f67"),
  S("transition_whip", "Whip", "transition", 0.91, 0.113, "whoosh_fast/whip", "ae0778a638f46f49936093335f3a7f378e0e8a4acef8f25fcb6761658c3c7ac7"),
  S("transition_swipe", "Paper swipe", "transition", 0.77, 0.13, "swipe/paper", "516f6afb055a63bea9cdd6b92fafe304ed09f2fae6d1da1612d7df9883acf6a7"),
  S("transition_big", "Big swell", "transition", 1.355, 0.435, "whoosh_big/swell", "94c9c54db6d02e54ba889c7fb63297ce18a71b159acd90316e7966845fe06715"),
  S("text_pop", "Pop in", "text", 0.172, 0.019, "pro_pop_in/round", "bf59095bd65a7cf881f4aeda7f1baf61aff0ce1766e1c338c393949f8619f384"),
  S("text_pop_soft", "Soft pop", "text", 0.18, 0.042, "ui_pop/soft", "195e7faa2fd23bed35b4545de1a4dacef9f6b1f286a495bbc95d98d75036845b"),
  S("bullet_tick", "Soft tap", "text", 0.13, 0.006, "tap/soft", "685d58e71602076e8369a426ef08cda880f0a5793a11be5663042a4e244f89b8"),
  S("ui_blip", "Blip", "text", 0.118, 0.017, "ui_pop/blip", "1fd0553bfbca307773926976b0d1a5396e5d19e20eb983193adf5600a7c2d5e7"),
  S("typing_run", "Typing run", "typing", 1.755, 0.528, "pro_typing_run/soft", "9f2f587b643334c93e5fc3c648db0d2a49d0eabfa4c00a45b6731f52f1ec91b4"),
  S("typing_key", "Key press", "typing", 0.223, 0.01, "typing_key/crisp", "6c2dd8999877c47b4cb65ee453488363be4c7f8b7957c3c59f6e6b57b006aefe"),
  S("marker_tap", "Marker tap", "typing", 0.154, 0.014, "knock/wood", "51bb77b737eeba90b6b5b524f1637d13d64e516521524cb3593e3e0ce745222e"),
  S("correct_chime", "Correct chime", "reveal", 2.0, 0.007, "notify/m1", "e7036c9a49b2ccfcd01be8ab3dbc6bb895ebe12e46c6b3ed17eab13626a6ccf7"),
  S("reveal_marimba", "Marimba reveal", "reveal", 0.564, 0.033, "mallet/marimba", "7de4bae079de54e62703738eff0b66eb8313283f04660571b111fc3d67d6040d"),
  S("build_riser", "Build-up riser", "emphasis", 1.5, 0.951, "riser/build", "ac50762d208959d2698f009ba66e5ff447ef620435a861ffcc0d0ce729e6701d"),
  S("logo_sting", "Logo sting", "emphasis", 1.85, 0.307, "logo_sting/soft_bloom", "d2529a98888f3978dfcdbb792eb3032aa41f3b33ab6d1d0d49abb37f42ba0ece"),
  S("emphasis_drop", "Sub drop", "emphasis", 1.004, 0.005, "sub_drop/punch", "e2925e6da2873e66a53b9764c2c074516112d5c7e04eb7f2373b50104abcb42f"),
];

export const SFX_MAP: Record<string, SfxSound> = Object.fromEntries(SFX_LIBRARY.map((s) => [s.key, s]));

/** Browser preview URL of a sound (static file). */
export function sfxUrl(key: string): string | null {
  const s = SFX_MAP[key];
  return s ? `/video-studio/sfx/${s.file}` : null;
}
