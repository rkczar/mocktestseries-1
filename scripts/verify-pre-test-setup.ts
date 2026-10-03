/**
 * Pre-Test Setup regression (server side, TEST ENGINE CORE).
 *
 * The student's time mode + answer review mode for a NEW Mock Test / PYQ
 * attempt, frozen onto the attempt, and the "Show answer after each
 * question" reveal path:
 *  - config parsing/validation (lib/attempt-config.ts);
 *  - preview writes nothing; Standard / 1 min per question / Custom frozen;
 *    Unlimited impossible for formal tests;
 *  - resume/refresh/re-start can never change a running attempt's config;
 *  - no answer key before a committed Check Answer, the reveal freezes the
 *    answer, Ask AI unlocks for that question only;
 *  - held-answer-key mocks, Grand/Live and OMR stay formal (even tampered);
 *  - same scoring in both modes; only Standard + after-test ranks;
 *  - concurrent start = one attempt; concurrent submit = one submission;
 *  - timeout finalizes and is never resumed; legacy attempts unchanged;
 *  - payment gate + Platform Controls run before any setup or attempt.
 *
 * Run against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-pre-test-setup.ts
 */
import "dotenv/config";
import { AttemptSourceType, AttemptStatus, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MAX_CUSTOM_DURATION_MINUTES, parseAttemptConfigForm, FORMAL_TIME_MODES, PRACTICE_TIME_MODES, type AttemptConfigChoice } from "@/lib/attempt-config";
import {
  previewFormalTestStart,
  revealAnswer,
  saveAnswer,
  startMockTestAttempt,
  startOfflineOmrEntryAttempt,
  startPreviousYearPaperAttempt,
  studentConfigAllowed,
  submitAttempt,
  remainingSecondsFor,
  toServerTimedAttempt,
} from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { getAnswerRevealStatus } from "@/lib/student-data";
import { PaymentRequiredError } from "@/lib/payments/access";
import { PLATFORM_CONTROLS_KEY, PlatformPausedError, bumpPlatformControlsCache, defaultPlatformControls } from "@/lib/platform-controls";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    if (e instanceof PaymentRequiredError) return "PAYMENT_REQUIRED";
    if (e instanceof PlatformPausedError) return "PAUSED";
    return (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e));
  }
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const cfg = (durationMode: AttemptConfigChoice["durationMode"], answerMode: AttemptConfigChoice["answerMode"], customMinutes?: number): AttemptConfigChoice => ({
  durationMode,
  answerMode,
  customMinutes,
});

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

  const suffix = Date.now().toString(36);
  const students: string[] = [];
  const mockIds: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `PTS${tag}-${suffix}`, name: `PTS ${tag}`, email: `pts-${tag.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };

  const savedPlatform = await prisma.setting.findUnique({ where: { key: PLATFORM_CONTROLS_KEY } });
  const savedPayments = await prisma.setting.findUnique({ where: { key: "payments.mode" } });

  // Five published single-answer questions from one active exam: the fixture mocks' question set.
  const exam = await prisma.exam.findFirstOrThrow({
    where: { isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    orderBy: { questions: { _count: "desc" } },
  });
  const bank = await prisma.question.findMany({
    where: { examId: exam.id, status: QuestionStatus.PUBLISHED, options: { some: { isCorrect: true } } },
    take: 5,
    orderBy: { code: "asc" },
    include: { options: true },
  });
  if (bank.length < 5) throw new Error("Fixture precondition: needs 5 published questions in one active exam.");
  const correctOf = (qid: string) => bank.find((q) => q.id === qid)!.options.find((o) => o.isCorrect)!.label;
  const wrongOf = (qid: string) => bank.find((q) => q.id === qid)!.options.find((o) => !o.isCorrect)!.label;

  const mkMock = async (tag: string, extra: Record<string, unknown> = {}) => {
    const m = await prisma.mockTest.create({
      data: {
        examId: exam.id,
        title: `PTS ${tag} ${suffix}`,
        durationMinutes: 37,
        negativeMarking: 0.25,
        status: "PUBLISHED",
        accessType: "FREE",
        ...extra,
        questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) },
      },
    });
    mockIds.push(m.id);
    return m;
  };

  try {
    console.log("\n--- Config parsing (lib/attempt-config.ts) ---");
    {
      const d = parseAttemptConfigForm(form({}), FORMAL_TIME_MODES, "FIXED");
      check("formal default = Standard + answers after the test", d.ok && d.config.durationMode === "FIXED" && d.config.answerMode === "EXAM");
      const ok = parseAttemptConfigForm(form({ durationMode: "CUSTOM", customMinutes: "45", answerMode: "INSTANT" }), FORMAL_TIME_MODES, "FIXED");
      check("custom 45 + instant parsed", ok.ok && ok.config.customMinutes === 45 && ok.config.answerMode === "INSTANT");
      for (const bad of ["0", "-5", "abc", "", "12.5", "1e3", "NaN", String(MAX_CUSTOM_DURATION_MINUTES + 1), "99999"]) {
        const r = parseAttemptConfigForm(form({ durationMode: "CUSTOM", customMinutes: bad }), FORMAL_TIME_MODES, "FIXED");
        check(`custom minutes "${bad}" rejected`, !r.ok);
      }
      check("formal: Unlimited is not offered/accepted", !parseAttemptConfigForm(form({ durationMode: "UNLIMITED" }), FORMAL_TIME_MODES, "FIXED").ok);
      check("practice: Standard is not offered/accepted", !parseAttemptConfigForm(form({ durationMode: "FIXED" }), PRACTICE_TIME_MODES, "PER_QUESTION").ok);
      check("unknown answer mode rejected", !parseAttemptConfigForm(form({ answerMode: "REVEAL_ALL" }), FORMAL_TIME_MODES, "FIXED").ok);
    }

    console.log("\n--- Policy: who may configure ---");
    check("PYQ configurable", studentConfigAllowed(AttemptSourceType.PREVIOUS_YEAR_PAPER));
    check("IMMEDIATE, unwindowed mock configurable", studentConfigAllowed(AttemptSourceType.MOCK_TEST, { resultReleaseMode: "IMMEDIATE", availableUntil: null }));
    check("windowed mock NOT configurable", !studentConfigAllowed(AttemptSourceType.MOCK_TEST, { resultReleaseMode: "IMMEDIATE", availableUntil: new Date(Date.now() + 3.6e6) }));
    check("held-result mock NOT configurable", !studentConfigAllowed(AttemptSourceType.MOCK_TEST, { resultReleaseMode: "CUSTOM_DATE", availableUntil: null }));
    check("Grand / Live NOT configurable", !studentConfigAllowed(AttemptSourceType.GRAND_TEST) && !studentConfigAllowed(AttemptSourceType.LIVE_TEST));
    check("Subject / Custom are not formal-configurable here (own setup)", !studentConfigAllowed(AttemptSourceType.SUBJECT_TEST) && !studentConfigAllowed(AttemptSourceType.CUSTOM_MODULE));

    const mock = await mkMock("FREE");

    console.log("\n--- Preview writes nothing ---");
    {
      const sid = await mkStudent("PREV");
      const p = await previewFormalTestStart(sid, { kind: "MOCK_TEST", id: mock.id });
      check("preview: setup summary (configurable, 5 questions, standard 37)", !p.resume && p.summary.configurable && p.summary.questionCount === 5 && p.summary.standardMinutes === 37);
      check("preview: no attempt row created", (await prisma.testAttempt.count({ where: { studentId: sid } })) === 0);
    }

    console.log("\n--- Time modes frozen ---");
    const sTime = await mkStudent("TIME");
    {
      const a = await startMockTestAttempt(sTime, mock.id, undefined, cfg("PER_QUESTION", "EXAM"));
      check("1 min/question: PER_QUESTION, 5 questions = 5 minutes", a.durationMode === "PER_QUESTION" && a.durationMinutes === 5);
      const again = await startMockTestAttempt(sTime, mock.id, undefined, cfg("CUSTOM", "INSTANT", 300));
      check("re-start/refresh resumes the SAME attempt, config untouched", again.id === a.id && again.durationMode === "PER_QUESTION" && again.durationMinutes === 5 && again.answerMode === "EXAM");
      const preview = await previewFormalTestStart(sTime, { kind: "MOCK_TEST", id: mock.id });
      check("preview with a running attempt → resume, no setup", preview.resume?.id === a.id);
      const remaining = remainingSecondsFor(toServerTimedAttempt(again));
      check("server window = frozen 5 minutes (timer never resets)", remaining <= 300 && remaining > 290, remaining);
      await submitAttempt(a.id, sTime);

      const std = await startMockTestAttempt(sTime, mock.id, undefined, cfg("FIXED", "EXAM"));
      check("Standard: admin duration 37 (never a global 120)", std.durationMode === "FIXED" && std.durationMinutes === 37 && std.id !== a.id);
      await submitAttempt(std.id, sTime);

      const custom = await startMockTestAttempt(sTime, mock.id, undefined, cfg("CUSTOM", "EXAM", 13));
      check("Custom: 13 minutes frozen", custom.durationMode === "CUSTOM" && custom.durationMinutes === 13);
      await submitAttempt(custom.id, sTime);

      check("Unlimited refused for a formal test", (await outcome(() => startMockTestAttempt(sTime, mock.id, undefined, cfg("UNLIMITED", "EXAM")))) === "NOT_ALLOWED");
      check("custom 0 refused by the engine", (await outcome(() => startMockTestAttempt(sTime, mock.id, undefined, cfg("CUSTOM", "EXAM", 0)))) === "NOT_ALLOWED");
      check("custom 601 refused by the engine", (await outcome(() => startMockTestAttempt(sTime, mock.id, undefined, cfg("CUSTOM", "EXAM", 601)))) === "NOT_ALLOWED");
      const legacy = await startMockTestAttempt(sTime, mock.id);
      check("no choice (old page / deploy skew) = legacy FIXED + EXAM", legacy.durationMode === "FIXED" && legacy.answerMode === "EXAM" && legacy.durationMinutes === 37);
      await submitAttempt(legacy.id, sTime);
    }

    console.log("\n--- Show answer after each question ---");
    const sInst = await mkStudent("INST");
    let instantScore = 0;
    const responses: Record<string, string | null> = {};
    {
      const a = await startMockTestAttempt(sInst, mock.id, undefined, cfg("FIXED", "INSTANT"));
      check("INSTANT frozen on the mock attempt", a.answerMode === "INSTANT" && a.durationMode === "FIXED");
      const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: a.id }, orderBy: { order: "asc" }, include: { answer: true } });
      const [q1, q2, q3, q4] = rows.map((r) => r.questionId);

      const before = toPlayerQuestions(rows, { instantMode: true });
      check("no answer key in the player payload before commit", before.every((p) => p.reveal === null) && !JSON.stringify(before).includes("correctLabel") && !JSON.stringify(before).includes("isCorrect"));
      check("Ask AI locked before commit", (await getAnswerRevealStatus(sInst, q1)) === "IN_PROGRESS");

      // Selecting (saving) is NOT committing: still no key.
      await saveAnswer(a.id, sInst, q1, wrongOf(q1), false, 1);
      const afterSave = await prisma.testAttemptQuestion.findMany({ where: { attemptId: a.id }, orderBy: { order: "asc" }, include: { answer: true } });
      check("a saved (uncommitted) answer reveals nothing", toPlayerQuestions(afterSave, { instantMode: true }).every((p) => p.reveal === null));

      const r1 = await revealAnswer(a.id, sInst, q1, wrongOf(q1), 2);
      check("commit wrong answer → incorrect + correct label returned", !r1.isCorrect && r1.correctLabel === correctOf(q1) && r1.selectedOptionLabel === wrongOf(q1));
      check("committed answer is final (switching to the key refused)", (await outcome(() => saveAnswer(a.id, sInst, q1, correctOf(q1), false, 3))) === "LOCKED");
      check("mark-for-review still allowed after commit", (await outcome(() => saveAnswer(a.id, sInst, q1, wrongOf(q1), true, 4))) === "OK");
      const r2 = await revealAnswer(a.id, sInst, q2, correctOf(q2), 5);
      check("commit correct answer → correct", r2.isCorrect);
      check("Ask AI unlocked for the committed question only", (await getAnswerRevealStatus(sInst, q1)) === "REVEALABLE" && (await getAnswerRevealStatus(sInst, q3)) === "IN_PROGRESS");

      const refreshed = toPlayerQuestions(
        await prisma.testAttemptQuestion.findMany({ where: { attemptId: a.id }, orderBy: { order: "asc" }, include: { answer: true } }),
        { instantMode: true }
      );
      check("refresh: committed reveals persist, others still hidden", refreshed[0].reveal?.correctLabel === correctOf(q1) && refreshed[1].reveal !== null && refreshed[2].reveal === null && refreshed[3].reveal === null);
      check("refresh: answer mode cannot change mid-attempt", (await startMockTestAttempt(sInst, mock.id, undefined, cfg("FIXED", "EXAM"))).answerMode === "INSTANT");

      // q3 answered but never checked; q4 + q5 blank.
      await saveAnswer(a.id, sInst, q3, wrongOf(q3), false, 6);
      Object.assign(responses, { [q1]: wrongOf(q1), [q2]: correctOf(q2), [q3]: wrongOf(q3), [q4]: null });
      const sub = await submitAttempt(a.id, sInst);
      instantScore = sub.score ?? NaN;
      check("instant attempt scored with negative marking (1 right, 2 wrong × 0.25, 2 blank)", sub.correctCount === 1 && sub.incorrectCount === 2 && sub.unansweredCount === 2 && sub.score === 1 - 2 * 0.25);
      check("practice-config attempt is NOT a leaderboard attempt", sub.isLeaderboardAttempt === false);
      check("reveal after submit refused", (await outcome(() => revealAnswer(a.id, sInst, q4, correctOf(q4), 9))) === "NOT_EDITABLE");
    }

    console.log("\n--- Same scoring in both modes ---");
    {
      const sExam = await mkStudent("EXAM");
      const a = await startMockTestAttempt(sExam, mock.id, undefined, cfg("FIXED", "EXAM"));
      check("after-test mode: Check Answer refused", (await outcome(() => revealAnswer(a.id, sExam, bank[0].id, wrongOf(bank[0].id), 1))) === "NOT_ALLOWED");
      let seq = 10;
      for (const [qid, label] of Object.entries(responses)) if (label) await saveAnswer(a.id, sExam, qid, label, false, seq++);
      const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: a.id }, include: { answer: true } });
      check("after-test mode: no answer key in the payload at any point", toPlayerQuestions(rows, { instantMode: false }).every((p) => p.reveal === null));
      check("after-test mode: Ask AI locked during the test", (await getAnswerRevealStatus(sExam, bank[0].id)) === "IN_PROGRESS");
      const sub = await submitAttempt(a.id, sExam);
      check("identical responses → identical score in both modes", sub.score === instantScore, { exam: sub.score, instant: instantScore });
      check("Standard + after-test first submission IS the leaderboard attempt", sub.isLeaderboardAttempt === true);
    }
    {
      // First submission practice-configured, later Standard one ranks.
      const sid = await mkStudent("RANK");
      const p = await startMockTestAttempt(sid, mock.id, undefined, cfg("PER_QUESTION", "EXAM"));
      check("1 min/question attempt does not rank", (await submitAttempt(p.id, sid)).isLeaderboardAttempt === false);
      const s = await startMockTestAttempt(sid, mock.id, undefined, cfg("FIXED", "EXAM"));
      check("…the later Standard attempt becomes the leaderboard attempt", (await submitAttempt(s.id, sid)).isLeaderboardAttempt === true);
    }

    console.log("\n--- Ask AI: another running exam containing the question still wins ---");
    {
      const sid = await mkStudent("AIW");
      const a = await startMockTestAttempt(sid, mock.id, undefined, cfg("FIXED", "INSTANT"));
      await revealAnswer(a.id, sid, bank[0].id, correctOf(bank[0].id), 1);
      check("revealed → REVEALABLE", (await getAnswerRevealStatus(sid, bank[0].id)) === "REVEALABLE");
      const other = await mkMock("OTHER");
      await startMockTestAttempt(sid, other.id, undefined, cfg("FIXED", "EXAM"));
      check("same question in another running EXAM attempt → locked again", (await getAnswerRevealStatus(sid, bank[0].id)) === "IN_PROGRESS");
    }

    console.log("\n--- Held answer key / tampering ---");
    {
      const held = await mkMock("HELD", { resultReleaseMode: "CUSTOM_DATE", resultReleaseAt: new Date(Date.now() + 86_400_000) });
      const sid = await mkStudent("HELD");
      const p = await previewFormalTestStart(sid, { kind: "MOCK_TEST", id: held.id });
      check("held-result mock: no setup offered", !p.resume && !p.summary.configurable);
      const a = await startMockTestAttempt(sid, held.id, undefined, cfg("CUSTOM", "INSTANT", 200));
      check("held-result mock: a posted choice is ignored (FIXED + EXAM)", a.durationMode === "FIXED" && a.answerMode === "EXAM" && a.durationMinutes === 37);
      await prisma.testAttempt.update({ where: { id: a.id }, data: { answerMode: "INSTANT" } });
      check("held-result mock: tampered INSTANT row still cannot reveal", (await outcome(() => revealAnswer(a.id, sid, bank[0].id, wrongOf(bank[0].id), 1))) === "NOT_ALLOWED");

      // Admin holds the key AFTER an instant attempt started.
      const flip = await mkMock("FLIP");
      const s2 = await mkStudent("FLIP");
      const b = await startMockTestAttempt(s2, flip.id, undefined, cfg("FIXED", "INSTANT"));
      await revealAnswer(b.id, s2, bank[0].id, wrongOf(bank[0].id), 1);
      await prisma.mockTest.update({ where: { id: flip.id }, data: { resultReleaseMode: "CUSTOM_DATE", resultReleaseAt: new Date(Date.now() + 86_400_000) } });
      check("key held mid-attempt: further reveals refused", (await outcome(() => revealAnswer(b.id, s2, bank[1].id, wrongOf(bank[1].id), 2))) === "NOT_ALLOWED");
      check("key held mid-attempt: Ask AI locked again", (await getAnswerRevealStatus(s2, bank[0].id)) !== "REVEALABLE");

      const windowed = await mkMock("WIN", { availableUntil: new Date(Date.now() + 3_600_000) });
      const s3 = await mkStudent("WIN");
      const w = await startMockTestAttempt(s3, windowed.id, undefined, cfg("CUSTOM", "INSTANT", 500));
      check("fixed-window mock: formal (FIXED + EXAM), window still caps time", w.durationMode === "FIXED" && w.answerMode === "EXAM");
    }

    console.log("\n--- OMR ---");
    {
      const sid = await mkStudent("OMR");
      const o = await startOfflineOmrEntryAttempt(sid, mock.id);
      check("OMR entry: formal FIXED + EXAM (bulk entry never reveals)", o.entryMode === "OFFLINE_OMR_ENTRY" && o.durationMode === "FIXED" && o.answerMode === "EXAM");
      const p = await previewFormalTestStart(sid, { kind: "MOCK_TEST", id: mock.id });
      check("OMR in progress: online Start resumes it (no setup)", p.resume?.id === o.id);
      await submitAttempt(o.id, sid);
    }

    console.log("\n--- Concurrency ---");
    {
      const sid = await mkStudent("DBL");
      const starts = await Promise.all([
        startMockTestAttempt(sid, mock.id, undefined, cfg("PER_QUESTION", "INSTANT")),
        startMockTestAttempt(sid, mock.id, undefined, cfg("CUSTOM", "EXAM", 20)),
        startMockTestAttempt(sid, mock.id, undefined, cfg("FIXED", "EXAM")),
        startMockTestAttempt(sid, mock.id, undefined, cfg("PER_QUESTION", "INSTANT")),
      ]);
      const ids = new Set(starts.map((s) => s.id));
      check("4 concurrent configured starts → ONE attempt", ids.size === 1 && (await prisma.testAttempt.count({ where: { studentId: sid } })) === 1);
      const id = starts[0].id;
      await saveAnswer(id, sid, bank[0].id, correctOf(bank[0].id), false, 1);
      const logsBefore = await prisma.studentActivity.count({ where: { studentId: sid, activity: "TEST_SUBMITTED" } });
      const subs = await Promise.all([submitAttempt(id, sid), submitAttempt(id, sid), submitAttempt(id, sid)]);
      const row = await prisma.testAttempt.findUniqueOrThrow({ where: { id } });
      check("3 concurrent submits → one consistent result", subs.every((s) => s.status === "SUBMITTED" && s.score === row.score) && row.correctCount === 1);
      check("…and exactly one submission logged", (await prisma.studentActivity.count({ where: { studentId: sid, activity: "TEST_SUBMITTED" } })) - logsBefore === 1);
      check("one Answer row per question (no duplicates)", (await prisma.answer.count({ where: { attemptId: id } })) === 5);
    }

    console.log("\n--- Timeout ---");
    {
      const sid = await mkStudent("TMO");
      const a = await startMockTestAttempt(sid, mock.id, undefined, cfg("PER_QUESTION", "INSTANT"));
      await prisma.testAttempt.update({ where: { id: a.id }, data: { startedAt: new Date(Date.now() - 6 * 60_000) } });
      check("after 1-min/question window: save refused (EXPIRED)", (await outcome(() => saveAnswer(a.id, sid, bank[0].id, "A", false, 1))) === "EXPIRED");
      check("after window: reveal refused (EXPIRED)", (await outcome(() => revealAnswer(a.id, sid, bank[0].id, "A", 2))) === "EXPIRED");
      const p = await previewFormalTestStart(sid, { kind: "MOCK_TEST", id: mock.id });
      const old = await prisma.testAttempt.findUniqueOrThrow({ where: { id: a.id } });
      check("timed-out attempt finalized, never resumed → fresh setup", !p.resume && old.status === "SUBMITTED");
    }

    console.log("\n--- Legacy in-progress attempts (pre-feature rows) ---");
    {
      const legacy = await prisma.testAttempt.findMany({
        where: { status: AttemptStatus.IN_PROGRESS, sourceType: { in: ["MOCK_TEST", "PREVIOUS_YEAR_PAPER"] }, studentId: { notIn: students } },
        include: { questions: { include: { answer: true } } },
        take: 25,
      });
      check(`legacy rows found (${legacy.length})`, legacy.length > 0);
      check("legacy formal attempts are all FIXED + EXAM", legacy.every((a) => a.durationMode === "FIXED" && a.answerMode === "EXAM"));
      check("legacy payloads never carry an answer key", legacy.every((a) => toPlayerQuestions(a.questions, { instantMode: a.answerMode === "INSTANT" }).every((p) => p.reveal === null)));
      const one = legacy.find((a) => a.questions.length > 0);
      if (one) {
        const q = one.questions[0];
        const label = (q.questionSnapshot as { options: { label: string }[] }).options[0].label;
        const r = await outcome(() => revealAnswer(one.id, one.studentId, q.questionId, label, 1));
        check("legacy attempt: reveal refused (no write)", r === "NOT_ALLOWED" || r === "EXPIRED", r);
      }
    }

    console.log("\n--- PYQ ---");
    {
      const paper = await prisma.previousYearPaper.findFirstOrThrow({
        where: { isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED } } },
        orderBy: { year: "desc" },
        include: { exam: true, _count: { select: { questions: { where: { status: QuestionStatus.PUBLISHED } } } } },
      });
      const sid = await mkStudent("PYQ");
      const p = await previewFormalTestStart(sid, { kind: "PREVIOUS_YEAR_PAPER", id: paper.id });
      check("PYQ preview: configurable, standard = configured exam duration (60 when unset)", !p.resume && p.summary.configurable && p.summary.standardMinutes === (paper.exam.durationMinutes ?? 60));
      const a = await startPreviousYearPaperAttempt(sid, paper.id, cfg("PER_QUESTION", "INSTANT"));
      check("PYQ: 1 min/question = whole paper's count", a.durationMode === "PER_QUESTION" && a.durationMinutes === a.totalQuestions && a.totalQuestions === paper._count.questions);
      const first = await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: a.id }, orderBy: { order: "asc" } });
      const snap = first.questionSnapshot as { options: { label: string }[]; correctLabel: string };
      const r = await revealAnswer(a.id, sid, first.questionId, snap.options[0].label, 1);
      check("PYQ: Check Answer works in instant mode", r.correctLabel === snap.correctLabel);
      await submitAttempt(a.id, sid);
      const legacy = await startPreviousYearPaperAttempt(sid, paper.id);
      check("PYQ without a choice = legacy FIXED + EXAM", legacy.durationMode === "FIXED" && legacy.answerMode === "EXAM");
    }

    console.log("\n--- Payment gate before setup ---");
    {
      await prisma.setting.upsert({ where: { key: "payments.mode" }, update: { value: { mode: "PAID" } }, create: { key: "payments.mode", value: { mode: "PAID" } } });
      const paid = await mkMock("PAID", { accessType: "PAID" });
      const sid = await mkStudent("PAID");
      check("paid, not purchased: preview → PAYMENT_REQUIRED", (await outcome(() => previewFormalTestStart(sid, { kind: "MOCK_TEST", id: paid.id }))) === "PAYMENT_REQUIRED");
      check("paid, not purchased: configured start → PAYMENT_REQUIRED", (await outcome(() => startMockTestAttempt(sid, paid.id, undefined, cfg("FIXED", "INSTANT")))) === "PAYMENT_REQUIRED");
      check("paid, not purchased: no attempt / no question payload", (await prisma.testAttempt.count({ where: { studentId: sid } })) === 0);
    }

    console.log("\n--- Platform Controls: Start New Tests paused ---");
    {
      const sid = await mkStudent("PAUSE");
      const running = await startMockTestAttempt(sid, mock.id, undefined, cfg("FIXED", "INSTANT"));
      const state = defaultPlatformControls();
      state.tests.open = false;
      await prisma.setting.upsert({ where: { key: PLATFORM_CONTROLS_KEY }, update: { value: state as never }, create: { key: PLATFORM_CONTROLS_KEY, value: state as never } });
      bumpPlatformControlsCache();
      const s2 = await mkStudent("PAUSE2");
      check("paused: preview refused (no setup shown)", (await outcome(() => previewFormalTestStart(s2, { kind: "MOCK_TEST", id: mock.id }))) === "PAUSED");
      check("paused: configured start refused", (await outcome(() => startMockTestAttempt(s2, mock.id, undefined, cfg("PER_QUESTION", "EXAM")))) === "PAUSED");
      check("paused: a running attempt still resumes", (await startMockTestAttempt(sid, mock.id, undefined, cfg("PER_QUESTION", "EXAM"))).id === running.id);
      check("paused: committing an answer still works", (await outcome(() => revealAnswer(running.id, sid, bank[0].id, wrongOf(bank[0].id), 1))) === "OK");
    }
  } finally {
    if (savedPlatform) await prisma.setting.upsert({ where: { key: PLATFORM_CONTROLS_KEY }, update: { value: savedPlatform.value as never }, create: { key: PLATFORM_CONTROLS_KEY, value: savedPlatform.value as never } });
    else await prisma.setting.deleteMany({ where: { key: PLATFORM_CONTROLS_KEY } });
    if (savedPayments) await prisma.setting.update({ where: { key: "payments.mode" }, data: { value: savedPayments.value as never } });
    else await prisma.setting.deleteMany({ where: { key: "payments.mode" } });
    bumpPlatformControlsCache();
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.mockTest.deleteMany({ where: { id: { in: mockIds } } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
  }

  console.log(failures === 0 ? "\nALL PRE-TEST SETUP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
