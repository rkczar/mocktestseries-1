/**
 * Gives every synthetic student in a loadtest fixture a production-shaped
 * session: a registered device + tracked session via the real sign-in
 * admission (admitStudentSignIn), and a JWT carrying did/sid/sref/authAt —
 * exactly what the password/OTP/Google login issues. Without this, requests
 * use the legacy (pre-device-security) path, which registers a new device on
 * every cookie-less request and trips the one-active-device lock.
 * Also clears attempt device leases left by earlier runs. Disposable
 * "loadtest" databases only.
 *
 *   DATABASE_URL=<loadtest url> NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx ops/load-test/sign-in.ts /path/fixture.json
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { encode } from "next-auth/jwt";

if (!/\/[^/?]*loadtest[^/?]*(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a disposable 'loadtest' database.");
  process.exit(2);
}

async function main() {
  const file = process.argv[2];
  const { prisma } = await import("@/lib/prisma");
  const { admitStudentSignIn } = await import("@/lib/student-devices");
  const F = JSON.parse(readFileSync(file, "utf8"));
  const ids: string[] = F.students.map((s: { id: string }) => s.id);
  await prisma.testAttempt.updateMany({ where: { studentId: { in: ids } }, data: { activeDeviceId: null, activeSeenAt: null } });
  await prisma.studentSession.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: ids } } });
  const rows = await prisma.student.findMany({ where: { id: { in: ids } }, select: { id: true, studentId: true, name: true, email: true } });
  const token = new Map<string, string>();
  for (const s of rows) {
    const a = await admitStudentSignIn(s.id, "PASSWORD", { deviceIdRaw: randomBytes(16).toString("hex"), signals: { userAgent: "k6-loadtest", ip: null } });
    token.set(
      s.id,
      await encode({
        token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email, did: a.deviceId, sid: a.sessionSecret ?? undefined, sref: a.sessionRowId ?? undefined, authAt: a.authAt },
        secret: process.env.AUTH_SECRET!,
        salt: "student-session-token",
      })
    );
  }
  const attemptOwner = new Map((await prisma.testAttempt.findMany({ where: { studentId: { in: ids } }, select: { id: true, studentId: true } })).map((a) => [a.id, a.studentId]));
  F.students = F.students.map((s: { id: string }) => ({ ...s, token: token.get(s.id) }));
  for (const k of ["inProgress", "submitted"]) {
    if (F[k]) F[k] = F[k].map((a: { attemptId: string }) => ({ ...a, token: token.get(attemptOwner.get(a.attemptId)!) }));
  }
  writeFileSync(file, JSON.stringify(F));
  console.log(`signed in ${rows.length} students with tracked device sessions`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
