/**
 * Fixture for scripts/verify-critical-flows.mjs: three password students in a
 * DISPOSABLE copy of production (free, paid with an active entitlement to the
 * exam's series product, and paid-but-expired). Prints the fixture as JSON;
 * `cleanup` removes the students and everything that cascades from them.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/critical-flows-fixture.ts setup > /tmp/flows.json
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/critical-flows-fixture.ts cleanup
 */
import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { nextStudentId } from "@/lib/student-id";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";

const PASSWORD = "QaFlows!2345678";
const ADMIN_USERNAME = "qa-flows-admin";
const STUDENTS = [
  { key: "free", email: "qa-flows-free@example.test", mobile: "+919000000101" },
  { key: "paid", email: "qa-flows-paid@example.test", mobile: "+919000000102" },
  { key: "expired", email: "qa-flows-expired@example.test", mobile: "+919000000103" },
] as const;

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

async function cleanup() {
  const admin = await prisma.adminUser.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } });
  if (admin) {
    await prisma.loginAttempt.deleteMany({ where: { adminUserId: admin.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: admin.id } }).catch(() => {});
    await prisma.adminUser.delete({ where: { id: admin.id } });
  }
  for (const s of STUDENTS) {
    const student = await prisma.student.findFirst({ where: { email: s.email }, select: { id: true } });
    await prisma.studentLoginAttempt.deleteMany({ where: { OR: [{ identifier: s.email }, ...(student ? [{ studentId: student.id }] : [])] } });
    if (!student) continue;
    await prisma.answer.deleteMany({ where: { studentId: student.id } });
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: student.id } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: student.id } });
    await prisma.studentEntitlement.deleteMany({ where: { studentId: student.id } });
    await prisma.student.delete({ where: { id: student.id } });
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "cleanup") return cleanup();
  if (mode !== "setup") throw new Error("usage: critical-flows-fixture.ts setup|cleanup");
  await cleanup();

  const product = await prisma.product.findFirst({
    where: { isActive: true, productType: "TEST_SERIES", accessType: "PAID" },
    select: { id: true, code: true, testSeriesId: true, examId: true },
  });
  if (!product?.testSeriesId) throw new Error("No active PAID TEST_SERIES product in this database.");
  const exam = await prisma.exam.findUnique({ where: { id: product.examId! }, select: { id: true, publicSlug: true } });
  const mocks = await prisma.mockTest.findMany({
    where: { testSeriesId: product.testSeriesId, status: "PUBLISHED", availableFrom: null },
    select: { id: true, accessType: true, title: true },
    orderBy: { createdAt: "asc" },
  });
  const freeMock = mocks.find((m) => m.accessType === "FREE");
  const paidMock = mocks.find((m) => m.accessType === "PAID");
  const paper = await prisma.previousYearPaper.findFirst({ where: { examId: exam!.id, isActive: true }, select: { id: true }, orderBy: { year: "desc" } });
  const upcomingMock = await prisma.mockTest.findFirst({
    where: { testSeriesId: product.testSeriesId, status: "PUBLISHED", availableFrom: { gt: new Date() } },
    select: { id: true },
  });

  const passwordHash = await argon2.hash(PASSWORD);
  const masterRole = await prisma.role.findUnique({ where: { name: "MASTER_ADMIN" }, select: { id: true } });
  if (masterRole) {
    await prisma.adminUser.create({ data: { name: "QA Flows Admin", username: ADMIN_USERNAME, passwordHash, roleId: masterRole.id } });
  }
  const out: Record<string, unknown> = {
    password: PASSWORD,
    adminUsername: masterRole ? ADMIN_USERNAME : null,
    examId: exam!.id,
    examSlug: exam!.publicSlug,
    productCode: product.code,
    freeMockId: freeMock?.id,
    paidMockId: paidMock?.id,
    upcomingMockId: upcomingMock?.id,
    paperId: paper?.id,
    students: {} as Record<string, { id: string; email: string }>,
  };
  for (const s of STUDENTS) {
    const student = await prisma.student.create({
      data: {
        studentId: await nextStudentId(),
        name: `QA Flows ${s.key}`,
        email: s.email,
        mobile: s.mobile,
        passwordHash,
        authProvider: "CREDENTIALS",
      },
    });
    await prisma.studentProfile.create({ data: { studentId: student.id } });
    await ensureDefaultExamEnrollmentSafely(student.id);
    if (s.key !== "free") {
      const expired = s.key === "expired";
      await prisma.studentEntitlement.create({
        data: {
          studentId: student.id,
          productId: product.id,
          source: "ADMIN_GRANT",
          status: "ACTIVE",
          startsAt: new Date(Date.now() - 40 * 864e5),
          expiresAt: expired ? new Date(Date.now() - 864e5) : new Date(Date.now() + 300 * 864e5),
          reason: "critical-flows fixture",
        },
      });
    }
    (out.students as Record<string, unknown>)[s.key] = { id: student.id, email: s.email };
  }
  console.log(JSON.stringify(out));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
