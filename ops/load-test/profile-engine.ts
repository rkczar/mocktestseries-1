/**
 * Function-level cost profile of the test-engine hot paths: exact SQL
 * statement count, summed DB time and wall time per operation, measured with
 * a query-logging Prisma client injected as the app's singleton. Runs ONLY
 * against a disposable "loadtest" database seeded by ops/load-test/seed.ts.
 *
 *   DATABASE_URL=<loadtest url> NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx ops/load-test/profile-engine.ts /path/fixture.json
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const DB = process.env.DATABASE_URL ?? "";
if (!/\/[^/?]*loadtest[^/?]*(\?|$)/.test(DB)) {
  console.error("Refusing to run: DATABASE_URL must point at a disposable 'loadtest' database.");
  process.exit(2);
}

type Fixture = { examId: string; mocks: string[]; questionIdsByMock: Record<string, string[]>; students: { id: string }[] };
const F = JSON.parse(readFileSync(process.argv[2], "utf8")) as Fixture;

const log: { ms: number }[] = [];
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }), log: [{ emit: "event", level: "query" }] });
(client as unknown as { $on: (e: "query", cb: (ev: { duration: number }) => void) => void }).$on("query", (ev) => log.push({ ms: ev.duration }));
(globalThis as unknown as { prisma: PrismaClient }).prisma = client;

async function measure<T>(label: string, fn: () => Promise<T>, runs = 5): Promise<T> {
  let out: T | undefined;
  const q: number[] = [], db: number[] = [], wall: number[] = [];
  for (let i = 0; i < runs; i++) {
    log.length = 0;
    const t0 = performance.now();
    out = await fn();
    wall.push(performance.now() - t0);
    q.push(log.length);
    db.push(log.reduce((s, e) => s + e.ms, 0));
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`${label.padEnd(44)} queries=${String(med(q)).padStart(4)}  dbMs=${med(db).toFixed(1).padStart(7)}  wallMs=${med(wall).toFixed(1).padStart(7)}`);
  return out as T;
}

async function main() {
  const { startMockTestAttempt, saveAnswer, submitAttempt } = await import("@/lib/test-attempt");
  const { claimAttemptLease } = await import("@/lib/attempt-device-lease");
  const { getOwnedAttempt, getScheduledMockTestsForStudent, getMockTestDetailForStudent, getEnrolledExams } = await import("@/lib/student-data");
  const { loadAccessContext, evaluateContentAccess } = await import("@/lib/payments/access");
  const { getStudentExamAccessSummaries } = await import("@/lib/payments/student-access");
  const { checkStudentToken } = await import("@/lib/student-devices");

  const mock = F.mocks[0];
  const qids = F.questionIdsByMock[mock];
  const pool = F.students.slice(150); // untouched by seed history
  let n = 0;
  const next = () => pool[n++ % pool.length].id;
  console.log(`mock with ${qids.length} questions; medians of 5 runs\n`);

  const sid = next();
  await measure("session check (per request, legacy token)", () => checkStudentToken({ studentDbId: sid } as never, async () => null));
  await measure("content access gate (loadAccessContext+eval)", async () =>
    evaluateContentAccess(await loadAccessContext(sid), { kind: "MOCK_TEST", id: mock, examId: F.examId, testSeriesId: null, accessType: "FREE" })
  );
  await measure("test-series list data", () => getScheduledMockTestsForStudent(sid));
  await measure("mock instructions data", () => getMockTestDetailForStudent(sid, mock));
  await measure("dashboard: enrolled exams", () => getEnrolledExams(sid));
  await measure("dashboard/plans: access summaries", async () => getStudentExamAccessSummaries(sid, await getEnrolledExams(sid)));

  const attempts: string[] = [];
  await measure("START attempt (new, 100 q snapshot)", async () => {
    const s = next();
    const a = await startMockTestAttempt(s, mock);
    attempts.push(`${s}:${a.id}`);
    return a;
  });
  const [s0, a0] = attempts[0].split(":");
  await measure("START (resume existing)", () => startMockTestAttempt(s0, mock));
  await measure("device lease claim (run page / heartbeat / submit)", () => claimAttemptLease(a0, s0, null));
  await measure("run page: getOwnedAttempt (loads 100 snapshots)", () => getOwnedAttempt(a0, s0));
  let seq = 1;
  await measure("SAVE answer", () => saveAnswer(a0, s0, qids[seq % qids.length], "A", false, ++seq), 20);
  await measure("SAVE mark-for-review", () => saveAnswer(a0, s0, qids[3], "C", true, ++seq), 10);
  for (let i = 0; i < 60; i++) await saveAnswer(a0, s0, qids[i], ["A", "B", "C", "D"][i % 4], false, ++seq);
  await measure(
    "SUBMIT (60/100 answered)",
    async () => {
      const s = next();
      const a = await startMockTestAttempt(s, mock);
      for (let i = 0; i < 60; i++) await saveAnswer(a.id, s, qids[i], "B", false, i + 1);
      log.length = 0;
      const t0 = performance.now();
      await submitAttempt(a.id, s);
      return performance.now() - t0;
    },
    1
  );
  await measure("SUBMIT", () => submitAttempt(a0, s0), 1);
  await measure("SUBMIT again (idempotent no-op)", () => submitAttempt(a0, s0));
  await measure("result/review: getOwnedAttempt (submitted)", () => getOwnedAttempt(a0, s0));
  await client.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
