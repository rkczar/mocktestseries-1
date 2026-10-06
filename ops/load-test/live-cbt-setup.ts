/**
 * Live CBT load step setup (ops/load-test/run-live-cbt.sh): turns seeded mock
 * #<index> into a Live CBT — Fixed Window opening at --start-ms and closing
 * --window-s later, enrollment ON, Single Attempt, results after the window —
 * and enrolls the first --candidates students. Loadtest databases only.
 *
 *   DATABASE_URL=<.../mts_loadtest_x> NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx ops/load-test/live-cbt-setup.ts /tmp/lt.json --mock 0 --candidates 100 --start-ms <epoch ms> --window-s 180
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

const DB = process.env.DATABASE_URL ?? "";
if (!/\/[^/?]*loadtest[^/?]*(\?|$)/.test(DB)) {
  console.error("Refusing: DATABASE_URL must point at a database whose name contains 'loadtest'.");
  process.exit(2);
}
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const F = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const mockId: string = F.mocks[Number(arg("mock", "0"))];
  const n = Number(arg("candidates", "50"));
  const start = new Date(Number(arg("start-ms", String(Date.now() + 60_000))));
  const end = new Date(start.getTime() + Number(arg("window-s", "180")) * 1000);
  await prisma.mockTest.update({
    where: { id: mockId },
    data: { availableFrom: start, availableUntil: end, durationMinutes: 120, enrollmentEnabled: true, attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW", resultReleaseAt: null },
  });
  const ids: string[] = F.students.slice(0, n).map((s: { id: string }) => s.id);
  await prisma.mockTestEnrollment.createMany({ data: ids.map((studentId) => ({ mockTestId: mockId, studentId })), skipDuplicates: true });
  console.log(JSON.stringify({ mockId, candidates: ids.length, start: start.toISOString(), end: end.toISOString() }));
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
