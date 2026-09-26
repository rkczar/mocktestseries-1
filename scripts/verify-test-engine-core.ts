/**
 * TEST ENGINE CORE — permanent regression guard (server side).
 *
 * TEST ENGINE CORE — HIGH RISK SHARED PATH. Changes to option selection,
 * answer persistence, navigation, attempt snapshots, timer, submission or
 * answer reveal require this suite AND scripts/verify-test-engine-ui.mjs to
 * pass before deployment. See ops/TEST-ENGINE.md.
 *
 * Drives the real engine (lib/test-attempt.ts, lib/answer-save-queue.ts,
 * lib/test-player-data.ts) against disposable fixtures it creates and deletes
 * itself. Covers, for Custom Module / Subject Test / Mock Test / PYQ:
 *   1, 2 and 10 question attempts: select, persist, change, unanswered,
 *   mark for review, resume (re-read), submit, result;
 *   save ordering (seq), idempotency, stale-write rejection, concurrent saves
 *   on one question, invalid options, time windows (per-question / custom /
 *   unlimited / expired), instant-answer authorization + lock, exam-mode
 *   answer leakage in the player payload, malformed questions, the client
 *   save queue (rapid A→B→C, out-of-order, timeouts, retries) and a
 *   many-students concurrency run.
 *
 * Run from the repo root against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-test-engine-core.ts
 */
import "dotenv/config";
import {
  PrismaClient,
  AttemptAnswerMode,
  AttemptDurationMode,
  AttemptSourceType,
  QuestionDifficulty,
  QuestionSource,
  QuestionStatus,
  StudentAuthProvider,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  instantAnswerAllowed,
  practiceDurationMinutes,
  revealAnswer,
  saveAnswer,
  startCustomModuleAttempt,
  startMockTestAttempt,
  startPreviousYearPaperAttempt,
  startSubjectTestAttempt,
  submitAttempt,
  toServerTimedAttempt,
  TestEngineError,
} from "@/lib/test-attempt";
import { isExpired } from "@/lib/attempt-timing";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { AnswerSaveQueue, type SaveResult } from "@/lib/answer-save-queue";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database. Point DATABASE_URL at a disposable copy.");
  process.exit(2);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
async function engineCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof TestEngineError ? e.code : `THROWN:${e instanceof Error ? e.message : String(e)}`;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `ENG Exam ${suffix}`, code: `ENG-${suffix}`, isActive: true } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "ENG Subject" } });
  const topic = await prisma.topic.create({ data: { subjectId: subject.id, name: "ENG Topic" } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: `ENG PYQ ${suffix}` } });

  // Options are inserted D,C,B,A with explicit `order` so snapshot ordering is exercised.
  const mkQuestion = (n: number, extra: Partial<{ previousYearPaperId: string; source: QuestionSource }> = {}) =>
    prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        code: `ENG-${suffix}-${n}`,
        text: `Engine question ${n}?`,
        status: QuestionStatus.PUBLISHED,
        difficulty: QuestionDifficulty.MEDIUM,
        ...extra,
        options: {
          create: [
            { label: "D", text: "d", isCorrect: false, order: 3 },
            { label: "C", text: "c", isCorrect: n % 2 === 0, order: 2 },
            { label: "B", text: "b", isCorrect: n % 2 === 1, order: 1 },
            { label: "A", text: "a", isCorrect: false, order: 0 },
          ],
        },
      },
      include: { options: true },
    });
  type FixtureQuestion = Awaited<ReturnType<typeof mkQuestion>>;
  const bank: FixtureQuestion[] = [];
  for (let n = 1; n <= 12; n++) bank.push(await mkQuestion(n));
  const pyq: FixtureQuestion[] = [];
  for (let n = 101; n <= 110; n++) pyq.push(await mkQuestion(n, { previousYearPaperId: paper.id, source: QuestionSource.PYQ }));
  const correctOf = (q: (typeof bank)[number]) => q.options.find((o) => o.isCorrect)!.label;

  const mock = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `ENG Mock ${suffix}`,
      durationMinutes: 30,
      status: "PUBLISHED",
      questions: { create: bank.slice(0, 10).map((q, order) => ({ questionId: q.id, order })) },
    },
  });

  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `ENG${tag}-${suffix}`, name: `ENG ${tag}`, email: `eng-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };
  const mkModule = (studentId: string, qs: typeof bank, cfg: { durationMode: AttemptDurationMode; answerMode: AttemptAnswerMode; durationMinutes?: number | null; studentOwned?: boolean }) =>
    prisma.customModule.create({
      data: {
        examId: exam.id,
        title: "ENG Custom Practice",
        selectionMode: "RULE_BASED",
        status: "ACTIVE",
        accessType: "FREE",
        isStudentOwned: cfg.studentOwned ?? true,
        createdByStudentId: cfg.studentOwned === false ? null : studentId,
        durationMode: cfg.durationMode,
        durationMinutes: cfg.durationMinutes ?? null,
        answerMode: cfg.answerMode,
        questions: { create: qs.map((q, order) => ({ questionId: q.id, order })) },
      },
    });

  const answersOf = (attemptId: string) =>
    prisma.answer.findMany({ where: { attemptId }, include: { attemptQuestion: { select: { order: true } } }, orderBy: { attemptQuestion: { order: "asc" } } });

  try {
    // -----------------------------------------------------------------------
    console.log("\n--- Duration + answer-mode configuration ---");
    check("PER_QUESTION: 1 question = 1 minute", practiceDurationMinutes(AttemptDurationMode.PER_QUESTION, 1) === 1);
    check("PER_QUESTION: 2 questions = 2 minutes", practiceDurationMinutes(AttemptDurationMode.PER_QUESTION, 2) === 2);
    check("PER_QUESTION: 100 questions = 100 minutes", practiceDurationMinutes(AttemptDurationMode.PER_QUESTION, 100) === 100);
    check("CUSTOM: explicit minutes", practiceDurationMinutes(AttemptDurationMode.CUSTOM, 5, 45) === 45);
    check("CUSTOM: 0 minutes rejected", (await engineCode(async () => practiceDurationMinutes(AttemptDurationMode.CUSTOM, 5, 0))) === "NOT_ALLOWED");
    check("UNLIMITED: stored as 0 (never a window)", practiceDurationMinutes(AttemptDurationMode.UNLIMITED, 5) === 0);
    check("instant answer never allowed for Mock Tests", !instantAnswerAllowed(AttemptSourceType.MOCK_TEST));
    check("instant answer never allowed for PYQ", !instantAnswerAllowed(AttemptSourceType.PREVIOUS_YEAR_PAPER));
    check("instant answer never allowed for Grand/Live", !instantAnswerAllowed(AttemptSourceType.GRAND_TEST) && !instantAnswerAllowed(AttemptSourceType.LIVE_TEST));
    check("instant answer not allowed for admin custom modules", !instantAnswerAllowed(AttemptSourceType.CUSTOM_MODULE, { studentOwnedModule: false }));
    check("instant answer allowed for student practice", instantAnswerAllowed(AttemptSourceType.CUSTOM_MODULE, { studentOwnedModule: true }) && instantAnswerAllowed(AttemptSourceType.SUBJECT_TEST));
    check(
      "unlimited attempts never expire (started a year ago)",
      !isExpired(toServerTimedAttempt({ startedAt: new Date(Date.now() - 365 * 86400_000), durationMinutes: 0, durationMode: AttemptDurationMode.UNLIMITED }))
    );
    check(
      "a FIXED 0-minute attempt IS expired (unlimited only via durationMode)",
      isExpired(toServerTimedAttempt({ startedAt: new Date(Date.now() - 1000), durationMinutes: 0, durationMode: AttemptDurationMode.FIXED }))
    );

    // -----------------------------------------------------------------------
    // One full lifecycle, shared by every test type and size.
    async function lifecycle(label: string, studentId: string, attemptId: string, qs: typeof bank, expected: number) {
      const snapshotRows = await prisma.testAttemptQuestion.findMany({ where: { attemptId }, orderBy: { order: "asc" } });
      check(`${label}: ${expected} frozen question(s)`, snapshotRows.length === expected, snapshotRows.length);
      const labels = snapshotRows.map((r) => (r.questionSnapshot as { options: { label: string }[] }).options.map((o) => o.label).join(""));
      check(`${label}: snapshot options frozen in A-D order`, labels.every((l) => l === "ABCD"), labels);
      let answers = await answersOf(attemptId);
      check(`${label}: exactly one Answer row per question`, answers.length === expected);

      const ids = snapshotRows.map((r) => r.questionId);
      const byId = new Map(qs.map((q) => [q.id, q]));
      // Q1: select wrong then change to correct (answer change persists).
      await saveAnswer(attemptId, studentId, ids[0], "A", false, 1000);
      await saveAnswer(attemptId, studentId, ids[0], correctOf(byId.get(ids[0])!), false, 1001);
      if (ids.length >= 2) {
        // Q2: answered + marked for review, but wrong.
        const wrong = correctOf(byId.get(ids[1])!) === "D" ? "A" : "D";
        await saveAnswer(attemptId, studentId, ids[1], wrong, true, 1002);
      }
      if (ids.length >= 3) {
        // Q3: marked for review, unanswered. Q4+: left unanswered (navigation "Next" without answering).
        await saveAnswer(attemptId, studentId, ids[2], null, true, 1003);
      }
      // "Resume": re-read everything from the DB as a fresh page load would.
      answers = await answersOf(attemptId);
      const a1 = answers.find((a) => a.questionId === ids[0])!;
      check(`${label}: changed answer persisted (resume shows final choice)`, a1.selectedOptionLabel === correctOf(byId.get(ids[0])!) && a1.status === "ANSWERED");
      if (ids.length >= 2) {
        const a2 = answers.find((a) => a.questionId === ids[1])!;
        check(`${label}: answered + marked persisted`, a2.status === "ANSWERED_AND_MARKED");
      }
      if (ids.length >= 3) {
        const a3 = answers.find((a) => a.questionId === ids[2])!;
        check(`${label}: marked-unanswered persisted`, a3.status === "MARKED_FOR_REVIEW" && a3.selectedOptionLabel === null);
      }
      const payload = toPlayerQuestions(
        (await prisma.testAttemptQuestion.findMany({ where: { attemptId }, orderBy: { order: "asc" }, include: { answer: true } })),
        { instantMode: false }
      );
      check(`${label}: player payload restores selections on resume`, payload[0].selectedOptionLabel === a1.selectedOptionLabel);
      check(`${label}: EXAM payload carries no answer key`, !/correctLabel|isCorrect/.test(JSON.stringify(payload.map((p) => ({ ...p, reveal: undefined })))) && payload.every((p) => p.reveal === null));

      const submitted = await submitAttempt(attemptId, studentId);
      const expectedCorrect = 1;
      const expectedIncorrect = ids.length >= 2 ? 1 : 0;
      check(
        `${label}: submit → result generated`,
        submitted.status === "SUBMITTED" && submitted.correctCount === expectedCorrect && submitted.incorrectCount === expectedIncorrect && submitted.unansweredCount === ids.length - expectedCorrect - expectedIncorrect,
        { c: submitted.correctCount, i: submitted.incorrectCount, u: submitted.unansweredCount }
      );
      check(`${label}: save after submit refused (NOT_EDITABLE)`, (await engineCode(() => saveAnswer(attemptId, studentId, ids[0], "A", false))) === "NOT_EDITABLE");
      check(`${label}: double submit is idempotent`, (await submitAttempt(attemptId, studentId)).correctCount === submitted.correctCount);
    }

    console.log("\n--- Custom Module: 1 / 2 / 10 questions ---");
    for (const n of [1, 2, 10]) {
      const sid = await mkStudent(`CM${n}`);
      const mod = await mkModule(sid, bank.slice(0, n), { durationMode: AttemptDurationMode.PER_QUESTION, answerMode: AttemptAnswerMode.EXAM });
      const attempt = await startCustomModuleAttempt(sid, mod.id);
      check(`CM ${n}q: 1 min/question → ${n} min`, attempt.durationMinutes === n && attempt.durationMode === "PER_QUESTION");
      const resumed = await startCustomModuleAttempt(sid, mod.id);
      check(`CM ${n}q: restart resumes the same attempt`, resumed.id === attempt.id);
      await lifecycle(`CM ${n}q`, sid, attempt.id, bank, n);
    }

    console.log("\n--- Subject Test: 1 / 2 / 10 questions ---");
    for (const n of [1, 2, 10]) {
      const sid = await mkStudent(`ST${n}`);
      const attempt = await startSubjectTestAttempt(sid, { examId: exam.id, subjectId: subject.id, count: n, durationMinutes: 0, minutesPerQuestion: 1 });
      check(`ST ${n}q: ${n} questions, ${n} min`, attempt.totalQuestions === n && attempt.durationMinutes === n);
      await lifecycle(`ST ${n}q`, sid, attempt.id, [...bank, ...pyq], n);
    }

    console.log("\n--- Mock Test (disposable fixture, 10 questions) ---");
    {
      const sid = await mkStudent("MOCK");
      const attempt = await startMockTestAttempt(sid, mock.id);
      check("Mock: FIXED duration + EXAM mode", attempt.durationMode === "FIXED" && attempt.answerMode === "EXAM" && attempt.durationMinutes === 30);
      const q = bank[0];
      check("Mock: instant reveal refused (NOT_ALLOWED)", (await engineCode(() => revealAnswer(attempt.id, sid, q.id, "A"))) === "NOT_ALLOWED");
      const ans = await prisma.answer.findFirst({ where: { attemptId: attempt.id, questionId: q.id } });
      check("Mock: refused reveal wrote nothing", ans?.revealedAt === null && ans.selectedOptionLabel === null);
      await lifecycle("Mock 10q", sid, attempt.id, bank, 10);
    }

    console.log("\n--- Previous Year Paper (10 questions) ---");
    {
      const sid = await mkStudent("PYQ");
      const attempt = await startPreviousYearPaperAttempt(sid, paper.id);
      check("PYQ: EXAM mode", attempt.answerMode === "EXAM");
      check("PYQ: instant reveal refused", (await engineCode(() => revealAnswer(attempt.id, sid, pyq[0].id, "A"))) === "NOT_ALLOWED");
      await lifecycle("PYQ 10q", sid, attempt.id, pyq, 10);
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Save ordering, idempotency, validation ---");
    {
      const sid = await mkStudent("ORD");
      const mod = await mkModule(sid, bank.slice(0, 3), { durationMode: AttemptDurationMode.UNLIMITED, answerMode: AttemptAnswerMode.EXAM });
      const attempt = await startCustomModuleAttempt(sid, mod.id);
      check("UNLIMITED module → attempt durationMode UNLIMITED", attempt.durationMode === "UNLIMITED" && attempt.durationMinutes === 0);
      const qid = bank[0].id;
      // Rapid A → B → C, delivered out of order: C (seq 30) lands before B (seq 20).
      await saveAnswer(attempt.id, sid, qid, "A", false, 10);
      await saveAnswer(attempt.id, sid, qid, "C", false, 30);
      const stale = await saveAnswer(attempt.id, sid, qid, "B", false, 20);
      let row = await prisma.answer.findFirst({ where: { attemptId: attempt.id, questionId: qid } });
      check("rapid A→B→C: final answer is C even when B arrives late", row?.selectedOptionLabel === "C");
      check("late older save reported as not applied", stale.applied === false);
      const again = await saveAnswer(attempt.id, sid, qid, "C", false, 30);
      check("replaying the same save is an idempotent no-op", again.applied === false);
      check("invalid option label rejected", (await engineCode(() => saveAnswer(attempt.id, sid, qid, "Z", false, 40))) === "INVALID_OPTION");
      check("question outside the attempt rejected", (await engineCode(() => saveAnswer(attempt.id, sid, bank[11].id, "A", false, 41))) === "NOT_IN_ATTEMPT");
      const other = await mkStudent("ORD2");
      check("another student cannot write to this attempt", (await engineCode(() => saveAnswer(attempt.id, other, qid, "A", false, 42))) === "NOT_EDITABLE");

      // Concurrent saves on the SAME question: highest seq must win, one row.
      const seqs = Array.from({ length: 25 }, (_, i) => 1000 + i);
      const shuffled = [...seqs].sort(() => Math.random() - 0.5);
      const labelFor = (s: number) => "ABCD"[s % 4];
      const results = await Promise.allSettled(shuffled.map((s) => saveAnswer(attempt.id, sid, bank[1].id, labelFor(s), false, s)));
      row = await prisma.answer.findFirst({ where: { attemptId: attempt.id, questionId: bank[1].id } });
      const rows = await prisma.answer.count({ where: { attemptId: attempt.id, questionId: bank[1].id } });
      check("25 concurrent saves: no errors / deadlocks", results.every((r) => r.status === "fulfilled"), results.filter((r) => r.status === "rejected").length);
      check("25 concurrent saves: deterministic final = highest seq", row?.selectedOptionLabel === labelFor(1024) && row?.saveSeq === 1024, row);
      check("25 concurrent saves: still exactly one Answer row", rows === 1);

      // Expired window: a FIXED 1-minute attempt started 2 minutes ago.
      const expSid = await mkStudent("EXP");
      const expMod = await mkModule(expSid, bank.slice(0, 1), { durationMode: AttemptDurationMode.CUSTOM, durationMinutes: 1, answerMode: AttemptAnswerMode.EXAM });
      const expAttempt = await startCustomModuleAttempt(expSid, expMod.id);
      check("CUSTOM 1 min module → 1 min attempt", expAttempt.durationMinutes === 1 && expAttempt.durationMode === "CUSTOM");
      await prisma.testAttempt.update({ where: { id: expAttempt.id }, data: { startedAt: new Date(Date.now() - 120_000) } });
      check("save after the window → EXPIRED", (await engineCode(() => saveAnswer(expAttempt.id, expSid, bank[0].id, "A", false))) === "EXPIRED");
      // Unlimited attempt pushed a year back still accepts answers.
      await prisma.testAttempt.update({ where: { id: attempt.id }, data: { startedAt: new Date(Date.now() - 365 * 86400_000) } });
      check("unlimited attempt a year later still saves", (await saveAnswer(attempt.id, sid, bank[2].id, "A", false, 5000)).applied === true);
      const sub = await submitAttempt(attempt.id, sid);
      check("unlimited attempt submits with real elapsed time", sub.status === "SUBMITTED" && (sub.timeTakenSeconds ?? 0) > 300 * 86400);
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Instant answer mode ---");
    {
      const sid = await mkStudent("INST");
      const mod = await mkModule(sid, bank.slice(0, 3), { durationMode: AttemptDurationMode.PER_QUESTION, answerMode: AttemptAnswerMode.INSTANT });
      const attempt = await startCustomModuleAttempt(sid, mod.id);
      check("student INSTANT module → INSTANT attempt", attempt.answerMode === "INSTANT");
      const [q1, q2] = [bank[0], bank[1]];
      const wrong1 = correctOf(q1) === "A" ? "D" : "A";

      let rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, orderBy: { order: "asc" }, include: { answer: true } });
      let payload = toPlayerQuestions(rows, { instantMode: true });
      check("before Check Answer: payload has no answer key", payload.every((p) => p.reveal === null) && !JSON.stringify(payload).includes("correctLabel"));

      check("reveal without a selection refused", (await engineCode(() => revealAnswer(attempt.id, sid, q1.id, ""))) === "NO_SELECTION");
      await saveAnswer(attempt.id, sid, q1.id, wrong1, false, 100);
      const r1 = await revealAnswer(attempt.id, sid, q1.id, wrong1, 101);
      check("authorized reveal returns correct option + verdict", r1.correctLabel === correctOf(q1) && r1.isCorrect === false && r1.selectedOptionLabel === wrong1);
      check("revealed answer cannot be switched to the correct one", (await engineCode(() => saveAnswer(attempt.id, sid, q1.id, correctOf(q1), false, 200))) === "LOCKED");
      const r1b = await revealAnswer(attempt.id, sid, q1.id, correctOf(q1), 201);
      check("re-reveal is idempotent and keeps the frozen wrong answer", r1b.selectedOptionLabel === wrong1 && r1b.isCorrect === false);
      check("mark-for-review still allowed on a revealed question", (await saveAnswer(attempt.id, sid, q1.id, wrong1, true, 202)).applied === true);
      // A stale in-flight save racing the reveal cannot overwrite it.
      await saveAnswer(attempt.id, sid, q2.id, "A", false, 300);
      await revealAnswer(attempt.id, sid, q2.id, correctOf(q2), 310);
      const lateRace = await engineCode(() => saveAnswer(attempt.id, sid, q2.id, "A", false, 305));
      check("an older save landing after reveal is refused", lateRace === "LOCKED");

      rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, orderBy: { order: "asc" }, include: { answer: true } });
      payload = toPlayerQuestions(rows, { instantMode: true });
      const p1 = payload.find((p) => p.questionId === q1.id)!;
      const p3 = payload.find((p) => p.questionId === bank[2].id)!;
      check("refresh: reveal state persists (cannot be reset)", p1.reveal?.correctLabel === correctOf(q1) && p1.selectedOptionLabel === wrong1);
      check("refresh: unrevealed question still has no answer key", p3.reveal === null);
      check("EXAM serializer never emits reveal even if revealedAt were set", toPlayerQuestions(rows, { instantMode: false }).every((p) => p.reveal === null));

      const sub = await submitAttempt(attempt.id, sid);
      check("instant attempt scores the frozen answers (1 wrong, 1 right, 1 blank)", sub.correctCount === 1 && sub.incorrectCount === 1 && sub.unansweredCount === 1);
      check("reveal after submit refused", (await engineCode(() => revealAnswer(attempt.id, sid, bank[2].id, "A"))) === "NOT_EDITABLE");

      // Admin (non-student-owned) module flagged INSTANT is forced back to EXAM.
      const adminMod = await mkModule(sid, bank.slice(0, 2), { durationMode: AttemptDurationMode.FIXED, answerMode: AttemptAnswerMode.INSTANT, studentOwned: false });
      await prisma.customModule.update({ where: { id: adminMod.id }, data: { status: "PUBLISHED" } });
      const adminAttempt = await startCustomModuleAttempt(sid, adminMod.id);
      check("admin custom module can never run INSTANT", adminAttempt.answerMode === "EXAM" && adminAttempt.durationMinutes === 30);
      check("…and its reveal is refused", (await engineCode(() => revealAnswer(adminAttempt.id, sid, bank[0].id, "A"))) === "NOT_ALLOWED");

      // Subject practice may opt in.
      const stSid = await mkStudent("STI");
      const st = await startSubjectTestAttempt(stSid, { examId: exam.id, subjectId: subject.id, count: 2, durationMinutes: 10, answerMode: AttemptAnswerMode.INSTANT });
      check("subject practice can run INSTANT", st.answerMode === "INSTANT");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Malformed question safety ---");
    {
      const sid = await mkStudent("MAL");
      const mod = await mkModule(sid, bank.slice(0, 3), { durationMode: AttemptDurationMode.PER_QUESTION, answerMode: AttemptAnswerMode.EXAM });
      const attempt = await startCustomModuleAttempt(sid, mod.id);
      const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, orderBy: { order: "asc" } });
      // Corrupt one frozen snapshot the way a bad import could (1 option, duplicate-free) and another (duplicate labels).
      await prisma.testAttemptQuestion.update({ where: { id: rows[1].id }, data: { questionSnapshot: { code: "X", text: "broken", imageUrl: null, difficulty: "MEDIUM", options: [{ label: "A", text: "only", imageUrl: null }], correctLabel: "A" } } });
      await prisma.testAttemptQuestion.update({ where: { id: rows[2].id }, data: { questionSnapshot: { code: "Y", text: "dup", imageUrl: null, difficulty: "MEDIUM", options: [{ label: "A", text: "1", imageUrl: null }, { label: "A", text: "2", imageUrl: null }], correctLabel: "A" } } });
      const payload = toPlayerQuestions(await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, orderBy: { order: "asc" }, include: { answer: true } }), { instantMode: false });
      check("valid question unaffected", !payload[0].malformed && payload[0].options.length === 4);
      check("single-option snapshot flagged malformed (skippable, no options)", payload[1].malformed && payload[1].options.length === 0);
      check("duplicate-label snapshot flagged malformed", payload[2].malformed);
      check("null/garbage snapshot does not throw", toPlayerQuestions([{ questionId: "x", questionSnapshot: null }], { instantMode: false })[0].malformed);
      await saveAnswer(attempt.id, sid, rows[0].questionId, "A", false, 10);
      const sub = await submitAttempt(attempt.id, sid);
      check("attempt with malformed questions still submits", sub.status === "SUBMITTED");
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Client save queue (lib/answer-save-queue.ts) ---");
    {
      // Fake server honoring seq like the real one, with controllable latency/failures.
      const server = new Map<string, { label: string | null; seq: number }>();
      const log: string[] = [];
      let failNext = 0;
      const mkQueue = (latency: (label: string | null) => number, opts: { timeoutMs?: number } = {}) =>
        new AnswerSaveQueue({
          send: async (qid, value, seq): Promise<SaveResult> => {
            log.push(`send ${qid}=${value.selected}@${seq}`);
            await sleep(latency(value.selected));
            if (failNext > 0) {
              failNext--;
              return { ok: false, code: "INTERNAL" };
            }
            const cur = server.get(qid);
            if (!cur || cur.seq < seq) server.set(qid, { label: value.selected, seq });
            return { ok: true };
          },
          retryDelaysMs: [20, 20, 20],
          timeoutMs: opts.timeoutMs ?? 1000,
        });

      let q = mkQueue(() => 30);
      q.enqueue("q1", { selected: "A", marked: false });
      q.enqueue("q1", { selected: "B", marked: false });
      q.enqueue("q1", { selected: "C", marked: false });
      check("queue: flush resolves", await q.flush(2000));
      check("queue: rapid A→B→C persists C", server.get("q1")?.label === "C");
      check("queue: coalesced — at most 2 requests for 3 rapid clicks", log.filter((l) => l.startsWith("send q1")).length <= 2, log);

      // Timeout: first request hangs past the timeout, a newer value is sent, then the old one lands late.
      server.clear();
      log.length = 0;
      q = mkQueue((label) => (label === "A" ? 400 : 10), { timeoutMs: 100 });
      q.enqueue("q2", { selected: "A", marked: false });
      await sleep(150); // A timed out client-side, still "in flight" on the server
      q.enqueue("q2", { selected: "B", marked: false });
      check("queue: flush after timeout resolves", await q.flush(3000));
      await sleep(400); // A's late write arrives now
      check("queue: a timed-out older request landing late cannot overwrite the newer answer", server.get("q2")?.label === "B", server.get("q2"));

      // Transient failures retry and then succeed; exhausting retries reports failure (no hang).
      server.clear();
      failNext = 2;
      q = mkQueue(() => 5);
      q.enqueue("q3", { selected: "D", marked: false });
      check("queue: transient failures retried until saved", (await q.flush(2000)) && server.get("q3")?.label === "D");
      failNext = 100;
      let exhausted = false;
      q = new AnswerSaveQueue({
        send: async () => ({ ok: false, code: "INTERNAL" }),
        retryDelaysMs: [5, 5],
        timeoutMs: 100,
        onExhausted: () => (exhausted = true),
      });
      q.enqueue("q4", { selected: "A", marked: false });
      const flushed = await q.flush(2000);
      check("queue: permanent failure surfaces (flush=false, onExhausted) instead of hanging", !flushed && exhausted);
      failNext = 0;
      let fatal = "";
      q = new AnswerSaveQueue({ send: async () => ({ ok: false, code: "EXPIRED" }), onFatal: (c) => (fatal = c) });
      q.enqueue("q5", { selected: "A", marked: false });
      await sleep(20);
      check("queue: EXPIRED is fatal (no retry storm)", fatal === "EXPIRED" && q.idle());
      q = mkQueue(() => 1);
      const s1 = q.nextSeq();
      const s2 = q.nextSeq();
      check("queue: seq strictly increasing", s2 > s1);
    }

    // -----------------------------------------------------------------------
    console.log("\n--- Concurrency: many students, load → select → save → next ---");
    {
      const N = Number(process.env.ENGINE_CONCURRENCY ?? 40);
      const QN = 10;
      const sids: string[] = [];
      for (let i = 0; i < N; i++) sids.push(await mkStudent(`LOAD${i}`));
      const mods = await Promise.all(sids.map((sid) => mkModule(sid, bank.slice(0, QN), { durationMode: AttemptDurationMode.PER_QUESTION, answerMode: AttemptAnswerMode.EXAM })));
      const t0 = Date.now();
      const attempts = await Promise.all(sids.map((sid, i) => startCustomModuleAttempt(sid, mods[i].id)));
      const startMs = Date.now() - t0;
      const lat: number[] = [];
      let errors = 0;
      await Promise.all(
        attempts.map(async (attempt, i) => {
          const sid = sids[i];
          const qrows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, orderBy: { order: "asc" }, select: { questionId: true } });
          let seq = 1;
          for (const { questionId } of qrows) {
            // select, change mind once (a double save), then Next
            for (const label of ["A", "ABCD"[(i + questionId.length) % 4]]) {
              const t = Date.now();
              try {
                await saveAnswer(attempt.id, sid, questionId, label, false, seq++);
              } catch {
                errors++;
              }
              lat.push(Date.now() - t);
            }
          }
        })
      );
      lat.sort((a, b) => a - b);
      const p = (x: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))];
      const answered = await prisma.answer.count({ where: { attemptId: { in: attempts.map((a) => a.id) }, selectedOptionLabel: { not: null } } });
      const total = await prisma.answer.count({ where: { attemptId: { in: attempts.map((a) => a.id) } } });
      console.log(`  info  ${N} students × ${QN} questions × 2 saves = ${lat.length} saves; start ${startMs}ms total; save p50=${p(0.5)}ms p95=${p(0.95)}ms max=${lat[lat.length - 1]}ms`);
      check("concurrency: zero save errors / deadlocks", errors === 0, errors);
      check("concurrency: every answer persisted, no duplicate rows", answered === N * QN && total === N * QN, { answered, total });
      const subs = await Promise.all(attempts.map((a, i) => submitAttempt(a.id, sids[i])));
      check("concurrency: all attempts submit", subs.every((s) => s.status === "SUBMITTED"));
      // Same attempt+question hammered from "two tabs" while submitting: no corruption.
      const raceSid = await mkStudent("RACE");
      const raceMod = await mkModule(raceSid, bank.slice(0, 2), { durationMode: AttemptDurationMode.PER_QUESTION, answerMode: AttemptAnswerMode.EXAM });
      const race = await startCustomModuleAttempt(raceSid, raceMod.id);
      const ops = [
        ...Array.from({ length: 20 }, (_, k) => saveAnswer(race.id, raceSid, bank[0].id, "ABCD"[k % 4], false, 10 + k).catch((e) => e)),
        submitAttempt(race.id, raceSid),
      ];
      await Promise.all(ops);
      const raceAttempt = await prisma.testAttempt.findUnique({ where: { id: race.id } });
      const raceAnswers = await prisma.answer.count({ where: { attemptId: race.id } });
      check("save/submit race: attempt SUBMITTED, answer rows intact", raceAttempt?.status === "SUBMITTED" && raceAnswers === 2);
    }
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: students } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.customModule.deleteMany({ where: { examId: exam.id } });
    await prisma.mockTest.deleteMany({ where: { examId: exam.id } });
    await prisma.question.deleteMany({ where: { examId: exam.id } });
    await prisma.previousYearPaper.deleteMany({ where: { examId: exam.id } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await prisma.exam.delete({ where: { id: exam.id } });
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nALL TEST ENGINE CORE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
