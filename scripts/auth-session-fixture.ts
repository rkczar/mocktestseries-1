/**
 * Fixture for scripts/verify-auth-session.mjs: one password student in a
 * DISPOSABLE database. Prints the credentials as JSON; `cleanup` removes it.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/auth-session-fixture.ts setup > /tmp/auth-fixture.json
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/auth-session-fixture.ts cleanup
 */
import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { nextStudentId } from "@/lib/student-id";

const EMAIL = "qa-auth-session@example.test";
const PASSWORD = "QaAuthSession!2345";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

async function cleanup() {
  const student = await prisma.student.findFirst({ where: { email: EMAIL }, select: { id: true } });
  if (!student) return;
  // Sessions, devices, profile, activity and login attempts cascade or are fixture-only.
  await prisma.studentLoginAttempt.deleteMany({ where: { OR: [{ studentId: student.id }, { identifier: EMAIL }] } });
  await prisma.student.delete({ where: { id: student.id } });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "cleanup") return cleanup();
  if (mode !== "setup") throw new Error("usage: auth-session-fixture.ts setup|cleanup");
  await cleanup();
  const student = await prisma.student.create({
    data: {
      studentId: await nextStudentId(),
      name: "QA Auth Session",
      email: EMAIL,
      passwordHash: await argon2.hash(PASSWORD),
      authProvider: "CREDENTIALS",
    },
  });
  await prisma.studentProfile.create({ data: { studentId: student.id } });
  console.log(JSON.stringify({ studentIdentifier: EMAIL, studentPassword: PASSWORD }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
