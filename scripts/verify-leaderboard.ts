/**
 * Ranking & Leaderboard Phase 1 regression (lib/leaderboard.ts + lib/leaderboard-core.ts).
 *
 *  - pure rules: ranking order at every tie level, deterministic final tie,
 *    percentile / Top % (rank #1, #24/386, sum = 100), display names,
 *    eligibility (OMR, Practice Mode, practice-first, retakes, competitive-first);
 *  - the PostgreSQL ranking query agrees with the pure reference on crafted
 *    AND randomized data, and on the real (copied) production attempts;
 *  - real engine flows: OMR entry, Practice Mode first, Standard-first, PYQ;
 *  - PYQ board independent of Mock boards; PYQ can never count toward Overall
 *    (DB CHECK); leaderboard disabled; config defaults/legacy column;
 *  - privacy: no student id / email / phone / MTS id / surname in the payload,
 *    deleted → "Former Student", YOU only on the viewer;
 *  - Your Position window, page clamping, 10,000-participant timing;
 *  - read-only: every pre-existing TestAttempt / Answer row unchanged.
 *
 * DISPOSABLE database only (refuses the production DB name):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-leaderboard.ts
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  OVERALL_MIN_RANKED_TESTS,
  attemptRankingStatus,
  compareForRank,
  competitionRanks,
  exposesAnswerKey,
  isCompetitiveAttempt,
  leaderboardDisplayName,
  rankPercentiles,
  studentStanding,
  type RankableAttempt,
} from "@/lib/leaderboard-core";
import {
  clearOverallRankingCache,
  getAttemptRanking,
  getLeaderboard,
  getOverallLeaderboard,
  getOverallStanding,
  getRankingConfig,
  getStudentRankableAttempts,
  getStudentRankedTests,
  type RankingTestRef,
} from "@/lib/leaderboard";
import { saveAnswer, startMockTestAttempt, startOfflineOmrEntryAttempt, startPreviousYearPaperAttempt, submitAttempt } from "@/lib/test-attempt";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
let seq = 0;
function att(p: Partial<RankableAttempt> & { minute?: number }): RankableAttempt {
  seq += 1;
  return {
    id: p.id ?? `a${String(seq).padStart(6, "0")}`,
    status: p.status ?? "SUBMITTED",
    entryMode: p.entryMode ?? "ONLINE",
    durationMode: p.durationMode ?? "FIXED",
    answerMode: p.answerMode ?? "EXAM",
    startedAt: p.startedAt ?? new Date(T0 + (p.minute ?? seq) * 60_000),
    submittedAt: p.submittedAt === undefined ? new Date(T0 + (p.minute ?? seq) * 60_000 + 3_600_000) : p.submittedAt,
    score: p.score ?? 0,
    correctCount: p.correctCount ?? 0,
    incorrectCount: p.incorrectCount ?? 0,
    timeTakenSeconds: p.timeTakenSeconds === undefined ? 1800 : p.timeTakenSeconds,
  };
}

/** Pure reference: per-student official attempt → competition ranks (display order: rank, then student id). */
function referenceRanking(byStudent: Map<string, RankableAttempt[]>): { studentId: string; attemptId: string; rank: number }[] {
  const entries: { studentId: string; a: RankableAttempt }[] = [];
  for (const [studentId, list] of byStudent) {
    const s = studentStanding(list);
    if (s.kind === "RANKED") entries.push({ studentId, a: list.find((x) => x.id === s.officialAttemptId)! });
  }
  entries.sort((x, y) => compareForRank(x.a, y.a) || (x.studentId < y.studentId ? -1 : x.studentId > y.studentId ? 1 : 0));
  const ranks = competitionRanks(entries, (x, y) => compareForRank(x.a, y.a) === 0);
  return entries.map((e, i) => ({ studentId: e.studentId, attemptId: e.a.id, rank: ranks[i] }));
}

function letters(n: number, width = 4): string {
  let s = "";
  for (let i = 0; i < width; i++) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

async function integrityChecksum(): Promise<string> {
  const rows = await prisma.$queryRaw<{ a: string; b: string; c: string }[]>`
    SELECT
      (SELECT md5(string_agg(concat_ws('|',id,status,score,"correctCount","incorrectCount","unansweredCount","timeTakenSeconds","startedAt","submittedAt","isLeaderboardAttempt","answerMode","durationMode","entryMode"), ',' ORDER BY id)) FROM "TestAttempt") AS a,
      (SELECT md5(string_agg(concat_ws('|',id,"selectedOptionLabel",array_to_string("selectedLabels",'+'),"isCorrect",status,"answeredAt","revealedAt","saveSeq"), ',' ORDER BY id)) FROM "Answer") AS b,
      (SELECT md5(string_agg(concat_ws('|',id,"leaderboardEnabled"), ',' ORDER BY id)) FROM "MockTest") AS c`;
  return `${rows[0].a}/${rows[0].b}/${rows[0].c}`;
}

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

  // ===================================================================
  console.log("\n--- Pure: percentile / Top % ---");
  const p24 = rankPercentiles(24, 386);
  check("#24 / 386 → percentile 93.8", p24.percentile === 93.8, p24);
  check("#24 / 386 → Top 6.2%", p24.topPercent === 6.2, p24);
  const p1 = rankPercentiles(1, 100);
  check("#1 / 100 → percentile 99.0 (highest possible for N=100)", p1.percentile === 99, p1);
  check("#1 / 100 → Top 1.0% (the inverted 'Top 100%' bug is gone)", p1.topPercent === 1, p1);
  const pLast = rankPercentiles(100, 100);
  check("#100 / 100 → percentile 0.0, Top 100%", pLast.percentile === 0 && pLast.topPercent === 100, pLast);
  check("#1 / 1 (sole participant) → percentile 0.0, Top 100%", rankPercentiles(1, 1).percentile === 0 && rankPercentiles(1, 1).topPercent === 100);
  check("#1 / 5000 → Top never below 0.1% (percentile 99.9)", rankPercentiles(1, 5000).topPercent === 0.1 && rankPercentiles(1, 5000).percentile === 99.9);
  let monotonic = true;
  let sums = true;
  for (const n of [1, 2, 3, 7, 16, 99, 386, 1000, 2001, 12345]) {
    let prev = { percentile: Infinity, topPercent: -Infinity };
    for (let r = 1; r <= n; r++) {
      const p = rankPercentiles(r, n);
      if (Math.round((p.percentile + p.topPercent) * 10) !== 1000) sums = false;
      if (p.percentile > prev.percentile || p.topPercent < prev.topPercent) monotonic = false;
      prev = p;
    }
  }
  check("percentile + Top % = 100.0 exactly, for every rank of many N", sums);
  check("better rank ⇒ percentile never lower and Top % never higher", monotonic);
  let threw = false;
  try {
    rankPercentiles(0, 10);
  } catch {
    threw = true;
  }
  check("invalid rank throws", threw);

  // ===================================================================
  console.log("\n--- Pure: display names ---");
  const names: [string | null, string, string][] = [
    ["Rahul Kumar", "ACTIVE", "Rahul K."],
    ["Priya Sharma", "ACTIVE", "Priya S."],
    ["  rahul   kumar  verma ", "ACTIVE", "Rahul V."],
    ["PRIYA SHARMA", "ACTIVE", "Priya S."],
    ["Rahul", "ACTIVE", "Rahul"],
    ["Dr. Ankit Jain", "ACTIVE", "Ankit J."],
    ["Deleted Student", "DELETED", "Former Student"],
    ["Real Name", "DELETED", "Former Student"],
    ["Real Name", "DELETION_REQUESTED", "Former Student"],
    ["rahul@gmail.com", "ACTIVE", "Student"],
    ["9876543210", "ACTIVE", "Student"],
    ["Amit 9876543210", "ACTIVE", "Amit"],
    ["", "ACTIVE", "Student"],
    [null, "ACTIVE", "Student"],
    ["Ñandu Øster", "ACTIVE", "Ñandu Ø."],
  ];
  for (const [input, status, expected] of names) {
    const got = leaderboardDisplayName(input, status);
    check(`display name ${JSON.stringify(input)} (${status}) → ${expected}`, got === expected, got);
  }

  // ===================================================================
  console.log("\n--- Pure: ranking order ---");
  const sorted = (list: RankableAttempt[]) => [...list].sort(compareForRank).map((a) => a.id);
  check("higher score ranks first", sorted([att({ id: "lo", score: 5 }), att({ id: "hi", score: 9 })])[0] === "hi");
  check(
    "score tie → higher accuracy first",
    sorted([att({ id: "acc50", score: 4, correctCount: 4, incorrectCount: 4 }), att({ id: "acc80", score: 4, correctCount: 4, incorrectCount: 1 })])[0] === "acc80"
  );
  // Equal score and accuracy with different counts: 2/4 vs 4/8 at score 2 needs negative marking 0.5 → 2-1=1 vs 4-2=2; craft directly.
  check(
    "accuracy tie → more correct answers first",
    sorted([att({ id: "c2", score: 3, correctCount: 2, incorrectCount: 2 }), att({ id: "c4", score: 3, correctCount: 4, incorrectCount: 4 })])[0] === "c4"
  );
  const slow = att({ id: "slow", score: 3, correctCount: 3, timeTakenSeconds: 9000 });
  const fast = att({ id: "fast", score: 3, correctCount: 3, timeTakenSeconds: 60 });
  check("TIME DOES NOT AFFECT RANK: same score/accuracy/correct, 60 s vs 9000 s → equal (0)", compareForRank(slow, fast) === 0 && compareForRank(fast, slow) === 0);
  const late = att({ id: "late", score: 3, correctCount: 3, submittedAt: new Date(T0 + 9e9) });
  const early = att({ id: "early", score: 3, correctCount: 3, submittedAt: new Date(T0) });
  check("submission time does not affect rank either → equal (0)", compareForRank(late, early) === 0);
  check("a much faster attempt with ONE fewer mark still ranks below", compareForRank(att({ score: 2, correctCount: 2, timeTakenSeconds: 1 }), slow) > 0);
  check("competition ranks: equal performance shares a rank (1, 2, 2, 4)", JSON.stringify(competitionRanks([5, 4, 4, 3], (a, b) => a === b)) === "[1,2,2,4]");
  check("competition ranks: all equal → all rank 1", JSON.stringify(competitionRanks([7, 7, 7], (a, b) => a === b)) === "[1,1,1]");
  check("tied students share percentile: #2 of 4 twice → 50.0 / Top 50.0%", rankPercentiles(2, 4).percentile === 50 && rankPercentiles(2, 4).topPercent === 50);

  // ===================================================================
  console.log("\n--- Pure: eligibility ---");
  const comp = att({ minute: 10, score: 5 });
  check("competitive = ONLINE + Standard + Exam Mode", isCompetitiveAttempt(comp));
  check("OMR attempt is not competitive", !isCompetitiveAttempt(att({ entryMode: "OFFLINE_OMR_ENTRY" })));
  check("Practice Mode attempt (even still running) exposes the key", exposesAnswerKey(att({ answerMode: "INSTANT", durationMode: "UNLIMITED", status: "IN_PROGRESS" })));
  check("ABANDONED exam-mode custom-time attempt does not expose the key", !exposesAnswerKey(att({ durationMode: "CUSTOM", status: "ABANDONED" })));
  check("only competitive submitted attempt → RANKED", studentStanding([comp]).kind === "RANKED");
  const practiceFirst = [att({ minute: 1, answerMode: "INSTANT", durationMode: "UNLIMITED" }), att({ minute: 5, score: 9 })];
  check("Practice Mode first → permanently unranked (PRIOR_PRACTICE)", studentStanding(practiceFirst).kind === "PRIOR_PRACTICE");
  check("…its later Standard attempt reports PRACTICE_USED_BEFORE", attemptRankingStatus(practiceFirst[1].id, practiceFirst) === "PRACTICE_USED_BEFORE");
  check("…the practice attempt itself reports PRACTICE_MODE", attemptRankingStatus(practiceFirst[0].id, practiceFirst) === "PRACTICE_MODE");
  const perQFirst = [att({ minute: 1, durationMode: "PER_QUESTION" }), att({ minute: 5 })];
  check("submitted 1-min/question attempt first → unranked (answers were reviewed)", studentStanding(perQFirst).kind === "PRIOR_PRACTICE");
  const omrFirst = [att({ minute: 1, entryMode: "OFFLINE_OMR_ENTRY" }), att({ minute: 5 })];
  check("submitted OMR entry first → unranked", studentStanding(omrFirst).kind === "PRIOR_PRACTICE");
  check("…the OMR attempt reports OMR_ENTRY", attemptRankingStatus(omrFirst[0].id, omrFirst) === "OMR_ENTRY");
  const competitiveFirst = [att({ minute: 1, score: 2 }), att({ minute: 5, answerMode: "INSTANT", durationMode: "UNLIMITED" }), att({ minute: 9, score: 10 })];
  const cfStanding = studentStanding(competitiveFirst);
  check("competitive first, practice later → ranked on the FIRST attempt", cfStanding.kind === "RANKED" && cfStanding.officialAttemptId === competitiveFirst[0].id);
  check("…a higher-scoring retake does not replace it (RETAKE)", attemptRankingStatus(competitiveFirst[2].id, competitiveFirst) === "RETAKE");
  check("…the first attempt is OFFICIAL", attemptRankingStatus(competitiveFirst[0].id, competitiveFirst) === "OFFICIAL");
  const abandonedFirst = [att({ minute: 1, status: "ABANDONED" }), att({ minute: 5 })];
  check("ABANDONED (content-reset) attempt first is ignored", studentStanding(abandonedFirst).kind === "RANKED" && studentStanding(abandonedFirst).kind === "RANKED");
  const runningFirst = [att({ minute: 1, status: "IN_PROGRESS" })];
  check("only an in-progress attempt → no rank yet", studentStanding(runningFirst).kind === "NO_COMPETITIVE_ATTEMPT");

  // ===================================================================
  console.log("\n--- DB fixtures ---");
  const before = await integrityChecksum();
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.findFirstOrThrow({
    where: { isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED, previousYearPaperId: null } } },
    orderBy: { questions: { _count: "desc" } },
  });
  const bank = await prisma.question.findMany({
    where: { examId: exam.id, status: QuestionStatus.PUBLISHED, questionType: "SINGLE_CORRECT", options: { some: { isCorrect: true } } },
    take: 4,
    orderBy: { code: "asc" },
    include: { options: true },
  });
  const correctOf = (qid: string) => bank.find((q) => q.id === qid)!.options.find((o) => o.isCorrect)!.label;
  const wrongOf = (qid: string) => bank.find((q) => q.id === qid)!.options.find((o) => !o.isCorrect)!.label;

  const createdStudents: string[] = [];
  const mkStudent = async (name: string, extra: Partial<Prisma.StudentCreateInput> = {}) => {
    const s = await prisma.student.create({
      data: {
        studentId: `LBV-${suffix}-${createdStudents.length}`,
        name,
        email: `lbv-${suffix}-${createdStudents.length}@example.test`,
        mobile: `+9190${String(Date.now()).slice(-6)}${String(createdStudents.length).padStart(2, "0")}`,
        authProvider: StudentAuthProvider.CREDENTIALS,
        ...extra,
      },
    });
    createdStudents.push(s.id);
    return s;
  };
  const mkMock = async (tag: string) =>
    prisma.mockTest.create({
      data: {
        examId: exam.id,
        title: `LBV ${tag} ${suffix}`,
        durationMinutes: 30,
        status: "PUBLISHED",
        accessType: "FREE",
        questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) },
      },
    });
  type Raw = Partial<Prisma.TestAttemptUncheckedCreateInput> & { studentId: string };
  const insertAttempt = (test: RankingTestRef, a: Raw) =>
    prisma.testAttempt.create({
      data: {
        sourceType: test.kind,
        testType: test.kind === "MOCK_TEST" ? "FULL_MOCK" : "PREVIOUS_YEAR_PAPER",
        examId: exam.id,
        mockTestId: test.kind === "MOCK_TEST" ? test.id : null,
        previousYearPaperId: test.kind === "PREVIOUS_YEAR_PAPER" ? test.id : null,
        durationMinutes: 30,
        totalQuestions: 10,
        maxScore: 10,
        status: "SUBMITTED",
        ...a,
      },
    });

  // ---- crafted ordering on one mock, through SQL --------------------------
  console.log("\n--- SQL: crafted ordering ---");
  const mockA = await mkMock("A");
  const A: RankingTestRef = { kind: "MOCK_TEST", id: mockA.id };
  const base = new Date("2026-03-01T10:00:00Z").getTime();
  const crafted: { name: string; score: number; c: number; i: number; t: number; sub: number }[] = [
    { name: "Ishaan Low", score: 1, c: 1, i: 0, t: 100, sub: 1 },
    { name: "Hema Top", score: 9, c: 9, i: 1, t: 900, sub: 2 },
    { name: "Gopal Acc", score: 6, c: 6, i: 0, t: 900, sub: 3 }, // score 6, 100%
    { name: "Farah Acclow", score: 6, c: 6, i: 4, t: 100, sub: 4 }, // score 6, 60% (faster, still below)
    { name: "Esha More", score: 5, c: 10, i: 10, t: 900, sub: 5 }, // score 5, 50%, 10 correct
    { name: "Dev Less", score: 5, c: 5, i: 5, t: 100, sub: 6 }, // score 5, 50%, 5 correct (faster, still below)
    { name: "Chirag Fast", score: 4, c: 4, i: 0, t: 500, sub: 9 },
    { name: "Bina Slow", score: 4, c: 4, i: 0, t: 600, sub: 7 },
    { name: "Aman Earlier", score: 3, c: 3, i: 0, t: 500, sub: 8 },
    { name: "Zoya Later", score: 3, c: 3, i: 0, t: 500, sub: 10 },
  ];
  // Chirag/Bina differ only in time (and submission) → shared #6; Aman/Zoya only in submission → shared #8.
  const expectedRanks: Record<string, number> = { "Hema T.": 1, "Gopal A.": 2, "Farah A.": 3, "Esha M.": 4, "Dev L.": 5, "Chirag F.": 6, "Bina S.": 6, "Aman E.": 8, "Zoya L.": 8, "Ishaan L.": 10 };
  const craftedStudents: string[] = [];
  for (const [k, c] of crafted.entries()) {
    const s = await mkStudent(c.name);
    craftedStudents.push(s.id);
    await insertAttempt(A, {
      studentId: s.id,
      score: c.score,
      correctCount: c.c,
      incorrectCount: c.i,
      unansweredCount: 0,
      timeTakenSeconds: c.t,
      startedAt: new Date(base + k * 1000),
      submittedAt: new Date(base + 3_600_000 + c.sub * 1000),
    });
  }
  const boardA = await getLeaderboard(A, craftedStudents[0]);
  check(
    "SQL ranks = score → accuracy → correct only; time/submission ties share a rank (6, 6, 8, 8)",
    boardA.rows.every((r) => expectedRanks[r.displayName] === r.rank) && JSON.stringify(boardA.rows.map((r) => r.rank)) === "[1,2,3,4,5,6,6,8,8,10]",
    boardA.rows.map((r) => [r.displayName, r.rank])
  );
  check("list positions stay unique 1..10 for paging", JSON.stringify(boardA.rows.map((r) => r.position)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  check("shared rank → shared percentile (#6 twice = 40.0)", boardA.rows[5].percentile === 40 && boardA.rows[6].percentile === 40);
  check("10 participants", boardA.totalParticipants === 10);
  check("viewer (Ishaan, last) is rank 10 with YOU flag, nobody else flagged", boardA.self?.rank === 10 && boardA.rows.filter((r) => r.isSelf).length === 1 && boardA.rows[9].isSelf);
  check("rank 1 percentile 90.0 / Top 10.0%", boardA.rows[0].percentile === 90 && boardA.rows[0].topPercent === 10, boardA.rows[0]);
  check("accuracy 0..1 from stored counts", boardA.rows[1].accuracy === 1 && boardA.rows[2].accuracy === 0.6);

  // ---- engine flows: OMR, practice-first, competitive-first, retakes -------
  console.log("\n--- Engine flows (real start/save/submit) ---");
  const mockB = await mkMock("B");
  const B: RankingTestRef = { kind: "MOCK_TEST", id: mockB.id };
  const answerAll = async (attemptId: string, studentId: string, correct: number) => {
    const qs = await prisma.testAttemptQuestion.findMany({ where: { attemptId }, orderBy: { order: "asc" } });
    for (const [k, q] of qs.entries()) await saveAnswer(attemptId, studentId, q.questionId, k < correct ? correctOf(q.questionId) : wrongOf(q.questionId), false);
  };
  const omrStudent = await mkStudent("Omar Omr");
  const omr = await startOfflineOmrEntryAttempt(omrStudent.id, mockB.id);
  await answerAll(omr.id, omrStudent.id, 4);
  await submitAttempt(omr.id, omrStudent.id);
  const practiceStudent = await mkStudent("Pooja Practice");
  const prac = await startMockTestAttempt(practiceStudent.id, mockB.id, "ONLINE", { durationMode: "UNLIMITED", answerMode: "INSTANT" });
  check("fixture: practice attempt frozen as INSTANT", prac.answerMode === "INSTANT");
  await submitAttempt(prac.id, practiceStudent.id);
  const practiceStd = await startMockTestAttempt(practiceStudent.id, mockB.id);
  await answerAll(practiceStd.id, practiceStudent.id, 4);
  await submitAttempt(practiceStd.id, practiceStudent.id);
  const firstStudent = await mkStudent("Kiran First");
  const k1 = await startMockTestAttempt(firstStudent.id, mockB.id);
  await answerAll(k1.id, firstStudent.id, 2);
  await submitAttempt(k1.id, firstStudent.id);
  const k2 = await startMockTestAttempt(firstStudent.id, mockB.id);
  await answerAll(k2.id, firstStudent.id, 4);
  await submitAttempt(k2.id, firstStudent.id);
  const boardB = await getLeaderboard(B, firstStudent.id);
  check("only Kiran is ranked (OMR and practice-first excluded)", boardB.totalParticipants === 1, boardB.totalParticipants);
  check("Kiran's ranked attempt is the first (2/4), not the 4/4 retake", boardB.self?.score === 2 && boardB.selfOfficialAttemptId === k1.id, boardB.self);
  const rkOmr = await getAttemptRanking({ ...omr, studentId: omrStudent.id });
  check("OMR attempt: status OMR_ENTRY, no rank", rkOmr?.status === "OMR_ENTRY" && rkOmr.board?.self === null);
  const rkPrac = await getAttemptRanking({ ...practiceStd, studentId: practiceStudent.id });
  check("practice-first student's Standard attempt: PRACTICE_USED_BEFORE, no rank", rkPrac?.status === "PRACTICE_USED_BEFORE" && rkPrac.board?.self === null);
  const rkRetake = await getAttemptRanking({ ...k2, studentId: firstStudent.id });
  check("retake: status RETAKE, still shows official rank #1", rkRetake?.status === "RETAKE" && rkRetake.board?.self?.rank === 1);
  const rkOfficial = await getAttemptRanking({ ...k1, studentId: firstStudent.id });
  check("first attempt: status OFFICIAL", rkOfficial?.status === "OFFICIAL");
  const legacyFlags = await prisma.testAttempt.findMany({ where: { id: { in: [omr.id, practiceStd.id] } }, select: { isLeaderboardAttempt: true } });
  check("(engine untouched: legacy isLeaderboardAttempt flag still set by submitAttempt, but ignored for ranking)", legacyFlags.some((x) => x.isLeaderboardAttempt));

  // ---- PYQ ---------------------------------------------------------------
  console.log("\n--- Previous Year Paper leaderboard ---");
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2001, title: `LBV Paper ${suffix}`, durationMinutes: 20 } });
  const pyqQs = await Promise.all(
    bank.slice(0, 3).map((q, k) =>
      prisma.question.create({
        data: {
          examId: exam.id,
          subjectId: q.subjectId,
          code: `LBV-${suffix}-${k}`,
          text: `LBV PYQ ${k}`,
          status: "PUBLISHED",
          previousYearPaperId: paper.id,
          options: { create: ["A", "B", "C", "D"].map((label, i) => ({ label, text: label, isCorrect: i === 0, order: i })) },
        },
      })
    )
  );
  const P: RankingTestRef = { kind: "PREVIOUS_YEAR_PAPER", id: paper.id };
  const pyqA = await mkStudent("Neha Paper");
  const pyqB = await mkStudent("Varun Paper");
  const pa = await startPreviousYearPaperAttempt(pyqA.id, paper.id);
  for (const q of pyqQs) await saveAnswer(pa.id, pyqA.id, q.id, "A", false);
  await submitAttempt(pa.id, pyqA.id);
  const pb = await startPreviousYearPaperAttempt(pyqB.id, paper.id, { durationMode: "PER_QUESTION", answerMode: "EXAM" });
  await submitAttempt(pb.id, pyqB.id);
  const pb2 = await startPreviousYearPaperAttempt(pyqB.id, paper.id);
  for (const q of pyqQs) await saveAnswer(pb2.id, pyqB.id, q.id, "A", false);
  await submitAttempt(pb2.id, pyqB.id);
  const boardP = await getLeaderboard(P, pyqA.id);
  check("PYQ board ranks Neha (Standard first); Varun excluded (1-min/question first)", boardP.totalParticipants === 1 && boardP.self?.rank === 1 && boardP.self.score === 3, boardP);
  const rkP = await getAttemptRanking({ ...pa, studentId: pyqA.id });
  check("PYQ attempt resolves to the paper's board", rkP?.test.kind === "PREVIOUS_YEAR_PAPER" && rkP.status === "OFFICIAL");
  check("PYQ board is independent of Mock boards", (await getLeaderboard(A, pyqA.id)).self === null && boardP.totalParticipants === 1);
  check("PYQ config default: leaderboard on, never counts toward Overall", JSON.stringify(await getRankingConfig(P)) === JSON.stringify({ leaderboardEnabled: true, countsTowardOverall: false }));
  let pyqCheck = "accepted";
  try {
    await prisma.testRankingConfig.create({ data: { kind: "PREVIOUS_YEAR_PAPER", previousYearPaperId: paper.id, countsTowardOverall: true } });
  } catch (e) {
    pyqCheck = (e as Error).message.includes("TestRankingConfig_target_check") ? "refused" : (e as Error).message.slice(0, 120);
  }
  check("DB CHECK refuses a PYQ counting toward Overall Rank", pyqCheck === "refused", pyqCheck);
  let mismatch = "accepted";
  try {
    await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", previousYearPaperId: paper.id } });
  } catch (e) {
    mismatch = (e as Error).message.includes("TestRankingConfig_target_check") ? "refused" : (e as Error).message.slice(0, 120);
  }
  check("DB CHECK refuses a kind/target mismatch", mismatch === "refused", mismatch);

  // ---- non-ranked test types --------------------------------------------
  const { rankingTestForAttempt } = await import("@/lib/leaderboard");
  for (const sourceType of ["SUBJECT_TEST", "CUSTOM_MODULE", "GRAND_TEST", "LIVE_TEST"]) {
    check(`${sourceType} has no leaderboard`, rankingTestForAttempt({ sourceType, mockTestId: null, previousYearPaperId: null }) === null);
  }

  // ---- config: disabled / legacy column / countsTowardOverall default ---
  console.log("\n--- Config ---");
  check("Mock default: leaderboard on, Counts Toward Overall OFF", JSON.stringify(await getRankingConfig(A)) === JSON.stringify({ leaderboardEnabled: true, countsTowardOverall: false }));
  await prisma.mockTest.update({ where: { id: mockA.id }, data: { leaderboardEnabled: false } });
  check("no config row → legacy MockTest.leaderboardEnabled=false respected", (await getRankingConfig(A)).leaderboardEnabled === false);
  await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: mockA.id, leaderboardEnabled: true, countsTowardOverall: true } });
  check("config row wins over the legacy column", JSON.stringify(await getRankingConfig(A)) === JSON.stringify({ leaderboardEnabled: true, countsTowardOverall: true }));
  await prisma.testRankingConfig.update({ where: { mockTestId: mockA.id }, data: { leaderboardEnabled: false } });
  const anyAttemptA = await prisma.testAttempt.findFirstOrThrow({ where: { mockTestId: mockA.id } });
  const disabled = await getAttemptRanking(anyAttemptA);
  check("leaderboard disabled → no board, no rank", disabled !== null && disabled.board === null && !disabled.config.leaderboardEnabled);
  await prisma.testRankingConfig.update({ where: { mockTestId: mockA.id }, data: { leaderboardEnabled: true } });

  // ---- privacy ------------------------------------------------------------
  console.log("\n--- Privacy ---");
  const deleted = await mkStudent("Deleted Student", { status: "DELETED", email: null, mobile: null });
  const leaving = await mkStudent("Secret Surname", { status: "DELETION_REQUESTED" });
  await insertAttempt(A, { studentId: deleted.id, score: 8, correctCount: 8, incorrectCount: 0, timeTakenSeconds: 50, startedAt: new Date(base), submittedAt: new Date(base + 99) });
  await insertAttempt(A, { studentId: leaving.id, score: 7, correctCount: 7, incorrectCount: 0, timeTakenSeconds: 50, startedAt: new Date(base), submittedAt: new Date(base + 99) });
  const pv = await getLeaderboard(A, craftedStudents[1]);
  const payload = JSON.stringify({ rows: pv.rows, self: pv.self, nearby: pv.nearby, totalParticipants: pv.totalParticipants });
  check("deleted student shows as Former Student", pv.rows.some((r) => r.displayName === "Former Student"));
  check("deletion-requested student's real name never appears", !payload.includes("Secret") && !payload.includes("Surname"));
  const allStudents = await prisma.student.findMany({ where: { id: { in: createdStudents } }, select: { id: true, studentId: true, email: true, mobile: true, name: true } });
  const leaks = allStudents.flatMap((s) => [s.id, s.studentId, s.email, s.mobile].filter((v): v is string => !!v && payload.includes(v)));
  check("no internal id / MTS id / email / phone in the leaderboard payload", leaks.length === 0, leaks);
  const surnames = crafted.map((c) => c.name.split(" ")[1]);
  check("no full surname in the payload (First Name + Last Initial only)", !surnames.some((s) => payload.includes(s)));
  check("row objects carry only display fields", Object.keys(pv.rows[0]).sort().join(",") === "accuracy,correctCount,displayName,isSelf,percentile,position,rank,score,timeTakenSeconds,topPercent");
  check("YOU on exactly the viewer (Hema, still rank 1)", pv.rows.filter((r) => r.isSelf).length === 1 && pv.self?.displayName === "Hema T." && pv.self.rank === 1, pv.self);
  check("Former Student keeps its rank (#2) without its name", pv.rows[1]?.displayName === "Former Student" && pv.rows[2]?.displayName === "Former Student");

  // ---- Your Position window + paging -----------------------------------
  console.log("\n--- Your Position / paging ---");
  const mockC = await mkMock("C");
  const C: RankingTestRef = { kind: "MOCK_TEST", id: mockC.id };
  const bulk = Array.from({ length: 130 }, (_, k) => ({
    id: `lbvs${suffix}${letters(k)}`,
    studentId: `LBV-${suffix}-bulk-${k}`,
    name: `P${letters(k)} X`,
    authProvider: StudentAuthProvider.CREDENTIALS,
  }));
  await prisma.student.createMany({ data: bulk });
  createdStudents.push(...bulk.map((b) => b.id));
  await prisma.testAttempt.createMany({
    data: bulk.map((b, k) => ({
      studentId: b.id,
      sourceType: "MOCK_TEST" as const,
      testType: "FULL_MOCK" as const,
      examId: exam.id,
      mockTestId: mockC.id,
      durationMinutes: 30,
      totalQuestions: 200,
      maxScore: 200,
      status: "SUBMITTED" as const,
      score: 200 - k,
      correctCount: 200 - k,
      incorrectCount: 0,
      timeTakenSeconds: 1000,
      startedAt: new Date(base),
      submittedAt: new Date(base + 1000),
    })),
  });
  const viewer128 = bulk[127].id;
  const pc = await getLeaderboard(C, viewer128, { pageSize: 50 });
  check("viewer rank 128 of 130", pc.self?.rank === 128 && pc.totalParticipants === 130);
  check("page 1 shows ranks 1–50", pc.rows.length === 50 && pc.rows[0].rank === 1 && pc.rows[49].rank === 50);
  check("Your Position = #126–#130 with YOU at #128", JSON.stringify(pc.nearby.map((r) => r.rank)) === "[126,127,128,129,130]" && pc.nearby[2].isSelf);
  const pc3 = await getLeaderboard(C, viewer128, { page: 3, pageSize: 50 });
  check("on the viewer's own page there is no separate Your Position block", pc3.nearby.length === 0 && pc3.rows.some((r) => r.isSelf));
  const pcBig = await getLeaderboard(C, viewer128, { page: 999, pageSize: 50 });
  check("page beyond the end is clamped to the last page", pcBig.page === 3 && pcBig.rows[0].rank === 101);
  const pcTop = await getLeaderboard(C, bulk[0].id, { pageSize: 50 });
  check("rank #1 viewer: percentile 99.2, Top 0.8%", pcTop.self?.percentile === 99.2 && pcTop.self?.topPercent === 0.8, pcTop.self);

  // ---- randomized SQL vs pure-reference parity ---------------------------
  console.log("\n--- Randomized SQL ⇄ reference parity ---");
  let rng = 12345;
  const rand = (n: number) => {
    // mulberry32: deterministic, well-mixed low bits.
    rng = (rng + 0x6d2b79f5) | 0;
    let x = Math.imul(rng ^ (rng >>> 15), 1 | rng);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) % n;
  };
  for (let round = 0; round < 4; round++) {
    const mock = await mkMock(`R${round}`);
    const R: RankingTestRef = { kind: "MOCK_TEST", id: mock.id };
    const students = Array.from({ length: 60 }, (_, k) => ({
      id: `lbvr${round}${suffix}${letters(k)}`,
      studentId: `LBV-${suffix}-r${round}-${k}`,
      name: `R${letters(k)} Y`,
      authProvider: StudentAuthProvider.CREDENTIALS,
    }));
    await prisma.student.createMany({ data: students });
    createdStudents.push(...students.map((s) => s.id));
    const byStudent = new Map<string, RankableAttempt[]>();
    const rows: Prisma.TestAttemptCreateManyInput[] = [];
    for (const s of students) {
      const n = 1 + rand(3);
      const list: RankableAttempt[] = [];
      for (let j = 0; j < n; j++) {
        const c = rand(6);
        const i = rand(4);
        const a = att({
          id: `lbva${round}${suffix}${s.id.slice(-4)}${j}`,
          status: (["SUBMITTED", "SUBMITTED", "SUBMITTED", "IN_PROGRESS", "ABANDONED"] as const)[rand(5)],
          entryMode: rand(8) === 0 ? "OFFLINE_OMR_ENTRY" : "ONLINE",
          durationMode: (["FIXED", "FIXED", "FIXED", "PER_QUESTION", "CUSTOM", "UNLIMITED"] as const)[rand(6)],
          answerMode: rand(5) === 0 ? "INSTANT" : "EXAM",
          startedAt: new Date(base + rand(5) * 60_000),
          submittedAt: new Date(base + 3_600_000 + rand(3) * 1000),
          score: c - i * 0.25,
          correctCount: c,
          incorrectCount: i,
          timeTakenSeconds: 600 + rand(3) * 100,
        });
        list.push(a);
        rows.push({
          id: a.id,
          studentId: s.id,
          sourceType: "MOCK_TEST",
          testType: "FULL_MOCK",
          examId: exam.id,
          mockTestId: mock.id,
          durationMinutes: 30,
          totalQuestions: 10,
          maxScore: 10,
          negativeMarking: 0.25,
          status: a.status,
          entryMode: a.entryMode,
          durationMode: a.durationMode,
          answerMode: a.answerMode,
          startedAt: a.startedAt,
          submittedAt: a.status === "SUBMITTED" ? a.submittedAt : null,
          score: a.status === "SUBMITTED" ? a.score : null,
          correctCount: a.status === "SUBMITTED" ? a.correctCount : null,
          incorrectCount: a.status === "SUBMITTED" ? a.incorrectCount : null,
          timeTakenSeconds: a.status === "SUBMITTED" ? a.timeTakenSeconds : null,
        });
        if (a.status !== "SUBMITTED") Object.assign(a, { submittedAt: null, score: null, correctCount: null, incorrectCount: null, timeTakenSeconds: null });
      }
      byStudent.set(s.id, list);
    }
    await prisma.testAttempt.createMany({ data: rows });
    const expected = referenceRanking(byStudent);
    const nameOf = new Map(students.map((s) => [s.id, leaderboardDisplayName(s.name, "ACTIVE")]));
    const got = await getLeaderboard(R, students[0].id, { pageSize: 100 });
    const ok =
      got.totalParticipants === expected.length &&
      JSON.stringify(got.rows.map((r) => [r.displayName, r.rank])) === JSON.stringify(expected.map((e) => [nameOf.get(e.studentId), e.rank]));
    // Every student's own view agrees on rank and official attempt.
    let selfOk = true;
    for (const s of students.slice(0, 15)) {
      const v = await getLeaderboard(R, s.id, { pageSize: 5 });
      const idx = expected.findIndex((e) => e.studentId === s.id);
      if (idx < 0 ? v.self !== null : v.self?.rank !== expected[idx].rank || v.selfOfficialAttemptId !== expected[idx].attemptId) selfOk = false;
    }
    const ties = expected.filter((e, i) => i > 0 && expected[i - 1].rank === e.rank).length;
    check(`round ${round}: SQL ranking = pure reference (${expected.length} ranked of 60, ${ties} shared ranks)`, ok && selfOk && expected.length > 5 && ties > 0);
  }

  // ---- real (copied production) attempts ------------------------------------
  console.log("\n--- Real attempts (production copy) ---");
  const realMocks = await prisma.testAttempt.groupBy({ by: ["mockTestId"], where: { sourceType: "MOCK_TEST", mockTestId: { not: null }, mockTest: { title: { not: { startsWith: "LBV " } } } } });
  const realPapers = await prisma.testAttempt.groupBy({ by: ["previousYearPaperId"], where: { sourceType: "PREVIOUS_YEAR_PAPER", previousYearPaperId: { not: null, notIn: [paper.id] } } });
  let realOk = true;
  let realRanked = 0;
  let omrRanked = 0;
  for (const test of [
    ...realMocks.map((m) => ({ kind: "MOCK_TEST" as const, id: m.mockTestId! })),
    ...realPapers.map((p) => ({ kind: "PREVIOUS_YEAR_PAPER" as const, id: p.previousYearPaperId! })),
  ]) {
    const all = await prisma.testAttempt.findMany({
      where: test.kind === "MOCK_TEST" ? { mockTestId: test.id, sourceType: "MOCK_TEST" } : { previousYearPaperId: test.id, sourceType: "PREVIOUS_YEAR_PAPER" },
      select: { studentId: true },
      distinct: ["studentId"],
    });
    const byStudent = new Map<string, RankableAttempt[]>();
    for (const s of all) byStudent.set(s.studentId, await getStudentRankableAttempts(test, s.studentId));
    const expected = referenceRanking(byStudent);
    for (const e of expected) {
      const v = await getLeaderboard(test, e.studentId, { pageSize: 1 });
      if (v.self?.rank !== e.rank || v.selfOfficialAttemptId !== e.attemptId || v.totalParticipants !== expected.length) realOk = false;
      const official = byStudent.get(e.studentId)!.find((a) => a.id === e.attemptId)!;
      if (official.entryMode !== "ONLINE") omrRanked++;
    }
    for (const s of all) {
      if (!expected.some((e) => e.studentId === s.studentId) && (await getLeaderboard(test, s.studentId, { pageSize: 1 })).self !== null) realOk = false;
    }
    realRanked += expected.length;
  }
  check(`real data: SQL = reference on ${realMocks.length} mocks + ${realPapers.length} papers (${realRanked} ranked)`, realOk);
  check("real data: no OMR attempt ranked", omrRanked === 0);


  // ---- Overall Rank ---------------------------------------------------------
  console.log("\n--- Overall Rank ---");
  // Earlier sections left mockA counting; this section owns the exam's counted set.
  await prisma.testRankingConfig.update({ where: { mockTestId: mockA.id }, data: { countsTowardOverall: false } });
  const ovMocks = [await mkMock("O1"), await mkMock("O2"), await mkMock("O3"), await mkMock("O4")];
  const o5 = await mkMock("O5-lb-off");
  const o6 = await mkMock("O6-held");
  await prisma.mockTest.update({ where: { id: o6.id }, data: { resultReleaseMode: "CUSTOM_DATE", resultReleaseAt: new Date(Date.now() + 30 * 864e5) } });
  for (const m of ovMocks) await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: m.id, countsTowardOverall: true } });
  await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: o5.id, countsTowardOverall: true, leaderboardEnabled: false } });
  await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: o6.id, countsTowardOverall: true } });
  const paper2 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2003, title: `LBV Paper2 ${suffix}`, durationMinutes: 20 } });
  const ov: Record<string, string> = {};
  for (const n of ["Asha Ov", "Bala Ov", "Chitra Ov", "Dinesh Ov", "Eshan Ov", "Farid Ov", "Gita Ov", "Hari Ov", "Pyqstar Ov"]) ov[n.split(" ")[0]] = (await mkStudent(n)).id;
  const O = (k: number): RankingTestRef => ({ kind: "MOCK_TEST", id: [...ovMocks, o5, o6][k].id });
  const put = (k: number, who: string, score: number, extra: Partial<Prisma.TestAttemptUncheckedCreateInput> = {}) =>
    insertAttempt(O(k), { studentId: ov[who], score, correctCount: score, incorrectCount: 0, timeTakenSeconds: 1000, startedAt: new Date(base), submittedAt: new Date(base + 99), ...extra });
  // Asha and Bala: identical score/accuracy/correct everywhere; Bala always 8x slower and later.
  const slowB = { timeTakenSeconds: 8000, submittedAt: new Date(base + 9e6) };
  await put(0, "Asha", 90); await put(0, "Bala", 90, slowB); await put(0, "Chitra", 80); await put(0, "Dinesh", 70); await put(0, "Eshan", 60); await put(0, "Pyqstar", 50); await put(0, "Gita", 5);
  await put(0, "Farid", 0, { answerMode: "INSTANT", durationMode: "UNLIMITED", startedAt: new Date(base - 864e5), submittedAt: new Date(base - 864e5 + 99) });
  await put(0, "Farid", 95); // after practice → unranked on O1
  await put(1, "Asha", 50); await put(1, "Bala", 50, slowB); await put(1, "Chitra", 40); await put(1, "Eshan", 99); await put(1, "Pyqstar", 30); await put(1, "Farid", 60);
  await put(2, "Asha", 70); await put(2, "Bala", 70, slowB); await put(2, "Eshan", 100, { entryMode: "OFFLINE_OMR_ENTRY" }); await put(2, "Farid", 80); await put(2, "Gita", 10);
  await put(3, "Asha", 20); await put(3, "Bala", 20, slowB); await put(3, "Farid", 90); await put(3, "Gita", 30); await put(3, "Hari", 40);
  await put(4, "Dinesh", 100); await put(4, "Asha", 100); // O5: leaderboard off → never counted
  await put(5, "Dinesh", 100); // O6: result held → not counted yet
  await insertAttempt({ kind: "PREVIOUS_YEAR_PAPER", id: paper2.id }, { studentId: ov.Pyqstar, score: 100, correctCount: 100, incorrectCount: 0, startedAt: new Date(base), submittedAt: new Date(base + 99) });
  await insertAttempt({ kind: "PREVIOUS_YEAR_PAPER", id: paper2.id }, { studentId: ov.Chitra, score: 10, correctCount: 10, incorrectCount: 0, startedAt: new Date(base), submittedAt: new Date(base + 99) });

  // Pure reference over the 4 counted mocks.
  const ovSums = new Map<string, { tests: number; tenths: number }>();
  for (const m of ovMocks) {
    const test: RankingTestRef = { kind: "MOCK_TEST", id: m.id };
    const who = await prisma.testAttempt.findMany({ where: { mockTestId: m.id }, select: { studentId: true }, distinct: ["studentId"] });
    const byStudent = new Map<string, RankableAttempt[]>();
    for (const w of who) byStudent.set(w.studentId, await getStudentRankableAttempts(test, w.studentId));
    const ref = referenceRanking(byStudent);
    for (const e of ref) {
      const cur = ovSums.get(e.studentId) ?? { tests: 0, tenths: 0 };
      cur.tests += 1;
      cur.tenths += Math.round(rankPercentiles(e.rank, ref.length).percentile * 10);
      ovSums.set(e.studentId, cur);
    }
  }
  const refEligible = [...ovSums.entries()].filter(([, v]) => v.tests >= OVERALL_MIN_RANKED_TESTS);
  const cmp = (a: [string, { tests: number; tenths: number }], b: [string, { tests: number; tenths: number }]) => b[1].tenths * a[1].tests - a[1].tenths * b[1].tests;
  refEligible.sort((a, b) => cmp(a, b) || (a[0] < b[0] ? -1 : 1));
  const refRanks = competitionRanks(refEligible, (a, b) => cmp(a, b) === 0);
  const ovBoard = await getOverallLeaderboard(exam.id, ov.Asha, { pageSize: 100, fresh: true });
  const nameById = new Map(Object.entries(ov).map(([k, id]) => [id, `${k} O.`]));
  check(
    "Overall Rank = pure reference (avg per-test percentile, ≥3 tests, competition ranks)",
    JSON.stringify(ovBoard.rows.map((r) => [r.displayName, r.rank, r.rankedTests, r.averagePercentile])) ===
      JSON.stringify(refEligible.map(([id, v], i) => [nameById.get(id), refRanks[i], v.tests, Math.round(v.tenths / v.tests) / 10])),
    { got: ovBoard.rows.map((r) => [r.displayName, r.rank, r.rankedTests, r.averagePercentile]), want: refEligible.map(([id, v], i) => [nameById.get(id), refRanks[i], v.tests]) }
  );
  check("4 counted mocks (leaderboard-off and result-held mocks excluded)", ovBoard.countedTests === 4, ovBoard.countedTests);
  const asha = ovBoard.rows.find((r) => r.displayName === "Asha O.");
  const bala = ovBoard.rows.find((r) => r.displayName === "Bala O.");
  check("time does not affect Overall Rank: Asha and Bala (8x slower) share the same rank and average", !!asha && !!bala && asha.rank === bala.rank && asha.averagePercentile === bala.averagePercentile, [asha, bala]);
  check("YOU only on the viewer", ovBoard.rows.filter((r) => r.isSelf).length === 1 && asha?.isSelf === true);
  check("eligible = Asha, Bala, Farid, Gita (3+ ranked counted tests)", JSON.stringify(ovBoard.rows.map((r) => r.displayName).sort()) === JSON.stringify(["Asha O.", "Bala O.", "Farid O.", "Gita O."]));
  const chitra = await getOverallStanding(exam.id, ov.Chitra);
  check("Chitra: 2 ranked counted tests → no Overall Rank yet (2 of 3), PYQ not counted", chitra.self === null && chitra.selfRankedTests === 2, chitra);
  const eshan = await getOverallStanding(exam.id, ov.Eshan);
  check("Eshan: OMR attempt on O3 not counted → 2 tests → not ranked", eshan.self === null && eshan.selfRankedTests === 2, eshan);
  const farid = ovBoard.rows.find((r) => r.displayName === "Farid O.");
  check("Farid: practice-first O1 excluded → ranked on O2–O4 only (3 tests)", farid?.rankedTests === 3);
  const pyqstar = await getOverallStanding(exam.id, ov.Pyqstar);
  check("PYQ #1 never contributes: Pyqstar has 2 counted tests, no Overall Rank", pyqstar.self === null && pyqstar.selfRankedTests === 2, pyqstar);
  const dinesh = await getOverallStanding(exam.id, ov.Dinesh);
  check("Dinesh: leaderboard-off O5 and held O6 not counted → 1 test", dinesh.selfRankedTests === 1 && dinesh.self === null, dinesh);
  check("Overall Top % = 100 × rank / ranked students", asha !== undefined && asha.topPercent === rankPercentiles(asha.rank, ovBoard.totalRanked).topPercent);
  const ovPayload = JSON.stringify(ovBoard);
  check("overall payload: no student id / email / phone / surname", !Object.values(ov).some((id) => ovPayload.includes(id)) && !ovPayload.includes("@") && !ovPayload.includes(" Ov"));
  check("overall row objects carry only display fields", Object.keys(ovBoard.rows[0]).sort().join(",") === "averagePercentile,displayName,isSelf,position,rank,rankedTests,topPercent");

  // History (Ranking & Progress)
  const hist = await getStudentRankedTests(exam.id, ov.Asha);
  check("Asha's history: O1–O4 only (leaderboard-off O5 hidden), all marked Overall", hist.length === 4 && hist.every((h) => h.countsTowardOverall && h.kind === "MOCK_TEST"), hist.map((h) => h.title));
  let histOk = true;
  for (const h of hist) {
    const m = ovMocks.find((x) => h.title === x.title)!;
    const v = await getLeaderboard({ kind: "MOCK_TEST", id: m.id }, ov.Asha);
    if (v.self?.rank !== h.rank || v.totalParticipants !== h.total || v.self.percentile !== h.percentile) histOk = false;
  }
  check("history rank / total / percentile = each test's leaderboard", histOk);
  const pyqHist = await getStudentRankedTests(exam.id, ov.Pyqstar);
  check("PYQ appears in history with its rank but never as Overall", pyqHist.some((h) => h.kind === "PREVIOUS_YEAR_PAPER" && h.rank === 1 && !h.countsTowardOverall));

  // Cache: memoized per process, cleared by the admin save.
  const cachedBefore = (await getOverallStanding(exam.id, ov.Hari)).totalRanked;
  await put(0, "Hari", 1); await put(1, "Hari", 1);
  check("Overall Rank is memoized (no recompute inside the cache window)", (await getOverallStanding(exam.id, ov.Hari)).totalRanked === cachedBefore);
  clearOverallRankingCache();
  const hariNow = await getOverallStanding(exam.id, ov.Hari);
  check("after clearOverallRankingCache, Hari (now 3 tests) is ranked", hariNow.totalRanked === cachedBefore + 1 && hariNow.self !== null && hariNow.selfRankedTests === 3);
  const window = await getOverallLeaderboard(exam.id, ov.Hari, { pageSize: 1, window: 1 });
  check("overall Your Position window around the viewer when off-page", window.nearby.some((r) => r.isSelf) && window.nearby.length >= 2 && window.rows.length === 1);
  await prisma.testRankingConfig.updateMany({ where: { mockTestId: { in: [...ovMocks, o5, o6].map((m) => m.id) } }, data: { countsTowardOverall: false } });
  clearOverallRankingCache();
  const none = await getOverallStanding(exam.id, ov.Asha);
  check("no counted tests → countedTests 0, nobody ranked", none.countedTests === 0 && none.totalRanked === 0 && none.self === null);

  // ---- scale ------------------------------------------------------------
  console.log("\n--- Scale: 10,000 participants ---");
  const mockS = await mkMock("S");
  const S: RankingTestRef = { kind: "MOCK_TEST", id: mockS.id };
  const big = Array.from({ length: 10_000 }, (_, k) => ({
    id: `lbvb${suffix}${letters(k, 5)}`,
    studentId: `LBV-${suffix}-big-${k}`,
    name: `B${letters(k, 5)} Z`,
    authProvider: StudentAuthProvider.CREDENTIALS,
  }));
  for (let k = 0; k < big.length; k += 2000) await prisma.student.createMany({ data: big.slice(k, k + 2000) });
  createdStudents.push(...big.map((b) => b.id));
  for (let k = 0; k < big.length; k += 2000) {
    await prisma.testAttempt.createMany({
      data: big.slice(k, k + 2000).flatMap((b, j) => {
        const n = k + j;
        const first = {
          studentId: b.id,
          sourceType: "MOCK_TEST" as const,
          testType: "FULL_MOCK" as const,
          examId: exam.id,
          mockTestId: mockS.id,
          durationMinutes: 180,
          totalQuestions: 200,
          maxScore: 200,
          status: "SUBMITTED" as const,
          score: (n * 7919) % 201,
          correctCount: (n * 7919) % 201,
          incorrectCount: n % 7,
          timeTakenSeconds: 5000 + (n % 3000),
          startedAt: new Date(base),
          submittedAt: new Date(base + 6_000_000 + n),
        };
        return n % 3 === 0 ? [first, { ...first, startedAt: new Date(base + 10_000_000), score: 200, correctCount: 200 }] : [first];
      }),
    });
  }
  await prisma.$executeRawUnsafe(`ANALYZE "TestAttempt"`);
  await getLeaderboard(S, big[5000].id);
  const t = performance.now();
  const sb = await getLeaderboard(S, big[5000].id);
  const ms = performance.now() - t;
  console.log(`  (10,000 participants, 13,334 attempts: ${ms.toFixed(0)} ms)`);
  check("10,000-participant board (page + Your Position) in < 500 ms", ms < 500 && sb.totalParticipants === 10_000, ms);
  const plan = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
    `EXPLAIN SELECT 1 FROM "TestAttempt" a WHERE a."mockTestId" = $1 AND a."sourceType" = 'MOCK_TEST'`,
    mockB.id
  );
  // Overall Rank at scale: 10,000 students × 3 counted mocks.
  const mockS2 = await mkMock("S2");
  const mockS3 = await mkMock("S3");
  for (const m of [mockS2, mockS3]) {
    for (let k = 0; k < big.length; k += 2500) {
      await prisma.testAttempt.createMany({
        data: big.slice(k, k + 2500).map((b, j) => ({
          studentId: b.id, sourceType: "MOCK_TEST" as const, testType: "FULL_MOCK" as const, examId: exam.id, mockTestId: m.id,
          durationMinutes: 180, totalQuestions: 200, maxScore: 200, status: "SUBMITTED" as const,
          score: ((k + j) * (m === mockS2 ? 31 : 17)) % 201, correctCount: ((k + j) * (m === mockS2 ? 31 : 17)) % 201, incorrectCount: (k + j) % 5,
          timeTakenSeconds: 5000, startedAt: new Date(base), submittedAt: new Date(base + 6_000_000),
        })),
      });
    }
  }
  for (const m of [mockS, mockS2, mockS3]) await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: m.id, countsTowardOverall: true } });
  const to = performance.now();
  const bigOverall = await getOverallLeaderboard(exam.id, big[1234].id, { fresh: true });
  const oms = performance.now() - to;
  console.log(`  (Overall Rank, 10,000 students × 3 tests: ${oms.toFixed(0)} ms uncached)`);
  check("Overall Rank for 10,000 students computed in < 3 s (then cached)", oms < 3000 && bigOverall.totalRanked === 10_000 && bigOverall.self !== null, oms);
  const tc = performance.now();
  await getOverallStanding(exam.id, big[99].id);
  check("cached Overall Rank read is instant (< 20 ms)", performance.now() - tc < 20);
  await prisma.testRankingConfig.deleteMany({ where: { mockTestId: { in: [mockS.id, mockS2.id, mockS3.id] } } });
  clearOverallRankingCache();

  check("a normal-size test reads only its own rows via a mockTestId index", plan.some((p) => /Index|Bitmap/.test(p["QUERY PLAN"])), plan);

  // ---- cleanup + read-only proof -------------------------------------------
  console.log("\n--- Cleanup / historical integrity ---");
  const mocks = await prisma.mockTest.findMany({ where: { title: { startsWith: "LBV " } }, select: { id: true } });
  await prisma.testAttempt.deleteMany({ where: { OR: [{ studentId: { in: createdStudents } }, { mockTestId: { in: mocks.map((m) => m.id) } }] } });
  await prisma.testRankingConfig.deleteMany({ where: { OR: [{ mockTestId: { in: mocks.map((m) => m.id) } }, { previousYearPaperId: { in: [paper.id, paper2.id] } }] } });
  await prisma.mockTest.deleteMany({ where: { id: { in: mocks.map((m) => m.id) } } });
  await prisma.questionOption.deleteMany({ where: { questionId: { in: pyqQs.map((q) => q.id) } } });
  await prisma.question.deleteMany({ where: { id: { in: pyqQs.map((q) => q.id) } } });
  await prisma.testAttempt.deleteMany({ where: { previousYearPaperId: paper2.id } });
  await prisma.previousYearPaper.deleteMany({ where: { id: { in: [paper.id, paper2.id] } } });
  for (let k = 0; k < createdStudents.length; k += 5000) {
    const chunk = createdStudents.slice(k, k + 5000);
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: chunk } } });
    await prisma.student.deleteMany({ where: { id: { in: chunk } } });
  }
  const after = await integrityChecksum();
  check("every pre-existing TestAttempt / Answer / MockTest row unchanged after all leaderboard reads", before === after, { before, after });

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
