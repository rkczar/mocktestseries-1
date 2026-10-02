/**
 * Adds attempts to a seeded loadtest fixture: IN_PROGRESS attempts (for the
 * player/save/submit scenarios) and the ids of already-SUBMITTED attempts
 * (for result/review). Disposable "loadtest" databases only.
 *
 *   DATABASE_URL=<loadtest url> NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx ops/load-test/prepare-attempts.ts /path/fixture.json [inProgressCount]
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

if (!/\/[^/?]*loadtest[^/?]*(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a disposable 'loadtest' database.");
  process.exit(2);
}
const file = process.argv[2];
const count = Number(process.argv[3] ?? "150");

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { startMockTestAttempt } = await import("@/lib/test-attempt");
  const F = JSON.parse(readFileSync(file, "utf8"));
  const inProgress: { token: string; attemptId: string; mockTestId: string }[] = [];
  const pool = F.students.slice(F.students.length - count);
  for (const [i, s] of pool.entries()) {
    const mockTestId = F.mocks[i % (F.mocks.length - 1)];
    const a = await startMockTestAttempt(s.id, mockTestId);
    inProgress.push({ token: s.token, attemptId: a.id, mockTestId });
  }
  const submitted = await prisma.testAttempt.findMany({ where: { status: "SUBMITTED", studentId: { in: F.students.map((s: { id: string }) => s.id) } }, select: { id: true, studentId: true } });
  const tokenOf = new Map(F.students.map((s: { id: string; token: string }) => [s.id, s.token]));
  F.inProgress = inProgress;
  F.submitted = submitted.map((a) => ({ attemptId: a.id, token: tokenOf.get(a.studentId) }));
  writeFileSync(file, JSON.stringify(F));
  console.log(`in-progress ${inProgress.length}, submitted ${F.submitted.length}`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
