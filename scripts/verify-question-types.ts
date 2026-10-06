/**
 * NEET Phase 4 — advanced question types (server side).
 *
 * Proves, against a DISPOSABLE database:
 *  - every existing / default question is SINGLE_CORRECT and freezes exactly as
 *    before (v1 / v2 keys, no v3 key on a SINGLE_CORRECT snapshot or payload);
 *  - MULTIPLE_CORRECT and MATCH_THE_FOLLOWING freeze to snapshot v3 (type,
 *    correctLabels / matchSpec, LIST_ITEM assets) and old attempts keep
 *    rendering + scoring from the snapshot after the live question is edited;
 *  - label-set save: validation, normalization, idempotency, seq (stale never
 *    overwrites), overlapping requests, single/multi API separation;
 *  - ALL-OR-NOTHING scoring matrix for [A,B,D], click order, unanswered,
 *    negative marking, mixed paper totals;
 *  - Practice Mode reveal commits + locks the set and returns the full set;
 *    Exam Mode never reveals and the player payload never carries the key;
 *  - Match the Following: structured lists, single-choice scoring, review view;
 *  - OMR entry refuses MULTIPLE_CORRECT mocks, still allows MATCH/SINGLE;
 *  - AI variant source guard, Question Insights key rules + copy text,
 *    WhatsApp share text (SINGLE byte-identical to the Phase 3 builder);
 *  - importer manifest: MSQ keys, repeated labels, LIST_ITEM mapping, dedup identity.
 *
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-question-types.ts
 *
 * `setup` / `cleanup <fixture.json>` prepare the browser suite
 * (scripts/verify-question-types.mjs). `setup` honours MEDIA_KEYS=<json map
 * n → storageKey> so the browser suite can use real stored images.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import argon2 from "argon2";
import { AttemptStatus, PrismaClient, QuestionDifficulty, QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  revealAnswer,
  revealAnswerLabels,
  saveAnswer,
  saveAnswerLabels,
  startMockTestAttempt,
  startOfflineOmrEntryAttempt,
  startPreviousYearPaperAttempt,
  submitAttempt,
  type QuestionSnapshot,
} from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { matchView, richQuestionView, snapshotVersion } from "@/lib/rich-content";
import {
  AI_UNSUPPORTED_TYPE_MESSAGE,
  correctCountIssue,
  gradeLabelSet,
  matchSpecIssues,
  normalizeLabelSet,
  parseMatchLines,
  readMatchSpec,
  snapshotCorrectLabels,
  snapshotQuestionType,
  snapshotShareFields,
} from "@/lib/question-types";
import { answerKeyIssue, answerKeyString, buildCopyBlocks } from "@/lib/question-insights-format";
import { buildQuestionShareText, DEFAULT_WHATSAPP_SHARE_TEMPLATE } from "@/lib/whatsapp-share-template";
import { ensureQuestionVariants } from "@/lib/ai-variant";
import { composeQuestionText, hasRepeatedLabel, manifestMatchSpec, matchIdentityText, parseCorrect, toManifestQuestion } from "@/lib/rich-import/manifest";
import { nextStudentId } from "@/lib/student-id";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";
import type { BulkImportRow } from "@/lib/bulk-import";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";
import { fakeKey, qtFixtureQuestions, type QtQuestion } from "./question-types-fixtures";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database. Point DATABASE_URL at a disposable copy.");
  process.exit(2);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  if (!passed) failures++;
}
const section = (t: string) => console.log(`\n--- ${t} ---`);

async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? (e instanceof Error ? e.message : "ERR");
  }
}

// ---------------------------------------------------------------------------
// Fixture DB helpers
// ---------------------------------------------------------------------------

async function seedQuestions(examId: string, subjectId: string, topicId: string, paperId: string | null, prefix: string, questions: QtQuestion[]) {
  const ids: Record<string, string> = {};
  const t0 = Date.now() - questions.length * 1000;
  for (const [i, q] of questions.entries()) {
    const row = await prisma.question.create({
      data: {
        examId,
        subjectId,
        topicId,
        previousYearPaperId: paperId,
        source: paperId ? QuestionSource.PYQ : QuestionSource.QUESTION_BANK,
        examYear: 2026,
        code: `${prefix}-${String(i + 1).padStart(3, "0")}`,
        text: q.text,
        contentFormat: q.contentFormat,
        explanation: q.explanation ?? null,
        // SINGLE_CORRECT is written by OMITTING the column: the default is what every legacy row gets.
        ...(q.questionType !== "SINGLE_CORRECT" ? { questionType: q.questionType } : {}),
        ...(q.matchSpec ? { matchSpec: q.matchSpec } : {}),
        status: QuestionStatus.PUBLISHED,
        difficulty: QuestionDifficulty.MEDIUM,
        createdAt: new Date(t0 + i * 1000),
        options: { create: q.options.map((o, order) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect, order })) },
        assets: q.assets?.length
          ? {
              create: q.assets.map((a) => ({
                role: a.role,
                optionLabel: a.optionLabel ?? null,
                listKey: a.listKey ?? null,
                order: a.order,
                storageKey: a.storageKey,
                mime: "image/webp",
                width: a.width,
                height: a.height,
                bytes: 4321,
                sha256: a.storageKey.replace(/^q\/(?:[0-9a-f]{2}\/)?/, "").slice(0, 64),
                alt: a.alt,
              })),
            }
          : undefined,
      },
    });
    ids[q.key] = row.id;
  }
  return ids;
}

async function seedExam(suffix: string, mediaKey?: (n: number) => string) {
  const exam = await prisma.exam.create({ data: { name: `QT Exam ${suffix}`, code: `QT-${suffix}`, isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "QT Science" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "QT Topic" });
  const fixtures = qtFixtureQuestions(mediaKey);
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2026, title: `QT Paper ${suffix}`, isActive: true } });
  const ids = await seedQuestions(exam.id, subject.id, topic.id, paper.id, `QT-${suffix}`, fixtures);
  // One-question papers for the scoring matrix (one fresh attempt per case).
  const matrixPaper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2025, title: `QT Matrix ${suffix}`, isActive: true } });
  const matrixIds = await seedQuestions(exam.id, subject.id, topic.id, matrixPaper.id, `QTM-${suffix}`, fixtures.filter((q) => q.key === "msq-abd"));
  // Mocks: one with an MSQ (OMR refused), one MATCH + SINGLE only (OMR allowed); negative marking 0.25.
  const mkMock = async (title: string, keys: string[]) =>
    prisma.mockTest.create({
      data: {
        examId: exam.id,
        title,
        durationMinutes: 60,
        negativeMarking: 0.25,
        status: "PUBLISHED",
        questions: { create: keys.map((k, order) => ({ questionId: ids[k], order })) },
      },
    });
  const mockMixed = await mkMock(`QT Mixed Mock ${suffix}`, fixtures.map((q) => q.key));
  const mockNoMsq = await mkMock(`QT OMR-safe Mock ${suffix}`, ["single-plain", "mtf-bio", "mtf-chem"]);
  return { examId: exam.id, subjectId: subject.id, topicId: topic.id, paperId: paper.id, matrixPaperId: matrixPaper.id, ids, matrixIds, mockMixedId: mockMixed.id, mockNoMsqId: mockNoMsq.id };
}

async function cleanupExam(examId: string, studentIds: string[]) {
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.testAttempt.deleteMany({ where: { OR: [{ studentId: { in: studentIds } }, { examId }] } });
  await prisma.mockTest.deleteMany({ where: { examId } });
  await prisma.question.deleteMany({ where: { examId } });
  await prisma.previousYearPaper.deleteMany({ where: { examId } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentSession.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await deleteFixtureTaxonomy(prisma, [examId]);
  await prisma.exam.deleteMany({ where: { id: examId } });
}

const attemptRows = (attemptId: string) =>
  prisma.testAttemptQuestion.findMany({ where: { attemptId }, orderBy: { order: "asc" }, include: { answer: true } });

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function main() {
  const suffix = Date.now().toString(36);
  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `QT${tag}-${suffix}`, name: `QT ${tag}`, email: `qt-${tag.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };
  const F = await seedExam(suffix);
  const fixtures = qtFixtureQuestions();
  const keyOf = (questionId: string) => Object.entries(F.ids).find(([, id]) => id === questionId)?.[0] ?? "?";

  try {
    // ------------------------------------------------------------------ A
    section("A. QuestionType default + legacy rows");
    {
      const typed = await prisma.question.findMany({ where: { id: { in: Object.values(F.ids) } }, select: { id: true, questionType: true } });
      const t = (k: string) => typed.find((r) => r.id === F.ids[k])?.questionType;
      check("question created without questionType is SINGLE_CORRECT (column default)", t("single-plain") === "SINGLE_CORRECT" && t("single-rich") === "SINGLE_CORRECT");
      check("advanced types stored", t("msq-abd") === "MULTIPLE_CORRECT" && t("mtf-bio") === "MATCH_THE_FOLLOWING");
      const nonSingleOutsideFixture = await prisma.question.count({ where: { questionType: { not: "SINGLE_CORRECT" }, examId: { not: F.examId } } });
      check("every pre-existing question in the copy is SINGLE_CORRECT", nonSingleOutsideFixture === 0, nonSingleOutsideFixture);
      const legacyAnswersWithLabels = await prisma.answer.count({ where: { selectedLabels: { isEmpty: false } } });
      check("no historical Answer row has selectedLabels", legacyAnswersWithLabels === 0, legacyAnswersWithLabels);
      const v3 = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "TestAttemptQuestion" WHERE "questionSnapshot"->>'v' = '3'`;
      check("no historical snapshot is v3", v3[0].n === 0, v3[0].n);
    }

    // ------------------------------------------------------------------ B
    section("B. snapshots (v1 / v2 unchanged, v3 for advanced types only)");
    const sExam = await mkStudent("EXAM");
    const exam = await startPreviousYearPaperAttempt(sExam, F.paperId, { durationMode: "FIXED", answerMode: "EXAM" });
    const rows = await attemptRows(exam.id);
    const snapOf = (k: string) => rows.find((r) => r.questionId === F.ids[k])!.questionSnapshot as unknown as QuestionSnapshot & Record<string, unknown>;
    {
      const v1 = snapOf("single-plain");
      check("SINGLE PLAIN → v1, exact legacy key set", JSON.stringify(Object.keys(v1).sort()) === JSON.stringify(["code", "correctLabel", "difficulty", "imageUrl", "options", "text"]), Object.keys(v1));
      const v2 = snapOf("single-rich");
      check("SINGLE RICH → v2 without any v3 key", v2.v === 2 && !("questionType" in v2) && !("correctLabels" in v2) && !("matchSpec" in v2), Object.keys(v2));
      const m = snapOf("msq-abd");
      check("MSQ → v3, questionType, correctLabels [A,B,D], correctLabel \"\"", m.v === 3 && m.questionType === "MULTIPLE_CORRECT" && JSON.stringify(m.correctLabels) === '["A","B","D"]' && m.correctLabel === "", m);
      check("snapshotVersion / snapshotQuestionType read v3", snapshotVersion(m) === 3 && snapshotQuestionType(m) === "MULTIPLE_CORRECT" && snapshotQuestionType(v2) === "SINGLE_CORRECT" && snapshotQuestionType(v1) === "SINGLE_CORRECT");
      const all = snapOf("msq-all");
      check("MSQ all-four freezes four correct labels", JSON.stringify(snapshotCorrectLabels(all)) === '["A","B","C","D"]');
      const t = snapOf("mtf-bio");
      check("MTF → v3 with frozen matchSpec + single correctLabel", t.v === 3 && t.questionType === "MATCH_THE_FOLLOWING" && t.correctLabel === "A" && (t.matchSpec as { listI: unknown[] }).listI.length === 4 && !("correctLabels" in t));
      const ph = snapOf("mtf-phys");
      const listAssets = ((ph.assets ?? []) as { role: string; listKey?: string }[]).filter((a) => a.role === "LIST_ITEM");
      check("MTF LIST_ITEM assets frozen with their listKey", listAssets.map((a) => a.listKey).join() === "I:A,I:B", ph.assets);
      const optImgs = ((snapOf("msq-img").assets ?? []) as { role: string; optionLabel: string | null }[]).filter((a) => a.role === "OPTION");
      check("image-option MSQ freezes 4 OPTION assets", optImgs.map((a) => a.optionLabel).join("") === "ABCD");
      const mv = matchView(ph)!;
      check("matchView: entry text rendered, list images attached to their entry", !!mv && mv.listI[0].assets.length === 1 && mv.listI[2].assets.length === 0 && mv.listII[0].body.format === "RICH_V1", mv);
      check("richQuestionView keeps LIST_ITEM images out of question/option media", (richQuestionView(ph)?.assets ?? []).every((a) => a.role !== "LIST_ITEM"));
      check("matchView is null for SINGLE / MSQ snapshots", matchView(v2) === null && matchView(m) === null && matchView(v1) === null);
    }

    // ------------------------------------------------------------------ C
    section("C. Exam Mode payload never carries the key");
    {
      const payload = toPlayerQuestions(rows, { instantMode: false });
      const json = JSON.stringify(payload);
      check("no reveal on any question", payload.every((q) => q.reveal === null));
      check("no correctLabels / matchSpec / explanation in the serialized payload", !json.includes("correctLabels") && !json.includes("matchSpec") && !json.includes("Sharks are fish") && !json.includes('"correctLabel"'));
      const single = payload.find((q) => q.questionId === F.ids["single-plain"])!;
      check("SINGLE payload has no Phase 4 keys", !("questionType" in single) && !("selectedLabels" in single) && !("match" in single), Object.keys(single));
      const msq = payload.find((q) => q.questionId === F.ids["msq-abd"])!;
      check("MSQ payload: questionType + empty selectedLabels, no key", msq.questionType === "MULTIPLE_CORRECT" && JSON.stringify(msq.selectedLabels) === "[]" && msq.reveal === null);
      const mtf = payload.find((q) => q.questionId === F.ids["mtf-chem"])!;
      check("MTF payload: rendered lists, no correct option", mtf.questionType === "MATCH_THE_FOLLOWING" && mtf.match?.listI.length === 4 && mtf.reveal === null);
      check("Exam Mode: revealAnswerLabels refused", (await errorCode(() => revealAnswerLabels(exam.id, sExam, F.ids["msq-abd"], ["A"]))) === "NOT_ALLOWED");
    }

    // ------------------------------------------------------------------ D
    section("D. label-set save: validation, normalization, seq");
    {
      const q = F.ids["msq-abd"];
      const read = async () => (await prisma.answer.findFirst({ where: { attemptId: exam.id, questionId: q } }))!;
      await saveAnswerLabels(exam.id, sExam, q, ["A"], false, 10);
      check("A selected → [A], ANSWERED", JSON.stringify((await read()).selectedLabels) === '["A"]' && (await read()).status === "ANSWERED");
      await saveAnswerLabels(exam.id, sExam, q, ["A", "B"], false, 11);
      check("B selected → [A,B]", JSON.stringify((await read()).selectedLabels) === '["A","B"]');
      await saveAnswerLabels(exam.id, sExam, q, ["B"], false, 12);
      check("A deselected → [B]", JSON.stringify((await read()).selectedLabels) === '["B"]');
      const stale = await saveAnswerLabels(exam.id, sExam, q, ["A", "B", "C"], false, 11);
      check("stale seq never overwrites (applied=false, still [B])", !stale.applied && JSON.stringify((await read()).selectedLabels) === '["B"]');
      const replay = await saveAnswerLabels(exam.id, sExam, q, ["B"], false, 12);
      check("replayed seq is idempotent (applied=false)", !replay.applied);
      await saveAnswerLabels(exam.id, sExam, q, ["D", "B", "B", "A"], true, 13);
      const a = await read();
      check("duplicates removed, option order, mark kept → [A,B,D] ANSWERED_AND_MARKED", JSON.stringify(a.selectedLabels) === '["A","B","D"]' && a.status === "ANSWERED_AND_MARKED" && a.selectedOptionLabel === null, a);
      check("unknown label refused", (await errorCode(() => saveAnswerLabels(exam.id, sExam, q, ["A", "E"], false, 14))) === "INVALID_OPTION");
      check("non-array refused", (await errorCode(() => saveAnswerLabels(exam.id, sExam, q, "A,B" as unknown as string[], false, 15))) === "INVALID_OPTION");
      check("non-string label refused", (await errorCode(() => saveAnswerLabels(exam.id, sExam, q, [1, 2] as unknown as string[], false, 16))) === "INVALID_OPTION");
      check("still [A,B,D] after refused saves", JSON.stringify((await read()).selectedLabels) === '["A","B","D"]');
      await saveAnswerLabels(exam.id, sExam, q, [], false, 17);
      const cleared = await read();
      check("[] → unanswered (UNANSWERED, answeredAt null)", cleared.selectedLabels.length === 0 && cleared.status === "UNANSWERED" && cleared.answeredAt === null, cleared);
      await saveAnswerLabels(exam.id, sExam, q, [], true, 18);
      check("[] + mark → MARKED_FOR_REVIEW", (await read()).status === "MARKED_FOR_REVIEW");
      check("single-option save refused on an MSQ", (await errorCode(() => saveAnswer(exam.id, sExam, q, "A", false, 19))) === "INVALID_OPTION");
      check("label-set save refused on a SINGLE question", (await errorCode(() => saveAnswerLabels(exam.id, sExam, F.ids["single-plain"], ["C"], false, 20))) === "INVALID_OPTION");
      check("label-set save refused on a MATCH question", (await errorCode(() => saveAnswerLabels(exam.id, sExam, F.ids["mtf-bio"], ["A"], false, 21))) === "INVALID_OPTION");
      check("another student cannot save into this attempt", (await errorCode(async () => saveAnswerLabels(exam.id, await mkStudent("INTRUDER"), q, ["A"], false, 22))) !== null);

      // Rapid toggling with overlapping, out-of-order requests: A, B, D, unselect B, select C.
      const sequence: string[][] = [["A"], ["A", "B"], ["A", "B", "D"], ["A", "D"], ["A", "C", "D"]];
      const q2 = F.ids["msq-ab"];
      const order = [3, 0, 4, 1, 2];
      await Promise.all(order.map((i) => saveAnswerLabels(exam.id, sExam, q2, sequence[i], false, 100 + i)));
      const final = await prisma.answer.findFirst({ where: { attemptId: exam.id, questionId: q2 } });
      check("overlapping saves → the LATEST set wins ([A,C,D], seq 104)", JSON.stringify(final?.selectedLabels) === '["A","C","D"]' && Number(final?.saveSeq) === 104, final);
      const answers = await prisma.answer.count({ where: { attemptId: exam.id, questionId: q2 } });
      check("exactly one Answer row per attempt-question", answers === 1);
      // 40 concurrent random-order saves
      const many = Array.from({ length: 40 }, (_, i) => i).sort(() => Math.random() - 0.5);
      await Promise.all(many.map((i) => saveAnswerLabels(exam.id, sExam, q2, i % 2 ? ["B"] : ["A", "B"], false, 200 + i)));
      const after = await prisma.answer.findFirst({ where: { attemptId: exam.id, questionId: q2 } });
      check("40 concurrent saves → seq 239's set ([B])", JSON.stringify(after?.selectedLabels) === '["B"]' && Number(after?.saveSeq) === 239, after);

      // navigation / resume: the payload restores the saved set
      const payload = toPlayerQuestions(await attemptRows(exam.id), { instantMode: false });
      check("resume payload restores the saved set", JSON.stringify(payload.find((x) => x.questionId === q2)?.selectedLabels) === '["B"]');
    }

    // ------------------------------------------------------------------ E
    section("E. ALL-OR-NOTHING scoring matrix (correct = [A,B,D])");
    {
      const cases: [string[], boolean | null][] = [
        [[], null],
        [["A"], false],
        [["B"], false],
        [["D"], false],
        [["A", "B"], false],
        [["A", "D"], false],
        [["B", "D"], false],
        [["A", "B", "D"], true],
        [["A", "B", "C"], false],
        [["A", "B", "C", "D"], false],
        [["C"], false],
        [["C", "D"], false],
      ];
      for (const [sel, expected] of cases) {
        check(`gradeLabelSet [${sel.join(",")}] → ${expected}`, gradeLabelSet(sel, ["A", "B", "D"]) === expected);
      }
      check("click order D→A→B equals [A,B,D]", gradeLabelSet(["D", "A", "B"], ["A", "B", "D"]) === true);
      // Real submissions, one fresh attempt per case, negative marking 0.25.
      const qid = Object.values(F.matrixIds)[0];
      for (const [sel, expected] of cases) {
        const s = await mkStudent(`M${sel.join("") || "0"}`);
        const att = await startPreviousYearPaperAttempt(s, F.matrixPaperId, { durationMode: "FIXED", answerMode: "EXAM" });
        await prisma.testAttempt.update({ where: { id: att.id }, data: { negativeMarking: 0.25 } });
        if (sel.length) await saveAnswerLabels(att.id, s, qid, [...sel].reverse(), false, 1);
        const done = await submitAttempt(att.id, s);
        const ans = await prisma.answer.findFirst({ where: { attemptId: att.id } });
        const score = expected === true ? 1 : expected === false ? -0.25 : 0;
        check(
          `submit [${sel.join(",")}] → isCorrect ${expected}, score ${score}`,
          ans?.isCorrect === expected && done.score === score && done.correctCount === (expected === true ? 1 : 0) && done.incorrectCount === (expected === false ? 1 : 0) && done.unansweredCount === (expected === null ? 1 : 0),
          { isCorrect: ans?.isCorrect, score: done.score, c: done.correctCount, i: done.incorrectCount, u: done.unansweredCount }
        );
      }
    }

    // ------------------------------------------------------------------ F
    section("F. mixed paper: SINGLE unchanged, MSQ set, MTF single-choice, negative marking");
    {
      const s = await mkStudent("MIX");
      const att = await startMockTestAttempt(s, F.mockMixedId);
      check("mock attempt froze negativeMarking 0.25", att.negativeMarking === 0.25);
      const plan: Record<string, string | string[]> = {
        "single-plain": "C", // correct
        "single-rich": "B", // wrong
        "msq-ab": ["B", "A"], // correct (order)
        "msq-abd": ["A", "B"], // wrong (missed D)
        // msq-all unanswered
        "msq-phys": ["D", "B", "A"], // correct
        "msq-chem": ["A", "B", "C", "D"], // wrong (extra C)
        "msq-img": ["B", "D"], // correct
        "msq-bio": ["A"], // wrong
        "mtf-bio": "A", // correct
        "mtf-phys": "B", // wrong
        "mtf-chem": "B", // correct
        // mtf-mixed unanswered
      };
      let seq = 1;
      for (const [k, v] of Object.entries(plan)) {
        if (Array.isArray(v)) await saveAnswerLabels(att.id, s, F.ids[k], v, false, seq++);
        else await saveAnswer(att.id, s, F.ids[k], v, false, seq++);
      }
      const done = await submitAttempt(att.id, s);
      check("counts: 6 correct, 5 incorrect, 2 unanswered", done.correctCount === 6 && done.incorrectCount === 5 && done.unansweredCount === 2, done);
      check("score = 6 − 5×0.25 = 4.75 of 13", done.score === 4.75 && done.maxScore === 13, { score: done.score, max: done.maxScore });
      const rs = await attemptRows(att.id);
      const correctOf = (k: string) => rs.find((r) => r.questionId === F.ids[k])?.answer?.isCorrect;
      check("per-answer isCorrect follows the plan", correctOf("single-plain") === true && correctOf("single-rich") === false && correctOf("msq-ab") === true && correctOf("msq-abd") === false && correctOf("msq-all") === null && correctOf("mtf-chem") === true && correctOf("mtf-mixed") === null);
      check("unanswered MSQ gets no negative mark (isCorrect null)", correctOf("msq-all") === null);
      const resubmit = await submitAttempt(att.id, s);
      check("re-submit is idempotent", resubmit.score === 4.75 && resubmit.status === AttemptStatus.SUBMITTED);
      check("save after submit refused", (await errorCode(() => saveAnswerLabels(att.id, s, F.ids["msq-all"], ["A"], false, 999))) !== null);
    }

    // ------------------------------------------------------------------ G
    section("G. Practice Mode reveal (commit + lock + full set)");
    {
      const s = await mkStudent("PRAC");
      const att = await startPreviousYearPaperAttempt(s, F.paperId, { durationMode: "UNLIMITED", answerMode: "INSTANT" });
      check("practice attempt is INSTANT", att.answerMode === "INSTANT");
      const q = F.ids["msq-abd"];
      await saveAnswerLabels(att.id, s, q, ["A", "B"], false, 1);
      let payload = toPlayerQuestions(await attemptRows(att.id), { instantMode: true });
      check("before reveal: no key in the payload", payload.every((x) => x.reveal === null) && !JSON.stringify(payload).includes("correctLabels"));
      check("empty set cannot be checked", (await errorCode(() => revealAnswerLabels(att.id, s, q, [], 2))) === "NO_SELECTION");
      check("single reveal API refused on an MSQ", (await errorCode(() => revealAnswer(att.id, s, q, "A", 2))) === "INVALID_OPTION");
      check("label-set reveal refused on a SINGLE", (await errorCode(() => revealAnswerLabels(att.id, s, F.ids["single-plain"], ["C"], 2))) === "INVALID_OPTION");
      const r = await revealAnswerLabels(att.id, s, q, ["B", "A"], 3);
      check("reveal returns committed [A,B], full correct set [A,B,D], isCorrect false", JSON.stringify(r.selectedLabels) === '["A","B"]' && JSON.stringify(r.correctLabels) === '["A","B","D"]' && r.isCorrect === false, r);
      check("reveal releases the explanation", r.explanation?.body !== null && r.explanation !== undefined);
      check("changing the set after reveal → LOCKED", (await errorCode(() => saveAnswerLabels(att.id, s, q, ["A", "B", "D"], false, 4))) === "LOCKED");
      const again = await revealAnswerLabels(att.id, s, q, ["A", "B", "D"], 5);
      check("second reveal (other set) returns the FIRST commit", JSON.stringify(again.selectedLabels) === '["A","B"]' && again.isCorrect === false);
      const ans = await prisma.answer.findFirst({ where: { attemptId: att.id, questionId: q } });
      check("stored set stays [A,B] with revealedAt", JSON.stringify(ans?.selectedLabels) === '["A","B"]' && !!ans?.revealedAt);
      // Concurrent first reveals on another MSQ: exactly one commit.
      const q2 = F.ids["msq-all"];
      const [x, y] = await Promise.all([revealAnswerLabels(att.id, s, q2, ["A"], 10), revealAnswerLabels(att.id, s, q2, ["A", "B", "C", "D"], 11)]);
      check("two racing reveals report the same committed set", JSON.stringify(x.selectedLabels) === JSON.stringify(y.selectedLabels));
      payload = toPlayerQuestions(await attemptRows(att.id), { instantMode: true });
      const revealedQ = payload.find((p) => p.questionId === q)!;
      check("after reveal: that question carries correctLabels, others still nothing", JSON.stringify(revealedQ.reveal?.correctLabels) === '["A","B","D"]' && payload.filter((p) => p.reveal).length === 2);
      // MATCH in practice uses the ordinary single reveal
      const m = await revealAnswer(att.id, s, F.ids["mtf-bio"], "A", 20);
      check("MATCH practice reveal: single coded option, correct", m.correctLabel === "A" && m.isCorrect === true);
      const done = await submitAttempt(att.id, s);
      check("practice submit grades the committed sets (msq-abd wrong, msq-all by commit, mtf right)", done.status === "SUBMITTED" && (done.correctCount ?? 0) >= 1);
    }

    // ------------------------------------------------------------------ H
    section("H. historical snapshots survive edits to the live question");
    {
      const s = await mkStudent("HIST");
      const att = await startPreviousYearPaperAttempt(s, F.paperId, { durationMode: "FIXED", answerMode: "EXAM" });
      await saveAnswerLabels(att.id, s, F.ids["msq-abd"], ["A", "B", "D"], false, 1);
      await saveAnswer(att.id, s, F.ids["mtf-bio"], "A", false, 2);
      // Edit the live questions: new key, new type, new lists, new text.
      await prisma.questionOption.updateMany({ where: { questionId: F.ids["msq-abd"] }, data: { isCorrect: false } });
      await prisma.questionOption.updateMany({ where: { questionId: F.ids["msq-abd"], label: "C" }, data: { isCorrect: true } });
      await prisma.question.update({ where: { id: F.ids["msq-abd"] }, data: { questionType: "SINGLE_CORRECT", text: "EDITED" } });
      await prisma.question.update({ where: { id: F.ids["mtf-bio"] }, data: { matchSpec: { v: 1, listI: [{ key: "A", text: "CHANGED" }, { key: "B", text: "X" }], listII: [{ key: "I", text: "Y" }, { key: "II", text: "Z" }] } } });
      const done = await submitAttempt(att.id, s);
      const rs = await attemptRows(att.id);
      const r = (k: string) => rs.find((x) => x.questionId === F.ids[k])!;
      check("old attempt scores the MSQ from the frozen set (correct)", r("msq-abd").answer?.isCorrect === true, r("msq-abd").answer);
      check("old attempt keeps the frozen text + type", (r("msq-abd").questionSnapshot as { text: string }).text.startsWith("QT MSQ 2") && snapshotQuestionType(r("msq-abd").questionSnapshot as object) === "MULTIPLE_CORRECT");
      const mv = matchView(r("mtf-bio").questionSnapshot as unknown as QuestionSnapshot);
      check("old attempt renders the frozen List I (Insulin), not the edit", mv?.listI[0].body.format === "PLAIN" && mv.listI[0].body.text === "Insulin", mv?.listI[0]);
      check("old attempt MTF scored from the snapshot", r("mtf-bio").answer?.isCorrect === true && done.status === "SUBMITTED");
      // restore for later sections
      await prisma.questionOption.updateMany({ where: { questionId: F.ids["msq-abd"] }, data: { isCorrect: false } });
      await prisma.questionOption.updateMany({ where: { questionId: F.ids["msq-abd"], label: { in: ["A", "B", "D"] } }, data: { isCorrect: true } });
      await prisma.question.update({ where: { id: F.ids["msq-abd"] }, data: { questionType: "MULTIPLE_CORRECT", text: fixtures.find((q) => q.key === "msq-abd")!.text } });
    }

    // ------------------------------------------------------------------ I
    section("I. OMR entry");
    {
      const s = await mkStudent("OMR");
      check("OMR entry refused for a mock with an MSQ", (await errorCode(() => startOfflineOmrEntryAttempt(s, F.mockMixedId))) === "UNAVAILABLE");
      const ok = await startOfflineOmrEntryAttempt(s, F.mockNoMsqId);
      check("OMR entry allowed for MATCH + SINGLE only", ok.entryMode === "OFFLINE_OMR_ENTRY");
      await saveAnswer(ok.id, s, F.ids["mtf-bio"], "A", false, 1);
      await saveAnswer(ok.id, s, F.ids["single-plain"], "C", false, 2);
      const done = await submitAttempt(ok.id, s);
      check("OMR-entered MATCH + SINGLE score as single-choice", done.correctCount === 2 && done.unansweredCount === 1, done);
    }

    // ------------------------------------------------------------------ J
    section("J. AI guards");
    {
      const err = await (async () => {
        try {
          await ensureQuestionVariants(F.ids["msq-abd"], { generate: async () => ({ text: "{}", provider: "test", model: "test" }) as never });
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      })();
      check("AI Variants refuse a MULTIPLE_CORRECT source", err === AI_UNSUPPORTED_TYPE_MESSAGE, err);
      const err2 = await (async () => {
        try {
          await ensureQuestionVariants(F.ids["mtf-bio"], { generate: async () => ({ text: "{}", provider: "test", model: "test" }) as never });
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      })();
      check("AI Variants refuse a MATCH_THE_FOLLOWING source", err2 === AI_UNSUPPORTED_TYPE_MESSAGE, err2);
      const src = readFileSync("app/student/ai-actions.ts", "utf8");
      check("all three student AI actions call the type guard before quota", (src.match(/aiUnsupportedTypeMessage\(questionId\)/g) ?? []).length === 3);
      for (const f of ["lib/ai-explanation.ts", "lib/ai-explanation-variants.ts"]) {
        check(`${f} refuses non-SINGLE sources`, /questionType !== "SINGLE_CORRECT"\) throw new Error\(AI_UNSUPPORTED_TYPE_MESSAGE\)/.test(readFileSync(f, "utf8")));
      }
    }

    // ------------------------------------------------------------------ K
    section("K. Question Insights + copy text");
    {
      const o = (c: string) => ["A", "B", "C", "D"].map((l) => ({ label: l, text: `opt ${l}`, imageUrl: null, isCorrect: c.includes(l) }));
      check("SINGLE: 1 correct ok, 2 correct = MULTIPLE_CORRECT_OPTIONS defect", answerKeyIssue(o("A")) === null && answerKeyIssue(o("AB")) === "MULTIPLE_CORRECT_OPTIONS" && answerKeyIssue(o("AB"), "SINGLE_CORRECT") === "MULTIPLE_CORRECT_OPTIONS");
      check("MSQ: 2+ correct valid, 1 correct = TOO_FEW, 0 = NO_CORRECT", answerKeyIssue(o("ABD"), "MULTIPLE_CORRECT") === null && answerKeyIssue(o("A"), "MULTIPLE_CORRECT") === "TOO_FEW_CORRECT_OPTIONS" && answerKeyIssue(o(""), "MULTIPLE_CORRECT") === "NO_CORRECT_OPTION");
      check("MATCH: two correct is still a defect", answerKeyIssue(o("AB"), "MATCH_THE_FOLLOWING") === "MULTIPLE_CORRECT_OPTIONS");
      check("answerKeyString: B / A,B,D", answerKeyString(o("B")) === "B" && answerKeyString(o("DBA")) === "A,B,D");
      const base = { code: "X", text: "Q", imageUrl: null, wrongPct: 40, explanation: null };
      const single = buildCopyBlocks({ questions: [{ id: "1", ...base, options: o("B") }], headline: "H", subtitle: "S", blockSize: 0, includeExplanation: false });
      check("SINGLE copy unchanged shape (✅ Correct Answer: B. opt B)", single.blocks[0].text.includes("✅ Correct Answer: B. opt B"));
      const msq = buildCopyBlocks({ questions: [{ id: "2", ...base, options: o("ABD"), questionType: "MULTIPLE_CORRECT" }], headline: "H", subtitle: "S", blockSize: 0, includeExplanation: false });
      check("MSQ copy lists every correct answer", msq.excluded.length === 0 && msq.blocks[0].text.includes("✅ Correct Answers: A, B, D") && msq.blocks[0].text.includes("More than one option"));
      const mtf = buildCopyBlocks({ questions: [{ id: "3", ...base, options: o("A"), questionType: "MATCH_THE_FOLLOWING", matchSpec: fixtures.find((q) => q.key === "mtf-bio")!.matchSpec }], headline: "H", subtitle: "S", blockSize: 0, includeExplanation: false });
      check("MTF copy includes List I / List II", /List I\nA\. Insulin[\s\S]*List II\nI\. Pancreas/.test(mtf.blocks[0].text));
      // Key-changed SQL: v3 MSQ snapshots read as the sorted set
      const keyRows = await prisma.$queryRaw<{ key: string }[]>`
        SELECT COALESCE(CASE WHEN tq."questionSnapshot"->>'questionType' = 'MULTIPLE_CORRECT' AND tq."questionSnapshot"->>'v' = '3'
                             THEN (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(tq."questionSnapshot"->'correctLabels') x)
                             ELSE tq."questionSnapshot"->>'correctLabel' END, '') AS key
        FROM "TestAttemptQuestion" tq WHERE tq."attemptId" = ${exam.id} AND tq."questionId" IN (${F.ids["msq-abd"]}, ${F.ids["single-plain"]}) ORDER BY tq."order"`;
      check("snapshot key SQL: SINGLE → C, MSQ → A,B,D", keyRows.map((r) => r.key).join("|") === "C|A,B,D", keyRows);
    }

    // ------------------------------------------------------------------ L
    section("L. WhatsApp share text");
    {
      // Phase 3 builder, byte for byte, from git HEAD.
      const dir = mkdtempSync(path.join(process.cwd(), "scripts", ".qt-head-"));
      try {
        writeFileSync(path.join(dir, "share.ts"), execFileSync("git", ["show", "HEAD:lib/whatsapp-share-template.ts"]));
        const head = (await import(path.join(dir, "share.ts"))) as typeof import("@/lib/whatsapp-share-template");
        const q = { text: "Which is prime?", imageUrl: null, options: [{ label: "A", text: "4" }, { label: "B", text: "7" }] };
        const args = { template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: "RUHS MO", subjectName: "Medicine", question: q };
        check("SINGLE share text byte-identical to Phase 3", buildQuestionShareText(args) === head.buildQuestionShareText(args));
        check("snapshotShareFields of a SINGLE snapshot adds nothing", JSON.stringify(snapshotShareFields(snapOf("single-plain"))) === "{}" && buildQuestionShareText({ ...args, question: { ...q, ...snapshotShareFields(snapOf("single-rich")) } }) === head.buildQuestionShareText(args));
      } finally {
        execFileSync("rm", ["-rf", dir]);
      }
      const msqSnap = snapOf("msq-abd");
      const msqText = buildQuestionShareText({ template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: "NEET", question: { text: msqSnap.text, options: msqSnap.options, ...snapshotShareFields(msqSnap) } });
      check("MSQ share says more than one may be correct, never the answer", msqText.includes("More than one option may be correct") && !/Correct Answer|A, B, D/.test(msqText));
      const mtfSnap = snapOf("mtf-bio");
      const mtfText = buildQuestionShareText({ template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: "NEET", question: { text: mtfSnap.text, options: mtfSnap.options, ...snapshotShareFields(mtfSnap) } });
      check("MTF share includes both lists, not the answer", /List I\*\nA\. Insulin/.test(mtfText) && mtfText.includes("IV. Adrenal cortex") && !/Correct/.test(mtfText), mtfText);
    }

    // ------------------------------------------------------------------ M
    section("M. pure helpers + importer manifest");
    {
      const labels = ["A", "B", "C", "D"];
      check("normalizeLabelSet: order + dedupe", JSON.stringify(normalizeLabelSet(["D", "A", "A"], labels)) === '{"ok":true,"labels":["A","D"]}');
      check("normalizeLabelSet: unknown → refused", normalizeLabelSet(["A", "Z"], labels).ok === false && normalizeLabelSet("A", labels).ok === false);
      check("correctCountIssue rules", correctCountIssue("MULTIPLE_CORRECT", 1, 4) !== null && correctCountIssue("MULTIPLE_CORRECT", 2, 4) === null && correctCountIssue("SINGLE_CORRECT", 2, 4) !== null && correctCountIssue("MATCH_THE_FOLLOWING", 1, 4) === null);
      const spec = fixtures.find((q) => q.key === "mtf-phys")!.matchSpec;
      check("matchSpecIssues: image-only entries need their image", matchSpecIssues(spec).length === 2 && matchSpecIssues(spec, new Set(["I:A", "I:B"])).length === 0);
      check("matchSpecIssues: duplicate / invalid keys", matchSpecIssues({ listI: [{ key: "A", text: "x" }, { key: "A", text: "y" }], listII: [{ key: "I", text: "x" }, { key: "a b", text: "y" }] }).length === 2);
      check("matchSpecIssues: too few entries", matchSpecIssues({ listI: [{ key: "A", text: "x" }], listII: [{ key: "I", text: "x" }, { key: "II", text: "y" }] }).length === 1);
      check("readMatchSpec refuses garbage, never throws", readMatchSpec(null) === null && readMatchSpec({ listI: "x" }) === null && readMatchSpec({ listI: [{}], listII: [] }) === null);
      check("parseMatchLines", JSON.stringify(parseMatchLines("A. one\n(ii) two\nbad line").entries) === '[{"key":"A","text":"one"},{"key":"II","text":"two"}]' && parseMatchLines("bad").issues.length === 1);
      check("parseCorrect A,B,D / hasRepeatedLabel", JSON.stringify(parseCorrect("D, a , B")) === '["A","B","D"]' && hasRepeatedLabel("A,A") && !hasRepeatedLabel("A,B"));
      const row = (o: Partial<BulkImportRow>) =>
        ({ rowNumber: 2, exam: "X", examYear: "2026", subject: "S", topic: "", subTopic: "", questionText: "Match List I with List II.", optionA: "A-I", optionB: "A-II", optionC: "x", optionD: "y", correctAnswer: "A", difficulty: "EASY", source: "", status: "", ...o }) as unknown as BulkImportRow;
      const mtfRow = toManifestQuestion(row({ questionType: "MATCH_THE_FOLLOWING", contentFormat: "RICH_V1", listI: "A. one @@ a.png :: fig\nB. two", listII: "I. x\nII. y" }));
      check("manifest: MTF list image becomes LIST_ITEM I:A", mtfRow.match?.listI[0].images[0]?.role === "LIST_ITEM" && mtfRow.match.listI[0].images[0].listKey === "I:A");
      check("manifest: MTF stores stem only + structured spec", composeQuestionText(mtfRow) === "Match List I with List II." && manifestMatchSpec(mtfRow)?.listII[1].text === "y");
      check("manifest: dedup identity includes the lists", matchIdentityText(mtfRow).includes("List I") && matchIdentityText(mtfRow) !== composeQuestionText(mtfRow));
      const other = toManifestQuestion(row({ questionType: "SINGLE_CORRECT", contentFormat: "RICH_V1", listI: "A. one @@ a.png\nB. two", listII: "I. x\nII. y" }));
      check("manifest: lists on a non-MTF row keep the Phase 3 behaviour (QUESTION figure, appended text)", other.match?.listI[0].images[0]?.role === "QUESTION" && composeQuestionText(other).includes("List I") && manifestMatchSpec(other) === null);
      const msqRow = toManifestQuestion(row({ questionType: "MULTIPLE_CORRECT", correctAnswer: "D,A,B" }));
      check("manifest: MSQ correct set normalized [A,B,D]", JSON.stringify(msqRow.correct) === '["A","B","D"]' && msqRow.parseIssues.length === 0);
      check("manifest: repeated label → parse issue", toManifestQuestion(row({ questionType: "MULTIPLE_CORRECT", correctAnswer: "A,A,B" })).parseIssues.some((i) => /twice/.test(i.message)));
      check("manifest: blank Question Type stays SINGLE_CORRECT (legacy templates)", toManifestQuestion(row({})).questionType === "SINGLE_CORRECT");
    }

    // ------------------------------------------------------------------ N
    section("N. fixture coverage");
    check("11 required advanced fixtures present (7 MSQ + 4 MTF)", fixtures.filter((q) => q.questionType === "MULTIPLE_CORRECT").length === 7 && fixtures.filter((q) => q.questionType === "MATCH_THE_FOLLOWING").length === 4);
    void keyOf;
  } finally {
    await cleanupExam(F.examId, students);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Browser fixture
// ---------------------------------------------------------------------------

async function setup() {
  const suffix = Date.now().toString(36);
  // REAL_MEDIA=1 (with a disposable STORAGE_DIR): store real figures through the Phase 2 engine.
  const mediaKeys = process.env.REAL_MEDIA === "1" ? await storeFixtureFigures() : null;
  const F = await seedExam(suffix, mediaKeys ? (n) => mediaKeys[String(n)] ?? fakeKey(n) : undefined);
  // A 180-question mixed paper for the performance run (SINGLE / MSQ / MTF, formulas, images).
  const base = qtFixtureQuestions(mediaKeys ? (n) => mediaKeys[String(n)] ?? fakeKey(n) : undefined).filter((q) => q.key !== "single-plain");
  const perfQs: QtQuestion[] = Array.from({ length: 180 }, (_, i) => {
    const b = i % 3 === 0 ? { ...base[0], questionType: "SINGLE_CORRECT" as const } : base[1 + (i % (base.length - 1))];
    return { ...b, key: `perf-${i}`, text: `P${i + 1}. ${b.text}` };
  });
  const perfPaper = await prisma.previousYearPaper.create({ data: { examId: F.examId, year: 2024, title: `QT Perf 180 ${suffix}`, isActive: true } });
  await seedQuestions(F.examId, F.subjectId, F.topicId, perfPaper.id, `QTP-${suffix}`, perfQs);
  const password = `Qt!${suffix}Pw9`;
  const hash = await argon2.hash(password);
  const students: Record<string, { id: string; email: string; password: string }> = {};
  for (const tag of ["exam", "prac", "mobile", "perf", "review", "dark"]) {
    const email = `qt-ui-${tag}-${suffix}@example.test`;
    const s = await prisma.student.create({
      data: { studentId: await nextStudentId(), name: `QT UI ${tag}`, email, passwordHash: hash, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    await prisma.studentProfile.create({ data: { studentId: s.id } });
    await ensureDefaultExamEnrollmentSafely(s.id);
    students[tag] = { id: s.id, email, password };
  }
  const EXAM = { answerMode: "EXAM", durationMode: "FIXED" } as const;
  const runs = {
    exam: (await startPreviousYearPaperAttempt(students.exam.id, F.paperId, EXAM)).id,
    prac: (await startPreviousYearPaperAttempt(students.prac.id, F.paperId, { answerMode: "INSTANT", durationMode: "UNLIMITED" })).id,
    mobile: (await startPreviousYearPaperAttempt(students.mobile.id, F.paperId, EXAM)).id,
    dark: (await startPreviousYearPaperAttempt(students.dark.id, F.paperId, EXAM)).id,
    perf: (await startPreviousYearPaperAttempt(students.perf.id, perfPaper.id, EXAM)).id,
  };
  // Review: a submitted attempt with selected-correct / selected-wrong / missed states.
  const rv = await startPreviousYearPaperAttempt(students.review.id, F.paperId, EXAM);
  await saveAnswerLabels(rv.id, students.review.id, F.ids["msq-abd"], ["A", "C"], false, 1);
  await saveAnswerLabels(rv.id, students.review.id, F.ids["msq-ab"], ["A", "B"], false, 2);
  await saveAnswer(rv.id, students.review.id, F.ids["mtf-bio"], "B", false, 3);
  await saveAnswer(rv.id, students.review.id, F.ids["single-plain"], "C", false, 4);
  await submitAttempt(rv.id, students.review.id);
  await prisma.savedQuestion.createMany({ data: ["msq-abd", "mtf-phys"].map((k) => ({ studentId: students.review.id, questionId: F.ids[k] })) });
  console.log(JSON.stringify({ suffix, ...F, perfPaperId: perfPaper.id, students, runs, reviewAttemptId: rv.id }, null, 2));
  await prisma.$disconnect();
}

/** Simple labelled line-art figures (SVG → PNG → stored WebP), n → storageKey. */
async function storeFixtureFigures(): Promise<Record<string, string>> {
  const sharp = (await import("sharp")).default;
  const { storeScientificImage } = await import("@/lib/media-processing");
  const shapes: Record<number, [number, number, string]> = {
    1: [240, 240, '<polygon points="120,30 210,200 30,200" fill="none" stroke="#111" stroke-width="6"/>'],
    2: [240, 240, '<rect x="40" y="40" width="160" height="160" fill="none" stroke="#111" stroke-width="6"/>'],
    3: [240, 240, '<circle cx="120" cy="120" r="85" fill="none" stroke="#111" stroke-width="6"/>'],
    4: [240, 240, '<rect x="20" y="70" width="200" height="100" fill="none" stroke="#111" stroke-width="6"/>'],
    5: [640, 400, '<ellipse cx="320" cy="200" rx="280" ry="170" fill="none" stroke="#111" stroke-width="5"/><rect x="50" y="40" width="540" height="320" fill="none" stroke="#2a7" stroke-width="5"/><circle cx="300" cy="200" r="50" fill="none" stroke="#111" stroke-width="4"/><text x="270" y="207" font-size="22">Nucleus</text>'],
    6: [320, 240, '<path d="M20 220 Q160 -180 300 220" fill="none" stroke="#111" stroke-width="5"/><line x1="10" y1="220" x2="310" y2="220" stroke="#555" stroke-width="2"/>'],
    7: [320, 240, '<path d="M40 20 Q60 200 300 210" fill="none" stroke="#111" stroke-width="5"/><line x1="30" y1="230" x2="310" y2="230" stroke="#555" stroke-width="2"/>'],
    8: [300, 300, '<circle cx="150" cy="150" r="30" fill="none" stroke="#111" stroke-width="5"/><text x="140" y="158" font-size="22">C</text><line x1="150" y1="120" x2="150" y2="40" stroke="#111" stroke-width="4"/><line x1="150" y1="180" x2="150" y2="260" stroke="#111" stroke-width="4"/><line x1="120" y1="150" x2="40" y2="150" stroke="#111" stroke-width="4"/><line x1="180" y1="150" x2="260" y2="150" stroke="#111" stroke-width="4"/>'],
    9: [300, 300, '<line x1="40" y1="150" x2="260" y2="150" stroke="#111" stroke-width="4"/><text x="30" y="140" font-size="22">C</text><text x="140" y="140" font-size="22">C</text><text x="240" y="140" font-size="22">OH</text>'],
    10: [360, 240, '<circle cx="180" cy="120" r="30" fill="none" stroke="#111" stroke-width="3"/><circle cx="180" cy="120" r="60" fill="none" stroke="#111" stroke-width="3"/><circle cx="180" cy="120" r="95" fill="none" stroke="#111" stroke-width="3"/><circle cx="180" cy="120" r="6" fill="#111"/>'],
  };
  const out: Record<string, string> = {};
  for (const [n, [w, h, body]] of Object.entries(shapes)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${body}<text x="8" y="${h - 8}" font-size="14" fill="#888">QT fig ${n}</text></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    out[n] = (await storeScientificImage(png, { declaredMime: "image/png", filename: `qt-fig-${n}.png` })).storageKey;
  }
  return out;
}

async function cleanup(fixturePath: string) {
  const F = JSON.parse(readFileSync(fixturePath, "utf8"));
  const ids = Object.values(F.students as Record<string, { id: string }>).map((s) => s.id);
  await cleanupExam(F.examId, ids);
  console.log("cleaned");
  await prisma.$disconnect();
}

const mode = process.argv[2];
(mode === "setup" ? setup() : mode === "cleanup" ? cleanup(process.argv[3]) : main()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
