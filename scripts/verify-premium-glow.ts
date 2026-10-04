/**
 * PREMIUM GLOW EFFECTS — config + storage checks, and the fixture for
 * scripts/verify-premium-glow.mjs (the browser half).
 *
 *   unit            → parse / strict validate / CSS emission (no DB writes
 *                     except a save+read round trip of ui.premium_glow).
 *   setup           → a FULL_ADMIN account (read-only RBAC check) and the
 *                     WhatsApp question-share switched on, so the review
 *                     page renders its Share on WhatsApp button. Prints JSON.
 *   reveal <studentId> <submittedAttemptId> <runningAttemptId> <questionId>
 *                   → the review-context Ask AI rule: the question is
 *                     IN_PROGRESS overall (a running attempt has it), yet
 *                     reviewable inside the submitted attempt only.
 *   cleanup         → removes what setup created and the ui.premium_glow row.
 *
 * DISPOSABLE database only:
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-premium-glow.ts unit
 */
import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_PREMIUM_GLOW_COLOR,
  PREMIUM_GLOW_PRESETS,
  PREMIUM_GLOW_TARGETS,
  defaultPremiumGlowConfig,
  parsePremiumGlowConfig,
  premiumGlowToCss,
  premiumGlowVariables,
  validatePremiumGlowConfig,
} from "@/lib/premium-glow";
import { PREMIUM_GLOW_SETTING_KEY, getPremiumGlowConfig, savePremiumGlowConfig } from "@/lib/premium-glow-settings";
import { getAnswerRevealStatus, isQuestionReviewableInAttempt } from "@/lib/student-data";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

const FULL_ADMIN_USERNAME = "glowqa-full";
const FULL_ADMIN_PASSWORD = "GlowQaFull!2026pass";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

async function unit() {
  console.log("--- defaults ---");
  const d = defaultPremiumGlowConfig();
  check("default: master ON, all five targets ON", d.enabled && PREMIUM_GLOW_TARGETS.every((t) => d.targets[t]));
  check("default: current violet #9592FA, Medium, Normal", d.color === DEFAULT_PREMIUM_GLOW_COLOR && d.color === "#9592FA" && d.intensity === "MEDIUM" && d.speed === "NORMAL");
  check("allowlist is exactly the five supported targets", PREMIUM_GLOW_TARGETS.join() === "ASK_AI,AI_QUESTION_VARIANT,WHATSAPP_SHARE,THEME_TOGGLE,TEXT_SIZE");
  check("six presets incl. Purple = default", PREMIUM_GLOW_PRESETS.map((p) => p.name).join() === "Purple,Blue,Cyan,Green,Gold,Pink" && PREMIUM_GLOW_PRESETS[0].color === d.color);

  console.log("--- tolerant parse (read path) ---");
  check("missing doc → defaults", JSON.stringify(parsePremiumGlowConfig(null)) === JSON.stringify(d));
  const junk = parsePremiumGlowConfig({
    enabled: "false",
    targets: { ASK_AI: "no", WHATSAPP_SHARE: false, "body{}": false },
    color: "red;}</style><script>",
    intensity: "EXTREME",
    speed: "0.1s",
  });
  check("string booleans ignored, real boolean kept", junk.enabled === true && junk.targets.ASK_AI === true && junk.targets.WHATSAPP_SHARE === false);
  check("unknown target key dropped", !("body{}" in junk.targets));
  check("injection color → default color", junk.color === d.color);
  check("bad enums → defaults", junk.intensity === "MEDIUM" && junk.speed === "NORMAL");
  check("lower-case hex normalised to upper", parsePremiumGlowConfig({ color: "#22c55e" }).color === "#22C55E");

  console.log("--- strict validation (save path) ---");
  const good = { ...d, targets: { ...d.targets }, color: "#123abc", intensity: "HIGH", speed: "FAST" };
  const v = validatePremiumGlowConfig(good);
  check("valid custom config accepted", v.ok && v.config.color === "#123ABC" && v.config.intensity === "HIGH");
  for (const [label, bad] of [
    ["invalid HEX #12345", { ...good, color: "#12345" }],
    ["invalid HEX 8B5CF6 (no #)", { ...good, color: "8B5CF6" }],
    ["named color", { ...good, color: "purple" }],
    ["CSS injection in color", { ...good, color: "#123456;}" }],
    ["intensity enum", { ...good, intensity: "ULTRA" }],
    ["speed enum", { ...good, speed: "0.2s" }],
    ["string boolean master", { ...good, enabled: "true" }],
    ["string boolean target", { ...good, targets: { ...good.targets, ASK_AI: "true" } }],
    ["unknown/arbitrary target", { ...good, targets: { ...good.targets, "a{x:y}": true } }],
    ["missing target", { ...good, targets: { ASK_AI: true } }],
    ["not an object", "x"],
  ] as const) {
    check(`rejects ${label}`, !validatePremiumGlowConfig(bad).ok);
  }

  console.log("--- CSS emission ---");
  const on = premiumGlowToCss(d);
  check("defaults: vars only, no off rule", on.startsWith(":root{--premium-glow-color:#9592FA;--premium-glow-duration:2.5s;") && !on.includes(".premium-glow"), on);
  const wa = premiumGlowToCss({ ...d, targets: { ...d.targets, WHATSAPP_SHARE: false } });
  check("WhatsApp off: one targeted off rule", wa.includes('.premium-glow[data-glow-target="WHATSAPP_SHARE"]{--premium-glow-animation:none;--premium-glow-rest:0%;}') && !wa.includes("ASK_AI"), wa);
  const master = premiumGlowToCss({ ...d, enabled: false });
  check("master off: every .premium-glow off", master.endsWith(".premium-glow{--premium-glow-animation:none;--premium-glow-rest:0%;}"), master);
  check("speeds 3.5s / 2.5s / 1.5s", ["SLOW", "NORMAL", "FAST"].map((s) => premiumGlowVariables({ ...d, speed: s as never })["--premium-glow-duration"]).join() === "3.5s,2.5s,1.5s");
  const blur = (i: string) => parseInt(premiumGlowVariables({ ...d, intensity: i as never })["--premium-glow-blur"]);
  check("intensity Low < Medium < High", blur("LOW") < blur("MEDIUM") && blur("MEDIUM") < blur("HIGH"));
  check("emitted CSS never contains < or }} breakouts", !/[<>]/.test(master + wa + on));

  console.log("--- Setting storage round trip ---");
  await prisma.setting.deleteMany({ where: { key: PREMIUM_GLOW_SETTING_KEY } });
  check("no row → defaults", JSON.stringify(await getPremiumGlowConfig()) === JSON.stringify(d));
  if (v.ok) await savePremiumGlowConfig(v.config);
  const row = await prisma.setting.findUnique({ where: { key: PREMIUM_GLOW_SETTING_KEY } });
  check("saved in the existing Setting table under ui.premium_glow", !!row && (row.value as { color?: string }).color === "#123ABC");
  check("read back from DB", (await getPremiumGlowConfig()).color === "#123ABC");
  await prisma.setting.update({ where: { key: PREMIUM_GLOW_SETTING_KEY }, data: { value: { color: "javascript:alert(1)", enabled: false } } });
  check("tampered row parsed safely (fresh process sees sanitised value)", parsePremiumGlowConfig((await prisma.setting.findUnique({ where: { key: PREMIUM_GLOW_SETTING_KEY } }))!.value).color === d.color);
  await prisma.setting.deleteMany({ where: { key: PREMIUM_GLOW_SETTING_KEY } });
}

async function setup() {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: "FULL_ADMIN" }, select: { id: true } });
  const passwordHash = await argon2.hash(FULL_ADMIN_PASSWORD);
  await prisma.adminUser.upsert({
    where: { username: FULL_ADMIN_USERNAME },
    update: { passwordHash, roleId: role.id, isActive: true },
    create: { name: "Glow QA Full Admin", username: FULL_ADMIN_USERNAME, passwordHash, roleId: role.id },
  });
  await prisma.setting.upsert({
    where: { key: "question.whatsapp_share" },
    update: { value: { enabled: true } },
    create: { key: "question.whatsapp_share", value: { enabled: true } },
  });
  console.log(JSON.stringify({ fullAdmin: { username: FULL_ADMIN_USERNAME, password: FULL_ADMIN_PASSWORD } }));
}

async function reveal(studentId: string, submittedId: string, runningId: string, questionId: string) {
  console.log("--- review-context Ask AI rule ---");
  check("question is IN_PROGRESS overall (another attempt is running)", (await getAnswerRevealStatus(studentId, questionId)) === "IN_PROGRESS");
  check("…but reviewable inside the SUBMITTED attempt", await isQuestionReviewableInAttempt(studentId, submittedId, questionId));
  check("not reviewable via the RUNNING attempt id", !(await isQuestionReviewableInAttempt(studentId, runningId, questionId)));
  const other = await prisma.student.findFirst({ where: { id: { not: studentId } }, select: { id: true } });
  if (other) check("another student can't borrow this attempt id", !(await isQuestionReviewableInAttempt(other.id, submittedId, questionId)));
  check("unknown attempt id → false", !(await isQuestionReviewableInAttempt(studentId, "nope", questionId)));
}

async function cleanup() {
  await prisma.adminUser.deleteMany({ where: { username: FULL_ADMIN_USERNAME } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { key: PREMIUM_GLOW_SETTING_KEY } });
}

const [cmd, ...args] = process.argv.slice(2);
(async () => {
  if (cmd === "unit") await unit();
  else if (cmd === "setup") await setup();
  else if (cmd === "reveal") await reveal(args[0], args[1], args[2], args[3]);
  else if (cmd === "cleanup") await cleanup();
  else {
    console.error("usage: unit | setup | reveal <studentId> <submittedAttemptId> <runningAttemptId> <questionId> | cleanup");
    process.exit(2);
  }
  if (cmd === "unit" || cmd === "reveal") console.log(failures === 0 ? "\nALL PREMIUM GLOW CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  await prisma.$disconnect();
  if (failures) process.exitCode = 1;
})();
