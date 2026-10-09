/**
 * Fixture for scripts/verify-account-recovery.mjs — DISPOSABLE database only.
 *
 *   setup              students (see STUDENTS) + a FULL_ADMIN (read-only) admin; prints JSON
 *   state              the fixture students' rows, their recovery requests and email OTP rows (no codes — only hashes exist)
 *   email-otp on|off   sets the "Security code emails" switch directly (on = also records a passing test)
 *   email-otp reset    removes the switch setting (fresh install state)
 *   expire-email <a>   expires open email codes for that address
 *   flag on|off        "Require mobile verification" toggle
 *   reset-otp          clears SMS + email OTP rows and failed OTP attempts (cooldowns)
 *   reset-devices      removes the fixture students' devices / sessions (device limit)
 *   cleanup            removes everything the fixture and suite created
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/account-recovery-fixture.ts setup
 */
import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { nextStudentId } from "@/lib/student-id";
import { saveAuthProviderConfig } from "@/lib/auth-provider-config";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

const PASSWORD = "QaRecovery!2345";
const DOMAIN = "@recov.example.test";
const FULL_ADMIN = "qa-recov-full";

/** R* request a number that H* holds. V verifies its own email. */
const STUDENTS = {
  R1: { name: "QA Google Payer", mobile: null, provider: "GOOGLE", mobileVerified: false, email: true, google: "qa-recov-google-1" },
  H1: { name: "QA Old Phone Account", mobile: "+919000008001", provider: "OTP", mobileVerified: true, email: true },
  R2: { name: "QA Reject Requester", mobile: null, provider: "CREDENTIALS", mobileVerified: false, email: true },
  H2: { name: "QA Legacy Holder", mobile: "9000008002", provider: "OTP", mobileVerified: false, email: false },
  R3: { name: "QA Cancel Requester", mobile: null, provider: "CREDENTIALS", mobileVerified: false, email: true },
  H3: { name: "QA Third Holder", mobile: "+919000008003", provider: "CREDENTIALS", mobileVerified: true, email: true },
  V: { name: "QA Email Verifier", mobile: "+919000008009", provider: "CREDENTIALS", mobileVerified: true, email: true },
} as const;
type Key = keyof typeof STUDENTS;
const emailOf = (k: string) => `qa-${k.toLowerCase()}${DOMAIN}`;
const MOBILES = ["+919000008001", "9000008002", "+919000008002", "+919000008003", "+919000008009"];

const fixtureWhere = { OR: [{ email: { endsWith: DOMAIN } }, { mobile: { in: MOBILES } }] };

async function resetOtp() {
  await prisma.otpRequest.deleteMany({ where: { mobile: { contains: "900000800" } } });
  await prisma.emailOtpRequest.deleteMany({});
  await prisma.studentLoginAttempt.deleteMany({ where: { success: false } });
}

async function resetDevices() {
  const ids = (await prisma.student.findMany({ where: fixtureWhere, select: { id: true } })).map((s) => s.id);
  await prisma.studentSession.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.deviceSecurityEvent.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentLoginAttempt.deleteMany({ where: { studentId: { in: ids } } });
}

async function cleanup() {
  const ids = (await prisma.student.findMany({ where: fixtureWhere, select: { id: true } })).map((s) => s.id);
  await prisma.accountRecoveryRequest.deleteMany({ where: { OR: [{ requesterId: { in: ids } }, { holderId: { in: ids } }] } });
  await resetDevices();
  for (const model of ["studentActivity", "studentOAuthAccount", "studentProfile"] as const) {
    await (prisma[model] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { studentId: { in: ids } } });
  }
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await resetOtp();
  const admin = await prisma.adminUser.findUnique({ where: { username: FULL_ADMIN } });
  if (admin) {
    await prisma.loginAttempt.deleteMany({ where: { adminUserId: admin.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: admin.id } }).catch(() => {});
    await prisma.adminUser.delete({ where: { id: admin.id } });
  }
}

async function state() {
  const students = await prisma.student.findMany({
    where: fixtureWhere,
    select: {
      id: true,
      email: true,
      name: true,
      mobile: true,
      mobileVerifiedAt: true,
      emailVerifiedAt: true,
      authProvider: true,
      status: true,
      passwordHash: true,
      updatedAt: true,
      _count: { select: { oauthAccounts: true, testAttempts: true, payments: true, entitlements: true, sessions: true } },
    },
  });
  const ids = students.map((s) => s.id);
  const requests = await prisma.accountRecoveryRequest.findMany({
    where: { OR: [{ requesterId: { in: ids } }, { holderId: { in: ids } }] },
    orderBy: { createdAt: "asc" },
  });
  const emailOtps = await prisma.emailOtpRequest.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, purpose: true, attempts: true, consumedAt: true, expiresAt: true, otpHash: true, recoveryRequestId: true },
  });
  return { students, requests, emailOtps };
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  if (mode === "cleanup") return cleanup();
  if (mode === "reset-otp") return resetOtp();
  if (mode === "reset-devices") return resetDevices();
  if (mode === "state") return console.log(JSON.stringify(await state()));
  if (mode === "flag") return saveAuthProviderConfig({ toggles: { mobileVerificationRequired: arg === "on" } });
  if (mode === "expire-email") {
    await prisma.emailOtpRequest.updateMany({ where: { email: arg, consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    return;
  }
  if (mode === "email-otp") {
    if (arg === "reset") {
      await prisma.setting.deleteMany({ where: { key: "email.otp" } });
      return;
    }
    const value = {
      enabled: arg === "on",
      updatedAt: new Date().toISOString(),
      updatedBy: "fixture",
      lastTest: arg === "on" ? { at: new Date().toISOString(), ok: true, message: "fixture" } : null,
    };
    await prisma.setting.upsert({ where: { key: "email.otp" }, create: { key: "email.otp", value }, update: { value } });
    return;
  }
  if (mode !== "setup") throw new Error("usage: account-recovery-fixture.ts setup|state|email-otp on|off|reset|expire-email <a>|flag on|off|reset-otp|reset-devices|cleanup");

  await cleanup();
  await saveAuthProviderConfig({ toggles: { mobileVerificationRequired: false } });
  await prisma.setting.deleteMany({ where: { key: "email.otp" } });
  const passwordHash = await argon2.hash(PASSWORD);
  const out: Record<string, { id: string; email: string; studentId: string }> = {};
  for (const [key, seed] of Object.entries(STUDENTS) as [Key, (typeof STUDENTS)[Key]][]) {
    const student = await prisma.student.create({
      data: {
        studentId: await nextStudentId(),
        name: seed.name,
        email: seed.email ? emailOf(key) : null,
        mobile: seed.mobile,
        mobileVerifiedAt: seed.mobileVerified ? new Date() : null,
        passwordHash,
        authProvider: seed.provider,
      },
    });
    await prisma.studentProfile.create({ data: { studentId: student.id } });
    if ("google" in seed) {
      await prisma.studentOAuthAccount.create({
        data: { studentId: student.id, provider: "GOOGLE", providerAccountId: seed.google, email: emailOf(key) },
      });
    }
    out[key] = { id: student.id, email: emailOf(key), studentId: student.studentId };
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { name: "FULL_ADMIN" }, select: { id: true } });
  await prisma.adminUser.create({ data: { name: "QA Full Admin", username: FULL_ADMIN, passwordHash, roleId: role.id } });
  console.log(JSON.stringify({ password: PASSWORD, fullAdmin: FULL_ADMIN, students: out }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
