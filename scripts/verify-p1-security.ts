/**
 * Regression coverage for the pre-launch security P1 fixes (2026-09-25):
 *   P1-04 trusted client IP (lib/client-ip.ts)
 *   P1-05 central auth abuse limits (lib/auth-rate-limit.ts, lib/otp.ts)
 *   P1-02 Appearance allow-lists (lib/appearance.ts)
 *   P1-01 FULL_ADMIN global read-only (lib/permissions.ts + every admin action)
 * P1-03 (DB-validated admin sessions) needs a real request context and is
 * exercised over HTTP separately (see the P1 security report).
 *
 * Run from the repo root against a DISPOSABLE database:
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-p1-security.ts
 */
import "dotenv/config";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import argon2 from "argon2";
import { PrismaClient, OtpPurpose } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { clientIpFromHeaders } from "@/lib/client-ip";
import {
  AUTH_LIMITS,
  assertOtpSendAllowed,
  assertOtpVerifyAllowed,
  assertStudentPasswordLoginAllowed,
  isAdminLoginBlocked,
} from "@/lib/auth-rate-limit";
import { requestOtp, verifyOtp } from "@/lib/otp";
import { verifyPasswordResetCode } from "@/lib/password-reset";
import { isValidFontStack, getAppearance, appearanceToCssVariables } from "@/lib/appearance";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type PermissionKey } from "@/lib/permissions";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}
async function rejects(fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    return false;
  } catch (e) {
    return match ? match.test(e instanceof Error ? e.message : String(e)) : true;
  }
}
const H = (h: Record<string, string>) => new Headers(h);

async function main() {
  const tag = Date.now().toString(36);

  console.log("P1-04 — trusted client IP");
  check("X-Real-IP (set by nginx) wins over a forged X-Forwarded-For", clientIpFromHeaders(H({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" })) === "198.51.100.7");
  check("forged multi-entry XFF: first (client-chosen) entry is never used", clientIpFromHeaders(H({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" })) === "198.51.100.7");
  check("rotating forged first XFF entry yields the same identity", clientIpFromHeaders(H({ "x-forwarded-for": "9.9.9.9, 198.51.100.7" })) === clientIpFromHeaders(H({ "x-forwarded-for": "8.8.8.8, 198.51.100.7" })));
  check("IPv6 accepted", clientIpFromHeaders(H({ "x-real-ip": "2001:db8::1" })) === "2001:db8::1");
  check("IPv4-mapped IPv6 normalized", clientIpFromHeaders(H({ "x-real-ip": "::ffff:198.51.100.7" })) === "198.51.100.7");
  check("garbage X-Real-IP rejected", clientIpFromHeaders(H({ "x-real-ip": "evil<script>" })) === "unknown");
  check("no headers -> unknown", clientIpFromHeaders(H({})) === "unknown");
  const nginx = readFileSync("/etc/nginx/sites-enabled/mocktestseries.in", "utf8");
  check("nginx overwrites X-Real-IP with $remote_addr", /proxy_set_header\s+X-Real-IP\s+\$remote_addr;/.test(nginx));
  check("nginx overwrites (does not append) X-Forwarded-For", /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/.test(nginx) && !/\$proxy_add_x_forwarded_for/.test(nginx));
  const srcFiles = ["lib/auth.ts", "lib/auth-student.ts", "app/login/actions.ts", "lib/communications.ts", "app/api/webhooks/razorpay/route.ts"];
  check("no rate-limited code reads the first X-Forwarded-For entry", srcFiles.every((f) => !/x-forwarded-for"\)\?\.split\(","\)\[0\]/.test(readFileSync(f, "utf8"))));

  console.log("P1-05 — auth abuse limits");
  const ip = "203.0.113.50";
  const otherIp = "203.0.113.51";
  const L = AUTH_LIMITS;
  // Student password: per-identifier cap across IPs.
  const ident = `victim-${tag}@example.test`;
  await prisma.studentLoginAttempt.createMany({
    data: Array.from({ length: L.passwordFailuresPerIdentifier.max }, (_, i) => ({ identifier: ident, ipAddress: `203.0.113.${100 + i}`, success: false, method: "PASSWORD" })),
  });
  check("password: per-identifier cap blocks distributed guessing (any IP)", await rejects(() => assertStudentPasswordLoginAllowed(ident, otherIp), /Too many attempts/));
  check("password: other identifiers from a clean IP unaffected", !(await rejects(() => assertStudentPasswordLoginAllowed(`other-${tag}@example.test`, otherIp))));
  // Per-IP cap across identifiers.
  await prisma.studentLoginAttempt.createMany({
    data: Array.from({ length: L.passwordFailuresPerIp.max }, (_, i) => ({ identifier: `spray-${i}-${tag}`, ipAddress: ip, success: false, method: "PASSWORD" })),
  });
  check("password: per-IP cap blocks credential stuffing", await rejects(() => assertStudentPasswordLoginAllowed(`fresh-${tag}`, ip), /Too many attempts/));
  check("password: message is generic (no account state)", await rejects(() => assertStudentPasswordLoginAllowed(`fresh-${tag}`, ip), /^Too many attempts\. Please try again later\.$/));
  // Admin.
  await prisma.loginAttempt.createMany({ data: Array.from({ length: L.passwordFailuresPerIdentifier.max }, (_, i) => ({ username: `admin-${tag}`, ipAddress: `198.51.100.${i}`, success: false })) });
  check("admin: per-username cap across IPs", await isAdminLoginBlocked(`admin-${tag}`, otherIp));
  check("admin: unrelated username/IP not blocked", !(await isAdminLoginBlocked(`someone-${tag}`, "198.18.0.1")));

  // OTP send caps (checked before any provider call).
  const otpIp = "203.0.113.60";
  const mk = (mobile: string, ipAddress: string, n: number) =>
    prisma.otpRequest.createMany({
      data: Array.from({ length: n }, () => ({ mobile, purpose: OtpPurpose.LOGIN, otpHash: "x", expiresAt: new Date(Date.now() + 300_000), ipAddress, maxAttempts: 5 })),
    });
  await mk(`+9100${tag}`.slice(0, 15), otpIp, L.otpSendsPerIp.max);
  check("OTP send: per-IP cap (numbers rotated)", await rejects(() => assertOtpSendAllowed(`+9111${Date.now()}`.slice(0, 15), otpIp)));
  check("OTP send: requestOtp refuses before sending, generic message", await rejects(() => requestOtp(`+9122${Date.now()}`.slice(0, 15), OtpPurpose.LOGIN, otpIp), /^Too many attempts/));
  const dailyMobile = `+9133${Date.now()}`.slice(0, 15);
  await mk(dailyMobile, "198.18.1.1", L.otpSendsPerMobileDaily.max);
  check("OTP send: per-mobile daily cap", await rejects(() => assertOtpSendAllowed(dailyMobile, "198.18.9.9")));
  const globalBefore = await prisma.otpRequest.count({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  const needed = Math.max(0, L.otpSendsGlobalHourly.max - globalBefore);
  for (let i = 0; i < needed; i += 50) await mk(`+9144${i}${tag}`.slice(0, 15), `198.18.2.${i % 250}`, Math.min(50, needed - i));
  check("OTP send: global hourly provider ceiling trips for everyone", await rejects(() => assertOtpSendAllowed(`+9155${Date.now()}`.slice(0, 15), "198.18.3.3")));
  await prisma.otpRequest.deleteMany({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) }, otpHash: "x" } });
  check("OTP send: clean IP + number allowed again after ceiling clears", !(await rejects(() => assertOtpSendAllowed(`+9166${Date.now()}`.slice(0, 15), "198.18.4.4"))));

  // OTP verify: atomic attempt cap and single use.
  const vMobile = `+9177${Date.now()}`.slice(0, 15);
  await prisma.otpRequest.create({
    data: { mobile: vMobile, purpose: OtpPurpose.LOGIN, otpHash: await argon2.hash("123456"), expiresAt: new Date(Date.now() + 300_000), ipAddress: ip, maxAttempts: 5 },
  });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => verifyOtp(vMobile, OtpPurpose.LOGIN, "000000")));
  const row = await prisma.otpRequest.findFirstOrThrow({ where: { mobile: vMobile } });
  check("OTP verify: 12 parallel wrong guesses -> attempts capped at 5", row.attempts === 5 && results.every((r) => r.status === "rejected"));
  check("OTP verify: correct code refused once the cap is spent", await rejects(() => verifyOtp(vMobile, OtpPurpose.LOGIN, "123456"), /Too many incorrect attempts/));
  const sMobile = `+9188${Date.now()}`.slice(0, 15);
  await prisma.otpRequest.create({
    data: { mobile: sMobile, purpose: OtpPurpose.LOGIN, otpHash: await argon2.hash("654321"), expiresAt: new Date(Date.now() + 300_000), ipAddress: ip, maxAttempts: 5 },
  });
  const both = await Promise.allSettled([verifyOtp(sMobile, OtpPurpose.LOGIN, "654321"), verifyOtp(sMobile, OtpPurpose.LOGIN, "654321")]);
  check("OTP verify: a correct code is single-use under concurrency", both.filter((r) => r.status === "fulfilled").length === 1);
  const okMobile = `+9199${Date.now()}`.slice(0, 15);
  await prisma.otpRequest.create({
    data: { mobile: okMobile, purpose: OtpPurpose.LOGIN, otpHash: await argon2.hash("111222"), expiresAt: new Date(Date.now() + 300_000), ipAddress: ip, maxAttempts: 5 },
  });
  check("OTP verify: legitimate code still accepted", !(await rejects(() => verifyOtp(okMobile, OtpPurpose.LOGIN, "111222"))));

  // OTP verify per-IP failure cap (login, sign-up and password reset share it).
  const vIp = "203.0.113.70";
  await prisma.studentLoginAttempt.createMany({
    data: Array.from({ length: L.otpVerifyFailuresPerIp.max }, (_, i) => ({ identifier: `+91${i}`, ipAddress: vIp, success: false, method: i % 2 ? "PHONE_OTP" : "PASSWORD_RESET_VERIFY" })),
  });
  check("OTP verify: per-IP failure cap", await rejects(() => assertOtpVerifyAllowed(vIp)));
  check("password reset verify: shares the per-IP cap, generic message", await rejects(() => verifyPasswordResetCode(`anyone-${tag}@example.test`, "123456", vIp), /^Too many attempts/));
  const before = await prisma.studentLoginAttempt.count({ where: { method: "PASSWORD_RESET_VERIFY", ipAddress: "203.0.113.71" } });
  check("password reset verify: unknown account -> generic error", await rejects(() => verifyPasswordResetCode(`nobody-${tag}@example.test`, "123456", "203.0.113.71"), /Incorrect or expired code/));
  check("password reset verify: failure recorded (feeds the cap)", (await prisma.studentLoginAttempt.count({ where: { method: "PASSWORD_RESET_VERIFY", ipAddress: "203.0.113.71" } })) === before + 1);

  console.log("P1-02 — Appearance allow-lists");
  const good = ["var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif", `"Inter", Arial, sans-serif`, "'Noto Sans', serif", "Georgia"];
  const bad = [
    "x;}</style><script>alert(1)</script>",
    "Arial; background:url(//evil)",
    "Arial} body{display:none",
    "Arial</style>",
    "url(https://evil)",
    "expression(alert(1))",
    `"Inter\\"}`,
    "a".repeat(301),
  ];
  check("legitimate font stacks accepted", good.every(isValidFontStack));
  check("injection payloads rejected", bad.every((b) => !isValidFontStack(b)));
  // Stored malicious row (written before validation existed) never renders.
  await prisma.appearanceConfig.updateMany({ data: { isActive: false } });
  const evil = await prisma.appearanceConfig.create({
    data: {
      isActive: true,
      colors: { primary: "#ff0000;}</style><script>x()</script>", accent: "#EA580C" },
      fonts: { heading: "x;}</style><script>alert(1)</script>", body: "Georgia" },
      buttonStyle: { radius: "1rem;}</style><img src=x onerror=alert(1)>" },
      componentStyle: { cardRadius: "0.75rem", shadowIntensity: "md" },
    },
  });
  const css = appearanceToCssVariables(await getAppearance());
  check("stored malicious appearance: no </style>, <script>, < or ; injection in output", !/<|>|script|onerror/i.test(css) && !/;\s*}/.test(css.replace(/;\n}/, "")));
  check("stored malicious appearance: valid fields kept, invalid fall back", css.includes("--color-accent:#EA580C") && css.includes("--font-body:Georgia") && css.includes("--color-primary:#3B82F6"));
  await prisma.appearanceConfig.delete({ where: { id: evil.id } });

  console.log("P1-01 — FULL_ADMIN global read-only");
  const full = new Set<PermissionKey>(DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN);
  check("FULL_ADMIN holds only *:view keys", [...full].every((k) => k.endsWith(":view")));
  check("MASTER_ADMIN still holds every key", Object.values(PERMISSIONS).every((k) => DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(k)));
  // Every exported admin Server Action / mutating route: its guard key must be one FULL_ADMIN lacks.
  const keyByConst = new Map(Object.entries(PERMISSIONS));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const actionFiles = walk("app/admin").filter((f) => /actions\.ts$/.test(f) && readFileSync(f, "utf8").includes('"use server"'));
  const routeFiles = walk("app/api/admin").filter((f) => f.endsWith("route.ts"));
  const PUBLIC_OK = new Set(["loginAction", "logoutAction", "clearServerCacheAction"]);
  // POST handlers that write nothing (file generation only) — any admin may use them.
  const READ_ONLY_POST = new Set(["app/api/admin/questions/templates/generate/route.ts#POST"]);
  const allowedForFull: string[] = [];
  let checked = 0;
  for (const f of actionFiles) {
    const src = readFileSync(f, "utf8");
    const helperKeys = [...src.matchAll(/async function (\w+)\(\)[^{]*\{\s*return requirePermission\(PERMISSIONS\.(\w+)\)/g)].map((m) => [m[1], m[2]] as const);
    for (const part of src.split(/(?=export async function )/).slice(1)) {
      const name = /export async function (\w+)/.exec(part)![1];
      if (PUBLIC_OK.has(name)) continue;
      const keys = [...part.matchAll(/requirePermission\(PERMISSIONS\.(\w+)\)/g)].map((m) => m[1]);
      for (const [helper, key] of helperKeys) if (new RegExp(`\\b${helper}\\(\\)`).test(part)) keys.push(key);
      if (/reviewDeletion\(/.test(part)) keys.push("STUDENT_DELETION_MANAGE");
      checked++;
      if (keys.length === 0 || keys.every((k) => full.has(keyByConst.get(k) as PermissionKey))) allowedForFull.push(`${f}#${name}`);
    }
  }
  for (const f of routeFiles) {
    const src = readFileSync(f, "utf8");
    for (const part of src.split(/(?=export async function (?:POST|PUT|PATCH|DELETE))/).slice(1)) {
      const name = /export async function (\w+)/.exec(part)![1];
      const keys = [...part.matchAll(/requirePermission\(PERMISSIONS\.(\w+)\)/g)].map((m) => m[1]);
      if (READ_ONLY_POST.has(`${f}#${name}`)) continue;
      checked++;
      if (keys.length === 0 || keys.every((k) => full.has(keyByConst.get(k) as PermissionKey))) allowedForFull.push(`${f}#${name}`);
    }
  }
  check(`every admin mutation (${checked} actions/handlers) requires a key FULL_ADMIN lacks`, allowedForFull.length === 0);
  if (allowedForFull.length) console.log("    reachable by FULL_ADMIN:", allowedForFull);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
