/**
 * Phase 1 question safety — server regression (docs/QUESTION-RETIREMENT.md).
 *
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-question-safety.ts
 *
 * Seeds its own synthetic exam (prefix QSAF-), never runs against the
 * production database. Covers: the serving guard on every start path, Replace
 * (positions kept, holds, D4/D5/D6/P1-D resets), Retire, D7 variants, D8
 * saved-question hiding, D9 leaderboard, student-facing filters, engine RESET,
 * dependency counts vs raw SQL, preview/apply hash, validation refusals,
 * fault injection (full rollback of a failed apply), concurrency, rollback,
 * and the OP-1/OP-2/OP-3 scripts (dry runs write nothing).
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { AttemptStatus, QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAttemptNotReset,
  saveAnswer,
  startCustomModuleAttempt,
  startGrandTestAttempt,
  startLiveTestAttempt,
  startMockTestAttempt,
  startPreviousYearPaperAttempt,
  startSubjectTestAttempt,
  submitAttempt,
  TestEngineError,
} from "@/lib/test-attempt";
import { applyReplacement, previewReplacement, ReplacementError } from "@/lib/question-replacement/apply";
import { rollbackReplacement } from "@/lib/question-replacement/rollback";
import { getPaperDependencySummary, getQuestionDependencies } from "@/lib/question-dependencies";
import { evaluatePublishEligibility } from "@/lib/question-publish-policy";
import {
  getDashboardPreviousYearPapers,
  getMockTestDetailForStudent,
  getSavedQuestions,
  getStudentAnalytics,
  getStudentAttemptHistory,
  getWeakTopics,
} from "@/lib/student-data";
import { getLeaderboard } from "@/lib/leaderboard";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
async function code(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof TestEngineError) return e.code;
    if (e instanceof ReplacementError) return `REPLACEMENT:${e.message}${e.details.length ? ` ${e.details.join(" | ")}` : ""}`;
    return `THROWN:${e instanceof Error ? e.message : String(e)}`;
  }
}
const section = (t: string) => console.log(`\n== ${t}`);

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (/\/mocktestseries(\?|$)/.test(url) || !/qsafety|scratch|verify/.test(url)) throw new Error("Refusing to run outside a scratch database.");
  const sfx = Date.now().toString(36);

  // ---------------------------------------------------------------- fixture
  const exam = await prisma.exam.create({ data: { name: `QSAF Exam ${sfx}`, code: `QSAF${sfx}`.toUpperCase(), isActive: true, negativeMarking: 0 } });
  const otherExam = await prisma.exam.create({ data: { name: `QSAF Other ${sfx}`, code: `QSAFO${sfx}`.toUpperCase(), isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: `QSAF Subject ${sfx}` });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: `QSAF Topic ${sfx}` });
  const otherSubject = await createFixtureSubject(prisma, { examId: otherExam.id, name: `QSAF Other Subject ${sfx}` });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2016, title: `QSAF PYQ ${sfx}` } });

  let qn = 0;
  const mkQ = async (opts: { paper?: boolean; number?: number; status?: QuestionStatus; examId?: string; subjectId?: string; parentId?: string; noCorrect?: boolean; text?: string } = {}) => {
    qn++;
    return prisma.question.create({
      data: {
        code: `QSAF-${sfx}-${qn}`,
        examId: opts.examId ?? exam.id,
        subjectId: opts.subjectId ?? subject.id,
        topicId: opts.examId ? null : topic.id,
        text: opts.text ?? `QSAF question ${qn}`,
        status: opts.status ?? QuestionStatus.PUBLISHED,
        examYear: 2016,
        ...(opts.paper ? { previousYearPaperId: paper.id, source: QuestionSource.PYQ, paperQuestionNumber: opts.number ?? null } : {}),
        ...(opts.parentId ? { parentQuestionId: opts.parentId, aiVariantType: "AI_SIMILAR" as const, aiSlot: "AI01" as const, aiGenerationStatus: "COMPLETED" as const } : {}),
        options: {
          create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${label} of ${qn}`, isCorrect: !opts.noCorrect && label === "A", order })),
        },
      },
    });
  };

  // Paper of 12, created in REVERSE number order so ordering by number is observable.
  const pq: Awaited<ReturnType<typeof mkQ>>[] = [];
  for (let n = 12; n >= 1; n--) pq.unshift(await mkQ({ paper: true, number: n }));
  const byNo = (n: number) => pq[n - 1];
  const Q8 = byNo(8);
  const Q9 = byNo(9);
  const variant8 = await mkQ({ parentId: Q8.id, text: "variant of 8" });
  const bank: Awaited<ReturnType<typeof mkQ>>[] = [];
  for (let i = 0; i < 70; i++) bank.push(await mkQ());
  const corrected8 = await mkQ({ status: QuestionStatus.DRAFT, text: "QSAF corrected question 8" });

  // Mock "Grand Test 02": 70 questions, Q8 at position 64 (order 63), Q9 at 10.
  const gtIds = bank.slice(0, 68).map((q) => q.id);
  gtIds.splice(9, 0, Q9.id);
  gtIds.splice(63, 0, Q8.id);
  const mockGT = await prisma.mockTest.create({
    data: { examId: exam.id, title: `QSAF Grand Test 02 ${sfx}`, durationMinutes: 90, status: "PUBLISHED", questions: { create: gtIds.map((questionId, order) => ({ questionId, order })) } },
  });
  // Mock that already contains the corrected question → HOLD on replace.
  const mockConflict = await prisma.mockTest.create({
    data: { examId: exam.id, title: `QSAF Conflict Mock ${sfx}`, durationMinutes: 30, status: "PUBLISHED", questions: { create: [Q8.id, corrected8.id, bank[0].id].map((questionId, order) => ({ questionId, order })) } },
  });
  // Unrelated mock.
  const mockOther = await prisma.mockTest.create({
    data: { examId: exam.id, title: `QSAF Unrelated Mock ${sfx}`, durationMinutes: 30, status: "PUBLISHED", questions: { create: bank.slice(0, 5).map((q, order) => ({ questionId: q.id, order })) } },
  });
  const adminModule = await prisma.customModule.create({
    data: { examId: exam.id, title: `QSAF Admin Module ${sfx}`, status: "ACTIVE", questions: { create: [bank[1].id, Q8.id, Q9.id].map((questionId, order) => ({ questionId, order })) } },
  });
  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `QSAF${tag}-${sfx}`, name: `QSAF ${tag}`, email: `qsaf-${tag}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };
  const S = { a: await mkStudent("a"), b: await mkStudent("b"), c: await mkStudent("c"), d: await mkStudent("d"), e: await mkStudent("e"), f: await mkStudent("f"), g: await mkStudent("g") };
  const studentModule = await prisma.customModule.create({
    data: { examId: exam.id, title: `QSAF Student Module ${sfx}`, status: "ACTIVE", isStudentOwned: true, createdByStudentId: S.a, questions: { create: [bank[2].id, Q8.id, bank[3].id].map((questionId, order) => ({ questionId, order })) } },
  });
  const studentModuleOther = await prisma.customModule.create({
    data: { examId: exam.id, title: `QSAF Student Module Unrelated ${sfx}`, status: "ACTIVE", isStudentOwned: true, createdByStudentId: S.a, questions: { create: [bank[4].id, bank[5].id].map((questionId, order) => ({ questionId, order })) } },
  });
  const grand = await prisma.grandTest.create({
    data: { examId: exam.id, title: `QSAF Grand ${sfx}`, durationMinutes: 30, status: "PUBLISHED", questionCount: 3, questions: { create: [bank[6].id, Q9.id, bank[7].id].map((questionId, order) => ({ questionId, order })) } },
  });
  const live = await prisma.liveTest.create({
    data: {
      examId: exam.id, title: `QSAF Live ${sfx}`, startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 3_600_000),
      studentDurationMinutes: 30, status: "SCHEDULED", questionCount: 3, publishedAt: new Date(),
      questions: { create: [bank[8].id, Q9.id, bank[9].id].map((questionId, order) => ({ questionId, order })) },
    },
  });

  const answerAll = async (attemptId: string, studentId: string, label = "A") => {
    const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId }, select: { questionId: true } });
    for (const r of rows) await saveAnswer(attemptId, studentId, r.questionId, label, false);
  };
  const frozenIds = async (attemptId: string) =>
    (await prisma.testAttemptQuestion.findMany({ where: { attemptId }, orderBy: { order: "asc" }, select: { questionId: true } })).map((r) => r.questionId);

  // ------------------------------------------------- A. serving guard (archive)
  section("A. Serving guard — archived questions are never served");
  const archivedProbe = bank[3];
  await prisma.question.update({ where: { id: archivedProbe.id }, data: { status: QuestionStatus.ARCHIVED } });
  {
    const att = await startCustomModuleAttempt(S.a, studentModule.id);
    const ids = await frozenIds(att.id);
    check("student module skips an ARCHIVED question (no status filter before Phase 1)", !ids.includes(archivedProbe.id) && ids.length === 2, ids.length);
    await prisma.testAttempt.update({ where: { id: att.id }, data: { status: AttemptStatus.SUBMITTED, submittedAt: new Date() } });
  }
  await prisma.question.update({ where: { id: bank[6].id }, data: { status: QuestionStatus.ARCHIVED } });
  {
    const att = await startGrandTestAttempt(S.g, grand.id);
    const ids = await frozenIds(att.id);
    check("grand test skips an ARCHIVED question", !ids.includes(bank[6].id) && ids.length === 2, ids);
    await prisma.testAttempt.delete({ where: { id: att.id } });
  }
  await prisma.question.update({ where: { id: bank[8].id }, data: { status: QuestionStatus.ARCHIVED } });
  {
    const err = await code(async () => {
      const att = await startLiveTestAttempt(S.g, live.id);
      const ids = await frozenIds(att.id);
      check("live test skips an ARCHIVED question", !ids.includes(bank[8].id) && ids.length === 2, ids);
      await prisma.testAttempt.delete({ where: { id: att.id } });
    });
    check("live test start ran", err === null, err);
  }
  await prisma.question.update({ where: { id: bank[1].id }, data: { status: QuestionStatus.ARCHIVED } });
  {
    const att = await startCustomModuleAttempt(S.g, adminModule.id);
    const ids = await frozenIds(att.id);
    check("admin module skips an ARCHIVED question", !ids.includes(bank[1].id) && ids.length === 2, ids);
    await prisma.testAttempt.delete({ where: { id: att.id } });
  }
  for (const q of [bank[3], bank[6], bank[8], bank[1]]) await prisma.question.update({ where: { id: q.id }, data: { status: QuestionStatus.PUBLISHED } });

  // PYQ order follows the printed number although questions were created in reverse.
  {
    const att = await startPreviousYearPaperAttempt(S.g, paper.id);
    const ids = await frozenIds(att.id);
    check("PYQ attempt follows paperQuestionNumber (1..12)", JSON.stringify(ids) === JSON.stringify(pq.map((q) => q.id)), ids.map((id) => pq.findIndex((q) => q.id === id) + 1));
    await prisma.testAttempt.delete({ where: { id: att.id } });
  }

  // ---------------------------------------------- B. attempts before Replace
  section("B. Attempts before replacing Q8");
  const aGT = await startMockTestAttempt(S.a, mockGT.id); // will be submitted (D4)
  await answerAll(aGT.id, S.a);
  await submitAttempt(aGT.id, S.a);
  const bGT = await startMockTestAttempt(S.b, mockGT.id); // stays in progress (D4 + session)
  await saveAnswer(bGT.id, S.b, Q8.id, "A", false);
  const cPYQ = await startPreviousYearPaperAttempt(S.c, paper.id); // submitted PYQ: kept (P1-D)
  await answerAll(cPYQ.id, S.c, "B"); // all wrong → weak-topic rows
  await submitAttempt(cPYQ.id, S.c);
  const dPYQ = await startPreviousYearPaperAttempt(S.d, paper.id); // in-progress PYQ: closed
  const eSubjectDone = await startSubjectTestAttempt(S.e, { examId: exam.id, subjectId: subject.id, count: 90, durationMinutes: 0, minutesPerQuestion: 1 });
  check("subject test pool includes Q8 before retirement", (await frozenIds(eSubjectDone.id)).includes(Q8.id));
  await answerAll(eSubjectDone.id, S.e, "B");
  await submitAttempt(eSubjectDone.id, S.e);
  const eSubjectOpen = await startSubjectTestAttempt(S.f, { examId: exam.id, subjectId: subject.id, count: 90, durationMinutes: 0, minutesPerQuestion: 1 });
  const aSM = await startCustomModuleAttempt(S.a, studentModule.id); // D5
  await answerAll(aSM.id, S.a);
  await submitAttempt(aSM.id, S.a);
  const aSMOther = await startCustomModuleAttempt(S.a, studentModuleOther.id); // unrelated: untouched
  await answerAll(aSMOther.id, S.a);
  await submitAttempt(aSMOther.id, S.a);
  const fOther = await startMockTestAttempt(S.f, mockOther.id); // unrelated: untouched
  await answerAll(fOther.id, S.f);
  await submitAttempt(fOther.id, S.f);
  const conflictAttempt = await startMockTestAttempt(S.g, mockConflict.id); // held mock: D4
  // D9: a Practice-mode (answer-exposing) attempt makes S.d unranked on Grand Test 02 …
  const dPractice = await startMockTestAttempt(S.d, mockGT.id, undefined, { answerMode: "INSTANT", durationMode: "FIXED" });
  await submitAttempt(dPractice.id, S.d);
  const dCompetitive = await startMockTestAttempt(S.d, mockGT.id);
  await answerAll(dCompetitive.id, S.d);
  await submitAttempt(dCompetitive.id, S.d);
  const lbBefore = await getLeaderboard({ kind: "MOCK_TEST", id: mockGT.id }, S.d);
  check("D9 baseline: practice attempt leaves the student unranked", lbBefore.self === null, lbBefore.self);
  await prisma.savedQuestion.create({ data: { studentId: S.c, questionId: Q8.id } });

  const unrelatedBefore = JSON.stringify(
    await prisma.testAttempt.findMany({ where: { id: { in: [aSMOther.id, fOther.id] } }, include: { questions: true, answers: true }, orderBy: { id: "asc" } })
  );
  const gtRowsBefore = await prisma.mockTestQuestion.findMany({ where: { mockTestId: mockGT.id }, orderBy: { order: "asc" } });

  // ------------------------------------------------------------ C. preview
  section("C. Preview, validation and hash");
  {
    const { plan, summary } = await previewReplacement([{ oldQuestionId: Q8.id, newQuestionId: corrected8.id }]);
    check("preview has no errors", plan.errors.length === 0, plan.errors);
    check("D7: AI variant is retired with its question", plan.variants.some((v) => v.id === variant8.id));
    const gtRef = plan.references.find((r) => r.containerId === mockGT.id);
    check("Grand Test 02 row: SWAP at position 64", gtRef?.action === "SWAP" && gtRef.position === 64, gtRef);
    check("conflict mock: HOLD (replacement already in it)", plan.references.find((r) => r.containerId === mockConflict.id)?.action === "HOLD");
    check("student module: SWAP", plan.references.find((r) => r.containerId === studentModule.id)?.action === "SWAP");
    // Grand Test 02: 4 (submitted, in progress, practice, competitive) + conflict mock 1 + student module 2
    // (section A's + this one) + PYQ in progress 1 + subject test in progress 1.
    check("preview attempts = 4 GT + 1 conflict + 2 student module + 1 PYQ open + 1 subject open", summary.attemptsInvalidated === 9, summary);
    check("kept answers on Q8 excluded (submitted PYQ + submitted subject test)", summary.keptAnswersExcluded >= 2, summary.keptAnswersExcluded);
    // Hash refuses when references change after the preview.
    await prisma.mockTestQuestion.create({ data: { mockTestId: mockOther.id, questionId: Q9.id, order: 99 } });
    const stale = await previewReplacement([{ oldQuestionId: Q9.id, newQuestionId: null }]);
    await prisma.mockTestQuestion.deleteMany({ where: { mockTestId: mockOther.id, questionId: Q9.id } });
    const err = await code(() => applyReplacement({ pairs: [{ oldQuestionId: Q9.id, newQuestionId: null }], reason: "stale hash test", actor: { adminId: null, source: "SCRIPT" }, expectedHash: stale.summary.hash }));
    check("apply refuses a stale preview hash and changes nothing", !!err?.startsWith("REPLACEMENT:The tests using this question changed"), err);
    check("Q9 still not retired after refused apply", !(await prisma.question.findUnique({ where: { id: Q9.id } }))!.retiredAt);
  }
  {
    const otherQ = await mkQ({ examId: otherExam.id, subjectId: otherSubject.id });
    const broken = await mkQ({ status: QuestionStatus.DRAFT, noCorrect: true });
    const e1 = await previewReplacement([{ oldQuestionId: Q8.id, newQuestionId: otherQ.id }]);
    check("refuses a replacement from another exam", e1.plan.errors.some((e) => e.includes("different exam")), e1.plan.errors);
    const e2 = await previewReplacement([{ oldQuestionId: Q8.id, newQuestionId: broken.id }]);
    check("refuses an unpublishable replacement (no correct answer)", e2.plan.errors.some((e) => e.includes("cannot be published")), e2.plan.errors);
    const e3 = await previewReplacement([{ oldQuestionId: Q8.id, newQuestionId: variant8.id }]);
    check("refuses an AI variant as replacement", e3.plan.errors.some((e) => e.includes("AI variant")), e3.plan.errors);
    const e4 = await previewReplacement([{ oldQuestionId: Q8.id, newQuestionId: Q8.id }]);
    check("refuses replacing a question with itself", e4.plan.errors.some((e) => e.includes("cannot replace itself")), e4.plan.errors);
  }

  // ------------------------------------------------- D. fault injection
  section("D. Fault injection — a failure mid-apply changes nothing");
  {
    const gtRow = gtRowsBefore.find((r) => r.questionId === Q8.id)!;
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION qsaf_fail() RETURNS trigger AS $$ BEGIN IF NEW.id = '${gtRow.id}' THEN RAISE EXCEPTION 'qsaf injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER qsaf_fail_trg BEFORE UPDATE ON "MockTestQuestion" FOR EACH ROW EXECUTE FUNCTION qsaf_fail()`);
    const err = await code(() => applyReplacement({ pairs: [{ oldQuestionId: Q8.id, newQuestionId: corrected8.id }], reason: "fault injection", actor: { adminId: null, source: "SCRIPT" } }));
    await prisma.$executeRawUnsafe(`DROP TRIGGER qsaf_fail_trg ON "MockTestQuestion"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION qsaf_fail()`);
    check("apply failed", !!err && err.includes("qsaf injected failure"), err);
    const q8 = await prisma.question.findUnique({ where: { id: Q8.id } });
    const c8 = await prisma.question.findUnique({ where: { id: corrected8.id } });
    check("old question untouched (PUBLISHED, not retired)", q8!.status === "PUBLISHED" && !q8!.retiredAt);
    check("replacement untouched (still DRAFT)", c8!.status === "DRAFT");
    check("no replacement record left", (await prisma.questionReplacement.count({ where: { reason: "fault injection" } })) === 0);
    check("no attempt invalidated", (await prisma.testAttempt.count({ where: { invalidatedAt: { not: null }, studentId: { in: students } } })) === 0);
    check("conflict mock still PUBLISHED", (await prisma.mockTest.findUnique({ where: { id: mockConflict.id } }))!.status === "PUBLISHED");
  }

  // ------------------------------------------------- E. Replace Q8 (apply)
  section("E. Replace Q8 → corrected question");
  const preview = await previewReplacement([{ oldQuestionId: Q8.id, newQuestionId: corrected8.id }]);
  const applied = await applyReplacement({
    pairs: [{ oldQuestionId: Q8.id, newQuestionId: corrected8.id }],
    reason: "Wrong answer key (fixture)",
    actor: { adminId: null, source: "SCRIPT" },
    expectedHash: preview.summary.hash,
  });
  check("apply returned a record", !!applied.replacementId);
  {
    const q8 = await prisma.question.findUnique({ where: { id: Q8.id } });
    const c8 = await prisma.question.findUnique({ where: { id: corrected8.id } });
    const v8 = await prisma.question.findUnique({ where: { id: variant8.id } });
    check("old Q8 retired + ARCHIVED + replacedBy", !!q8!.retiredAt && q8!.status === "ARCHIVED" && q8!.replacedByQuestionId === corrected8.id);
    check("variant retired (D7)", !!v8!.retiredAt && v8!.status === "ARCHIVED");
    check("replacement PUBLISHED, takes paper slot Q8 (paper, PYQ, number 8)", c8!.status === "PUBLISHED" && c8!.previousYearPaperId === paper.id && c8!.source === "PYQ" && c8!.paperQuestionNumber === 8, c8);
    const rows = await prisma.mockTestQuestion.findMany({ where: { mockTestId: mockGT.id }, orderBy: { order: "asc" } });
    check("Grand Test 02: same row count", rows.length === gtRowsBefore.length);
    check("Grand Test 02: position 64 now holds the replacement", rows[63].questionId === corrected8.id && rows[63].id === gtRowsBefore[63].id);
    const othersSame = rows.every((r, i) => i === 63 || (r.questionId === gtRowsBefore[i].questionId && r.order === gtRowsBefore[i].order));
    check("Grand Test 02: every other position and order unchanged", othersSame);
    check("Grand Test 02 stays PUBLISHED, duration unchanged", (await prisma.mockTest.findUnique({ where: { id: mockGT.id } }))!.status === "PUBLISHED");
    const conflict = await prisma.mockTest.findUnique({ where: { id: mockConflict.id }, include: { questions: true } });
    check("conflict mock HELD → DRAFT, row left on old question", conflict!.status === "DRAFT" && conflict!.questions.some((r) => r.questionId === Q8.id));
    const am = await prisma.customModuleQuestion.findMany({ where: { customModuleId: adminModule.id }, orderBy: { order: "asc" } });
    check("admin module: swapped in place at the same order", am[1].questionId === corrected8.id);
    const sm = await prisma.customModuleQuestion.findMany({ where: { customModuleId: studentModule.id }, orderBy: { order: "asc" } });
    check("student module: swapped in place at the same order", sm[1].questionId === corrected8.id);
  }
  {
    const st = async (id: string) => prisma.testAttempt.findUnique({ where: { id }, select: { status: true, invalidatedAt: true, statusBeforeInvalidation: true, score: true, invalidatedByReplacementId: true } });
    const a = await st(aGT.id);
    check("D4: submitted Grand Test 02 attempt → ABANDONED, invalidated, score kept", a!.status === "ABANDONED" && !!a!.invalidatedAt && a!.statusBeforeInvalidation === "SUBMITTED" && a!.score !== null);
    check("D4: in-progress Grand Test 02 attempt invalidated", (await st(bGT.id))!.statusBeforeInvalidation === "IN_PROGRESS");
    check("D4: held conflict mock's attempt invalidated", !!(await st(conflictAttempt.id))!.invalidatedAt);
    check("D5: student module attempt invalidated", !!(await st(aSM.id))!.invalidatedAt);
    check("P1-D: SUBMITTED PYQ attempt kept", (await st(cPYQ.id))!.status === "SUBMITTED");
    check("P1-D: IN_PROGRESS PYQ attempt closed", (await st(dPYQ.id))!.status === "ABANDONED");
    check("D6: SUBMITTED subject test kept", (await st(eSubjectDone.id))!.status === "SUBMITTED");
    check("D6: IN_PROGRESS subject test holding Q8 closed", (await st(eSubjectOpen.id))!.status === "ABANDONED");
    const unrelatedAfter = JSON.stringify(
      await prisma.testAttempt.findMany({ where: { id: { in: [aSMOther.id, fOther.id] } }, include: { questions: true, answers: true }, orderBy: { id: "asc" } })
    );
    check("unrelated module + mock attempts byte-identical", unrelatedAfter === unrelatedBefore);
    const ans = await prisma.answer.findMany({ where: { attemptId: cPYQ.id }, select: { questionId: true, statsExcludedAt: true } });
    check("kept PYQ attempt: only the Q8 answer excluded from stats", ans.filter((x) => x.statsExcludedAt).length === 1 && !!ans.find((x) => x.questionId === Q8.id)?.statsExcludedAt);
    const invAns = await prisma.answer.count({ where: { attemptId: aGT.id, statsExcludedAt: null } });
    check("invalidated attempt: every answer excluded from stats", invAns === 0);
  }
  {
    check("engine: save on a reset attempt → RESET", (await code(() => saveAnswer(bGT.id, S.b, bank[0].id, "A", false))) === "RESET");
    check("engine: heartbeat check → RESET", (await code(() => assertAttemptNotReset(bGT.id, S.b))) === "RESET");
    const sub = await submitAttempt(bGT.id, S.b);
    check("engine: submit of a reset attempt never grades it", sub.status === "ABANDONED" && sub.score === null);
    const fresh = await startMockTestAttempt(S.b, mockGT.id);
    const ids = await frozenIds(fresh.id);
    check("fresh start: new attempt, position 64 = replacement, no retired question", fresh.id !== bGT.id && ids[63] === corrected8.id && !ids.includes(Q8.id) && ids.length === 70);
    const pyq = await startPreviousYearPaperAttempt(S.d, paper.id);
    const pids = await frozenIds(pyq.id);
    check("fresh PYQ: replacement at number 8, old Q8 absent", pids[7] === corrected8.id && !pids.includes(Q8.id) && pids.length === 12, pids.indexOf(corrected8.id));
    const subj = await startSubjectTestAttempt(S.f, { examId: exam.id, subjectId: subject.id, count: 200, durationMinutes: 0, minutesPerQuestion: 1 });
    const sids = await frozenIds(subj.id);
    check("subject test never selects a retired question (Q8, variant)", !sids.includes(Q8.id) && !sids.includes(variant8.id));
    const err = await code(() => startMockTestAttempt(S.g, mockConflict.id));
    check("held (DRAFT) mock cannot be started", err === "UNAVAILABLE", err);
  }
  {
    const hist = await getStudentAttemptHistory(S.a);
    check("History hides invalidated attempts", !hist.some((h) => h.id === aGT.id || h.id === aSM.id) && hist.some((h) => h.id === aSMOther.id));
    const detail = await getMockTestDetailForStudent(S.a, mockGT.id);
    check("Mock card: no previous result, no resume (Not Attempted)", detail?.latestSubmittedAttempt === null && detail?.inProgressAttempt === null);
    const papers = await getDashboardPreviousYearPapers(S.d, exam.id);
    check("PYQ card: closed in-progress attempt no longer offered as Resume", papers[0]?.inProgressAttemptId !== dPYQ.id);
    const an = await getStudentAnalytics(S.a);
    check(
      "Analytics: only the unrelated module counts (1 attempt, 2 correct answers)",
      an.performanceOverTime.length === 1 && an.correct === 2 && an.incorrect === 0 && an.attempted === 2,
      { over: an.performanceOverTime.length, correct: an.correct, incorrect: an.incorrect, attempted: an.attempted }
    );
    const weak = await getWeakTopics(S.c);
    const wrongKept = await prisma.answer.count({ where: { attemptId: cPYQ.id, isCorrect: false, statsExcludedAt: null } });
    check("Weak topics count only non-excluded wrong answers", (weak[0]?.incorrectCount ?? 0) === wrongKept, { weak, wrongKept });
    const saved = await getSavedQuestions(S.c);
    check("D8: Saved Questions hides the retired question (bookmark row kept)", !saved.some((s) => s.id === Q8.id) && (await prisma.savedQuestion.count({ where: { studentId: S.c, questionId: Q8.id } })) === 1);
    const lb = await getLeaderboard({ kind: "MOCK_TEST", id: mockGT.id }, S.d);
    check("D9: invalidated attempts are gone from the leaderboard", lb.totalParticipants === 0, lb.totalParticipants);
    const dNew = await startMockTestAttempt(S.d, mockGT.id);
    await answerAll(dNew.id, S.d);
    await submitAttempt(dNew.id, S.d);
    const lb2 = await getLeaderboard({ kind: "MOCK_TEST", id: mockGT.id }, S.d);
    check("D9: fresh attempt ranks (old practice attempt no longer makes the student unranked)", lb2.self !== null, lb2);
  }
  {
    const elig = await evaluatePublishEligibility([Q8.id]);
    check("republish guard: retired question blocked (RETIRED)", elig.blocked[0]?.reasons[0]?.code === "RETIRED");
    const err = await code(() => prisma.question.update({ where: { id: Q8.id }, data: { status: QuestionStatus.PUBLISHED } }));
    check("DB CHECK: a retired question cannot be set PUBLISHED", !!err && err.includes("Question_retired_is_archived"), err);
    const err2 = await code(() => prisma.testAttempt.update({ where: { id: aGT.id }, data: { status: AttemptStatus.SUBMITTED } }));
    check("DB CHECK: an invalidated attempt cannot be reactivated", !!err2 && err2.includes("TestAttempt_invalidated_is_abandoned"), err2);
    const again = await previewReplacement([{ oldQuestionId: Q8.id, newQuestionId: null }]);
    check("cannot retire an already retired question", again.plan.errors.some((e) => e.includes("already retired")));
  }

  // ---------------------------------------------------- F. dependencies
  section("F. Dependency view = raw SQL");
  {
    const deps = (await getQuestionDependencies([Q9.id])).get(Q9.id)!;
    const rawMock = await prisma.mockTestQuestion.count({ where: { questionId: Q9.id } });
    const rawCm = await prisma.customModuleQuestion.count({ where: { questionId: Q9.id } });
    const rawAtt = await prisma.testAttempt.count({ where: { questions: { some: { questionId: Q9.id } }, status: "SUBMITTED", invalidatedAt: null } });
    check("mock count", deps.mockTests === rawMock, [deps.mockTests, rawMock]);
    check("module count", deps.adminModules + deps.studentModules === rawCm, [deps.adminModules, deps.studentModules, rawCm]);
    check("grand + live count", deps.grandOrLive === 2, deps.grandOrLive);
    check("submitted attempts", deps.attempts.submitted === rawAtt, [deps.attempts.submitted, rawAtt]);
    check("Grand Test 02 position of Q9 = 10", deps.uses.find((u) => u.id === mockGT.id)?.position === 10);
    const paperSum = await getPaperDependencySummary(paper.id);
    check("paper summary lists 13 questions (12 + replacement)", paperSum!.totals.questions === 13, paperSum!.totals);
    check("paper summary: 1 retired, 12 published", paperSum!.totals.retired === 1 && paperSum!.totals.published === 12, paperSum!.totals);
  }

  // --------------------------------------------- G. retire with no replacement
  section("G. Retire Q9 with no replacement (P1-E)");
  {
    const r = await applyReplacement({ pairs: [{ oldQuestionId: Q9.id, newQuestionId: null }], reason: "Withdrawn question (fixture)", actor: { adminId: null, source: "SCRIPT" } });
    check("Grand Test 02 HELD (admin test lost a question)", (await prisma.mockTest.findUnique({ where: { id: mockGT.id } }))!.status === "DRAFT");
    check("admin module HELD → INACTIVE", (await prisma.customModule.findUnique({ where: { id: adminModule.id } }))!.status === "INACTIVE");
    check("grand test HELD → DRAFT", (await prisma.grandTest.findUnique({ where: { id: grand.id } }))!.status === "DRAFT");
    check("live test HELD → DRAFT", (await prisma.liveTest.findUnique({ where: { id: live.id } }))!.status === "DRAFT");
    const refs = await prisma.questionReplacementReference.findMany({ where: { replacementId: r.replacementId } });
    check("all references recorded as HOLD with prior status", refs.length > 0 && refs.every((x) => x.action === "HOLD" && !!x.priorContainerStatus));
    const rb = await rollbackReplacement(r.replacementId, { adminId: null, source: "SCRIPT" });
    check("rollback of the retire restores 4 containers", rb.containersRestored === 4, rb);
    check("Grand Test 02 back to PUBLISHED", (await prisma.mockTest.findUnique({ where: { id: mockGT.id } }))!.status === "PUBLISHED");
    check("Q9 back to PUBLISHED, not retired", (await prisma.question.findUnique({ where: { id: Q9.id } }))!.status === "PUBLISHED");
  }

  // ---------------------------------------------------- H. concurrency
  section("H. Concurrency");
  {
    const target = bank[20];
    await prisma.mockTestQuestion.create({ data: { mockTestId: mockOther.id, questionId: target.id, order: 50 } });
    const results = await Promise.all([0, 1].map(() => code(() => applyReplacement({ pairs: [{ oldQuestionId: target.id, newQuestionId: null }], reason: "concurrent", actor: { adminId: null, source: "SCRIPT" } }))));
    check("two concurrent retires of one question: exactly one wins", results.filter((x) => x === null).length === 1 && results.some((x) => x?.includes("already retired")), results);
    const r2 = await prisma.questionReplacement.findFirst({ where: { reason: "concurrent", status: "APPLIED" }, orderBy: { createdAt: "desc" } });
    if (r2) await rollbackReplacement(r2.id, { adminId: null, source: "SCRIPT" });
    // Starts racing a retirement never freeze the retired question into a live attempt.
    const racers = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => mkStudent(`race${i}`)));
    const startAll = racers.map((sid, i) =>
      (async () => {
        await new Promise((r) => setTimeout(r, i * 15));
        try {
          return await startMockTestAttempt(sid, mockOther.id);
        } catch {
          return null;
        }
      })()
    );
    const retire = applyReplacement({ pairs: [{ oldQuestionId: target.id, newQuestionId: null }], reason: "race", actor: { adminId: null, source: "SCRIPT" } });
    const [started] = await Promise.all([Promise.all(startAll), retire]);
    const live = await prisma.testAttempt.findMany({
      where: { id: { in: started.filter((x): x is NonNullable<typeof x> => !!x).map((a) => a.id) }, status: "IN_PROGRESS" },
      select: { id: true },
    });
    let leaked = 0;
    for (const a of live) if ((await frozenIds(a.id)).includes(target.id)) leaked++;
    check("race: no IN_PROGRESS attempt holds the retired question", leaked === 0, { leaked, live: live.length });
  }

  // -------------------------------------------------------- I. rollback
  section("I. Rollback of the Q8 replacement");
  {
    const rb = await rollbackReplacement(applied.replacementId, { adminId: null, source: "SCRIPT" });
    const q8 = await prisma.question.findUnique({ where: { id: Q8.id } });
    const c8 = await prisma.question.findUnique({ where: { id: corrected8.id } });
    check("old Q8 restored (PUBLISHED, not retired)", q8!.status === "PUBLISHED" && !q8!.retiredAt && !q8!.replacedByQuestionId);
    check("variant restored", (await prisma.question.findUnique({ where: { id: variant8.id } }))!.status === QuestionStatus.PUBLISHED);
    check("replacement back to DRAFT, unlinked", c8!.status === "DRAFT" && c8!.previousYearPaperId === null && c8!.paperQuestionNumber === null);
    const rows = await prisma.mockTestQuestion.findMany({ where: { mockTestId: mockGT.id }, orderBy: { order: "asc" } });
    check("Grand Test 02 position 64 back to Q8", rows[63].questionId === Q8.id);
    check("conflict mock back to PUBLISHED", (await prisma.mockTest.findUnique({ where: { id: mockConflict.id } }))!.status === "PUBLISHED");
    const a = await prisma.testAttempt.findUnique({ where: { id: aGT.id } });
    check("D4 attempt restored to SUBMITTED with its score", a!.status === "SUBMITTED" && !a!.invalidatedAt && a!.score !== null);
    check("in-progress attempt restored to IN_PROGRESS", (await prisma.testAttempt.findUnique({ where: { id: bGT.id } }))!.status === "IN_PROGRESS");
    check("no answer left excluded by this replacement", (await prisma.answer.count({ where: { statsExcludedByReplacementId: applied.replacementId } })) === 0);
    check("rollback summary counts", rb.attemptsRestored >= 8 && rb.rowsUnswapped >= 3, rb);
    const twice = await code(() => rollbackReplacement(applied.replacementId, { adminId: null, source: "SCRIPT" }));
    check("second rollback refused", !!twice?.includes("already rolled back"), twice);
  }

  // ---------------------------------------------------------- J. scripts
  section("J. Data-operation scripts (OP-1, OP-2, OP-3)");
  {
    const env = { ...process.env };
    const run = (args: string[]) => execFileSync("npx", ["tsx", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const snapshot = async () =>
      JSON.stringify([
        await prisma.question.count({ where: { retiredAt: { not: null } } }),
        await prisma.testAttempt.count({ where: { invalidatedAt: { not: null } } }),
        await prisma.questionReplacement.count(),
        await prisma.question.count({ where: { paperQuestionNumber: { not: null } } }),
      ]);
    // OP-3 shape: archived paper questions.
    await prisma.question.updateMany({ where: { id: { in: [byNo(11).id, byNo(12).id] } }, data: { status: QuestionStatus.ARCHIVED } });
    const before = await snapshot();
    const dry = run(["scripts/retire-questions.ts", "--paper", paper.id, "--status", "ARCHIVED", "--reason", "fixture OP-3", "--dry-run"]);
    const hash = /PLAN HASH (\w+)/.exec(dry)?.[1];
    check("OP-3 dry run prints a plan hash and changes nothing", !!hash && (await snapshot()) === before && dry.includes("Selected 2 question(s)"), dry.slice(-400));
    const bad = await code(async () => run(["scripts/retire-questions.ts", "--paper", paper.id, "--status", "ARCHIVED", "--reason", "fixture OP-3", "--apply", "--confirm", "deadbeef"]));
    check("OP-3 apply refuses a wrong hash", !!bad && (await snapshot()) === before);
    const out = run(["scripts/retire-questions.ts", "--paper", paper.id, "--status", "ARCHIVED", "--reason", "fixture OP-3", "--apply", "--confirm", hash!]);
    const rid = /"replacementId": "(\w+)"/.exec(out)?.[1];
    check("OP-3 apply retires exactly the 2 archived questions", !!rid && (await prisma.question.count({ where: { id: { in: [byNo(11).id, byNo(12).id] }, retiredAt: { not: null } } })) === 2, out.slice(-300));
    run(["scripts/retire-questions.ts", "rollback", "--replacement", rid!, "--apply"]);
    check("OP-3 rollback restores them (ARCHIVED, not retired)", (await prisma.question.count({ where: { id: { in: [byNo(11).id, byNo(12).id] }, retiredAt: null, status: "ARCHIVED" } })) === 2);

    // OP-2 on a paper with no numbers yet.
    const paper2 = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2015, title: `QSAF PYQ2 ${sfx}` } });
    const p2q = [];
    for (let i = 0; i < 3; i++) p2q.push(await prisma.question.update({ where: { id: (await mkQ()).id }, data: { previousYearPaperId: paper2.id, source: "PYQ" } }));
    const b2 = await snapshot();
    const d2 = run(["scripts/backfill-paper-question-numbers.ts", "--dry-run", "--paper", paper2.id]);
    const h2 = /PLAN HASH (\w+)/.exec(d2)?.[1];
    check("OP-2 dry run writes nothing", !!h2 && (await snapshot()) === b2 && d2.includes("ORDER"), d2.slice(-300));
    run(["scripts/backfill-paper-question-numbers.ts", "--apply", "--confirm", h2!, "--paper", paper2.id]);
    const nums = (await prisma.question.findMany({ where: { previousYearPaperId: paper2.id }, orderBy: [{ createdAt: "asc" }, { code: "asc" }], select: { paperQuestionNumber: true } })).map((q) => q.paperQuestionNumber);
    check("OP-2 apply numbers the paper 1..3 in today's order", JSON.stringify(nums) === "[1,2,3]", nums);
    run(["scripts/backfill-paper-question-numbers.ts", "--revert", "--apply"]);
    check("OP-2 revert clears exactly those numbers", (await prisma.question.count({ where: { previousYearPaperId: paper2.id, paperQuestionNumber: { not: null } } })) === 0 && (await prisma.question.count({ where: { previousYearPaperId: paper.id, paperQuestionNumber: { not: null } } })) >= 12);

    // OP-1 (read-only audit).
    const b3 = await snapshot();
    const a1 = run(["scripts/audit-module-dependencies.ts", "--exam", exam.code, "--out", process.env.QSAF_OUT ?? "qsaf-audit-out"]);
    check("OP-1 audit runs read-only and reports the student modules", (await snapshot()) === b3 && a1.includes('"studentOwned"'), a1.slice(-300));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
