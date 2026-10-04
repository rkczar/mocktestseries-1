/**
 * Premium Glow Effects (Admin → Settings → Glow Effects) — PRESENTATION ONLY.
 *
 * One breathing-glow system (`.premium-glow` in app/globals.css) shared by a
 * fixed allowlist of student-facing buttons. Each button carries
 * `data-glow-target="<TARGET>"`; the admin config only decides whether that
 * target glows and how (color / intensity / speed). It never enables,
 * disables or gates the feature behind the button — AI access and limits,
 * WhatsApp sharing, theme and text size all ignore this config entirely.
 *
 * Pure module (no server imports): the admin form uses the defaults,
 * presets and preview variables from here; lib/premium-glow-settings.ts
 * reads/writes the stored document. Everything here is emitted into the
 * root layout's <style> block, so every value is validated against an
 * allowlist on save AND on read — no free-form CSS or selector can render.
 */

export const PREMIUM_GLOW_TARGETS = ["ASK_AI", "AI_QUESTION_VARIANT", "WHATSAPP_SHARE", "THEME_TOGGLE", "TEXT_SIZE"] as const;
export type PremiumGlowTarget = (typeof PREMIUM_GLOW_TARGETS)[number];

export const PREMIUM_GLOW_TARGET_LABELS: Record<PremiumGlowTarget, string> = {
  ASK_AI: "Ask AI",
  AI_QUESTION_VARIANT: "AI Question Variant",
  WHATSAPP_SHARE: "Share on WhatsApp",
  THEME_TOGGLE: "Theme / Day-Night",
  TEXT_SIZE: "A+ Text / Accessibility",
};

export const PREMIUM_GLOW_INTENSITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type PremiumGlowIntensity = (typeof PREMIUM_GLOW_INTENSITIES)[number];
export const PREMIUM_GLOW_SPEEDS = ["SLOW", "NORMAL", "FAST"] as const;
export type PremiumGlowSpeed = (typeof PREMIUM_GLOW_SPEEDS)[number];

export const PREMIUM_GLOW_HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * The glow color shipped before this setting existed: the Ask AI violet,
 * color-mix(in srgb, #a78bfa 75%, #60a5fa) — resolved to a fixed hex.
 */
export const DEFAULT_PREMIUM_GLOW_COLOR = "#9592FA";

export const PREMIUM_GLOW_PRESETS = [
  { name: "Purple", color: DEFAULT_PREMIUM_GLOW_COLOR },
  { name: "Blue", color: "#3B82F6" },
  { name: "Cyan", color: "#06B6D4" },
  { name: "Green", color: "#22C55E" },
  { name: "Gold", color: "#F59E0B" },
  { name: "Pink", color: "#EC4899" },
] as const;

export interface PremiumGlowConfig {
  enabled: boolean;
  targets: Record<PremiumGlowTarget, boolean>;
  color: string;
  intensity: PremiumGlowIntensity;
  speed: PremiumGlowSpeed;
}

export function defaultPremiumGlowConfig(): PremiumGlowConfig {
  return {
    enabled: true,
    targets: { ASK_AI: true, AI_QUESTION_VARIANT: true, WHATSAPP_SHARE: true, THEME_TOGGLE: true, TEXT_SIZE: true },
    color: DEFAULT_PREMIUM_GLOW_COLOR,
    intensity: "MEDIUM",
    speed: "NORMAL",
  };
}

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

/**
 * Tolerant parse of a stored document: each field falls back to its default
 * on its own when missing or malformed. Booleans must be real booleans.
 * Unknown target keys are dropped, so the allowlist is the only source.
 */
export function parsePremiumGlowConfig(raw: unknown): PremiumGlowConfig {
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = defaultPremiumGlowConfig();
  if (typeof doc.enabled === "boolean") out.enabled = doc.enabled;
  const targets = doc.targets && typeof doc.targets === "object" ? (doc.targets as Record<string, unknown>) : {};
  for (const t of PREMIUM_GLOW_TARGETS) if (typeof targets[t] === "boolean") out.targets[t] = targets[t];
  if (typeof doc.color === "string" && PREMIUM_GLOW_HEX_RE.test(doc.color)) out.color = doc.color.toUpperCase();
  if (isOneOf(PREMIUM_GLOW_INTENSITIES, doc.intensity)) out.intensity = doc.intensity;
  if (isOneOf(PREMIUM_GLOW_SPEEDS, doc.speed)) out.speed = doc.speed;
  return out;
}

/**
 * Strict validation for an admin save: unlike parsePremiumGlowConfig it
 * rejects instead of defaulting, so a bad value is reported, never
 * silently replaced.
 */
export function validatePremiumGlowConfig(raw: unknown): { ok: true; config: PremiumGlowConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid settings." };
  const doc = raw as Record<string, unknown>;
  if (typeof doc.enabled !== "boolean") return { ok: false, error: "Premium Glow Effects must be ON or OFF." };
  if (!doc.targets || typeof doc.targets !== "object") return { ok: false, error: "Invalid button settings." };
  const targets = doc.targets as Record<string, unknown>;
  const keys = Object.keys(targets);
  if (keys.length !== PREMIUM_GLOW_TARGETS.length || keys.some((k) => !isOneOf(PREMIUM_GLOW_TARGETS, k))) {
    return { ok: false, error: "Unknown glow button." };
  }
  for (const t of PREMIUM_GLOW_TARGETS) {
    if (typeof targets[t] !== "boolean") return { ok: false, error: `${PREMIUM_GLOW_TARGET_LABELS[t]} must be ON or OFF.` };
  }
  if (typeof doc.color !== "string" || !PREMIUM_GLOW_HEX_RE.test(doc.color)) {
    return { ok: false, error: "Glow Color must be a 6-digit hex color like #8B5CF6." };
  }
  if (!isOneOf(PREMIUM_GLOW_INTENSITIES, doc.intensity)) return { ok: false, error: "Glow Intensity must be Low, Medium or High." };
  if (!isOneOf(PREMIUM_GLOW_SPEEDS, doc.speed)) return { ok: false, error: "Animation Speed must be Slow, Normal or Fast." };
  return {
    ok: true,
    config: {
      enabled: doc.enabled,
      targets: Object.fromEntries(PREMIUM_GLOW_TARGETS.map((t) => [t, targets[t] as boolean])) as Record<PremiumGlowTarget, boolean>,
      color: doc.color.toUpperCase(),
      intensity: doc.intensity,
      speed: doc.speed,
    },
  };
}

/** Breath length per speed. Fast stays a slow, smooth pulse — never a flash. */
const DURATION: Record<PremiumGlowSpeed, string> = { SLOW: "3.5s", NORMAL: "2.5s", FAST: "1.5s" };

/**
 * Per-intensity strength, consumed by the box-shadow/filter in
 * app/globals.css (.premium-glow + @keyframes premium-glow). MEDIUM is the
 * exact glow shipped before this setting existed. HIGH is a wider, brighter
 * halo on the same smooth ease-in-out curve — it never flashes.
 */
const STRENGTH: Record<PremiumGlowIntensity, Record<string, string>> = {
  LOW: {
    "--premium-glow-rest": "18%",
    "--premium-glow-peak": "38%",
    "--premium-glow-ring": "1px",
    "--premium-glow-blur": "14px",
    "--premium-glow-spread": "2px",
    "--premium-glow-brightness": "1.08",
  },
  MEDIUM: {
    "--premium-glow-rest": "25%",
    "--premium-glow-peak": "55%",
    "--premium-glow-ring": "2px",
    "--premium-glow-blur": "22px",
    "--premium-glow-spread": "4px",
    "--premium-glow-brightness": "1.15",
  },
  HIGH: {
    "--premium-glow-rest": "32%",
    "--premium-glow-peak": "68%",
    "--premium-glow-ring": "2px",
    "--premium-glow-blur": "28px",
    "--premium-glow-spread": "6px",
    "--premium-glow-brightness": "1.2",
  },
};

/** The CSS custom properties for one config — used by the root <style> and the admin live preview alike. */
export function premiumGlowVariables(config: Pick<PremiumGlowConfig, "color" | "intensity" | "speed">): Record<string, string> {
  return {
    "--premium-glow-color": config.color,
    "--premium-glow-duration": DURATION[config.speed],
    ...STRENGTH[config.intensity],
  };
}

/** Element-level overrides that switch one glow off (static and animated parts). */
export const PREMIUM_GLOW_OFF_VARIABLES: Record<string, string> = {
  "--premium-glow-animation": "none",
  "--premium-glow-rest": "0%",
};

/**
 * The site-wide rules appended to the root layout's <style>: the variables
 * on :root, plus one small rule switching off each disabled target (or
 * every glow when the master switch is off). The off rule sets custom
 * properties on the element itself, so it always beats the inherited :root
 * values regardless of stylesheet order. Every interpolated value comes
 * from the allowlists above — never from free text.
 */
export function premiumGlowToCss(config: PremiumGlowConfig): string {
  const decl = (vars: Record<string, string>) =>
    Object.entries(vars)
      .map(([k, v]) => `${k}:${v};`)
      .join("");
  const off = config.enabled ? PREMIUM_GLOW_TARGETS.filter((t) => !config.targets[t]) : null;
  const selector = off === null ? ".premium-glow" : off.map((t) => `.premium-glow[data-glow-target="${t}"]`).join(",");
  return `:root{${decl(premiumGlowVariables(config))}}` + (selector ? `${selector}{${decl(PREMIUM_GLOW_OFF_VARIABLES)}}` : "");
}
