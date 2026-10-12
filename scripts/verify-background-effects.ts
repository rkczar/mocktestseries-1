/**
 * BACKGROUND EFFECTS — config + storage checks, and the fixture for
 * scripts/verify-background-effects.mjs (the browser half).
 *
 *   unit     → defaults (OFF), tolerant parse, strict validation (ranges,
 *              enums, hex colors, CSS-injection attempts), per-design
 *              independence, scope coverage, excluded routes, and a save +
 *              read round trip of ui.background_effects that leaves
 *              ui.premium_glow (button glow) untouched.
 *   render   → renderer output for every design × glow ON/OFF. Run WITHOUT
 *              --conditions=react-server (react-dom/server refuses it).
 *   setup    → a FULL_ADMIN account (read-only RBAC check). Prints JSON.
 *   cleanup  → removes what setup created and the ui.background_effects row.
 *
 * DISPOSABLE database only:
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-background-effects.ts unit
 *   npx tsx scripts/verify-background-effects.ts render
 */
import "dotenv/config";
import {
  BG_DESIGNS,
  BG_EXCLUDED_PREFIXES,
  defaultBackgroundEffectsConfig,
  isBgExcludedPath,
  parseBackgroundEffectsConfig,
  scopeCovers,
  validateBackgroundEffectsConfig,
  type BackgroundEffectsConfig,
} from "@/lib/background-effects";
// DB and renderer modules are imported per mode: the settings module is
// server-only (needs react-server), react-dom/server refuses react-server.

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

const FULL_ADMIN_USERNAME = "bgfxqa-full";
const FULL_ADMIN_PASSWORD = "BgfxQaFull!2026pass";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}`, detail ?? "");
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// Deliberately untyped: these tests feed the validator malformed documents.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const layers = (html: string, kind: string) => (html.match(new RegExp(`data-bgfx-layer="${kind}"`, "g")) ?? []).length;

async function unit() {
  // --- Defaults -------------------------------------------------------------
  const d = defaultBackgroundEffectsConfig();
  check("default: OFF", d.enabled === false);
  check("default: Dotted Watermark / Homepage Only / Automatic", d.design === "DOTTED_WATERMARK" && d.scope === "HOMEPAGE" && d.theme === "AUTO");
  const wm = d.designs.DOTTED_WATERMARK;
  check("default Design 1: 10% opacity, 2px dots (Medium), 8px spacing, Center, Large", wm.opacity === 10 && wm.dotSize === "MEDIUM" && wm.dotSpacing === 8 && wm.watermarkPosition === "CENTER" && wm.watermarkScale === "LARGE");
  const pat = d.designs.DOTTED_PATTERN;
  check("default Design 2: 1.5px dots (Small), 18px spacing, 8% opacity", pat.dotSize === "SMALL" && pat.dotSpacing === 18 && pat.opacity === 8);
  check("default Galaxy: 4 s, 500 particles, animation OFF", d.designs.GALAXY.galaxyDuration === 4 && d.designs.GALAXY.galaxyParticles === 500 && !d.designs.GALAXY.galaxyAnimate);
  check("default: glow OFF on every design", BG_DESIGNS.every((x) => !d.designs[x].glowEnabled && !d.designs[x].glowAnimation));
  check("missing / broken row reads as OFF defaults", JSON.stringify(parseBackgroundEffectsConfig(null)) === JSON.stringify(d) && JSON.stringify(parseBackgroundEffectsConfig("garbage")) === JSON.stringify(d));

  // --- Strict validation ----------------------------------------------------
  check("defaults validate", validateBackgroundEffectsConfig(d).ok);
  const bad = (label: string, mutate: (c: Loose) => void) => {
    const c = clone(d) as Loose;
    mutate(c);
    const r = validateBackgroundEffectsConfig(c);
    check(`rejects ${label}`, !r.ok, r);
  };
  bad("opacity 0", (c) => (c.designs.DOTTED_WATERMARK.opacity = 0));
  bad("opacity 21", (c) => (c.designs.DOTTED_PATTERN.opacity = 21));
  bad("opacity 5.5", (c) => (c.designs.DOTTED_PATTERN.opacity = 5.5));
  bad("dot spacing 2", (c) => (c.designs.DOTTED_PATTERN.dotSpacing = 2));
  bad("dot spacing 999", (c) => (c.designs.DOTTED_PATTERN.dotSpacing = 999));
  bad("unknown dot size", (c) => (c.designs.DOTTED_WATERMARK.dotSize = "HUGE"));
  bad("glow intensity 101", (c) => (c.designs.GRADIENT_DOTS.glowIntensity = 101));
  bad("glow intensity -1", (c) => (c.designs.GRADIENT_DOTS.glowIntensity = -1));
  bad("unknown glow spread", (c) => (c.designs.GRADIENT_DOTS.glowSpread = "MAX"));
  bad("galaxy duration 1", (c) => (c.designs.GALAXY.galaxyDuration = 1));
  bad("galaxy duration 7", (c) => (c.designs.GALAXY.galaxyDuration = 7));
  bad("galaxy duration 3.3", (c) => (c.designs.GALAXY.galaxyDuration = 3.3));
  bad("particles 501", (c) => (c.designs.GALAXY.galaxyParticles = 501));
  bad("particles 5000", (c) => (c.designs.GALAXY.galaxyParticles = 5000));
  bad("particles NaN (as string)", (c) => (c.designs.GALAXY.galaxyParticles = "500"));
  bad("unknown design", (c) => (c.design = "MATRIX"));
  bad("extra design key", (c) => (c.designs.EVIL = c.designs.GALAXY));
  bad("missing design", (c) => delete c.designs.GALAXY);
  bad("unknown scope", (c) => (c.scope = "EVERYWHERE"));
  bad("unknown theme", (c) => (c.theme = "NEON"));
  bad("enabled as string", (c) => (c.enabled = "true"));
  bad("unknown dot color", (c) => (c.designs.DOTTED_WATERMARK.dotColor = "red"));
  // CSS / markup injection through the free-text color fields.
  for (const v of ["red", "#FFF", "#12345G", "#123456;background:url(x)", "#123456)", "url(javascript:alert(1))", "</style><script>alert(1)</script>", "var(--x)", "expression(alert(1))"]) {
    bad(`custom dot color ${JSON.stringify(v)}`, (c) => {
      c.designs.DOTTED_WATERMARK.dotColor = "CUSTOM";
      c.designs.DOTTED_WATERMARK.dotCustomColor = v;
    });
    bad(`custom glow color ${JSON.stringify(v)}`, (c) => (c.designs.DOTTED_WATERMARK.glowCustomColor = v));
  }
  const okCustom = clone(d);
  okCustom.designs.DOTTED_WATERMARK.dotColor = "CUSTOM";
  okCustom.designs.DOTTED_WATERMARK.dotCustomColor = "#abcdef";
  const vr = validateBackgroundEffectsConfig(okCustom);
  check("accepts #RRGGBB custom color (normalized upper-case)", vr.ok && vr.config.designs.DOTTED_WATERMARK.dotCustomColor === "#ABCDEF", vr);
  const extraField = clone(d) as Loose;
  extraField.designs.DOTTED_WATERMARK.style = "background:url(//evil)";
  extraField.css = "body{display:none}";
  const er = validateBackgroundEffectsConfig(extraField);
  check("unknown fields are dropped, never stored", er.ok && !("style" in er.config.designs.DOTTED_WATERMARK) && !("css" in er.config), er);

  // Tolerant read clamps instead of failing.
  const tampered = parseBackgroundEffectsConfig({
    enabled: true,
    design: "GALAXY",
    designs: { GALAXY: { opacity: 90, galaxyParticles: 99999, galaxyDuration: 60, dotCustomColor: "red;x", dotColor: "CUSTOM" } },
  });
  check(
    "read clamps a tampered row (opacity 20, particles 500, duration 6, bad hex → default)",
    tampered.designs.GALAXY.opacity === 20 && tampered.designs.GALAXY.galaxyParticles === 500 && tampered.designs.GALAXY.galaxyDuration === 6 && tampered.designs.GALAXY.dotCustomColor === "#7DD3FC",
    tampered.designs.GALAXY
  );

  // --- Scope ----------------------------------------------------------------
  check("Homepage Only covers only the homepage", scopeCovers("HOMEPAGE", "HOMEPAGE") && !scopeCovers("HOMEPAGE", "PUBLIC") && !scopeCovers("HOMEPAGE", "STUDENT"));
  check("Public Website covers homepage + public pages, not the dashboard", scopeCovers("PUBLIC", "HOMEPAGE") && scopeCovers("PUBLIC", "PUBLIC") && !scopeCovers("PUBLIC", "STUDENT"));
  check("Student Dashboard covers only the dashboard", scopeCovers("STUDENT_DASHBOARD", "STUDENT") && !scopeCovers("STUDENT_DASHBOARD", "HOMEPAGE"));
  check("Homepage + Student Dashboard", scopeCovers("HOMEPAGE_AND_DASHBOARD", "HOMEPAGE") && scopeCovers("HOMEPAGE_AND_DASHBOARD", "STUDENT") && !scopeCovers("HOMEPAGE_AND_DASHBOARD", "PUBLIC"));
  const excluded = ["/student/attempt/abc/run", "/student/attempt/abc/review", "/student/attempt/abc/result", "/student/omr", "/student/checkout/PLAN1", "/live-cbt/xyz", "/admin", "/admin/website/appearance"];
  const allowed = ["/", "/student/dashboard", "/student/exams", "/exams/ruhs-mo", "/plans-and-pricing", "/student/omr-guide", "/admins"];
  check("excluded routes (Test Player, review, OMR, checkout, Live CBT, Admin)", excluded.every(isBgExcludedPath), excluded.filter((p) => !isBgExcludedPath(p)));
  check("ordinary routes are not excluded", allowed.every((p) => !isBgExcludedPath(p)), allowed.filter(isBgExcludedPath));
  check("excluded list unchanged", BG_EXCLUDED_PREFIXES.length === 5);

  // --- Storage + independence -----------------------------------------------
  const { prisma } = await import("@/lib/prisma");
  const { BACKGROUND_EFFECTS_SETTING_KEY, getBackgroundEffectsConfig, getBackgroundEffectsFor, saveBackgroundEffectsConfig } = await import("@/lib/background-effects-settings");
  const { PREMIUM_GLOW_SETTING_KEY } = await import("@/lib/premium-glow-settings");
  const glowBefore = await prisma.setting.findUnique({ where: { key: PREMIUM_GLOW_SETTING_KEY } });
  await prisma.setting.deleteMany({ where: { key: BACKGROUND_EFFECTS_SETTING_KEY } });
  const c = clone(d);
  c.enabled = true;
  c.scope = "PUBLIC";
  // The task's own example: four designs, four different settings.
  Object.assign(c.designs.DOTTED_WATERMARK, { dotColor: "SOFT_BLUE", opacity: 10, glowEnabled: true, glowColor: "CYAN", glowIntensity: 30 });
  Object.assign(c.designs.DOTTED_PATTERN, { dotColor: "GREY", opacity: 6, glowEnabled: true, glowColor: "BLUE", glowIntensity: 15 });
  Object.assign(c.designs.GALAXY, { dotColor: "WHITE", glowEnabled: true, glowColor: "PURPLE", glowIntensity: 40 });
  Object.assign(c.designs.GRADIENT_DOTS, { dotColor: "SOFT_BLUE", opacity: 8, glowEnabled: true, glowColor: "CYAN", glowIntensity: 20 });
  const v = validateBackgroundEffectsConfig(c);
  check("independent example validates", v.ok, v);
  if (v.ok) await saveBackgroundEffectsConfig(v.config);
  // Switch the active design four times; nothing else may move.
  for (const design of BG_DESIGNS) {
    const cur = await getBackgroundEffectsConfig();
    const next = clone(cur);
    next.design = design;
    const r = validateBackgroundEffectsConfig(next);
    if (r.ok) await saveBackgroundEffectsConfig(r.config);
  }
  const row = await prisma.setting.findUnique({ where: { key: BACKGROUND_EFFECTS_SETTING_KEY } });
  const stored = parseBackgroundEffectsConfig(row?.value);
  check("stored after design switches: active design = last selected", stored.design === "GRADIENT_DOTS");
  check(
    "each design kept its own settings across switches",
    JSON.stringify(stored.designs) === JSON.stringify(v.ok ? v.config.designs : null),
    stored.designs
  );
  check("Design 2 kept Grey / 6% / Blue / 15%", stored.designs.DOTTED_PATTERN.dotColor === "GREY" && stored.designs.DOTTED_PATTERN.opacity === 6 && stored.designs.DOTTED_PATTERN.glowColor === "BLUE" && stored.designs.DOTTED_PATTERN.glowIntensity === 15);
  check("Design 3 kept White / Purple / 40%", stored.designs.GALAXY.dotColor === "WHITE" && stored.designs.GALAXY.glowColor === "PURPLE" && stored.designs.GALAXY.glowIntensity === 40);
  check("getBackgroundEffectsFor: PUBLIC scope → homepage + public, not dashboard", !!(await getBackgroundEffectsFor("HOMEPAGE")) && !!(await getBackgroundEffectsFor("PUBLIC")) && (await getBackgroundEffectsFor("STUDENT")) === null);
  const offCfg = clone(stored);
  offCfg.enabled = false;
  await saveBackgroundEffectsConfig(offCfg);
  check("OFF → nothing on any surface", (await getBackgroundEffectsFor("HOMEPAGE")) === null && (await getBackgroundEffectsFor("PUBLIC")) === null && (await getBackgroundEffectsFor("STUDENT")) === null);
  check("OFF keeps every design's settings", JSON.stringify(parseBackgroundEffectsConfig((await prisma.setting.findUnique({ where: { key: BACKGROUND_EFFECTS_SETTING_KEY } }))?.value).designs) === JSON.stringify(stored.designs));
  const glowAfter = await prisma.setting.findUnique({ where: { key: PREMIUM_GLOW_SETTING_KEY } });
  check("button glow (ui.premium_glow) untouched", JSON.stringify(glowBefore?.value ?? null) === JSON.stringify(glowAfter?.value ?? null));
  check("separate Setting keys", BACKGROUND_EFFECTS_SETTING_KEY === "ui.background_effects" && (BACKGROUND_EFFECTS_SETTING_KEY as string) !== PREMIUM_GLOW_SETTING_KEY);
  await prisma.setting.deleteMany({ where: { key: BACKGROUND_EFFECTS_SETTING_KEY } });

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
}

async function renderChecks() {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BackgroundEffectsRenderer } = await import("@/components/background-effects/renderer");
  const render = (config: BackgroundEffectsConfig) => renderToStaticMarkup(createElement(BackgroundEffectsRenderer, { config }));
  const d = defaultBackgroundEffectsConfig();
  // --- Renderer: every design, glow ON / OFF ----------------------------------
  for (const design of BG_DESIGNS) {
    const on = clone(d);
    on.enabled = true;
    on.design = design;
    on.designs[design].glowEnabled = true;
    const off = clone(on);
    off.designs[design].glowEnabled = false;
    const hOn = render(on);
    const hOff = render(off);
    check(`${design}: renders a decorative aria-hidden layer`, hOn.includes('aria-hidden="true"') && hOn.includes(`data-bgfx="${design}"`));
    check(`${design}: glow ON draws glow layers`, layers(hOn, "glow") > 0, layers(hOn, "glow"));
    check(`${design}: glow OFF draws no glow layer`, layers(hOff, "glow") === 0, layers(hOff, "glow"));
    check(`${design}: no <script>, no external url`, !/<script/i.test(hOn) && !/url\((?!(?:"|&quot;)data:image\/svg\+xml|%23b\))/.test(hOn) && hOn.includes("data:image/svg+xml") === (design !== "DOTTED_PATTERN"));
    if (design === "DOTTED_PATTERN") check(`${design}: dot grid layer`, layers(hOn, "dots") === 1);
    else if (design === "GRADIENT_DOTS") check(`${design}: gradient + dots + watermark`, layers(hOn, "gradient") === 1 && layers(hOn, "dots") === 1 && layers(hOn, "watermark") === 2);
    else check(`${design}: dotted wordmark (wide + stacked)`, layers(hOn, "watermark") === 2);
    // Many dots, few elements: the whole design is a handful of nodes.
    check(`${design}: at most 10 elements`, (hOn.match(/<div/g) ?? []).length <= 10, (hOn.match(/<div/g) ?? []).length);
  }
  const gx = clone(d);
  gx.enabled = true;
  gx.design = "GALAXY";
  gx.designs.GALAXY.galaxyAnimate = true;
  const gxHtml = render(gx);
  check("Galaxy animated: server HTML has the still fallback but no canvas (canvas is client-only)", gxHtml.includes('class="gx-fb"') && !gxHtml.includes("<canvas"));
  const custom = clone(d);
  custom.enabled = true;
  custom.designs.DOTTED_WATERMARK.dotColor = "CUSTOM";
  custom.designs.DOTTED_WATERMARK.dotCustomColor = "#123456";
  check("custom dot color reaches the dots as rgb", render(custom).includes("#123456"));

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
}

async function setup() {
  const argon2 = (await import("argon2")).default;
  const { prisma } = await import("@/lib/prisma");
  const role = await prisma.role.findUniqueOrThrow({ where: { name: "FULL_ADMIN" }, select: { id: true } });
  const passwordHash = await argon2.hash(FULL_ADMIN_PASSWORD);
  await prisma.adminUser.upsert({
    where: { username: FULL_ADMIN_USERNAME },
    update: { passwordHash, roleId: role.id, isActive: true },
    create: { name: "Background QA Full Admin", username: FULL_ADMIN_USERNAME, passwordHash, roleId: role.id },
  });
  console.log(JSON.stringify({ fullAdmin: { username: FULL_ADMIN_USERNAME, password: FULL_ADMIN_PASSWORD } }));
}

async function cleanup() {
  const { prisma } = await import("@/lib/prisma");
  const { BACKGROUND_EFFECTS_SETTING_KEY } = await import("@/lib/background-effects-settings");
  await prisma.adminUser.deleteMany({ where: { username: FULL_ADMIN_USERNAME } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { key: BACKGROUND_EFFECTS_SETTING_KEY } });
  console.log("cleaned");
}

const cmd = process.argv[2];
const modes: Record<string, () => Promise<void>> = { unit, render: renderChecks, setup, cleanup };
(modes[cmd] ?? (() => Promise.reject(new Error("usage: unit | render | setup | cleanup"))))()
  .then(() => process.exit(failures ? 1 : 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
