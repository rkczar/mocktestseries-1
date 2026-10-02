/**
 * Small, bounded burst + race tests of the test engine through ONE app-like
 * Prisma pool (pg default max 10 — the same pool one PM2 worker has).
 * Disposable "loadtest" databases only.
 *
 *   DATABASE_URL=<loadtest url> NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx ops/load-test/burst-engine.ts /path/fixture.json 10,25,50
 *
 * Measures simultaneous START and SUBMIT bursts (latency p50/p95/max, total
 * wall time), and checks correctness under races: duplicate concurrent
 * submits of one attempt, and a double-click START by one student.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

if (!/\/[^/?]*loadtest[^/?]*(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a disposable 'loadtest' database.");
  process.exit(2);
}
type Fixture = { mocks: string[]; questionIdsByMock: Record<string, string[]>; students: { id: string }[] };
const F = JSON.parse(readFileSync(process.argv[2], "utf8")) as Fixture;
const SIZES = (process.argv[3] ?? "10,25,50").split(",").map(Number);
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];

async function timed<T>(fn: () => Promise<T>) {
  const t0 = performance.now();
  try {
    await fn();
    return { ms: performance.now() - t0, ok: true };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, err: e instanceof Error ? e.message.slice(0, 80) : String(e) };
  }
}
function report(label: string, r: { ms: number; ok: boolean; err?: string }[], wall: number) {
  const ms = r.map((x) => x.ms);
  const errs = r.filter((x) => !x.ok);
  console.log(
    `${label.padEnd(26)} n=${String(r.length).padStart(3)}  wall=${wall.toFixed(0).padStart(5)}ms  p50=${pct(ms, 50).toFixed(0).padStart(5)}  p95=${pct(ms, 95).toFixed(0).padStart(5)}  max=${Math.max(...ms).toFixed(0).padStart(5)}  errors=${errs.length}${errs[0] ? ` (${errs[0].err})` : ""}`
  );
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { startMockTestAttempt, saveAnswer, submitAttempt } = await import("@/lib/test-attempt");
  const mock = F.mocks[2]; // untouched by the HTTP scenarios
  const qids = F.questionIdsByMock[mock];
  let cursor = 0;
  const take = (n: number) => {
    const s = F.students.slice(cursor, cursor + n);
    cursor += n;
    if (s.length < n) throw new Error("fixture too small for this burst plan");
    return s.map((x) => x.id);
  };

  for (const n of SIZES) {
    const ids = take(n);
    const t0 = performance.now();
    const starts = await Promise.all(ids.map((id) => timed(() => startMockTestAttempt(id, mock))));
    report(`START burst`, starts, performance.now() - t0);
    const attempts = await prisma.testAttempt.findMany({ where: { studentId: { in: ids }, mockTestId: mock, status: "IN_PROGRESS" }, select: { id: true, studentId: true } });
    for (const a of attempts) for (let i = 0; i < 70; i++) await saveAnswer(a.id, a.studentId, qids[i], ["A", "B", "C", "D"][i % 4], false, i + 1);
    const t1 = performance.now();
    const subs = await Promise.all(attempts.map((a) => timed(() => submitAttempt(a.id, a.studentId))));
    report(`SUBMIT burst (70/100 ans)`, subs, performance.now() - t1);
    const bad = await prisma.testAttempt.count({ where: { id: { in: attempts.map((a) => a.id) }, OR: [{ status: { not: "SUBMITTED" } }, { NOT: { correctCount: 18 } }] } });
    // 70 answered cycling A,B,C,D with B correct → 18 correct (i%4==1 for i<70), 52 incorrect, 30 unanswered.
    console.log(`  scores correct & all SUBMITTED: ${bad === 0 ? "YES" : `NO (${bad} wrong)`}`);
  }

  // Race: 5 concurrent submits of the SAME attempt.
  const [r1] = take(1);
  const a = await startMockTestAttempt(r1, mock);
  for (let i = 0; i < 10; i++) await saveAnswer(a.id, r1, qids[i], "B", false, i + 1);
  const dup = await Promise.all(Array.from({ length: 5 }, () => timed(() => submitAttempt(a.id, r1))));
  const after = await prisma.testAttempt.findUniqueOrThrow({ where: { id: a.id } });
  const acts = await prisma.studentActivity.count({ where: { studentId: r1, activity: "TEST_SUBMITTED" } });
  console.log(`DUPLICATE SUBMIT x5: errors=${dup.filter((d) => !d.ok).length} status=${after.status} correct=${after.correctCount} (expect 10) score=${after.score} TEST_SUBMITTED activity rows=${acts}`);

  // Race: double-click START by one student (2 and 5 concurrent).
  for (const k of [2, 5]) {
    const [r2] = take(1);
    await Promise.all(Array.from({ length: k }, () => timed(() => startMockTestAttempt(r2, mock))));
    const open = await prisma.testAttempt.count({ where: { studentId: r2, mockTestId: mock, status: "IN_PROGRESS" } });
    console.log(`CONCURRENT START x${k} (same student): in-progress attempts created = ${open} (expect 1)`);
  }
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
