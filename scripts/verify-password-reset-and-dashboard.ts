/**
 * Forgot Password + Dashboard announcement dismissal regression (DB-backed,
 * targeted, disposable rows only — deleted afterwards):
 *  - requestPasswordReset answers identically for an unknown identifier and
 *    for a real account in resend cooldown (no enumeration, no SMS sent here:
 *    the known-account case is seeded into cooldown so no provider is called).
 *  - RESET_PASSWORD OTP (seeded locally, argon2 like lib/otp.ts) → token →
 *    new password; wrong code rejected; code and token single-use; short
 *    password rejected; old password no longer verifies, new one does.
 *  - Dismiss: SELECTED_STUDENTS announcement (never visible to real students)
 *    hidden for A only, still visible for B, Announcement row untouched, and
 *    a later announcement still shows for A.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-password-reset-and-dashboard.ts
 */
import "dotenv/config";
import crypto from "node:crypto";
import argon2 from "argon2";
import { OtpPurpose, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  requestPasswordReset,
  verifyPasswordResetCode,
  resetPasswordWithToken,
  PasswordResetError,
} from "@/lib/password-reset";
import { getVisibleAnnouncementsForStudent, dismissAnnouncementForStudent } from "@/lib/notifications";

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}
async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof PasswordResetError;
  }
}

const tag = crypto.randomBytes(4).toString("hex");
const IP = `verify-${tag}`;
const mobileA = `+91999${Math.floor(1e6 + Math.random() * 8e6)}`;
const mobileB = `+91998${Math.floor(1e6 + Math.random() * 8e6)}`;

async function main() {
  const a = await prisma.student.create({
    data: {
      studentId: `VERIFY-RA-${tag}`.toUpperCase(),
      name: "Verify Reset A",
      email: `verify-reset-a-${tag}@example.invalid`,
      mobile: mobileA,
      passwordHash: await argon2.hash("OldPass-123"),
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });
  const b = await prisma.student.create({
    data: {
      studentId: `VERIFY-RB-${tag}`.toUpperCase(),
      name: "Verify Reset B",
      email: `verify-reset-b-${tag}@example.invalid`,
      mobile: mobileB,
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });
  const announcementIds: string[] = [];

  try {
    console.log("--- Forgot Password: request (anti-enumeration) ---");
    const unknown = await requestPasswordReset(`nobody-${tag}@example.invalid`, IP);
    check("unknown identifier → normal response, no error", JSON.stringify(unknown) === "{}");
    check("unknown identifier → no OTP row", (await prisma.otpRequest.count({ where: { ipAddress: IP } })) === 0);

    // Seed A into resend cooldown so requestOtp throws before any provider call.
    await prisma.otpRequest.create({
      data: { mobile: mobileA, purpose: OtpPurpose.RESET_PASSWORD, otpHash: await argon2.hash("999999"), expiresAt: new Date(Date.now() - 1000), ipAddress: IP },
    });
    const known = await requestPasswordReset(a.email!, IP);
    check("real account in cooldown → same response shape as unknown", JSON.stringify(known) === "{}");

    console.log("--- Forgot Password: verify + reset ---");
    await prisma.otpRequest.create({
      data: { mobile: mobileA, purpose: OtpPurpose.RESET_PASSWORD, otpHash: await argon2.hash("123456"), expiresAt: new Date(Date.now() + 5 * 60_000), ipAddress: IP },
    });
    check("wrong code rejected", await rejects(() => verifyPasswordResetCode(a.email!, "000000")));
    check("unknown identifier + code rejected (generic)", await rejects(() => verifyPasswordResetCode(`nobody-${tag}@example.invalid`, "123456")));
    const token = await verifyPasswordResetCode(a.studentId.toLowerCase(), "123456"); // by User ID, any case
    check("correct code (via User ID) → token", typeof token === "string" && token.length >= 40);
    check("token stored hashed only", (await prisma.passwordResetToken.count({ where: { studentId: a.id, tokenHash: token } })) === 0);
    check("OTP single-use", await rejects(() => verifyPasswordResetCode(a.email!, "123456")));
    check("password < 8 chars rejected", await rejects(() => resetPasswordWithToken(token, "short")));
    await resetPasswordWithToken(token, "NewPass-456");
    const after = await prisma.student.findUniqueOrThrow({ where: { id: a.id } });
    check("new password verifies", await argon2.verify(after.passwordHash!, "NewPass-456"));
    check("old password rejected", !(await argon2.verify(after.passwordHash!, "OldPass-123")));
    check("token single-use", await rejects(() => resetPasswordWithToken(token, "Another-789")));
    check("bogus token rejected", await rejects(() => resetPasswordWithToken("not-a-token", "Another-789")));
    check("no open tokens remain", (await prisma.passwordResetToken.count({ where: { studentId: a.id, usedAt: null } })) === 0);

    console.log("--- Dashboard announcement dismissal ---");
    const mk = (title: string) =>
      prisma.announcement.create({
        data: {
          title,
          message: "verify",
          status: "PUBLISHED",
          showOnDashboard: true,
          audience: "SELECTED_STUDENTS",
          recipients: { create: [{ studentId: a.id }, { studentId: b.id }] },
        },
      });
    const x = await mk(`Verify X ${tag}`);
    announcementIds.push(x.id);
    const dash = async (id: string) => (await getVisibleAnnouncementsForStudent(id, { dashboardOnly: true, limit: 50 })).map((r) => r.id);
    check("A sees X before dismiss", (await dash(a.id)).includes(x.id));
    check("dismiss X for A", await dismissAnnouncementForStudent(a.id, x.id));
    check("A no longer sees X (persisted — fresh query)", !(await dash(a.id)).includes(x.id));
    check("B still sees X", (await dash(b.id)).includes(x.id));
    const xAfter = await prisma.announcement.findUniqueOrThrow({ where: { id: x.id } });
    check("Announcement row untouched", xAfter.status === "PUBLISHED" && xAfter.showOnDashboard && xAfter.updatedAt.getTime() === x.updatedAt.getTime());
    check("X still in A's full notification list", (await getVisibleAnnouncementsForStudent(a.id)).some((r) => r.id === x.id));
    const y = await mk(`Verify Y ${tag}`);
    announcementIds.push(y.id);
    check("new announcement Y visible to A", (await dash(a.id)).includes(y.id));
    const outsider = await prisma.announcement.create({
      data: { title: `Verify Z ${tag}`, message: "verify", status: "PUBLISHED", showOnDashboard: true, audience: "SELECTED_STUDENTS" },
    });
    announcementIds.push(outsider.id);
    check("cannot dismiss an announcement not addressed to you", !(await dismissAnnouncementForStudent(a.id, outsider.id)));
  } finally {
    await prisma.announcement.deleteMany({ where: { id: { in: announcementIds } } });
    await prisma.otpRequest.deleteMany({ where: { mobile: { in: [mobileA, mobileB] } } });
    await prisma.studentLoginAttempt.deleteMany({ where: { ipAddress: IP } });
    await prisma.student.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  }

  console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
