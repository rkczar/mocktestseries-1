/**
 * Fixture for scripts/verify-mobile-otp.mjs — DISPOSABLE database only.
 *
 *   setup            students A–G (see STUDENTS) + snapshot of A; prints JSON
 *   reset-otp        clears OtpRequest + failed OTP attempts (keeps cooldowns from blocking the next step)
 *   reset-devices    removes the fixture students' devices (device limit; ends their sessions)
 *   reset-recovery   removes duplicate-number recovery requests involving the fixture students
 *   expire <e164>    expires the pending OTP rows for that number
 *   state            prints the fixture students' current rows + related-row counts as JSON
 *   flag on|off      sets the "Require mobile verification" toggle directly
 *   cleanup          removes everything the fixture and suite created
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/mobile-otp-fixture.ts setup
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

const PASSWORD = "QaMobileOtp!2345";
const DOMAIN = "@motp.example.test";

/** key → seed. mobile is stored exactly as given (legacy spellings on purpose). */
const STUDENTS = {
  A: { name: "QA Unverified Password", mobile: "9000000001", provider: "CREDENTIALS", verified: false },
  B: { name: "QA Verified Password", mobile: "+919000000002", provider: "CREDENTIALS", verified: true },
  C: { name: "QA Google Linked", mobile: null, provider: "GOOGLE", verified: false, google: "qa-google-sub-123" },
  E: { name: "QA Legacy 91 Prefix", mobile: "919000000005", provider: "CREDENTIALS", verified: false },
  F: { name: "QA Old OTP Signup", mobile: "+919000000006", provider: "OTP", verified: false },
  G: { name: "QA Unverified Mobile Login", mobile: "9000000007", provider: "CREDENTIALS", verified: false },
} as const;
type Key = keyof typeof STUDENTS;
const email = (k: string) => `qa-${k.toLowerCase()}${DOMAIN}`;
const SUITE_MOBILES = ["+919000000010", "+919000000011", "+919000000099"];

async function fixtureStudents() {
  return prisma.student.findMany({
    where: { OR: [{ email: { endsWith: DOMAIN } }, { mobile: { in: SUITE_MOBILES } }] },
    select: { id: true },
  });
}

async function cleanup() {
  const ids = (await fixtureStudents()).map((s) => s.id);
  await resetRecovery();
  await prisma.studentLoginAttempt.deleteMany({ where: { OR: [{ studentId: { in: ids } }, { identifier: { contains: "90000000" } }, { identifier: { endsWith: DOMAIN } }] } });
  await prisma.otpRequest.deleteMany({ where: { mobile: { contains: "90000000" } } });
  await prisma.studentOAuthAccount.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
}

async function resetOtp() {
  await prisma.otpRequest.deleteMany({});
  await prisma.studentLoginAttempt.deleteMany({ where: { success: false } });
}

/** A duplicate number opens a recovery request, which the verify page then shows first. */
async function resetRecovery() {
  const ids = (await fixtureStudents()).map((s) => s.id);
  await prisma.accountRecoveryRequest.deleteMany({ where: { OR: [{ requesterId: { in: ids } }, { holderId: { in: ids } }] } });
}

/** Between browser contexts only: each new context is a new device (device limit). Kills open sessions. */
async function resetDevices() {
  await prisma.studentDevice.deleteMany({ where: { student: { OR: [{ email: { endsWith: DOMAIN } }, { mobile: { in: SUITE_MOBILES } }] } } });
}

async function state() {
  const rows = await prisma.student.findMany({
    where: { OR: [{ email: { endsWith: DOMAIN } }, { mobile: { in: SUITE_MOBILES } }] },
    include: { oauthAccounts: true, _count: { select: { testAttempts: true, payments: true, entitlements: true, activities: true } } },
  });
  return rows.map((r) => ({ ...r, passwordHash: r.passwordHash ? "<set>" : null }));
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  if (mode === "cleanup") return cleanup();
  if (mode === "reset-otp") return resetOtp();
  if (mode === "reset-devices") return resetDevices();
  if (mode === "reset-recovery") return resetRecovery();
  if (mode === "state") return console.log(JSON.stringify(await state()));
  if (mode === "expire") {
    const r = await prisma.otpRequest.updateMany({ where: { mobile: arg, consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    return console.log(JSON.stringify({ expired: r.count }));
  }
  if (mode === "flag") return saveAuthProviderConfig({ toggles: { mobileVerificationRequired: arg === "on" } });
  if (mode !== "setup") throw new Error("usage: mobile-otp-fixture.ts setup|reset-otp|reset-recovery|expire <e164>|state|flag on|off|cleanup");

  await cleanup();
  await resetOtp();
  await saveAuthProviderConfig({ toggles: { mobileVerificationRequired: false } });
  const passwordHash = await argon2.hash(PASSWORD);
  const out: Record<string, { id: string; email: string; studentId: string }> = {};
  for (const [key, seed] of Object.entries(STUDENTS) as [Key, (typeof STUDENTS)[Key]][]) {
    const student = await prisma.student.create({
      data: {
        studentId: await nextStudentId(),
        name: seed.name,
        email: email(key),
        mobile: seed.mobile,
        mobileVerifiedAt: seed.verified ? new Date() : null,
        passwordHash,
        authProvider: seed.provider,
      },
    });
    await prisma.studentProfile.create({ data: { studentId: student.id } });
    if ("google" in seed) {
      await prisma.studentOAuthAccount.create({
        data: { studentId: student.id, provider: "GOOGLE", providerAccountId: seed.google, email: email(key) },
      });
    }
    out[key] = { id: student.id, email: email(key), studentId: student.studentId };
  }
  console.log(JSON.stringify({ password: PASSWORD, students: out }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
